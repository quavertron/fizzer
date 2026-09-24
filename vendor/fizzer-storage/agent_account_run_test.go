package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadOnlyAPIKeepsOwnerTokenPrivateAndScopesToVault(t *testing.T) {
	var received []*http.Request
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received = append(received, r)
		w.Header().Set("content-type", "application/json")
		w.Write([]byte(`{"messages":[]}`))
	}))
	defer upstream.Close()
	config, closeProxy := startReadOnlyAPI(&runAPI{URL: upstream.URL, Token: "owner-secret", WriteToken: "human-write-secret"}, "vault-a")
	defer closeProxy()
	if config["token"] == "owner-secret" || strings.Contains(config["token"]+config["url"], "human-write-secret") {
		t.Fatalf("proxy config leaks an owner token: %v", config)
	}
	request := func(method, route string, auth bool) int {
		req, _ := http.NewRequest(method, config["url"]+route, nil)
		if auth {
			req.Header.Set("Authorization", "Bearer "+config["token"])
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	if got := request("GET", "/api/vaults/vault-a/channels?limit=5", true); got != 200 {
		t.Fatalf("in-vault GET: got %d", got)
	}
	for _, c := range [][2]string{{"POST", "/api/vaults/vault-a/notes"}, {"GET", "/api/vaults/vault-b/channels"}, {"GET", "/api/auth/session"}} {
		if got := request(c[0], c[1], true); got != 403 {
			t.Fatalf("%s %s: got %d, want 403", c[0], c[1], got)
		}
	}
	if got := request("GET", "/api/vaults/vault-a", false); got != 401 {
		t.Fatalf("unauthenticated: got %d, want 401", got)
	}
	if len(received) != 1 || received[0].Header.Get("Authorization") != "Bearer owner-secret" || received[0].URL.RawQuery != "limit=5" {
		t.Fatalf("upstream should see one owner-authorized request with its query, got %d", len(received))
	}
}

func terminalStatuses(events []agentRunEvent) []map[string]string {
	var out []map[string]string
	for _, ev := range events {
		if ev.Type != "status" {
			continue
		}
		var payload map[string]string
		json.Unmarshal([]byte(ev.PayloadJSON), &payload)
		out = append(out, payload)
	}
	return out
}

func TestAccountWorkerAuthorAndLaunchNeedNoNode(t *testing.T) {
	for input, want := range map[string]string{"Terra\x07 ": "Terra", "": "codex",
		strings.Repeat("é", 20): strings.Repeat("é", 16)} {
		if got := accountWorkerAuthor(map[string]any{"chatAuthor": input, "agent": "codex"}); got != want {
			t.Fatalf("%q: got %q want %q", input, got, want)
		}
	}
	argv := launchArguments(launchOptions{Socket: "/bridge/socket"})
	tail := strings.Join(argv[len(argv)-2:], " ")
	if tail != "agent-account worker" || strings.Contains(strings.Join(argv, " "), "node") || strings.Contains(strings.Join(argv, " "), "ELECTRON_RUN_AS_NODE") {
		t.Fatalf("argv %q", argv)
	}
}

func TestAccountRunMissingVaultFailsBeforeBridge(t *testing.T) {
	t.Setenv("CASCADE_DATA_DIR", t.TempDir())
	var events []agentRunEvent
	_, err := runAccountOrchestrated(runInput{Opts: map[string]any{
		"runId": float64(1507), "vaultRoot": filepath.Join(t.TempDir(), "missing"),
	}}, func(ev agentRunEvent) { events = append(events, ev) })
	if err == nil {
		t.Fatal("expected missing vault to fail")
	}
	statuses := terminalStatuses(events)
	if len(events) != 1 || events[0].RunID != 1507 || len(statuses) != 1 || statuses[0]["status"] != "failed" {
		t.Fatalf("want one failed status for run 1507, got %+v", events)
	}
}

func TestAccountRunReportsIncompatibleBridge(t *testing.T) {
	for _, tc := range []struct {
		stderr, want string
	}{
		{"usage:\n alock bridge serve --socket <path>", "Installed alock is outdated"},
		{"alock: unknown command", "older alock daemon"},
	} {
		t.Run(tc.want, func(t *testing.T) {
			dir := t.TempDir()
			t.Setenv("CASCADE_DATA_DIR", dir)
			bin := filepath.Join(dir, "alock")
			script := "#!/bin/sh\necho '" + tc.stderr + "' >&2\nexit 2\n"
			if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
				t.Fatal(err)
			}
			t.Setenv("FIZZER_ALOCK_BIN", bin)
			var events []agentRunEvent
			_, err := runAccountOrchestrated(runInput{Opts: map[string]any{"runId": float64(123)}, Root: dir},
				func(ev agentRunEvent) { events = append(events, ev) })
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("want error containing %q, got %v", tc.want, err)
			}
			statuses := terminalStatuses(events)
			if len(statuses) == 0 || statuses[len(statuses)-1]["status"] != "failed" {
				t.Fatalf("want a failed terminal status, got %+v", events)
			}
		})
	}
}
