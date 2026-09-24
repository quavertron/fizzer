//go:build unix

package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

// TestMain lets the test binary act as a fake `codex app-server` when it is
// invoked through a symlink named codex.
func TestMain(m *testing.M) {
	if filepath.Base(os.Args[0]) == "codex" && os.Getenv("FAKE_CODEX_DIR") != "" {
		fakeCodexAppServer(os.Getenv("FAKE_CODEX_DIR"))
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func appendLine(file, line string) {
	f, err := os.OpenFile(file, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err == nil {
		f.WriteString(line + "\n")
		f.Close()
	}
}

func fakeCodexAppServer(dir string) {
	appendLine(filepath.Join(dir, "launches"), "1")
	var mu sync.Mutex
	send := func(v any) {
		data, _ := json.Marshal(v)
		mu.Lock()
		os.Stdout.Write(append(data, '\n'))
		mu.Unlock()
	}
	thread, turn := 0, 0
	interrupted := map[string]bool{}
	retryTurns := map[string]*time.Timer{}
	var stateMu sync.Mutex
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 1<<20), 1<<24)
	for scanner.Scan() {
		var message map[string]any
		if json.Unmarshal(scanner.Bytes(), &message) != nil {
			continue
		}
		method := str(message["method"])
		params := asObject(message["params"])
		id := message["id"]
		threadID := str(params["threadId"])
		if method == "thread/start" || method == "thread/resume" {
			appendLine(filepath.Join(dir, "configs"), jsonString(params["config"]))
		}
		appendLine(filepath.Join(dir, "protocol"), method+":"+threadID)
		stateMu.Lock()
		switch method {
		case "initialize":
			send(map[string]any{"id": id, "result": map[string]any{}})
		case "thread/start":
			thread++
			send(map[string]any{"id": id, "result": map[string]any{"thread": map[string]any{"id": fmt.Sprintf("thread-%d", thread)}}})
		case "thread/resume":
			if threadID == "thread-locked" || (threadID == "thread-stale" && !interrupted["stale-turn"]) {
				send(map[string]any{"id": id, "error": map[string]any{"message": "thread " + threadID + " already has an active writer"}})
			} else {
				send(map[string]any{"id": id, "result": map[string]any{"thread": map[string]any{"id": threadID}}})
			}
		case "thread/read":
			turns := []any{}
			if threadID == "thread-stale" && !interrupted["stale-turn"] {
				turns = append(turns, map[string]any{"id": "stale-turn", "status": "inProgress", "items": []any{}})
			}
			send(map[string]any{"id": id, "result": map[string]any{"thread": map[string]any{"id": threadID, "turns": turns}}})
		case "turn/interrupt":
			turnID := str(params["turnId"])
			interrupted[turnID] = true
			if timer := retryTurns[turnID]; timer != nil {
				timer.Stop()
				send(map[string]any{"method": "turn/completed", "params": map[string]any{"turn": map[string]any{"id": turnID, "status": "interrupted"}}})
			}
			send(map[string]any{"id": id, "result": map[string]any{}})
		case "thread/unsubscribe":
			send(map[string]any{"id": id, "result": map[string]any{"status": "unsubscribed"}})
		case "turn/start":
			if threadID == "thread-raced" {
				send(map[string]any{"id": id, "error": map[string]any{"message": "thread already has an active writer"}})
				break
			}
			turn++
			turnID := fmt.Sprintf("turn-%d", turn)
			current := turn
			input, _ := params["input"].([]any)
			prompt := str(asObject(input[0])["text"])
			note := func(method string, p map[string]any) { send(map[string]any{"method": method, "params": p}) }
			switch prompt {
			case "retry succeeds", "retry fails", "retry stop", "retry exits", "fatal error", "stale events":
				send(map[string]any{"id": id, "result": map[string]any{"turn": map[string]any{"id": turnID}}})
				if prompt == "stale events" {
					note("item/completed", map[string]any{"threadId": threadID, "turnId": "old-turn", "item": map[string]any{"id": "old-answer", "type": "agentMessage", "text": "STALE"}})
					note("error", map[string]any{"threadId": threadID, "turnId": "old-turn", "willRetry": false, "error": map[string]any{"message": "old failure"}})
					note("item/completed", map[string]any{"threadId": "other-thread", "turnId": turnID, "item": map[string]any{"id": "foreign-answer", "type": "agentMessage", "text": "FOREIGN"}})
				} else {
					note("error", map[string]any{"threadId": threadID, "turnId": turnID, "willRetry": prompt != "fatal error", "error": map[string]any{"message": "Reconnecting... 1/5"}})
					if prompt == "fatal error" {
						break
					}
				}
				retryTurns[turnID] = time.AfterFunc(150*time.Millisecond, func() {
					switch prompt {
					case "retry exits":
						os.Exit(9)
					case "retry fails":
						note("turn/completed", map[string]any{"threadId": threadID, "turn": map[string]any{"id": turnID, "status": "failed", "error": map[string]any{"message": "Retries exhausted"}}})
					default:
						note("item/completed", map[string]any{"threadId": threadID, "turnId": turnID, "item": map[string]any{"id": "answer", "type": "agentMessage", "text": "Recovered answer"}})
						note("turn/completed", map[string]any{"threadId": threadID, "turn": map[string]any{"id": turnID, "status": "completed"}})
					}
				})
			case "stream tokens":
				// A notification can race the turn/start response; keep those tokens too.
				note("item/agentMessage/delta", map[string]any{"turnId": turnID, "itemId": "progress", "delta": "Checking"})
				send(map[string]any{"id": id, "result": map[string]any{"turn": map[string]any{"id": turnID}}})
				time.AfterFunc(200*time.Millisecond, func() {
					note("item/agentMessage/delta", map[string]any{"turnId": turnID, "itemId": "progress", "delta": " files"})
					note("item/completed", map[string]any{"turnId": turnID, "item": map[string]any{"id": "progress", "type": "agentMessage", "text": "Checking files."}})
					note("item/agentMessage/delta", map[string]any{"turnId": turnID, "itemId": "final", "delta": ""})
					note("item/agentMessage/delta", map[string]any{"turnId": turnID, "itemId": "final", "delta": "Fixed"})
					note("item/agentMessage/delta", map[string]any{"turnId": turnID, "itemId": "final", "delta": " it."})
					note("item/completed", map[string]any{"turnId": turnID, "item": map[string]any{"id": "final", "type": "agentMessage", "text": "Fixed it."}})
					note("item/completed", map[string]any{"turnId": turnID, "item": map[string]any{"id": "final", "type": "agentMessage", "text": "Fixed it."}})
					note("turn/completed", map[string]any{"turn": map[string]any{"id": turnID, "status": "completed"}})
				})
			default:
				send(map[string]any{"id": id, "result": map[string]any{"turn": map[string]any{"id": turnID}}})
				if prompt == "empty turn" {
					note("turn/completed", map[string]any{"turn": map[string]any{"id": turnID, "status": "completed"}})
					break
				}
				note("item/started", map[string]any{"turnId": turnID, "item": map[string]any{"id": "reason-" + turnID, "type": "reasoning"}})
				note("item/completed", map[string]any{"turnId": turnID, "item": map[string]any{"id": "reason-" + turnID, "type": "reasoning", "summary": []any{"Thinking"}}})
				note("item/started", map[string]any{"turnId": turnID, "item": map[string]any{"id": "answer-" + turnID, "type": "agentMessage"}})
				note("item/completed", map[string]any{"turnId": turnID, "item": map[string]any{"id": "answer-" + turnID, "type": "agentMessage", "text": fmt.Sprintf("answer %d", current)}})
				note("turn/completed", map[string]any{"turn": map[string]any{"id": turnID, "status": "completed"}})
			}
		}
		stateMu.Unlock()
	}
}

func appServerFixture(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(dir, "codex")
	if err := os.Symlink(exe, bin); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CODEX_BIN", bin)
	t.Setenv("RUNNER_CODEX_PERSISTENT", "1")
	t.Setenv("FAKE_CODEX_DIR", dir)
	t.Cleanup(codexServer.shutdown)
	return dir
}

func readLog(dir, name string) string {
	data, _ := os.ReadFile(filepath.Join(dir, name))
	return string(data)
}

func appOpts(dir, prompt string) cliAgentOpts {
	return cliAgentOpts{agent: "codex", prompt: prompt, cwd: dir, env: os.Environ(), emit: (&eventLog{}).emit}
}

func TestCodexAppServerIsReusedAcrossTurns(t *testing.T) {
	dir := appServerFixture(t)
	log := &eventLog{}
	o := appOpts(dir, "first")
	o.emit, o.remoteVault = log.emit, true
	first, err := runCliAgent(o)
	if err != nil {
		t.Fatal(err)
	}
	o = appOpts(dir, "second")
	o.resumeID = first.sessionID
	second, err := runCliAgent(o)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(log.phases(), ","); got != "request_start,first_response,completion" {
		t.Fatalf("phases %s", got)
	}
	if first.summary != "answer 1" || second.summary != "answer 2" {
		t.Fatalf("summaries %q %q", first.summary, second.summary)
	}
	configs := strings.Split(strings.TrimSpace(readLog(dir, "configs")), "\n")
	var c0, c1 map[string]any
	json.Unmarshal([]byte(configs[0]), &c0)
	json.Unmarshal([]byte(configs[1]), &c1)
	if markers, ok := c0["project_root_markers"].([]any); !ok || len(markers) != 0 {
		t.Fatalf("remote config %v", c0)
	}
	if _, ok := c1["project_root_markers"]; ok {
		t.Fatalf("local config %v", c1)
	}
	var types []string
	for _, b := range log.blocks("text") {
		types = append(types, str(b["type"]))
	}
	if strings.Join(types, ",") != "thinking,text" {
		t.Fatalf("blocks %v", types)
	}
	if launches := strings.Count(readLog(dir, "launches"), "1"); launches != 1 {
		t.Fatalf("launches %d", launches)
	}
	waitFor(t, func() bool { return strings.Contains(readLog(dir, "protocol"), "thread/unsubscribe:thread-1") })
}

func TestCodexAppServerStreamsTokensWithoutDuplicates(t *testing.T) {
	dir := appServerFixture(t)
	var mu sync.Mutex
	var chunks []string
	log := &eventLog{hook: func(ev recordedEvent) {
		if ev.kind == "text" && ev.payload["chatVisible"] == true {
			content, _ := asObject(ev.payload["message"])["content"].([]any)
			mu.Lock()
			chunks = append(chunks, str(asObject(content[0])["text"]))
			mu.Unlock()
		}
	}}
	o := appOpts(dir, "stream tokens")
	o.emit = log.emit
	result, err := runCliAgent(o)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"Checking", " files", ".", "\n\nFixed", " it."}
	if strings.Join(chunks, "|") != strings.Join(want, "|") || result.summary != "Fixed it." {
		t.Fatalf("chunks %q summary %q", chunks, result.summary)
	}
}

func TestCodexAppServerInterruptsUnfinishedWriter(t *testing.T) {
	dir := appServerFixture(t)
	o := appOpts(dir, "recover stale turn")
	o.resumeID = "thread-stale"
	result, err := runCliAgent(o)
	if err != nil || result.sessionID != "thread-stale" || result.summary != "answer 1" {
		t.Fatalf("result %+v err %v", result, err)
	}
	protocol := readLog(dir, "protocol")
	if !strings.Contains(protocol, "thread/read:thread-stale") || !strings.Contains(protocol, "turn/interrupt:thread-stale") {
		t.Fatalf("protocol %s", protocol)
	}
}

func TestCodexAppServerLockedThreadFallsBackToFresh(t *testing.T) {
	dir := appServerFixture(t)
	log := &eventLog{}
	o := appOpts(dir, "escape locked thread")
	o.resumeID, o.emit = "thread-locked", log.emit
	result, err := runCliAgent(o)
	if err != nil || result.sessionID != "thread-1" || !strings.Contains(log.harness(), "continuing in a fresh session") {
		t.Fatalf("result %+v err %v", result, err)
	}
}

func TestCodexAppServerImportedSessionsNeverInterrupt(t *testing.T) {
	dir := appServerFixture(t)
	start := len(readLog(dir, "protocol"))
	imported := func(id string) (cliAgentResult, error) {
		o := appOpts(dir, "continue imported session")
		o.resumeID, o.env = id, append(os.Environ(), "CASCADE_IMPORTED_CODEX_SESSION="+id)
		return runCliAgent(o)
	}
	if result, err := imported("thread-imported"); err != nil || result.sessionID != "thread-imported" {
		t.Fatalf("result %+v err %v", result, err)
	}
	for _, id := range []string{"thread-locked", "thread-raced"} {
		if _, err := imported(id); err == nil || !regexp.MustCompile(`(?i)active writer`).MatchString(err.Error()) {
			t.Fatalf("%s: err %v", id, err)
		}
	}
	protocol := readLog(dir, "protocol")[start:]
	if !strings.Contains(protocol, "turn/start:thread-imported") || regexp.MustCompile(`turn/interrupt|thread/start`).MatchString(protocol) {
		t.Fatalf("protocol %s", protocol)
	}
}

func TestCodexAppServerEmptyTurnHasNoFirstResponse(t *testing.T) {
	dir := appServerFixture(t)
	log := &eventLog{}
	o := appOpts(dir, "empty turn")
	o.emit = log.emit
	if _, err := runCliAgent(o); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(log.phases(), ","); got != "request_start,completion" {
		t.Fatalf("phases %s", got)
	}
}

func TestCodexAppServerTerminalOwnership(t *testing.T) {
	for _, prompt := range []string{"retry succeeds", "retry fails", "retry stop", "retry exits", "fatal error", "stale events"} {
		t.Run(prompt, func(t *testing.T) {
			dir := appServerFixture(t)
			start := len(readLog(dir, "protocol"))
			log := &eventLog{}
			log.hook = func(ev recordedEvent) {
				if ev.kind == "harness" && strings.Contains(str(ev.payload["data"]), "Reconnecting") {
					if strings.Contains(readLog(dir, "protocol")[start:], "thread/unsubscribe") {
						t.Error("unsubscribed during a retry")
					}
					if prompt == "retry stop" && !cancelCliRun(98765) {
						t.Error("cancel returned false")
					}
				}
			}
			o := appOpts(dir, prompt)
			o.resumeID, o.runID, o.emit = "thread-retry", 98765, log.emit
			result, err := runCliAgent(o)
			wantErr := map[string]string{"retry exits": "app-server exited", "retry fails": "Retries exhausted", "retry stop": "interrupted", "fatal error": "Reconnecting"}[prompt]
			if wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), wantErr) {
					t.Fatalf("err %v", err)
				}
			} else {
				if err != nil || result.summary != "Recovered answer" || result.sessionID != "thread-retry" {
					t.Fatalf("result %+v err %v", result, err)
				}
				var text strings.Builder
				for _, b := range log.blocks("text") {
					text.WriteString(str(b["text"]))
				}
				if text.String() != "Recovered answer" {
					t.Fatalf("text %q", text.String())
				}
			}
			if strings.HasPrefix(prompt, "retry ") && !strings.Contains(log.harness(), "Reconnecting") {
				t.Fatal("retry progress missing")
			}
			var outcomes []string
			for _, ev := range log.all() {
				if ev.kind == "timing" && ev.payload["phase"] == "completion" {
					outcomes = append(outcomes, str(ev.payload["outcome"]))
				}
			}
			want := "failed"
			switch prompt {
			case "retry succeeds", "stale events":
				want = "completed"
			case "retry stop":
				want = "interrupted"
			}
			if len(outcomes) != 1 || outcomes[0] != want {
				t.Fatalf("outcomes %v want %s", outcomes, want)
			}
			wantUnsubscribes := 1
			if prompt == "retry exits" {
				wantUnsubscribes = 0
			}
			waitFor(t, func() bool {
				return strings.Count(readLog(dir, "protocol")[start:], "thread/unsubscribe:") >= wantUnsubscribes
			})
			time.Sleep(30 * time.Millisecond)
			protocol := readLog(dir, "protocol")[start:]
			if strings.Count(protocol, "turn/start:") != 1 || strings.Count(protocol, "thread/unsubscribe:") != wantUnsubscribes {
				t.Fatalf("protocol %s", protocol)
			}
		})
	}
}
