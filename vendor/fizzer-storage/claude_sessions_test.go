package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestClaudeSessionImport(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, "projects", "-tmp-project")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	id := "12345678-1234-1234-1234-123456789abc"
	var lines []string
	add := func(role string, content any, side bool) {
		b, _ := json.Marshal(map[string]any{"type": role, "sessionId": id, "cwd": "/tmp/project", "timestamp": "2026-09-28T12:00:00Z", "isSidechain": side, "message": map[string]any{"role": role, "content": content}})
		lines = append(lines, string(b)+"\n")
	}
	add("user", "Hello", false)
	add("assistant", []map[string]string{{"type": "thinking", "text": "private reasoning"}, {"type": "text", "text": "Hi"}, {"type": "tool_use", "text": "ignored"}}, false)
	add("user", []map[string]string{{"type": "tool_result", "text": "tool output"}}, false)
	add("assistant", "Sidechain", true)
	for i := 0; i < 200; i++ {
		add("assistant", "More", false)
	}
	path := filepath.Join(dir, id+".jsonl")
	if err := os.WriteFile(path, []byte(strings.Join(lines, "")+`{"type":`), 0600); err != nil {
		t.Fatal(err)
	}
	first, err := readClaudeSession(codexReadOptions{Home: home, ID: id})
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Messages) != 200 || !first.HasMore || first.Messages[0].Body != "Hello" || first.Messages[1].Body != "Hi" || first.Cwd != "/tmp/project" {
		t.Fatalf("Unexpected first page: %#v", first)
	}
	second, err := readClaudeSession(codexReadOptions{Home: home, ID: id, Offset: first.NextOffset, SnapshotEnd: &first.SnapshotEnd})
	if err != nil {
		t.Fatal(err)
	}
	if len(second.Messages) != 2 || second.HasMore || second.Messages[0].Index < first.NextOffset {
		t.Fatalf("Unexpected second page: %#v", second)
	}
	again, err := readClaudeSession(codexReadOptions{Home: home, ID: id})
	if err != nil || again.Messages[1].Index != len(lines[0]) {
		t.Fatal("unstable message IDs", err)
	}
	list, err := listClaudeSessions(codexListOptions{Home: home})
	if err != nil || len(list.Sessions) != 1 || list.Sessions[0].Title != "Hello" {
		t.Fatal(list, err)
	}
	if _, err = readClaudeSession(codexReadOptions{Home: home, ID: "../../escape"}); err == nil {
		t.Fatal("accepted traversal")
	}
	if _, err = readClaudeSession(codexReadOptions{Home: home, ID: id, Offset: 1}); err == nil {
		t.Fatal("accepted mid-record cursor")
	}
}
