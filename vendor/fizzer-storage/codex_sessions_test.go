package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func codexEvent(role, text string) string {
	b, _ := json.Marshal(map[string]any{
		"type":      "response_item",
		"timestamp": "2026-09-01T00:00:00Z",
		"payload": map[string]any{
			"type":    "message",
			"role":    role,
			"content": []map[string]any{{"text": text}},
		},
	})
	return string(b)
}

func TestCodexSessionsRoundTrip(t *testing.T) {
	home := t.TempDir()
	rollout := filepath.Join(home, "rollout.jsonl")
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(filepath.Join(home, "state_5.sqlite")))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE threads(id TEXT, title TEXT, cwd TEXT, updated_at INTEGER, rollout_path TEXT)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO threads VALUES (?,?,?,?,?)`,
		"selected", "My session", "/tmp/work", 123, rollout); err != nil {
		t.Fatal(err)
	}
	db.Close()

	write := func(content string) {
		if err := os.WriteFile(rollout, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	appendRollout := func(content string) {
		f, err := os.OpenFile(rollout, os.O_APPEND|os.O_WRONLY, 0)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.WriteString(content); err != nil {
			t.Fatal(err)
		}
		f.Close()
	}

	write(codexEvent("developer", "private instructions") + "\n" + codexEvent("user", "héllo") + "\n" + codexEvent("assistant", "answer"))

	list, err := listCodexSessions(codexListOptions{Home: home})
	if err != nil {
		t.Fatal(err)
	}
	if len(list.Sessions) != 1 {
		t.Fatalf("sessions = %d, want 1", len(list.Sessions))
	}

	first, err := readCodexSession(codexReadOptions{Home: home, ID: "selected"})
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Messages) != 1 || first.Messages[0].Body != "héllo" {
		t.Fatalf("first messages = %+v", first.Messages)
	}
	next, err := readCodexSession(codexReadOptions{Home: home, ID: "selected", Offset: first.NextOffset})
	if err != nil {
		t.Fatal(err)
	}
	if len(next.Messages) != 0 {
		t.Fatalf("expected no messages, got %+v", next.Messages)
	}

	appendRollout("\n")
	second, err := readCodexSession(codexReadOptions{Home: home, ID: "selected", Offset: first.NextOffset})
	if err != nil {
		t.Fatal(err)
	}
	if len(second.Messages) != 1 || second.Messages[0].Body != "answer" {
		t.Fatalf("second messages = %+v", second.Messages)
	}
	if second.Messages[0].Index != first.NextOffset {
		t.Fatalf("index = %d, want %d", second.Messages[0].Index, first.NextOffset)
	}

	if _, err := readCodexSession(codexReadOptions{Home: home, ID: "../rollout"}); err == nil || err.Error() != "Codex session no longer exists." {
		t.Fatalf("missing session err = %v", err)
	}

	appendRollout(`{"type":"event_msg","payload":{"type":"task_started"}}` + "\n")
	if err := assertCodexSessionIdle(codexIdleOptions{Home: home, ID: "selected"}); err == nil {
		t.Fatal("expected busy session error")
	}
	appendRollout(`{"type":"event_msg","payload":{"type":"task_complete"}}` + "\n")
	if err := assertCodexSessionIdle(codexIdleOptions{Home: home, ID: "selected"}); err != nil {
		t.Fatal(err)
	}

	var lines []string
	for i := 0; i < 201; i++ {
		lines = append(lines, codexEvent("assistant", fmt.Sprintf("message %d", i)))
	}
	write(strings.Join(lines, "\n") + "\n")
	batch, err := readCodexSession(codexReadOptions{Home: home, ID: "selected"})
	if err != nil {
		t.Fatal(err)
	}
	if len(batch.Messages) != 200 || !batch.HasMore {
		t.Fatalf("batch len=%d hasMore=%v", len(batch.Messages), batch.HasMore)
	}
	appendRollout(codexEvent("assistant", "added after snapshot") + "\n")
	snapshotEnd := batch.SnapshotEnd
	last, err := readCodexSession(codexReadOptions{
		Home: home, ID: "selected", Offset: batch.NextOffset, SnapshotEnd: &snapshotEnd,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(last.Messages) != 1 || last.Messages[0].Body != "message 200" || last.HasMore {
		t.Fatalf("last = %+v hasMore=%v", last.Messages, last.HasMore)
	}
}
