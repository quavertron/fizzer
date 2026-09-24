package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

type helperRequest struct {
	method, path, runID string
	body                map[string]any
}

type helperServer struct {
	*httptest.Server
	mu       sync.Mutex
	requests []helperRequest
}

func newHelperServer(t *testing.T, handle func(r helperRequest, w http.ResponseWriter)) *helperServer {
	s := &helperServer{}
	s.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, _ := io.ReadAll(r.Body)
		var body map[string]any
		json.Unmarshal(data, &body)
		req := helperRequest{method: r.Method, path: r.URL.RequestURI(), runID: r.Header.Get("x-cascade-run-id"), body: body}
		s.mu.Lock()
		s.requests = append(s.requests, req)
		s.mu.Unlock()
		w.Header().Set("content-type", "application/json")
		handle(req, w)
	}))
	t.Cleanup(s.Close)
	return s
}

func (s *helperServer) calls() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []string
	for _, r := range s.requests {
		out = append(out, r.method+" "+r.path)
	}
	return out
}

func helperEnv(t *testing.T, url string) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("CASCADE_DATA_DIR", dir)
	t.Setenv("CASCADE_HELPER_CONFIG", filepath.Join(dir, "missing-config.json"))
	t.Setenv("CASCADE_NOTE_URL", url)
	t.Setenv("CASCADE_NOTE_TOKEN", "test-token")
	for _, name := range []string{"CASCADE_NOTE_VAULT", "CASCADE_CHAT_CHANNEL", "CASCADE_RUN_ID", "CASCADE_NOTE_USER", "CASCADE_NOTE_PASS",
		"CASCADE_CHAT_AUTHOR", "CASCADE_CHAT_MESSAGE"} {
		t.Setenv(name, "")
	}
}

func runHelperForTest(name string, stdin string, args ...string) (int, string, string) {
	var stdout, stderr bytes.Buffer
	code := runHelper(name, args, strings.NewReader(stdin), &stdout, &stderr)
	return code, stdout.String(), stderr.String()
}

func reply(w http.ResponseWriter, status int, v any) {
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func TestHelperParserKeepsPermissiveValuesAndAliases(t *testing.T) {
	args := parseHelperArgs([]string{"mission", "--json", "list", "--limit", "2", "--limit", "3", "--file", "-", "--priority", "-5", "--unknown", "--status", "open", "-h"}, nil)
	want := map[string]any{"json": true, "limit": "3", "file": "-", "priority": "-5", "unknown": true, "status": "open", "help": true}
	if !reflect.DeepEqual(args.vals, want) || strings.Join(args.pos, ",") != "mission,list" {
		t.Fatalf("got %v %v", args.pos, args.vals)
	}
	args = parseHelperArgs([]string{"--win", "task", "--loss", "--neutral", "--unconsolidated", "tail"}, map[string][2]any{
		"win": {"result", "win"}, "loss": {"result", "loss"}, "neutral": {"result", "neutral"}, "unconsolidated": {"unconsolidated", true}})
	if !reflect.DeepEqual(args.vals, map[string]any{"result": "neutral", "unconsolidated": true}) || strings.Join(args.pos, ",") != "task,tail" {
		t.Fatalf("got %v %v", args.pos, args.vals)
	}
}

func TestHelperJSONFailuresKeepStderrParseable(t *testing.T) {
	helperEnv(t, "http://127.0.0.1:1")
	t.Setenv("CASCADE_NOTE_TOKEN", "")
	for name, command := range map[string]string{"cascade-chat": "history", "cascade-note": "list", "cascade-scratchpad": "journal"} {
		for _, args := range [][]string{{"--json"}, {command, "--json"}} {
			code, stdout, stderr := runHelperForTest(name, "", args...)
			var body struct{ Error map[string]any }
			if code != 1 || stdout != "" || json.Unmarshal([]byte(stderr), &body) != nil {
				t.Fatalf("%s %v: code %d stdout %q stderr %q", name, args, code, stdout, stderr)
			}
			if body.Error["command"] != name || body.Error["code"] != "cli_error" || body.Error["exitCode"] != float64(1) ||
				!strings.ContainsAny(str(body.Error["message"]), "mnv") {
				t.Fatalf("%s: %v", name, body.Error)
			}
		}
		if _, _, stderr := runHelperForTest(name, "", command); !strings.HasPrefix(stderr, name+": no credentials") && !strings.HasPrefix(stderr, name+": missing vault") {
			t.Fatalf("%s: %q", name, stderr)
		}
	}
}

func TestHelperHTTPErrorsKeepStatusAndOrderedDetails(t *testing.T) {
	conflict := `{"error":"Read and reconcile","code":"revision_conflict","currentRevision":4,"changedFields":["status"],"comparison":"submitted_fields_only","limitation":"Historical values unavailable"}`
	var mu sync.Mutex
	var body string
	drop := false
	set := func(b string, d bool) { mu.Lock(); body, drop = b, d; mu.Unlock() }
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		body, drop := body, drop
		mu.Unlock()
		if drop {
			conn, _, _ := w.(http.Hijacker).Hijack()
			conn.Close()
			return
		}
		w.WriteHeader(409)
		io.WriteString(w, body)
	}))
	defer server.Close()
	helperEnv(t, server.URL)
	for name, command := range map[string]string{"cascade-chat": "history", "cascade-note": "list", "cascade-scratchpad": "journal"} {
		args := []string{command, "--token", "fixture", "--vault", "v", "--channel", "c", "--json"}
		for _, text := range []string{conflict, "<html>Unavailable</html>"} {
			set(text, false)
			code, stdout, stderr := runHelperForTest(name, "", args...)
			var parsed struct{ Error map[string]any }
			json.Unmarshal([]byte(stderr), &parsed)
			result := parsed.Error
			wantCode, wantDetails := "http_error", any(map[string]any{"raw": text})
			if text == conflict {
				wantCode = "revision_conflict"
				json.Unmarshal([]byte(conflict), &wantDetails)
			}
			if code != 1 || stdout != "" || result["status"] != float64(409) || result["method"] != "GET" ||
				!strings.HasPrefix(str(result["path"]), "/api/") || result["code"] != wantCode || !reflect.DeepEqual(result["details"], wantDetails) {
				t.Fatalf("%s: %s", name, stderr)
			}
			// Recovery details keep the server's field order in the message.
			if text == conflict && !strings.Contains(stderr, strings.ReplaceAll(conflict, `"`, `\"`)) {
				t.Fatalf("%s: conflict order lost: %s", name, stderr)
			}
		}
		set("", true)
		_, _, stderr := runHelperForTest(name, "", args...)
		set("", false)
		var parsed struct{ Error map[string]any }
		json.Unmarshal([]byte(stderr), &parsed)
		if parsed.Error["command"] != name || parsed.Error["code"] == "cli_error" || !strings.Contains(str(parsed.Error["message"]), "fetch failed") {
			t.Fatalf("%s: %s", name, stderr)
		}
	}
}

func TestNoteRenameAndDeleteByTitle(t *testing.T) {
	title := "Old title"
	server := newHelperServer(t, func(r helperRequest, w http.ResponseWriter) {
		switch {
		case r.method == "GET" && strings.HasPrefix(r.path, "/api/vaults/vault-1/notes?title="):
			reply(w, 200, map[string]any{"notes": []any{map[string]any{"id": "note-1", "title": title}}})
		case r.method == "POST" && r.path == "/api/notes/note-1/rename":
			title = str(r.body["title"])
			reply(w, 200, map[string]any{"note": map[string]any{"id": "note-1", "title": title}})
		case r.method == "GET" && r.path == "/api/notes/note-1":
			reply(w, 200, map[string]any{"note": map[string]any{"id": "note-1", "title": title, "content": "x"}})
		case r.method == "DELETE" && r.path == "/api/notes/note-1":
			reply(w, 200, map[string]any{"ok": true})
		default:
			reply(w, 404, map[string]any{"error": "unexpected"})
		}
	})
	helperEnv(t, server.URL)
	if code, stdout, stderr := runHelperForTest("cascade-note", "", "rename", "Old title", "--title", "New title", "--vault", "vault-1"); code != 0 || stdout != "renamed note-1  New title\n" {
		t.Fatalf("rename: %d %q %q", code, stdout, stderr)
	}
	if code, stdout, stderr := runHelperForTest("cascade-note", "", "delete", "New title", "--vault", "vault-1"); code != 0 || stdout != "deleted note-1  New title\n" {
		t.Fatalf("delete: %d %q %q", code, stdout, stderr)
	}
	want := []string{"GET /api/vaults/vault-1/notes?title=Old%20title", "POST /api/notes/note-1/rename",
		"GET /api/vaults/vault-1/notes?title=New%20title", "GET /api/notes/note-1", "DELETE /api/notes/note-1"}
	if got := server.calls(); !reflect.DeepEqual(got, want) {
		t.Fatalf("calls %q", got)
	}
}

func TestNoteResolvesTyposAndRejectsEmptyBodies(t *testing.T) {
	server := newHelperServer(t, func(r helperRequest, w http.ResponseWriter) {
		switch {
		case strings.Contains(r.path, "?title"):
			reply(w, 200, map[string]any{"notes": []any{}})
		case r.path == "/api/vaults/v/notes":
			reply(w, 200, map[string]any{"notes": []any{map[string]any{"id": "n1", "title": "Navigation & Search"}, map[string]any{"id": "n2", "title": "Release notes"}}})
		case r.path == "/api/notes/n1":
			reply(w, 200, map[string]any{"note": map[string]any{"id": "n1", "content": "found it"}})
		default:
			reply(w, 404, map[string]any{})
		}
	})
	helperEnv(t, server.URL)
	for _, cmd := range []string{"read", "show", "view", "cat", "get"} {
		if code, stdout, _ := runHelperForTest("cascade-note", "", cmd, "nab", "--vault", "v"); code != 0 || stdout != "found it\n" {
			t.Fatalf("%s: %d %q", cmd, code, stdout)
		}
	}
	for _, args := range [][]string{{"create", "--title", "T", "--vault", "v"}, {"create", "--title", "T", "--content", "--vault", "v"}} {
		if code, _, stderr := runHelperForTest("cascade-note", "", args...); code != 1 || !strings.Contains(stderr, "--content") {
			t.Fatalf("%v: %d %q", args, code, stderr)
		}
	}
}

func TestScratchpadJotAndPapercutPayloads(t *testing.T) {
	server := newHelperServer(t, func(r helperRequest, w http.ResponseWriter) {
		reply(w, 200, map[string]any{"entry": map[string]any{"id": 5, "kind": r.body["kind"]}})
	})
	helperEnv(t, server.URL)
	t.Setenv("CASCADE_RUN_ID", "77")
	if code, stdout, stderr := runHelperForTest("cascade-scratchpad", "", "papercut", "tool", "failed", "--vault", "v", "--agent", "@sol"); code != 0 || stdout != "jotted #5 [papercut]\n" {
		t.Fatalf("papercut: %d %q %q", code, stdout, stderr)
	}
	if code, _, _ := runHelperForTest("cascade-scratchpad", "piped body\n", "jot", "--kind", "decision", "--vault", "v"); code != 0 {
		t.Fatal("jot failed")
	}
	if code, _, stderr := runHelperForTest("cascade-scratchpad", "", "jot", "--text", "--vault", "v"); code != 1 || !strings.Contains(stderr, "--text needs a value") {
		t.Fatalf("bare --text: %q", stderr)
	}
	server.mu.Lock()
	defer server.mu.Unlock()
	first, second := server.requests[0], server.requests[1]
	if first.path != "/api/vaults/v/scratchpad/journal" || first.body["body"] != "papercut: tool failed" || first.body["agentKey"] != "sol" || first.body["runId"] != float64(77) {
		t.Fatalf("papercut body %v", first.body)
	}
	if second.body["body"] != "piped body" || second.body["kind"] != "decision" {
		t.Fatalf("jot body %v", second.body)
	}
}

func TestChatSendMarksRunAndDecodesInlineEscapes(t *testing.T) {
	server := newHelperServer(t, func(r helperRequest, w http.ResponseWriter) {
		reply(w, 201, map[string]any{"message": map[string]any{"id": r.body["id"]}})
	})
	helperEnv(t, server.URL)
	config := filepath.Join(t.TempDir(), "run.json")
	os.WriteFile(config, []byte(`{"vaultId":"v","chatChannelId":"c","agentId":"codex","registrationId":"reg-1","chatAuthor":"Terra"}`), 0o600)
	t.Setenv("CASCADE_HELPER_CONFIG", config)
	t.Setenv("CASCADE_RUN_ID", "42")
	code, stdout, stderr := runHelperForTest("cascade-chat", "", "send", "--message", `first\nsecond`)
	if code != 0 || !strings.HasPrefix(stdout, "sent agent-codex-") {
		t.Fatalf("send: %d %q %q", code, stdout, stderr)
	}
	server.mu.Lock()
	sent := server.requests[0]
	server.mu.Unlock()
	if sent.path != "/api/vaults/v/channels/c/messages" || sent.runID != "42" || sent.body["body"] != "first\nsecond" ||
		sent.body["author"] != "Terra" || sent.body["registrationId"] != "reg-1" {
		t.Fatalf("sent %+v", sent)
	}
	var marked map[string]any
	data, _ := os.ReadFile(config)
	json.Unmarshal(data, &marked)
	if marked["usedChatSend"] != true || marked["chatSendCount"] != float64(1) {
		t.Fatalf("config %s", data)
	}
}

func TestChatHistoryWindowsAndReplyContext(t *testing.T) {
	var messages []any
	for i := 1; i <= 20; i++ {
		m := map[string]any{"id": "m" + str(float64(i)), "author": "a", "createdAt": "t", "body": "body " + str(float64(i))}
		if i == 11 {
			m["replyTo"] = map[string]any{"messageId": "m3", "author": "b"}
		}
		messages = append(messages, m)
	}
	server := newHelperServer(t, func(r helperRequest, w http.ResponseWriter) {
		reply(w, 200, map[string]any{"messages": messages})
	})
	helperEnv(t, server.URL)
	code, stdout, _ := runHelperForTest("cascade-chat", "", "history", "--vault", "v", "--channel", "c", "--around-message-id", "m11", "--limit", "3", "--include-reply-context", "--json")
	var out []map[string]any
	json.Unmarshal([]byte(stdout), &out)
	if code != 0 || len(out) != 3 || out[0]["id"] != "m10" || out[2]["id"] != "m12" {
		t.Fatalf("window %s", stdout)
	}
	chain, _ := out[1]["replyContext"].([]any)
	if len(chain) != 1 || asObject(chain[0])["preview"] != "body 3" {
		t.Fatalf("reply context %v", out[1])
	}
	if calls := server.calls(); calls[0] != "GET /api/vaults/v/channels/c/messages?limit=120" {
		t.Fatalf("calls %q", calls)
	}
}

func TestChatRetriesOnlyRefusedLoopbackConnections(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := listener.Addr().String()
	listener.Close() // nothing listens: every attempt is refused
	helperEnv(t, "http://"+addr)
	started := time.Now()
	code, _, stderr := runHelperForTest("cascade-chat", "", "mission", "update", "--task", "t1", "--status", "completed", "--vault", "v", "--channel", "c", "--json")
	var parsed struct{ Error map[string]any }
	json.Unmarshal([]byte(stderr), &parsed)
	// Three attempts with 250ms and 500ms pauses between them.
	if elapsed := time.Since(started); code != 1 || parsed.Error["code"] != "ECONNREFUSED" || elapsed < 700*time.Millisecond || elapsed > 5*time.Second {
		t.Fatalf("code %d elapsed %v stderr %s", code, elapsed, stderr)
	}
}

func TestChatRevisionConflictIsNotRetried(t *testing.T) {
	conflict := `{"error":"Continuation changed; read and reconcile before saving","code":"revision_conflict","currentRevision":4,"changedFields":["status"],"changedFieldsBasis":"submitted_values","changesSinceRevisionKnown":false}`
	server := newHelperServer(t, func(r helperRequest, w http.ResponseWriter) {
		w.WriteHeader(409)
		io.WriteString(w, conflict)
	})
	helperEnv(t, server.URL)
	t.Setenv("CASCADE_NOTE_VAULT", "vault")
	t.Setenv("CASCADE_CHAT_CHANNEL", "channel")
	code, _, stderr := runHelperForTest("cascade-chat", "", "continuation", "--status", "completed", "--revision", "2")
	if code != 1 || !strings.Contains(stderr, conflict) || len(server.calls()) != 1 {
		t.Fatalf("code %d calls %d stderr %s", code, len(server.calls()), stderr)
	}
}

func TestHelperLinksAnswerByName(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CASCADE_AGENT_STATE_DIR", dir)
	links := ensureHelperLinks()
	exe, _ := os.Executable()
	exe, _ = filepath.EvalSymlinks(exe)
	for _, name := range helperNames() {
		if target, err := os.Readlink(filepath.Join(links, name)); err != nil || target != exe {
			t.Fatalf("%s -> %q (%v)", name, target, err)
		}
	}
	if again := ensureHelperLinks(); again != links {
		t.Fatalf("links moved: %s", again)
	}
}
