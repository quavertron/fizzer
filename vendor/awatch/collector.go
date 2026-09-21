package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

type watchCursor struct {
	Epoch string
	Seq   uint64
}
type watchPacket struct {
	Cursor watchCursor
	Event  *EditEvent
	Status string
}

func ensureAlock() (string, error) {
	binary := os.Getenv("FIZZER_ALOCK_BIN")
	if binary == "" {
		if executable, err := os.Executable(); err == nil {
			sibling := filepath.Join(filepath.Dir(executable), "alock")
			if _, err := os.Stat(sibling); err == nil {
				binary = sibling
			}
		}
	}
	if binary == "" {
		binary = "alock"
	}
	output, err := exec.Command(binary, "events", "--ensure").CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("%s: %s", err, output)
	}
	var ready struct {
		Socket string `json:"socket"`
	}
	if err := json.Unmarshal(output, &ready); err != nil {
		return "", err
	}
	if ready.Socket == "" {
		return "", fmt.Errorf("alock did not report its socket")
	}
	return ready.Socket, nil
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
		conn, err := net.DialTimeout("unix", path, 250*time.Millisecond)
		if err != nil {
			if time.Now().After(nextStart) {
				if ready, startErr := ensureAlock(); startErr != nil {
					report("Cannot connect to alock activity: " + startErr.Error())
				} else {
					path = ready
					report("Connecting to alock activity…")
				}
				nextStart = time.Now().Add(2 * time.Second)
			}
		} else {
			stop := context.AfterFunc(ctx, func() { conn.Close() })
			request, _ := json.Marshal(map[string]any{"cmd": "watch", "cursor": cursor})
			received := false
			conn.SetReadDeadline(time.Now().Add(5 * time.Second))
			frame := make([]byte, 4+len(request))
			binary.LittleEndian.PutUint32(frame, uint32(len(request)))
			copy(frame[4:], request)
			conn.SetWriteDeadline(time.Now().Add(time.Second))
			if _, err = conn.Write(frame); err == nil {
				decoder := json.NewDecoder(conn)
				for {
					var packet watchPacket
					if err = decoder.Decode(&packet); err != nil {
						break
					}
					received = true
					conn.SetReadDeadline(time.Time{})
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
			if !received && time.Now().After(nextStart) {
				if ready, startErr := ensureAlock(); startErr != nil {
					report("Cannot connect to alock activity: " + startErr.Error())
				} else {
					path = ready
				}
				nextStart = time.Now().Add(2 * time.Second)
			}
			if ctx.Err() == nil {
				report("Reconnecting to alock activity…")
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(250 * time.Millisecond):
		}
	}
}
