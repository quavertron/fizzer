package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"
)

const replayEvents = 1024
const replayBytes = 16 * 1024 * 1024

type watchCursor struct {
	Epoch string
	Seq   uint64
}
type watchPacket struct {
	Cursor watchCursor
	Event  *EditEvent `json:",omitempty"`
	Status string     `json:",omitempty"`
}
type subscriber struct {
	conn net.Conn
	out  chan []byte
}
type eventHub struct {
	mu      sync.Mutex
	epoch   string
	seq     uint64
	history [][]byte
	first   uint64
	bytes   int
	clients map[*subscriber]bool
}

func newEventHub() *eventHub {
	return &eventHub{epoch: fmt.Sprint(time.Now().UnixNano()), clients: make(map[*subscriber]bool)}
}
func (h *eventHub) publish(event EditEvent) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.seq++
	data, _ := json.Marshal(watchPacket{Cursor: watchCursor{h.epoch, h.seq}, Event: &event})
	data = append(data, '\n')
	h.history = append(h.history, data)
	h.bytes += len(data)
	for len(h.history) > replayEvents || h.bytes > replayBytes {
		h.bytes -= len(h.history[0])
		h.history[0] = nil
		h.history = h.history[1:]
	}
	h.first = h.seq - uint64(len(h.history)) + 1
	for client := range h.clients {
		select {
		case client.out <- data:
		default:
			// A slow viewer must never stall event producers or other viewers.
			delete(h.clients, client)
			close(client.out)
			client.conn.Close()
		}
	}
}
func (h *eventHub) serve(ctx context.Context, conn net.Conn) {
	defer conn.Close()
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	var cursor watchCursor
	if json.NewDecoder(conn).Decode(&cursor) != nil {
		return
	}
	conn.SetReadDeadline(time.Time{})
	h.mu.Lock()
	client := &subscriber{conn: conn, out: make(chan []byte, len(h.history)+128)}
	gap := cursor.Epoch != "" && (cursor.Epoch != h.epoch || cursor.Seq+1 < h.first || cursor.Seq > h.seq)
	status := ""
	if gap {
		status = "Collector history changed or expired; some events could not be replayed."
	}
	hello, _ := json.Marshal(watchPacket{Status: status})
	client.out <- append(hello, '\n')
	for i, data := range h.history {
		seq := h.first + uint64(i)
		if cursor.Epoch != h.epoch || seq > cursor.Seq {
			client.out <- data
		}
	}
	h.clients[client] = true
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		if h.clients[client] {
			delete(h.clients, client)
			close(client.out)
		}
		h.mu.Unlock()
	}()
	disconnected := make(chan struct{})
	go func() { io.Copy(io.Discard, conn); close(disconnected) }()
	for {
		select {
		case <-ctx.Done():
			return
		case <-disconnected:
			return
		case data, ok := <-client.out:
			if !ok {
				return
			}
			conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
			if _, err := conn.Write(data); err != nil {
				return
			}
		}
	}
}
func runCollector(parent context.Context, path string) error {
	// Claim producers first; never displace an older standalone monitor.
	eventsListener, eventsOwned, err := openEventListener(path)
	if err != nil {
		return err
	}
	viewersPath := path + ".viewers"
	viewersListener, viewersOwned, err := openEventListener(viewersPath)
	if err != nil {
		eventsListener.Close()
		removeOwnedSocket(path, eventsOwned)
		return err
	}
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	hub := newEventHub()
	events := make(chan EditEvent, 64)
	status := make(chan string, 1)
	var workers sync.WaitGroup
	workers.Add(2)
	go func() {
		defer workers.Done()
		runEventListener(ctx, path, eventsListener, eventsOwned, events, status, time.Second)
	}()
	go func() {
		defer workers.Done()
		runSocketListener(ctx, viewersPath, viewersListener, viewersOwned, status, time.Second, hub.serve)
	}()
	defer workers.Wait()
	for {
		select {
		case <-ctx.Done():
			return nil
		case event := <-events:
			hub.publish(event)
		case message := <-status:
			if message != "" {
				fmt.Fprintln(os.Stderr, "awatch collector:", message)
			}
		}
	}
}
func startCollector() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	command := exec.Command(exe, "--collector")
	// Independent of either viewer's terminal/process lifetime.
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := command.Start(); err != nil {
		return err
	}
	go func() { _ = command.Wait() }()
	return nil
}
func watchCollector(ctx context.Context, path string, events chan<- EditEvent, status chan string) {
	report := func(message string) {
		select {
		case <-status:
		default:
		}
		select {
		case status <- message:
		default:
		}
	}
	cursor := watchCursor{}
	nextStart := time.Time{}
	for ctx.Err() == nil {
		conn, err := net.DialTimeout("unix", path+".viewers", 250*time.Millisecond)
		if err != nil {
			if time.Now().After(nextStart) {
				// A live legacy producer socket cannot be upgraded in place.
				legacy, legacyErr := net.DialTimeout("unix", path, 100*time.Millisecond)
				if legacyErr == nil {
					legacy.Close()
					report("Waiting for shared collector. If an older awatch is running, quit it once; this viewer will retry.")
				} else if err := startCollector(); err != nil {
					report("Cannot start collector: " + err.Error())
				} else {
					report("Connecting to shared collector…")
				}
				nextStart = time.Now().Add(2 * time.Second)
			}
		} else {
			stop := context.AfterFunc(ctx, func() { conn.Close() })
			if err = json.NewEncoder(conn).Encode(cursor); err == nil {
				decoder := json.NewDecoder(conn)
				for {
					var packet watchPacket
					if err = decoder.Decode(&packet); err != nil {
						break
					}
					if packet.Event == nil {
						report(packet.Status)
						continue
					}
					if packet.Cursor.Epoch == cursor.Epoch && packet.Cursor.Seq <= cursor.Seq {
						continue
					}
					select {
					case events <- *packet.Event:
						cursor = packet.Cursor
					case <-ctx.Done():
						conn.Close()
						stop()
						return
					}
				}
			}
			stop()
			conn.Close()
			if ctx.Err() == nil {
				report("Reconnecting to shared collector…")
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(250 * time.Millisecond):
		}
	}
}
