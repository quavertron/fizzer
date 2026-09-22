package main

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	_ "modernc.org/sqlite"
)

type codexListOptions struct {
	Home   string `json:"home"`
	Offset int    `json:"offset"`
	Search string `json:"search"`
}

type codexReadOptions struct {
	Home        string `json:"home"`
	ID          string `json:"id"`
	Offset      int    `json:"offset"`
	SnapshotEnd *int64 `json:"snapshotEnd"`
}

type codexIdleOptions struct {
	Home string `json:"home"`
	ID   string `json:"id"`
}

type codexSession struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Cwd       string `json:"cwd"`
	UpdatedAt any    `json:"updated_at"`
}

type codexSessionList struct {
	Sessions   []codexSession `json:"sessions"`
	NextOffset *int           `json:"nextOffset"`
}

type codexMessage struct {
	Index     int   `json:"index"`
	Role      string `json:"role"`
	Body      string `json:"body"`
	CreatedAt any   `json:"createdAt,omitempty"`
}

type codexPage struct {
	ID          string         `json:"id"`
	Title       string         `json:"title"`
	Cwd         string         `json:"cwd"`
	Messages    []codexMessage `json:"messages"`
	NextOffset  int            `json:"nextOffset"`
	SnapshotEnd int64          `json:"snapshotEnd"`
	HasMore     bool           `json:"hasMore"`
}

type codexThread struct {
	ID          string
	Title       string
	Cwd         string
	RolloutPath string
}

func codexHome(home string) (string, error) {
	if home != "" {
		return home, nil
	}
	if root := os.Getenv("CODEX_HOME"); root != "" {
		return root, nil
	}
	userHome, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(userHome, ".codex"), nil
}

func openCodexDB(home string) (*sql.DB, error) {
	root, err := codexHome(home)
	if err != nil {
		return nil, err
	}
	dsn := "file:" + filepath.ToSlash(filepath.Join(root, "state_5.sqlite")) + "?mode=ro"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

func listCodexSessions(opts codexListOptions) (*codexSessionList, error) {
	db, err := openCodexDB(opts.Home)
	if err != nil {
		return nil, err
	}
	defer db.Close()
	start := opts.Offset
	if start < 0 {
		start = 0
	}
	search := opts.Search
	if runes := []rune(search); len(runes) > 200 {
		search = string(runes[:200])
	}
	rows, err := db.Query(`SELECT id, title, cwd, updated_at FROM threads
		WHERE title LIKE ? ORDER BY updated_at DESC, id LIMIT 51 OFFSET ?`,
		"%"+search+"%", start)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var matches []codexSession
	for rows.Next() {
		var session codexSession
		if err := rows.Scan(&session.ID, &session.Title, &session.Cwd, &session.UpdatedAt); err != nil {
			return nil, err
		}
		matches = append(matches, session)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	result := &codexSessionList{Sessions: []codexSession{}}
	if len(matches) > 50 {
		result.Sessions = matches[:50]
		next := start + 50
		result.NextOffset = &next
	} else {
		result.Sessions = matches
	}
	return result, nil
}

func readCodexThread(home, id string) (*codexThread, error) {
	db, err := openCodexDB(home)
	if err != nil {
		return nil, err
	}
	var thread codexThread
	err = db.QueryRow(`SELECT id, title, cwd, rollout_path FROM threads WHERE id=?`, id).
		Scan(&thread.ID, &thread.Title, &thread.Cwd, &thread.RolloutPath)
	db.Close()
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("Codex session no longer exists.")
	}
	if err != nil {
		return nil, err
	}
	return &thread, nil
}

func readCodexSession(opts codexReadOptions) (*codexPage, error) {
	if opts.ID == "" || opts.Offset < 0 {
		return nil, fmt.Errorf("Invalid Codex session or cursor.")
	}
	if opts.SnapshotEnd != nil && (*opts.SnapshotEnd < int64(opts.Offset)) {
		return nil, fmt.Errorf("Codex history changed; import it again.")
	}
	thread, err := readCodexThread(opts.Home, opts.ID)
	if err != nil {
		return nil, err
	}
	file, err := os.Open(thread.RolloutPath)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	size := info.Size()
	if opts.SnapshotEnd != nil && *opts.SnapshotEnd > size {
		return nil, fmt.Errorf("Codex history changed; import it again.")
	}
	limit := size
	if opts.SnapshotEnd != nil {
		limit = *opts.SnapshotEnd
	}
	if int64(opts.Offset) > size {
		return nil, fmt.Errorf("Codex history changed; import it again.")
	}
	readLen := int64(1024 * 1024)
	if remaining := limit - int64(opts.Offset); remaining < readLen {
		readLen = remaining
	}
	if readLen < 0 {
		readLen = 0
	}
	if _, err := file.Seek(int64(opts.Offset), io.SeekStart); err != nil {
		return nil, err
	}
	buffer := make([]byte, readLen)
	n, err := io.ReadFull(file, buffer)
	if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
		return nil, err
	}
	buffer = buffer[:n]
	end := bytes.LastIndexByte(buffer, '\n') + 1
	if end == 0 && len(buffer) == 1024*1024 {
		return nil, fmt.Errorf("A Codex history entry exceeds the 1 MB import limit.")
	}
	position := opts.Offset
	nextOffset := opts.Offset
	messages := []codexMessage{}
	for _, line := range bytes.Split(buffer[:end], []byte{'\n'}) {
		start := position
		position += len(line) + 1
		if len(line) == 0 {
			continue
		}
		nextOffset = position
		var event struct {
			Type      string          `json:"type"`
			Timestamp any             `json:"timestamp"`
			Payload   json.RawMessage `json:"payload"`
		}
		if err := json.Unmarshal(line, &event); err != nil {
			continue
		}
		if event.Type != "response_item" {
			continue
		}
		var item struct {
			Type    string `json:"type"`
			Role    string `json:"role"`
			Content any    `json:"content"`
		}
		if err := json.Unmarshal(event.Payload, &item); err != nil {
			continue
		}
		if item.Type != "message" || (item.Role != "user" && item.Role != "assistant") {
			continue
		}
		body := ""
		if parts, ok := item.Content.([]any); ok {
			texts := make([]string, len(parts))
			for i, part := range parts {
				if m, ok := part.(map[string]any); ok {
					if text, ok := m["text"].(string); ok {
						texts[i] = text
					}
				}
			}
			body = strings.Join(texts, "\n")
		}
		if strings.TrimSpace(body) != "" {
			messages = append(messages, codexMessage{
				Index:     start,
				Role:      item.Role,
				Body:      body,
				CreatedAt: event.Timestamp,
			})
		}
		if len(messages) >= 200 {
			break
		}
	}
	return &codexPage{
		ID:          thread.ID,
		Title:       thread.Title,
		Cwd:         thread.Cwd,
		Messages:    messages,
		NextOffset:  nextOffset,
		SnapshotEnd: limit,
		HasMore:     nextOffset < int(limit) && nextOffset > opts.Offset,
	}, nil
}

func readCodexTail(path string, maxBytes int64) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	start := int64(0)
	if info.Size() > maxBytes {
		start = info.Size() - maxBytes
	}
	if _, err := file.Seek(start, io.SeekStart); err != nil {
		return nil, err
	}
	return io.ReadAll(file)
}

func codexTurnIsActive(rolloutPath string) bool {
	if rolloutPath == "" {
		return false
	}
	tail, err := readCodexTail(rolloutPath, 8_000_000)
	if err != nil {
		return false
	}
	lines := bytes.Split(tail, []byte{'\n'})
	for i := len(lines) - 1; i >= 0; i-- {
		if len(lines[i]) == 0 {
			continue
		}
		var event struct {
			Type    string `json:"type"`
			Payload *struct {
				Type string `json:"type"`
			} `json:"payload"`
		}
		if err := json.Unmarshal(lines[i], &event); err != nil {
			continue
		}
		if event.Type != "event_msg" || event.Payload == nil {
			continue
		}
		if event.Payload.Type == "task_complete" {
			return false
		}
		if event.Payload.Type == "task_started" {
			return true
		}
	}
	return false
}

func assertCodexSessionIdle(opts codexIdleOptions) error {
	if opts.ID == "" {
		return fmt.Errorf("Invalid Codex session or cursor.")
	}
	thread, err := readCodexThread(opts.Home, opts.ID)
	if err != nil {
		return err
	}
	if codexTurnIsActive(thread.RolloutPath) {
		return fmt.Errorf("This Codex session is still working elsewhere. Wait for its turn to finish before continuing in Fizzer.")
	}
	return nil
}

func readCodexJSON(arg string, dest any) error {
	var data []byte
	if arg == "-" {
		var err error
		data, err = io.ReadAll(os.Stdin)
		if err != nil {
			return err
		}
	} else if arg == "" {
		data = []byte("{}")
	} else {
		data = []byte(arg)
	}
	return json.Unmarshal(data, dest)
}

func CodexSessionsCLI(args []string) int {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "Usage: fizzer-storage codex-sessions <list|read|assert-idle> [json]")
		return 1
	}
	var payload any
	var err error
	switch args[0] {
	case "list":
		var opts codexListOptions
		arg := ""
		if len(args) > 1 {
			arg = args[1]
		}
		if err = readCodexJSON(arg, &opts); err == nil {
			var result *codexSessionList
			result, err = listCodexSessions(opts)
			payload = result
		}
	case "read":
		var opts codexReadOptions
		arg := ""
		if len(args) > 1 {
			arg = args[1]
		}
		if err = readCodexJSON(arg, &opts); err == nil {
			var result *codexPage
			result, err = readCodexSession(opts)
			payload = result
		}
	case "assert-idle":
		var opts codexIdleOptions
		arg := ""
		if len(args) > 1 {
			arg = args[1]
		}
		if err = readCodexJSON(arg, &opts); err == nil {
			err = assertCodexSessionIdle(opts)
			payload = map[string]bool{"ok": err == nil}
		}
	default:
		fmt.Fprintln(os.Stderr, "unknown codex-sessions subcommand:", args[0])
		return 1
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		return 1
	}
	out, err := json.Marshal(payload)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		return 1
	}
	os.Stdout.Write(out)
	return 0
}
