package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const loginRenewalWindowSeconds = 3 * 24 * 60 * 60

func fizzerDir() string {
	if dir := os.Getenv("CASCADE_DATA_DIR"); dir != "" {
		return dir
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	primary := filepath.Join(home, ".fizzer")
	if info, err := os.Stat(primary); err == nil && info.IsDir() {
		return primary
	}
	legacy := filepath.Join(home, ".cascade")
	if info, err := os.Stat(legacy); err == nil && info.IsDir() {
		return legacy
	}
	return primary
}

func tokenPath() string {
	if p := os.Getenv("CASCADE_TOKEN_PATH"); p != "" {
		return p
	}
	return filepath.Join(fizzerDir(), "token")
}

func decodeTokenExp(token string) int64 {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return 0
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		payload, err = base64.URLEncoding.DecodeString(parts[1])
		if err != nil {
			return 0
		}
	}
	var body struct {
		Exp *int64 `json:"exp"`
	}
	if err := json.Unmarshal(payload, &body); err != nil || body.Exp == nil {
		return 0
	}
	return *body.Exp
}

func readTrimmed(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

func resolveToken() string {
	candidates := []string{
		os.Getenv("CASCADE_TOKEN"),
		readTrimmed(tokenPath()),
	}
	if sessions, err := ReadSessions(fizzerDir()); err == nil {
		candidates = append(candidates, sessions["local"])
	}
	seen := map[string]bool{}
	unique := make([]string, 0, 3)
	for _, c := range candidates {
		c = strings.TrimSpace(c)
		if c == "" || seen[c] {
			continue
		}
		seen[c] = true
		unique = append(unique, c)
	}
	if len(unique) == 0 {
		return ""
	}
	now := time.Now().Unix()
	fresh := make([]string, 0, len(unique))
	for _, c := range unique {
		if decodeTokenExp(c) > now {
			fresh = append(fresh, c)
		}
	}
	pool := fresh
	if len(pool) == 0 {
		pool = unique
	}
	best := pool[0]
	bestExp := decodeTokenExp(best)
	for _, c := range pool[1:] {
		exp := decodeTokenExp(c)
		if exp > bestExp {
			best, bestExp = c, exp
		}
	}
	return best
}

func parseRenewedSessionCookie(setCookies []string) string {
	best := ""
	var bestExp int64
	for _, line := range setCookies {
		pair := line
		if i := strings.Index(pair, ";"); i >= 0 {
			pair = pair[:i]
		}
		eq := strings.Index(pair, "=")
		if eq <= 0 {
			continue
		}
		name := strings.TrimSpace(pair[:eq])
		if name != "cascade_session" && name != "__Host-cascade_session" {
			continue
		}
		value, err := url.QueryUnescape(strings.TrimSpace(pair[eq+1:]))
		if err != nil {
			value = strings.TrimSpace(pair[eq+1:])
		}
		exp := decodeTokenExp(value)
		if value != "" && exp >= bestExp {
			best, bestExp = value, exp
		}
	}
	return best
}

func persistToken(token string) error {
	next := strings.TrimSpace(token)
	if next == "" {
		return nil
	}
	file := tokenPath()
	if readTrimmed(file) != next {
		if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
			return err
		}
		if err := os.WriteFile(file, []byte(next+"\n"), 0o600); err != nil {
			return err
		}
		os.Chmod(file, 0o600)
	}
	sessions, err := ReadSessions(fizzerDir())
	if err != nil {
		sessions = map[string]string{}
	}
	if strings.TrimSpace(sessions["local"]) != next {
		if err := RememberSession(fizzerDir(), "local", next); err != nil {
			return err
		}
	}
	return nil
}

func adoptToken(active *string) string {
	next := resolveToken()
	if next == "" {
		return ""
	}
	now := time.Now().Unix()
	prevExp := decodeTokenExp(*active)
	fileExp := decodeTokenExp(readTrimmed(tokenPath()))
	if fileExp < decodeTokenExp(next) {
		_ = persistToken(next)
	}
	if next != *active {
		*active = next
		if prevExp > 0 && prevExp <= now && decodeTokenExp(next) > now {
			logf("Runner login was stale. Using the current local session.")
		}
	}
	return *active
}

func refreshLogin(apiBase, token string) {
	now := time.Now().Unix()
	exp := decodeTokenExp(token)
	if token == "" || exp <= now || exp-now > int64(loginRenewalWindowSeconds) {
		return
	}
	req, err := http.NewRequest(http.MethodGet, strings.TrimRight(apiBase, "/")+"/api/session", nil)
	if err != nil {
		return
	}
	escaped := url.QueryEscape(token)
	req.Header.Set("Cookie", fmt.Sprintf("cascade_session=%s; __Host-cascade_session=%s", escaped, escaped))
	client := &http.Client{Timeout: 30 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		errorLogf("Login refresh failed: %v", err)
		return
	}
	defer res.Body.Close()
	renewed := parseRenewedSessionCookie(res.Header.Values("Set-Cookie"))
	if renewed != "" && decodeTokenExp(renewed) > exp {
		_ = persistToken(renewed)
		logf("Renewed the runner login before it expired.")
	}
}
