package main

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func jwtForExp(t *testing.T, exp int64) string {
	t.Helper()
	body, err := json.Marshal(map[string]any{"exp": exp, "id": 2, "access": "user"})
	if err != nil {
		t.Fatal(err)
	}
	return "e30." + base64.RawURLEncoding.EncodeToString(body) + ".sig"
}

func TestRunnerLoginPrefersNewestUnexpiredCredential(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CASCADE_DATA_DIR", dir)
	t.Setenv("CASCADE_TOKEN_PATH", filepath.Join(dir, "token"))
	t.Setenv("CASCADE_TOKEN", "")

	now := time.Now().Unix()
	expired := jwtForExp(t, now-3600)
	current := jwtForExp(t, now+7*24*60*60)
	if err := os.WriteFile(tokenPath(), []byte(expired+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := RememberSession(dir, "local", current); err != nil {
		t.Fatal(err)
	}
	got := resolveToken()
	if got != current {
		t.Fatalf("resolveToken() = %q, want %q", got, current)
	}
	if decodeTokenExp(got) <= now {
		t.Fatalf("expected unexpired token, exp=%d now=%d", decodeTokenExp(got), now)
	}

	longerFile := jwtForExp(t, now+2*24*60*60)
	shorterSession := jwtForExp(t, now+60*60)
	if err := os.WriteFile(tokenPath(), []byte(longerFile+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := RememberSession(dir, "local", shorterSession); err != nil {
		t.Fatal(err)
	}
	got = resolveToken()
	if got != longerFile {
		t.Fatalf("resolveToken() = %q, want %q", got, longerFile)
	}
}

func TestSessionRenewalKeepsCookieThatExpiresLatest(t *testing.T) {
	now := time.Now().Unix()
	older := jwtForExp(t, now+60)
	newer := jwtForExp(t, now+7*24*60*60)
	chosen := parseRenewedSessionCookie([]string{
		"cascade_session=" + older + "; Path=/; HttpOnly",
		"__Host-cascade_session=" + newer + "; Path=/; HttpOnly; Secure",
	})
	if chosen != newer {
		t.Fatalf("parseRenewedSessionCookie() = %q, want %q", chosen, newer)
	}
}
