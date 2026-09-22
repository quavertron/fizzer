package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"
)

const tuiDevTimeout = 5 * time.Minute

type devSession struct {
	repo         string
	healthURL    string
	logPath      string
	timeout      time.Duration
	startBackend func() (*exec.Cmd, error)
	startTUI     func() (*exec.Cmd, error)
}

func RunTuiDev() int {
	repo, err := findRepoRoot()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	logPath := filepath.Join(repo, "tui", "backend.log")
	healthURL := tuiHealthURL()
	fmt.Fprintf(os.Stderr, "Starting the Elixir backend. The TUI opens once %s is up.\n", healthURL)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	code, err := runDevSession(ctx, devSession{
		repo:         repo,
		healthURL:    healthURL,
		logPath:      logPath,
		timeout:      tuiDevTimeout,
		startBackend: func() (*exec.Cmd, error) { return startMixBackend(repo, logPath) },
		startTUI:     func() (*exec.Cmd, error) { return startCargoTUI(repo) },
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		if ctx.Err() != nil {
			return 130
		}
		return 1
	}
	return code
}

func tuiHealthURL() string {
	port := os.Getenv("API_PORT")
	if port == "" {
		port = "3000"
	}
	return "http://127.0.0.1:" + port + "/api/health"
}

func findRepoRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		backend := filepath.Join(dir, "backend_elixir", "mix.exs")
		tui := filepath.Join(dir, "tui", "Cargo.toml")
		if fileExists(backend) && fileExists(tui) {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("run fizzer-storage tui from the fizzer repository")
		}
		dir = parent
	}
}

func backendEnv() []string {
	if os.Getenv("CASCADE_DATA_DIR") != "" {
		return os.Environ()
	}
	home, err := os.UserHomeDir()
	if err != nil {
		home = os.Getenv("HOME")
	}
	return append(os.Environ(), "CASCADE_DATA_DIR="+filepath.Join(home, ".fizzer"))
}

func startMixBackend(repo, logPath string) (*exec.Cmd, error) {
	dotenv := filepath.Join(repo, "node_modules", ".bin", "dotenv")
	if !fileExists(dotenv) {
		return nil, fmt.Errorf("dotenv not found at %s", dotenv)
	}
	if err := os.MkdirAll(filepath.Dir(logPath), 0o755); err != nil {
		return nil, err
	}
	log, err := os.OpenFile(logPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return nil, err
	}
	defer log.Close()
	cmd := exec.Command(dotenv, "--", "sh", "-c", "cd backend_elixir && exec mix run --no-halt")
	cmd.Dir = repo
	cmd.Env = backendEnv()
	cmd.Stdout = log
	cmd.Stderr = log
	detachProcess(cmd)
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return cmd, nil
}

func startCargoTUI(repo string) (*exec.Cmd, error) {
	cmd := exec.Command("cargo", "run", "--locked", "--manifest-path", "tui/Cargo.toml", "--bin", "fizzer")
	cmd.Dir = repo
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd, nil
}

func runDevSession(ctx context.Context, session devSession) (int, error) {
	backend, err := session.startBackend()
	if err != nil {
		return 1, err
	}
	exited := make(chan struct{})
	go func() {
		_ = backend.Wait()
		close(exited)
	}()
	defer stopProcessGroup(backend, exited)

	if err := waitForBackend(ctx, backend, exited, session); err != nil {
		return 1, err
	}
	tui, err := session.startTUI()
	if err != nil {
		return 1, err
	}
	if err := tui.Start(); err != nil {
		return 1, err
	}
	tuiDone := make(chan error, 1)
	go func() { tuiDone <- tui.Wait() }()
	select {
	case <-ctx.Done():
		_ = tui.Process.Signal(os.Interrupt)
		<-tuiDone
		return 130, fmt.Errorf("stopped")
	case err := <-tuiDone:
		if err != nil {
			if exit, ok := err.(*exec.ExitError); ok {
				return exit.ExitCode(), nil
			}
			return 1, err
		}
		return 0, nil
	}
}

func waitForBackend(ctx context.Context, backend *exec.Cmd, exited <-chan struct{}, session devSession) error {
	deadline := time.NewTimer(session.timeout)
	defer deadline.Stop()
	ticker := time.NewTicker(150 * time.Millisecond)
	defer ticker.Stop()
	client := &http.Client{Timeout: time.Second}
	var last error
	for {
		if ctx.Err() != nil {
			return fmt.Errorf("stopped before the Elixir backend was healthy")
		}
		select {
		case <-exited:
			return backendFailed(backend, session.logPath)
		default:
		}
		if err := checkHealth(client, session.healthURL); err == nil {
			select {
			case <-exited:
				return backendFailed(backend, session.logPath)
			default:
				return nil
			}
		} else {
			last = err
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("stopped before the Elixir backend was healthy")
		case <-exited:
			return backendFailed(backend, session.logPath)
		case <-deadline.C:
			tail := readTail(session.logPath)
			return fmt.Errorf("Elixir backend did not become healthy at %s within %s: %v\nSee %s\n%s", session.healthURL, session.timeout, last, session.logPath, tail)
		case <-ticker.C:
		}
	}
}

func checkHealth(client *http.Client, url string) error {
	response, err := client.Get(url)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return err
	}
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("status %s", response.Status)
	}
	var payload struct {
		Status string `json:"status"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return err
	}
	if payload.Status != "ok" {
		return fmt.Errorf("health status %q", payload.Status)
	}
	return nil
}

func backendFailed(backend *exec.Cmd, logPath string) error {
	code := "unknown"
	if backend.ProcessState != nil {
		code = fmt.Sprint(backend.ProcessState.ExitCode())
	}
	return fmt.Errorf("Elixir backend exited before it was healthy (code=%s).\nSee %s\n%s", code, logPath, readTail(logPath))
}

func readTail(path string) string {
	file, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return ""
	}
	const max = 4000
	offset := int64(0)
	if info.Size() > max {
		offset = info.Size() - max
	}
	if _, err := file.Seek(offset, io.SeekStart); err != nil {
		return ""
	}
	buf, err := io.ReadAll(file)
	if err != nil {
		return ""
	}
	return string(buf)
}

func stopProcessGroup(cmd *exec.Cmd, exited <-chan struct{}) {
	signalGroup(cmd, syscall.SIGTERM)
	select {
	case <-exited:
		return
	case <-time.After(2 * time.Second):
		signalGroup(cmd, syscall.SIGKILL)
		<-exited
	}
}
