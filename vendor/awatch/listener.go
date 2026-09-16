package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"syscall"
	"time"
)

// Only remove stale sockets. In particular, another awatch must never steal
// the pathname from an existing live listener.
func openEventListener(path string) (*net.UnixListener, os.FileInfo, error) {
	info, err := os.Lstat(path)
	if err == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return nil, nil, fmt.Errorf("%s exists and is not a socket", path)
		}
		conn, dialErr := net.DialTimeout("unix", path, 250*time.Millisecond)
		if dialErr == nil {
			conn.Close()
			return nil, nil, fmt.Errorf("another awatch is already listening on %s", path)
		}
		if !errors.Is(dialErr, syscall.ECONNREFUSED) && !errors.Is(dialErr, os.ErrNotExist) {
			return nil, nil, dialErr
		}
		current, statErr := os.Lstat(path)
		if statErr == nil && os.SameFile(info, current) {
			if err := os.Remove(path); err != nil {
				return nil, nil, err
			}
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, nil, err
	}
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		return nil, nil, err
	}
	ln.SetUnlinkOnClose(false)
	info, err = os.Lstat(path)
	if err != nil {
		ln.Close()
		return nil, nil, err
	}
	return ln, info, nil
}

func removeOwnedSocket(path string, owned os.FileInfo) {
	info, err := os.Lstat(path)
	if err == nil && owned != nil && os.SameFile(owned, info) {
		os.Remove(path)
	}
}

// Recheck the pathname after idle periods/wake, and retry failures instead of
// silently abandoning Accept. Existing connections can finish independently.
func runEventListener(ctx context.Context, path string, ln *net.UnixListener, owned os.FileInfo, events chan<- EditEvent, status chan string, interval time.Duration) {
	runSocketListener(ctx, path, ln, owned, status, interval, func(ctx context.Context, conn net.Conn) {
		handleConnContext(ctx, conn, events)
	})
}

func runSocketListener(ctx context.Context, path string, ln *net.UnixListener, owned os.FileInfo, status chan string, interval time.Duration, handle func(context.Context, net.Conn)) {
	defer func() {
		if ln != nil {
			ln.Close()
			removeOwnedSocket(path, owned)
		}
	}()
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
	nextCheck := time.Now()
	for ctx.Err() == nil {
		if ln != nil && !time.Now().Before(nextCheck) {
			info, err := os.Lstat(path)
			if err != nil || !os.SameFile(info, owned) {
				ln.Close()
				ln = nil
			}
			nextCheck = time.Now().Add(interval)
		}
		if ln == nil {
			var err error
			ln, owned, err = openEventListener(path)
			if err != nil {
				report("reconnecting: " + err.Error())
				select {
				case <-ctx.Done():
					return
				case <-time.After(interval):
				}
				continue
			}
			report("")
			nextCheck = time.Now().Add(interval)
		}
		ln.SetDeadline(nextCheck)
		conn, err := ln.Accept()
		if err != nil {
			if timeout, ok := err.(net.Error); ok && timeout.Timeout() {
				continue
			}
			report("reconnecting: " + err.Error())
			ln.Close()
			removeOwnedSocket(path, owned)
			ln = nil
			select {
			case <-ctx.Done():
				return
			case <-time.After(interval):
			}
			continue
		}
		go func() {
			stop := context.AfterFunc(ctx, func() { conn.Close() })
			defer stop()
			handle(ctx, conn)
		}()
	}
}
