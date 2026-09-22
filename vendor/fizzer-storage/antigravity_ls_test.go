package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestDiscoveryEndpointRequiresLivePIDAndPort(t *testing.T) {
	if _, ok := discoveryEndpoint(lsDiscovery{PID: 0, HTTPPort: 1, CSRFToken: "x"}); ok {
		t.Fatal("pid 0 must not be considered alive")
	}
	if _, ok := discoveryEndpoint(lsDiscovery{PID: os.Getpid(), HTTPPort: 1, CSRFToken: ""}); ok {
		t.Fatal("missing csrf must be rejected")
	}
}

func TestReadDiscoveryFilesParsesDaemonJSON(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("ANTIGRAVITY_HOME", dir)
	daemon := filepath.Join(dir, "antigravity", "daemon")
	if err := os.MkdirAll(daemon, 0o755); err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(lsDiscovery{PID: 42, HTTPPort: 9, CSRFToken: "abc"})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(daemon, "ls_test.json"), payload, 0o600); err != nil {
		t.Fatal(err)
	}
	found := readDiscoveryFiles()
	if len(found) != 1 || found[0].CSRFToken != "abc" || found[0].PID != 42 {
		t.Fatalf("unexpected discovery parse: %+v", found)
	}
}

func TestEnsureReturnsEndpointOrError(t *testing.T) {
	// With a temp home and no LS binary, ensure must fail cleanly rather than hang forever.
	// If a real LS is already running on the machine, ensure may succeed — both are valid.
	t.Setenv("ANTIGRAVITY_HOME", t.TempDir())
	t.Setenv("ANTIGRAVITY_LS_BIN", filepath.Join(t.TempDir(), "missing-language_server"))
	endpoint, err := EnsureAntigravityLS()
	if err != nil {
		if endpoint.Address != "" || endpoint.CSRF != "" {
			t.Fatalf("endpoint must be empty on error: %+v", endpoint)
		}
		return
	}
	if endpoint.Address == "" || endpoint.CSRF == "" {
		t.Fatalf("expected address and csrf, got %+v", endpoint)
	}
}
