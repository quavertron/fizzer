package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestNormalizeOrigin(t *testing.T) {
	cases := []struct {
		input    string
		expected string
	}{
		{"https://server0.example", "https://server0.example"},
		{"https://server.example:443", "https://server.example"},
		{"http://server.example:80", "http://server.example"},
		{"https://server.example:8443", "https://server.example:8443"},
		{"http://[::1]:8080/path?query#hash", "http://[::1]:8080"},
		{"http://[::1]:80", "http://[::1]"},
	}

	for _, c := range cases {
		got, err := NormalizeOrigin(c.input)
		if err != nil {
			t.Fatalf("NormalizeOrigin(%q) failed: %v", c.input, err)
		}
		if got != c.expected {
			t.Errorf("NormalizeOrigin(%q) = %q, expected %q", c.input, got, c.expected)
		}
	}
}

func TestRemoteVaults(t *testing.T) {
	dir, err := os.MkdirTemp("", "fizzer-vaults-test-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)

	legacy := []RemoteVaultRecord{
		{ID: "legacy", Name: "Legacy", Origin: "https://legacy.example", Token: "original"},
	}
	legacyData, _ := json.Marshal(legacy)
	if err := os.WriteFile(filepath.Join(dir, "remote-vaults.json"), legacyData, 0600); err != nil {
		t.Fatal(err)
	}

	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			rec := RemoteVaultRecord{
				ID:     fmt.Sprintf("vault-%d", n),
				Name:   "Test",
				Origin: "https://example.com",
				Token:  fmt.Sprintf("token-%d", n),
			}
			if err := SaveRemoteVault(dir, rec); err != nil {
				t.Errorf("SaveRemoteVault failed: %v", err)
			}
		}(i)
	}
	wg.Wait()

	records, err := ReadRemoteVaults(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 51 {
		t.Fatalf("expected 51 records, got %d", len(records))
	}

	// Update legacy record
	updated := RemoteVaultRecord{
		ID:     "legacy",
		Name:   "Legacy Updated",
		Origin: "https://legacy.example",
		Token:  "updated-token",
	}
	if err := SaveRemoteVault(dir, updated); err != nil {
		t.Fatal(err)
	}

	records, err = ReadRemoteVaults(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 51 {
		t.Fatalf("expected 51 records, got %d", len(records))
	}

	var found *RemoteVaultRecord
	for _, r := range records {
		if r.ID == "legacy" {
			found = &r
			break
		}
	}
	if found == nil || found.Token != "updated-token" {
		t.Fatalf("expected updated token, got %+v", found)
	}

	// Check file permissions in remote-vaults/
	entries, _ := os.ReadDir(filepath.Join(dir, "remote-vaults"))
	for _, e := range entries {
		info, err := e.Info()
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0600 {
			t.Errorf("file %s has mode %o, expected 0600", e.Name(), info.Mode().Perm())
		}
	}
}

func TestServerSessions(t *testing.T) {
	dir, err := os.MkdirTemp("", "fizzer-sessions-test-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)

	legacy := map[string]string{"local": "legacy"}
	legacyData, _ := json.Marshal(legacy)
	if err := os.WriteFile(filepath.Join(dir, "server-sessions.json"), legacyData, 0600); err != nil {
		t.Fatal(err)
	}

	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			origin := fmt.Sprintf("https://server%d.example", n)
			token := fmt.Sprintf("token-%d", n)
			if err := RememberSession(dir, origin, token); err != nil {
				t.Errorf("RememberSession failed: %v", err)
			}
		}(i)
	}
	wg.Wait()

	sessions, err := ReadSessions(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 51 {
		t.Fatalf("expected 51 sessions, got %d", len(sessions))
	}

	// Update local session
	if err := RememberSession(dir, "local", "updated-local"); err != nil {
		t.Fatal(err)
	}

	sessions, err = ReadSessions(dir)
	if err != nil {
		t.Fatal(err)
	}
	if sessions["local"] != "updated-local" {
		t.Fatalf("expected 'updated-local', got %q", sessions["local"])
	}

	entries, _ := os.ReadDir(filepath.Join(dir, "server-sessions"))
	for _, e := range entries {
		info, err := e.Info()
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0600 {
			t.Errorf("file %s has mode %o, expected 0600", e.Name(), info.Mode().Perm())
		}
	}
}

func TestListConnections(t *testing.T) {
	dir, err := os.MkdirTemp("", "fizzer-connections-test-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)

	if err := RememberSession(dir, "local", "local-token"); err != nil {
		t.Fatal(err)
	}
	if err := RememberSession(dir, "https://remote.example", "remote-token"); err != nil {
		t.Fatal(err)
	}

	conns, err := ListConnections(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(conns) != 1 || conns[0].Origin != "https://remote.example" || conns[0].Name != "Remote server" {
		t.Fatalf("unexpected connections: %+v", conns)
	}

	vault := RemoteVaultRecord{
		ID:     "v1",
		Name:   "My Vault",
		Origin: "https://remote.example",
		Token:  "tok",
	}
	conns, err = ListConnections(dir, []RemoteVaultRecord{vault})
	if err != nil {
		t.Fatal(err)
	}
	if len(conns) != 1 || conns[0].ID != "v1" || conns[0].Name != "My Vault" {
		t.Fatalf("unexpected connections with vault: %+v", conns)
	}
}
