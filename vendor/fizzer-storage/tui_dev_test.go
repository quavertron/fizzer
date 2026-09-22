package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestTuiHealthURLDefaultsToLoopback3000(t *testing.T) {
	t.Setenv("API_PORT", "")
	if got := tuiHealthURL(); got != "http://127.0.0.1:3000/api/health" {
		t.Fatalf("health url = %s", got)
	}
	t.Setenv("API_PORT", "4010")
	if got := tuiHealthURL(); got != "http://127.0.0.1:4010/api/health" {
		t.Fatalf("health url = %s", got)
	}
}

func TestDevSessionStartsTUIOnlyAfterHealth(t *testing.T) {
	ready := time.Now().Add(250 * time.Millisecond)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if time.Now().Before(ready) {
			http.Error(w, "booting", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	}))
	defer server.Close()

	dir := t.TempDir()
	logPath := filepath.Join(dir, "backend.log")
	var tuiStarted time.Time
	code, err := runDevSession(context.Background(), devSession{
		healthURL: server.URL + "/api/health",
		logPath:   logPath,
		timeout:   5 * time.Second,
		startBackend: func() (*exec.Cmd, error) {
			cmd := exec.Command("sleep", "30")
			detachProcess(cmd)
			return cmd, cmd.Start()
		},
		startTUI: func() (*exec.Cmd, error) {
			tuiStarted = time.Now()
			cmd := exec.Command("sh", "-c", "exit 0")
			return cmd, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if code != 0 {
		t.Fatalf("exit code %d", code)
	}
	if tuiStarted.Before(ready) {
		t.Fatalf("tui started at %s before backend was healthy at %s", tuiStarted, ready)
	}
}

func TestDevSessionSkipsTUIWhenBackendExits(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "backend.log")
	started := false
	_, err := runDevSession(context.Background(), devSession{
		healthURL: "http://127.0.0.1:9/api/health",
		logPath:   logPath,
		timeout:   5 * time.Second,
		startBackend: func() (*exec.Cmd, error) {
			cmd := exec.Command("sh", "-c", "echo mix failed >&2; exit 9")
			log, openErr := os.OpenFile(logPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
			if openErr != nil {
				return nil, openErr
			}
			cmd.Stderr = log
			detachProcess(cmd)
			err := cmd.Start()
			log.Close()
			return cmd, err
		},
		startTUI: func() (*exec.Cmd, error) {
			started = true
			return exec.Command("sh", "-c", "exit 0"), nil
		},
	})
	if err == nil {
		t.Fatal("expected backend failure")
	}
	if started {
		t.Fatal("tui started after the backend exited")
	}
	if !strings.Contains(err.Error(), "code=9") || !strings.Contains(err.Error(), "mix failed") {
		t.Fatalf("error = %s", err)
	}
}

func TestSignalGroupDoesNotKillCaller(t *testing.T) {
	cmd := exec.Command("sleep", "30")
	detachProcess(cmd)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	exited := make(chan struct{})
	go func() {
		_ = cmd.Wait()
		close(exited)
	}()
	signalGroup(cmd, syscall.SIGTERM)
	select {
	case <-exited:
	case <-time.After(3 * time.Second):
		t.Fatal("sleep did not exit")
	}
	if os.Getpid() == cmd.Process.Pid {
		t.Fatal("killed the caller")
	}
}
