package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

var claudeSessionID = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func claudeProjects(home string) (string, error) {
	if home == "" {
		home = os.Getenv("CLAUDE_CONFIG_DIR")
	}
	if home == "" {
		h, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		home = filepath.Join(h, ".claude")
	}
	return filepath.Join(home, "projects"), nil
}

// Only direct project transcripts are importable, never subagent transcripts.
func claudeFiles(home, id string) ([]string, error) {
	root, err := claudeProjects(home)
	if err != nil {
		return nil, err
	}
	if id != "*" && !claudeSessionID.MatchString(id) {
		return nil, fmt.Errorf("Invalid Claude session ID")
	}
	paths, err := filepath.Glob(filepath.Join(root, "*", id+".jsonl"))
	if err != nil {
		return nil, err
	}
	safe := []string{}
	for _, p := range paths {
		if !claudeSessionID.MatchString(strings.TrimSuffix(filepath.Base(p), ".jsonl")) {
			continue
		}
		info, e := os.Lstat(p)
		if e != nil || !info.Mode().IsRegular() {
			continue
		}
		parent, e := os.Lstat(filepath.Dir(p))
		if e != nil || !parent.IsDir() || parent.Mode()&os.ModeSymlink != 0 {
			continue
		}
		safe = append(safe, p)
	}
	return safe, nil
}

func claudeText(raw json.RawMessage) string {
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return text
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &blocks) != nil {
		return ""
	}
	parts := []string{}
	for _, b := range blocks {
		if b.Type == "text" && b.Text != "" {
			parts = append(parts, b.Text)
		}
	}
	return strings.Join(parts, "\n")
}

func readClaudeSession(opts codexReadOptions) (*codexPage, error) {
	if opts.Offset < 0 {
		return nil, fmt.Errorf("Invalid history cursor")
	}
	paths, err := claudeFiles(opts.Home, opts.ID)
	if err != nil {
		return nil, err
	}
	if len(paths) != 1 {
		return nil, fmt.Errorf("Claude session not found or ambiguous")
	}
	f, err := os.Open(paths[0])
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	end := info.Size()
	if opts.SnapshotEnd != nil && *opts.SnapshotEnd < end {
		end = *opts.SnapshotEnd
	}
	if int64(opts.Offset) > end || end < 0 {
		return nil, fmt.Errorf("Invalid history cursor")
	}
	page := &codexPage{ID: opts.ID, Title: "Claude session", Messages: []codexMessage{}, SnapshotEnd: end, NextOffset: opts.Offset}
	if opts.Offset > 0 {
		b := []byte{0}
		if _, err = f.ReadAt(b, int64(opts.Offset-1)); err != nil || b[0] != '\n' {
			return nil, fmt.Errorf("Invalid history cursor")
		}
	}
	if _, err = f.Seek(int64(opts.Offset), io.SeekStart); err != nil {
		return nil, err
	}
	reader := bufio.NewReader(io.LimitReader(f, end-int64(opts.Offset)))
	for len(page.Messages) < 200 && page.NextOffset-opts.Offset < 1024*1024 {
		// Limit individual records so corrupt or huge tool output cannot exhaust memory.
		var line []byte
		for {
			part, e := reader.ReadSlice('\n')
			line = append(line, part...)
			if len(line) > 8*1024*1024 {
				return nil, fmt.Errorf("Claude history record exceeds 8 MiB")
			}
			if e == bufio.ErrBufferFull {
				continue
			}
			if e == io.EOF {
				page.HasMore = false
				return page, nil
			}
			if e != nil {
				return nil, e
			}
			break
		}
		index := page.NextOffset
		page.NextOffset += len(line)
		var event struct {
			Type      string `json:"type"`
			SessionID string `json:"sessionId"`
			Cwd       string `json:"cwd"`
			Timestamp string `json:"timestamp"`
			Sidechain bool   `json:"isSidechain"`
			Message   struct {
				Role    string          `json:"role"`
				Content json.RawMessage `json:"content"`
			} `json:"message"`
		}
		if json.Unmarshal(line, &event) != nil || event.Sidechain || (event.SessionID != "" && event.SessionID != opts.ID) {
			continue
		}
		if event.Cwd != "" {
			page.Cwd = event.Cwd
		}
		if event.Type != "user" && event.Type != "assistant" {
			continue
		}
		if event.Message.Role != event.Type {
			continue
		}
		text := claudeText(event.Message.Content)
		if strings.TrimSpace(text) == "" {
			continue
		}
		if _, e := time.Parse(time.RFC3339Nano, event.Timestamp); e != nil {
			continue
		}
		if len(text) > 1024*1024 {
			return nil, fmt.Errorf("Claude message exceeds 1 MiB")
		}
		if page.Title == "Claude session" && event.Type == "user" {
			title := []rune(text)
			if len(title) > 120 {
				title = title[:120]
			}
			page.Title = string(title)
		}
		page.Messages = append(page.Messages, codexMessage{Index: index, Role: event.Type, Body: text, CreatedAt: event.Timestamp})
	}
	page.HasMore = int64(page.NextOffset) < end
	return page, nil
}

func listClaudeSessions(opts codexListOptions) (*codexSessionList, error) {
	if opts.Offset < 0 {
		return nil, fmt.Errorf("Invalid history offset")
	}
	paths, err := claudeFiles(opts.Home, "*")
	if err != nil {
		return nil, err
	}
	type entry struct {
		path     string
		modified time.Time
	}
	entries := []entry{}
	for _, p := range paths {
		if s, e := os.Stat(p); e == nil {
			entries = append(entries, entry{p, s.ModTime()})
		}
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].modified.Equal(entries[j].modified) {
			return entries[i].path < entries[j].path
		}
		return entries[i].modified.After(entries[j].modified)
	})
	result := &codexSessionList{Sessions: []codexSession{}}
	for i := opts.Offset; i < len(entries); i++ {
		id := strings.TrimSuffix(filepath.Base(entries[i].path), ".jsonl")
		page, e := readClaudeSession(codexReadOptions{Home: opts.Home, ID: id})
		if e != nil {
			continue
		}
		if opts.Search != "" && !strings.Contains(strings.ToLower(page.Title+" "+page.Cwd), strings.ToLower(opts.Search)) {
			continue
		}
		result.Sessions = append(result.Sessions, codexSession{ID: id, Title: page.Title, Cwd: page.Cwd, UpdatedAt: entries[i].modified.Format(time.RFC3339Nano)})
		if len(result.Sessions) == 50 {
			if i+1 < len(entries) {
				next := i + 1
				result.NextOffset = &next
			}
			break
		}
	}
	return result, nil
}

func ClaudeSessionsCLI(args []string) int {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "Usage: fizzer-storage claude-sessions <list|read> [json]")
		return 1
	}
	arg := ""
	if len(args) > 1 {
		arg = args[1]
	}
	var result any
	var err error
	switch args[0] {
	case "list":
		var opts codexListOptions
		if err = readCodexJSON(arg, &opts); err == nil {
			result, err = listClaudeSessions(opts)
		}
	case "read":
		var opts codexReadOptions
		if err = readCodexJSON(arg, &opts); err == nil {
			result, err = readClaudeSession(opts)
		}
	default:
		err = fmt.Errorf("Unknown Claude session operation")
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if err = json.NewEncoder(os.Stdout).Encode(result); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}
