package main

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// startAwatchViewer connects to the alock command socket and emits edit/lock events.
// Returns a close function. Failure is non-fatal.
func startAwatchViewer(emit func(events []map[string]any), tail bool) func() {
	socketPath := "/tmp/alock/daemon.sock"
	binary := alockBinary()
	retryMs := 2000
	closed := make(chan struct{})
	var closeOnce sync.Once
	closeFn := func() {
		closeOnce.Do(func() { close(closed) })
	}

	// Best-effort ensure
	if out, err := exec.Command(binary, "events", "--ensure").CombinedOutput(); err == nil {
		var payload struct {
			Socket string `json:"socket"`
		}
		if json.Unmarshal(out, &payload) == nil && payload.Socket != "" {
			socketPath = payload.Socket
		}
	}

	cursor := map[string]any{}
	var connected bool
	ready := make(chan struct{})
	var readyOnce sync.Once

	connect := func() {
		for {
			select {
			case <-closed:
				return
			default:
			}
			conn, err := net.Dial("unix", socketPath)
			if err != nil {
				// try ensure again
				if out, e := exec.Command(binary, "events", "--ensure").CombinedOutput(); e == nil {
					var payload struct {
						Socket string `json:"socket"`
					}
					if json.Unmarshal(out, &payload) == nil && payload.Socket != "" {
						socketPath = payload.Socket
					}
				}
				time.Sleep(time.Duration(retryMs) * time.Millisecond)
				continue
			}
			body, _ := json.Marshal(map[string]any{"cmd": "watch", "cursor": cursor, "tail": tail && cursor["Epoch"] == nil})
			header := make([]byte, 4)
			n := len(body)
			header[0] = byte(n)
			header[1] = byte(n >> 8)
			header[2] = byte(n >> 16)
			header[3] = byte(n >> 24)
			conn.Write(append(header, body...))
			connected = true
			scanner := bufio.NewScanner(conn)
			scanner.Buffer(make([]byte, 1024*1024), 32*1024*1024)
			for scanner.Scan() {
				var packet struct {
					Event  map[string]any `json:"Event"`
					Cursor map[string]any `json:"Cursor"`
					Status string         `json:"Status"`
				}
				if json.Unmarshal(scanner.Bytes(), &packet) != nil {
					conn.Close()
					return
				}
				readyOnce.Do(func() { close(ready) })
				if packet.Event != nil && packet.Cursor != nil {
					cursor = packet.Cursor
					emit([]map[string]any{packet.Event})
				}
			}
			conn.Close()
			connected = false
			select {
			case <-closed:
				return
			case <-time.After(time.Duration(retryMs) * time.Millisecond):
			}
		}
	}
	go connect()
	_ = connected
	// A tail subscription must be live before the caller starts editing, or it misses those edits.
	select {
	case <-ready:
	case <-time.After(6 * time.Second):
	}
	return closeFn
}

// startReadOnlyAPI proxies GETs inside a vault with the owner's token, read-only.
func startReadOnlyAPI(api *runAPI, vaultID any) (config map[string]string, close func()) {
	empty := map[string]string{"url": "", "token": ""}
	if api == nil || api.URL == "" || api.Token == "" || vaultID == nil {
		return empty, func() {}
	}
	vault, ok := vaultID.(string)
	if !ok || vault == "" {
		return empty, func() {}
	}
	origin := api.Origin
	if origin == "" {
		origin = api.URL
	}
	if idx := indexOf(origin, "://"); idx >= 0 {
		rest := origin[idx+3:]
		if j := indexOfAny(rest, "/?"); j >= 0 {
			origin = origin[:idx+3] + rest[:j]
		}
	}
	token := randomHex(32)
	prefix := "/api/vaults/" + vault

	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		if r.Header.Get("Authorization") != "Bearer "+token {
			w.WriteHeader(401)
			w.Write([]byte("{}"))
			return
		}
		target := origin + r.URL.RequestURI()
		if r.Method != http.MethodGet || r.URL.Path != prefix && !hasPrefixStr(r.URL.Path, prefix+"/") ||
			containsFold(r.URL.RawPath, "%2f") || containsFold(r.URL.RawPath, "%5c") || contains(r.URL.RawPath, "%00") {
			w.WriteHeader(403)
			w.Write([]byte(`{"error":"Agent-account API access is read-only and vault-scoped. Use the alock bridge for file edits."}`))
			return
		}
		req, err := http.NewRequest(http.MethodGet, target, nil)
		if err != nil {
			w.WriteHeader(502)
			return
		}
		req.Header.Set("Authorization", "Bearer "+api.Token)
		client := &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		resp, err := client.Do(req)
		if err != nil {
			w.WriteHeader(502)
			return
		}
		defer resp.Body.Close()
		if ct := resp.Header.Get("content-type"); ct != "" {
			w.Header().Set("content-type", ct)
		}
		w.WriteHeader(resp.StatusCode)
		var written int64
		buf := make([]byte, 32*1024)
		for {
			n, err := resp.Body.Read(buf)
			if n > 0 {
				written += int64(n)
				if written > 8*1024*1024 {
					return
				}
				w.Write(buf[:n])
			}
			if err != nil {
				break
			}
		}
	})

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return empty, func() {}
	}
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 15 * time.Second}
	go srv.Serve(ln)
	return map[string]string{"url": "http://" + ln.Addr().String(), "token": token}, func() {
		srv.Close()
	}
}

func randomHex(n int) string {
	return hex.EncodeToString(mustRandom(n))
}

func mustRandom(n int) []byte {
	b := make([]byte, n)
	if _, err := io.ReadFull(rand.Reader, b); err != nil {
		seed := time.Now().UnixNano()
		for i := range b {
			seed = seed*6364136223846793005 + 1442695040888963407
			b[i] = byte(seed >> 33)
		}
	}
	return b
}

func indexOf(s, sub string) int {
	return strings.Index(s, sub)
}

func indexOfAny(s, chars string) int {
	return strings.IndexAny(s, chars)
}

func stringsContains(s string, b byte) bool {
	return strings.IndexByte(s, b) >= 0
}

func hasPrefixStr(s, prefix string) bool {
	return strings.HasPrefix(s, prefix)
}

func containsFold(s, sub string) bool {
	return strings.Contains(strings.ToLower(s), strings.ToLower(sub))
}

func contains(s, sub string) bool {
	return strings.Contains(s, sub)
}

func toLower(s string) string {
	return strings.ToLower(s)
}

// ensure workspace path helpers used by run
var _ = filepath.Join
