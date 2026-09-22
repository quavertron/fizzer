package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

type socketIOHandler func(args []json.RawMessage, ack func(...any))

type socketIOClient struct {
	mu        sync.Mutex
	conn      *websocket.Conn
	base      string
	token     string
	handlers  map[string][]socketIOHandler
	ackID     int
	acks      map[int]func([]json.RawMessage)
	connected bool
	closed    bool
	done      chan struct{}
}

func newSocketIOClient(base, token string) *socketIOClient {
	return &socketIOClient{
		base:     strings.TrimRight(base, "/"),
		token:    token,
		handlers: map[string][]socketIOHandler{},
		acks:     map[int]func([]json.RawMessage){},
		done:     make(chan struct{}),
	}
}

func (c *socketIOClient) SetToken(token string) {
	c.mu.Lock()
	c.token = token
	c.mu.Unlock()
}

func (c *socketIOClient) On(event string, h socketIOHandler) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.handlers[event] = append(c.handlers[event], h)
}

func (c *socketIOClient) IsConnected() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.connected
}

func (c *socketIOClient) Close() {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	c.closed = true
	conn := c.conn
	c.connected = false
	c.mu.Unlock()
	close(c.done)
	if conn != nil {
		_ = conn.Close(websocket.StatusNormalClosure, "")
	}
}

func (c *socketIOClient) wsURL() (string, error) {
	u, err := url.Parse(c.base)
	if err != nil {
		return "", err
	}
	switch u.Scheme {
	case "https":
		u.Scheme = "wss"
	case "http":
		u.Scheme = "ws"
	case "wss", "ws":
	default:
		return "", fmt.Errorf("unsupported scheme: %s", u.Scheme)
	}
	u.Path = "/socket.io/"
	q := u.Query()
	q.Set("EIO", "4")
	q.Set("transport", "websocket")
	u.RawQuery = q.Encode()
	return u.String(), nil
}

func (c *socketIOClient) connectOnce(ctx context.Context) error {
	wsURL, err := c.wsURL()
	if err != nil {
		return err
	}
	c.mu.Lock()
	token := c.token
	c.mu.Unlock()
	header := http.Header{}
	if token != "" {
		header.Set("Authorization", "Bearer "+token)
	}
	conn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{HTTPHeader: header})
	if err != nil {
		return err
	}
	conn.SetReadLimit(1_000_000)

	// Engine.IO open
	_, data, err := conn.Read(ctx)
	if err != nil {
		_ = conn.Close(websocket.StatusNormalClosure, "")
		return err
	}
	if len(data) == 0 || data[0] != '0' {
		_ = conn.Close(websocket.StatusNormalClosure, "")
		return fmt.Errorf("expected engine open packet, got %q", truncate(string(data), 80))
	}

	// Socket.IO CONNECT /runners with auth
	auth := map[string]string{"token": token}
	authJSON, _ := json.Marshal(auth)
	if err := c.write(ctx, conn, fmt.Sprintf("40/runners,%s", authJSON)); err != nil {
		_ = conn.Close(websocket.StatusNormalClosure, "")
		return err
	}

	// Wait for CONNECT ack (40) or error (44) while pumping packets.
	// Hand off the live conn to the read loop after we see 40/runners.
	for {
		_, msg, err := conn.Read(ctx)
		if err != nil {
			_ = conn.Close(websocket.StatusNormalClosure, "")
			return err
		}
		text := string(msg)
		if text == "2" {
			_ = c.write(ctx, conn, "3")
			continue
		}
		if strings.HasPrefix(text, "40/runners") || text == "40" {
			c.mu.Lock()
			c.conn = conn
			c.connected = true
			c.closed = false
			c.mu.Unlock()
			return nil
		}
		if strings.HasPrefix(text, "44") || strings.HasPrefix(text, "4") && strings.Contains(text, "error") {
			_ = conn.Close(websocket.StatusNormalClosure, "")
			return fmt.Errorf("socket connect error: %s", text)
		}
	}
}

func (c *socketIOClient) write(ctx context.Context, conn *websocket.Conn, payload string) error {
	wctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	return conn.Write(wctx, websocket.MessageText, []byte(payload))
}

func (c *socketIOClient) Emit(event string, args ...any) error {
	c.mu.Lock()
	conn := c.conn
	closed := c.closed
	c.mu.Unlock()
	if conn == nil || closed {
		return fmt.Errorf("socket not connected")
	}
	payload := make([]any, 0, len(args)+1)
	payload = append(payload, event)
	payload = append(payload, args...)
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	return c.write(ctx, conn, "42/runners,"+string(body))
}

func (c *socketIOClient) EmitAck(event string, args []any, timeout time.Duration) ([]json.RawMessage, error) {
	c.mu.Lock()
	conn := c.conn
	closed := c.closed
	if conn == nil || closed {
		c.mu.Unlock()
		return nil, fmt.Errorf("socket not connected")
	}
	c.ackID++
	ackID := c.ackID
	resultCh := make(chan []json.RawMessage, 1)
	c.acks[ackID] = func(msgs []json.RawMessage) { resultCh <- msgs }
	c.mu.Unlock()

	payload := make([]any, 0, len(args)+2)
	payload = append(payload, event)
	payload = append(payload, args...)
	payload = append(payload, ackID)
	body, err := json.Marshal(payload)
	if err != nil {
		c.clearAck(ackID)
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	if err := c.write(ctx, conn, "42/runners,"+string(body)); err != nil {
		c.clearAck(ackID)
		return nil, err
	}
	select {
	case msgs := <-resultCh:
		return msgs, nil
	case <-ctx.Done():
		c.clearAck(ackID)
		return nil, fmt.Errorf("ack timeout for %s", event)
	case <-c.done:
		c.clearAck(ackID)
		return nil, fmt.Errorf("socket closed")
	}
}

func (c *socketIOClient) clearAck(id int) {
	c.mu.Lock()
	delete(c.acks, id)
	c.mu.Unlock()
}

func (c *socketIOClient) readLoop(ctx context.Context) {
	for {
		select {
		case <-c.done:
			return
		default:
		}
		c.mu.Lock()
		conn := c.conn
		c.mu.Unlock()
		if conn == nil {
			return
		}
		_, msg, err := conn.Read(ctx)
		if err != nil {
			c.mu.Lock()
			c.connected = false
			c.mu.Unlock()
			return
		}
		c.handlePacket(string(msg))
	}
}

func (c *socketIOClient) handlePacket(text string) {
	if text == "2" {
		c.mu.Lock()
		conn := c.conn
		c.mu.Unlock()
		if conn != nil {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			_ = c.write(ctx, conn, "3")
			cancel()
		}
		return
	}
	if !strings.HasPrefix(text, "4") {
		return
	}
	// 43/runners,[ackId, ...]  or  42/runners,["event", ...]
	rest := text[1:]
	ns := "/runners"
	if strings.HasPrefix(rest, ns+",") {
		rest = rest[len(ns)+1:]
	} else if i := strings.Index(rest, ","); i > 0 && strings.HasPrefix(rest[:i], "/") {
		rest = rest[i+1:]
	}
	var payload []json.RawMessage
	if err := json.Unmarshal([]byte(rest), &payload); err != nil || len(payload) == 0 {
		return
	}
	// ACK?
	if strings.HasPrefix(text, "43") {
		var ackID int
		if err := json.Unmarshal(payload[0], &ackID); err == nil {
			c.mu.Lock()
			fn := c.acks[ackID]
			delete(c.acks, ackID)
			c.mu.Unlock()
			if fn != nil {
				fn(payload[1:])
			}
			return
		}
	}
	var event string
	if err := json.Unmarshal(payload[0], &event); err != nil || event == "" {
		return
	}
	args := payload[1:]
	var ackFn func(...any)
	// Trailing numeric arg is ack id when present as separate JSON number after args —
	// Socket.IO packs ack id inside the array as last element when client expects ack.
	// Server-initiated events with ack: 42/runners,["event", data, ackId]
	if len(args) >= 2 {
		var maybeAck int
		if err := json.Unmarshal(args[len(args)-1], &maybeAck); err == nil {
			// Heuristic: if last is a small integer and event expects ack, treat as ack id.
			// Only used for run:cancel / workspace:prepare which always include object args.
			if event == "run:cancel" || event == "workspace:prepare" {
				ackID := maybeAck
				dataArgs := args[:len(args)-1]
				ackFn = func(replies ...any) {
					body, _ := json.Marshal(append([]any{ackID}, replies...))
					c.mu.Lock()
					conn := c.conn
					c.mu.Unlock()
					if conn == nil {
						return
					}
					ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
					_ = c.write(ctx, conn, "43/runners,"+string(body))
					cancel()
				}
				args = dataArgs
			}
		}
	}

	c.mu.Lock()
	handlers := append([]socketIOHandler{}, c.handlers[event]...)
	c.mu.Unlock()
	for _, h := range handlers {
		h(args, ackFn)
	}
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

// connectAndServe runs connect with retry until ctx is done.
func (c *socketIOClient) connectAndServe(ctx context.Context, onConnect func()) {
	delay := 2 * time.Second
	for {
		select {
		case <-ctx.Done():
			return
		case <-c.done:
			return
		default:
		}
		err := c.connectOnce(ctx)
		if err != nil {
			errorLogf("Connection error: %v", err)
			select {
			case <-ctx.Done():
				return
			case <-c.done:
				return
			case <-time.After(delay):
			}
			if delay < 10*time.Second {
				delay += time.Second
			}
			continue
		}
		delay = 2 * time.Second
		if onConnect != nil {
			onConnect()
		}
		c.readLoop(ctx)
		c.mu.Lock()
		wasConnected := c.connected
		c.connected = false
		c.mu.Unlock()
		if wasConnected {
			logf("Disconnected")
		}
		select {
		case <-ctx.Done():
			return
		case <-c.done:
			return
		case <-time.After(2 * time.Second):
		}
	}
}
