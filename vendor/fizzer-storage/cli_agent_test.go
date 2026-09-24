//go:build unix

package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// ── fixtures ──────────────────────────────────────────────────

type recordedEvent struct {
	kind    string
	payload map[string]any
}

type eventLog struct {
	mu     sync.Mutex
	events []recordedEvent
	hook   func(recordedEvent)
}

func (l *eventLog) emit(kind, payload string) {
	var v map[string]any
	_ = json.Unmarshal([]byte(payload), &v)
	ev := recordedEvent{kind, v}
	l.mu.Lock()
	l.events = append(l.events, ev)
	hook := l.hook
	l.mu.Unlock()
	if hook != nil {
		hook(ev)
	}
}

func (l *eventLog) all() []recordedEvent {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]recordedEvent{}, l.events...)
}

func (l *eventLog) harness() string {
	var out strings.Builder
	for _, ev := range l.all() {
		if ev.kind == "harness" {
			out.WriteString(str(ev.payload["data"]))
		}
	}
	return out.String()
}

func (l *eventLog) blocks(kind string) []map[string]any {
	var out []map[string]any
	for _, ev := range l.all() {
		if ev.kind != kind {
			continue
		}
		content, _ := asObject(ev.payload["message"])["content"].([]any)
		for _, block := range content {
			out = append(out, asObject(block))
		}
	}
	return out
}

func (l *eventLog) phases() []string {
	var out []string
	for _, ev := range l.all() {
		if ev.kind == "timing" {
			out = append(out, str(ev.payload["phase"]))
		}
	}
	return out
}

func writeScript(t *testing.T, path, body string) string {
	t.Helper()
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

// logArgs is a shell snippet appending one invocation (one arg per line) to $1.
func logArgs(file string) string {
	return fmt.Sprintf("for a in \"$@\"; do printf '%%s\\n' \"$a\"; done >> %q; echo --END-- >> %q\n", file, file)
}

func readArgLog(t *testing.T, file string) [][]string {
	t.Helper()
	data, err := os.ReadFile(file)
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	var runs [][]string
	var current []string
	for _, line := range strings.Split(strings.TrimRight(string(data), "\n"), "\n") {
		if line == "--END--" {
			runs = append(runs, current)
			current = nil
		} else if line != "" || current != nil {
			current = append(current, line)
		}
	}
	return runs
}

func argIndex(values []string, target string) int {
	for i, v := range values {
		if v == target {
			return i
		}
	}
	return -1
}

func hasArg(values []string, target string) bool { return argIndex(values, target) >= 0 }

func waitFor(t *testing.T, predicate func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if predicate() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("condition did not become true")
}

func pidGone(pid int) bool { return syscall.Kill(pid, 0) != nil }

func readPid(t *testing.T, file string) int {
	t.Helper()
	var pid int
	waitFor(t, func() bool {
		data, err := os.ReadFile(file)
		if err != nil {
			return false
		}
		_, err = fmt.Sscanf(strings.TrimSpace(string(data)), "%d", &pid)
		return err == nil && pid > 0
	})
	return pid
}

// ── Codex exec ────────────────────────────────────────────────

func codexFixture(t *testing.T) (dir, args string) {
	dir = t.TempDir()
	args = filepath.Join(dir, "args")
	writeScript(t, filepath.Join(dir, "fake-codex"), logArgs(args)+`
if [ -n "$FAKE_RUNTIME_ENV" ]; then
  printf '{"type":"item.completed","item":{"type":"agent_message","text":"%s"}}' "$FAKE_RUNTIME_ENV"
  exit 0
fi
if [ -n "$FAKE_CODEX_BROKEN" ]; then echo 'Error: disk on fire' >&2; exit 1; fi
case " $* " in *" resume "*)
  if [ -z "$FAKE_CODEX_RESUME_OK" ]; then
    echo 'Error: thread/resume: thread/resume failed: no rollout found for thread id gone (code -32600)' >&2
    if [ -n "$FAKE_CODEX_QUIET_FAIL" ]; then exit 0; fi
    exit 1
  fi;;
esac
echo '{"type":"thread.started","thread_id":"fresh-session-1"}'
echo '{"type":"item.completed","item":{"type":"agent_message","text":"answered"}}'
`)
	t.Setenv("CODEX_BIN", filepath.Join(dir, "fake-codex"))
	return dir, args
}

func codexOpts(dir, prompt string, env ...string) cliAgentOpts {
	return cliAgentOpts{agent: "codex", prompt: prompt, cwd: dir, env: append(os.Environ(), env...)}
}

func TestCodexResumePassesSessionBeforePrompt(t *testing.T) {
	dir, argLog := codexFixture(t)
	o := codexOpts(dir, "hello there", "FAKE_CODEX_RESUME_OK=1")
	o.resumeID = "sess-abc123"
	result, err := runCliAgent(withLog(o))
	if err != nil {
		t.Fatal(err)
	}
	args := readArgLog(t, argLog)[0]
	if args[0] != "exec" || args[1] != "resume" || args[argIndex(args, "sess-abc123")+1] != "hello there" || result.summary != "answered" {
		t.Fatalf("args %q result %+v", args, result)
	}
}

func withLog(o cliAgentOpts) cliAgentOpts {
	if o.emit == nil {
		o.emit = (&eventLog{}).emit
	}
	return o
}

func TestCodexPriorityTierReachesFreshAndResumedRuns(t *testing.T) {
	dir, argLog := codexFixture(t)
	fresh := codexOpts(dir, "fast fresh")
	fresh.priorityServiceTier = true
	resumed := codexOpts(dir, "fast resume", "FAKE_CODEX_RESUME_OK=1")
	resumed.resumeID, resumed.priorityServiceTier = "sess-fast", true
	for _, o := range []cliAgentOpts{fresh, resumed} {
		if _, err := runCliAgent(withLog(o)); err != nil {
			t.Fatal(err)
		}
	}
	runs := readArgLog(t, argLog)
	if len(runs) != 2 {
		t.Fatalf("runs %d", len(runs))
	}
	for _, args := range runs {
		if i := argIndex(args, `service_tier="priority"`); i <= 0 || args[i-1] != "-c" {
			t.Fatalf("priority tier missing: %q", args)
		}
	}
}

func TestCodexDeadSessionFallsBackToFresh(t *testing.T) {
	for _, quiet := range []bool{false, true} {
		dir, argLog := codexFixture(t)
		o := codexOpts(dir, "still there?")
		if quiet {
			o.env = append(o.env, "FAKE_CODEX_QUIET_FAIL=1")
		}
		o.resumeID = "sess-long-gone"
		result, err := runCliAgent(withLog(o))
		if err != nil {
			t.Fatal(err)
		}
		runs := readArgLog(t, argLog)
		if len(runs) != 2 || !hasArg(runs[0], "resume") || hasArg(runs[1], "resume") || runs[1][len(runs[1])-1] != "still there?" {
			t.Fatalf("quiet=%v runs %q", quiet, runs)
		}
		// The new session must be handed back, or the next turn resumes the dead id.
		if result.summary != "answered" || result.sessionID != "fresh-session-1" {
			t.Fatalf("result %+v", result)
		}
	}
}

func TestCodexUnrelatedFailureIsNotRetried(t *testing.T) {
	dir, argLog := codexFixture(t)
	log := &eventLog{}
	o := codexOpts(dir, "x", "FAKE_CODEX_BROKEN=1")
	o.resumeID, o.emit = "sess-abc", log.emit
	_, err := runCliAgent(o)
	if err == nil || !strings.Contains(err.Error(), "disk on fire") {
		t.Fatalf("err %v", err)
	}
	if got := log.phases(); strings.Join(got, ",") != "request_start,completion" {
		t.Fatalf("phases %v", got)
	}
	if n := len(readArgLog(t, argLog)); n != 1 {
		t.Fatalf("attempts %d", n)
	}
}

func TestCodexFreshRunShowsAnswerInChat(t *testing.T) {
	dir, argLog := codexFixture(t)
	log := &eventLog{}
	o := codexOpts(dir, "new")
	o.emit = log.emit
	result, err := runCliAgent(o)
	if err != nil {
		t.Fatal(err)
	}
	if runs := readArgLog(t, argLog); len(runs) != 1 || hasArg(runs[0], "resume") || result.sessionID != "fresh-session-1" {
		t.Fatalf("runs %q result %+v", runs, result)
	}
	for _, ev := range log.all() {
		if ev.kind == "text" && ev.payload["chatVisible"] == true {
			if text := str(asObject(asObject(ev.payload["message"])["content"].([]any)[0])["text"]); text != "answered" {
				t.Fatalf("answer %q", text)
			}
			return
		}
	}
	t.Fatal("no chat-visible answer")
}

func TestDriversIsolateEnvAndFlushPartialLines(t *testing.T) {
	dir, _ := codexFixture(t)
	var wg sync.WaitGroup
	results := make([]cliAgentResult, 2)
	for i, value := range []string{"first", "second"} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			o := codexOpts(dir, "env", "FAKE_RUNTIME_ENV="+value)
			o.runID = 93000 + i
			results[i], _ = runCliAgent(withLog(o))
		}()
	}
	wg.Wait()
	if results[0].summary != "first" || results[1].summary != "second" {
		t.Fatalf("results %+v", results)
	}
	for _, id := range []int{93000, 93001} {
		cliMu.Lock()
		_, live := cliCancels[id]
		cliMu.Unlock()
		if live {
			t.Fatalf("run %d still registered", id)
		}
	}
}

// ── Pi ────────────────────────────────────────────────────────

func TestPiJSONModeResumeAndEvents(t *testing.T) {
	dir := t.TempDir()
	argLog := filepath.Join(dir, "args")
	t.Setenv("PI_BIN", writeScript(t, filepath.Join(dir, "fake-pi"), logArgs(argLog)+`
echo '{"type":"session","version":3,"id":"pi-session-1"}'
echo '{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","delta":"checking"}}'
echo '{"type":"tool_execution_start","toolCallId":"tool-1","toolName":"read","args":{"path":"README.md"}}'
echo '{"type":"tool_execution_end","toolCallId":"tool-1","toolName":"read","result":{"content":[{"type":"text","text":"contents"}]},"isError":false}'
echo '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"done"}}'
`))
	log := &eventLog{}
	result, err := runCliAgent(cliAgentOpts{agent: "pi", prompt: "inspect it", cwd: dir, resumeID: "prior-pi-session",
		model: "openai/gpt-5.6-terra", emit: log.emit, env: os.Environ()})
	if err != nil {
		t.Fatal(err)
	}
	args := readArgLog(t, argLog)[0]
	if strings.Join(args[:5], " ") != "--mode json --approve --session prior-pi-session" || args[argIndex(args, "--model")+1] != "openai/gpt-5.6-terra" || args[len(args)-1] != "inspect it" {
		t.Fatalf("args %q", args)
	}
	if result.sessionID != "pi-session-1" || result.summary != "done" {
		t.Fatalf("result %+v", result)
	}
	types := map[string]bool{}
	for _, b := range log.blocks("text") {
		types[str(b["type"])] = true
	}
	results := log.blocks("user")
	if !types["thinking"] || !types["tool_use"] || len(results) != 1 || results[0]["content"] != "contents" {
		t.Fatalf("blocks %v results %v", types, results)
	}
}

// ── Akron ─────────────────────────────────────────────────────

func akronFixture(t *testing.T) (dir, childPid, attempts string) {
	dir = t.TempDir()
	childPid = filepath.Join(dir, "child.pid")
	attempts = filepath.Join(dir, "attempts")
	t.Setenv("AKRON_BIN", writeScript(t, filepath.Join(dir, "fake-akron"), fmt.Sprintf(`
if [ -n "$FAKE_AKRON_RETRY" ]; then
  n=$(cat %[2]q 2>/dev/null || echo 0); n=$((n+1)); echo $n > %[2]q
  if [ $n -gt 1 ]; then echo 'recovered answer'; exit 0; fi
fi
if [ -n "$FAKE_AKRON_EVENTS" ]; then
  if [ "$HERMES_CASCADE_EVENTS" != 1 ]; then echo 'cascade events disabled' >&2; exit 13; fi
  echo '{"type":"reasoning.delta","text":"mapping the harness"}' >&2
  echo 'native answer'
  exit 0
fi
sleep 1000 &
echo $! > %[1]q
while :; do sleep 1; done
`, childPid, attempts)))
	t.Setenv("RUNNER_CLI_HEARTBEAT_MS", "25")
	t.Setenv("RUNNER_AKRON_IDLE_TIMEOUT_MS", "1000")
	t.Setenv("CASCADE_AGENT_PROCESS_DIR", filepath.Join(dir, "agent-processes"))
	return
}

func TestAkronHeartbeatsAndCancelKillsProcessTree(t *testing.T) {
	dir, childPid, _ := akronFixture(t)
	log := &eventLog{}
	done := make(chan error, 1)
	go func() {
		_, err := runCliAgent(cliAgentOpts{agent: "akron-grok", prompt: "work silently", cwd: dir, runID: 8080, emit: log.emit, env: os.Environ()})
		done <- err
	}()
	descendant := readPid(t, childPid)
	waitFor(t, func() bool { return strings.Contains(log.harness(), "still working") })
	if !cancelCliRun(8080) {
		t.Fatal("cancel returned false")
	}
	if err := <-done; err == nil || !strings.Contains(err.Error(), "exited with code") {
		t.Fatalf("err %v", err)
	}
	waitFor(t, func() bool { return pidGone(descendant) })
}

func TestAkronSilenceTimesOutAndReleasesTree(t *testing.T) {
	dir, childPid, _ := akronFixture(t)
	started := time.Now()
	done := make(chan error, 1)
	go func() {
		_, err := runCliAgent(cliAgentOpts{agent: "akron-grok", prompt: "provider never answers", cwd: dir, runID: 8081, emit: (&eventLog{}).emit, env: os.Environ()})
		done <- err
	}()
	descendant := readPid(t, childPid)
	err := <-done
	if err == nil || !strings.Contains(err.Error(), "produced no output for 1000ms and was stopped") {
		t.Fatalf("err %v", err)
	}
	// One byte-silent retry is allowed, so two idle windows at most.
	if elapsed := time.Since(started); elapsed > 4*time.Second {
		t.Fatalf("took %v", elapsed)
	}
	waitFor(t, func() bool { return pidGone(descendant) })
}

func TestAkronRetriesOneByteSilentRequest(t *testing.T) {
	dir, _, attempts := akronFixture(t)
	log := &eventLog{}
	result, err := runCliAgent(cliAgentOpts{agent: "akron-grok", prompt: "recover once", cwd: dir, runID: 8082, emit: log.emit,
		env: append(os.Environ(), "FAKE_AKRON_RETRY=1")})
	if err != nil || result.summary != "recovered answer" {
		t.Fatalf("result %+v err %v", result, err)
	}
	if data, _ := os.ReadFile(attempts); strings.TrimSpace(string(data)) != "2" {
		t.Fatalf("attempts %q", data)
	}
	if !strings.Contains(log.harness(), "retrying Akron once with a fresh bridge") {
		t.Fatal("missing retry note")
	}
}

func TestAkronEmitsLaunchMetadataAndNativeReasoning(t *testing.T) {
	dir, _, _ := akronFixture(t)
	bin := os.Getenv("AKRON_BIN")
	t.Setenv("AKRON_BIN", "")
	if got := cliAgentBin("akron-grok"); got != "akron" {
		t.Fatalf("default bin %q", got)
	}
	t.Setenv("AKRON_BIN", bin)
	log := &eventLog{}
	result, err := runCliAgent(cliAgentOpts{agent: "akron-grok", prompt: "exercise the bridge", cwd: dir, runID: 8083, emit: log.emit,
		env: append(os.Environ(), "FAKE_AKRON_EVENTS=1")})
	if err != nil || result.summary != "native answer" {
		t.Fatalf("result %+v err %v", result, err)
	}
	harness := log.harness()
	for _, want := range []string{"launching Akron --grok harness", "fake-akron --grok", "# cwd "} {
		if !strings.Contains(harness, want) {
			t.Fatalf("harness missing %q: %s", want, harness)
		}
	}
	found := false
	for _, b := range log.blocks("text") {
		found = found || (b["type"] == "thinking" && b["thinking"] == "mapping the harness")
	}
	if !found {
		t.Fatal("no native reasoning block")
	}
}

// ── Hermes ────────────────────────────────────────────────────

func hermesFixture(t *testing.T) (dir, argLog, attempts string) {
	dir = t.TempDir()
	argLog = filepath.Join(dir, "args")
	attempts = filepath.Join(dir, "503")
	t.Setenv("HOME", dir)
	t.Setenv("CASCADE_AGENT_PROCESS_DIR", filepath.Join(dir, "agent-processes"))
	t.Setenv("RUNNER_HERMES_UPSTREAM_BACKOFF_MS", "20")
	t.Setenv("HERMES_BIN", writeScript(t, filepath.Join(dir, "fake-hermes"), logArgs(argLog)+fmt.Sprintf(`
session=20260806_140649_084b24
prev=
for a in "$@"; do [ "$prev" = --resume ] && session=$a; prev=$a; done
if [ -n "$FAKE_HERMES_503" ]; then
  n=$(cat %[1]q 2>/dev/null || echo 0); n=$((n+1)); echo $n > %[1]q
  if [ $n -lt "$FAKE_HERMES_503" ]; then
    echo 'API call failed after 3 retries: HTTP 503: The requested model is temporarily unavailable due to upstream capacity limits. Please try again in a moment.'
    [ "$FAKE_HERMES_503" != 2 ] && printf '\nsession_id: %%s\n' "$session" >&2
    exit 0
  fi
  echo 'recovered after capacity error'
  printf '\nsession_id: %%s\n' "$session" >&2
  exit 0
fi
if [ -n "$FAKE_HERMES_TALKS_ABOUT_503" ]; then
  echo 'To handle this, retry when the API returns HTTP 503 with backoff.'
  printf '\nsession_id: %%s\n' "$session" >&2
  exit 0
fi
printf '\r\n'
printf '┌─ Reasoning ─────┐\r\n'
printf 'weighing the options\r\n'
if [ "$session" = 20260806_140649_084b24 ]; then echo 'fresh answer'; else echo 'resumed answer'; fi
printf '\nsession_id: %%s' "$session" >&2
`, attempts)))
	return
}

func hermesOpts(dir, prompt string, env ...string) cliAgentOpts {
	return cliAgentOpts{agent: "hermes", prompt: prompt, cwd: dir, env: append(os.Environ(), env...), emit: (&eventLog{}).emit}
}

func TestHermesFreshTurnReportsSession(t *testing.T) {
	dir, argLog, _ := hermesFixture(t)
	result, err := runCliAgent(hermesOpts(dir, "first turn"))
	if err != nil {
		t.Fatal(err)
	}
	args := readArgLog(t, argLog)[0]
	// Oneshot (-z) never reports a session id, so every following turn would start cold.
	if hasArg(args, "-z") || args[0] != "chat" || args[1] != "-Q" || args[argIndex(args, "-q")+1] != "first turn" ||
		hasArg(args, "--safe-mode") || hasArg(args, "--yolo") {
		t.Fatalf("args %q", args)
	}
	// The trailing session line has no newline; it must still be read.
	if result.sessionID != "20260806_140649_084b24" {
		t.Fatalf("session %q", result.sessionID)
	}
}

func TestHermesProfileSafeModeAndYoloAreIndependent(t *testing.T) {
	dir, argLog, _ := hermesFixture(t)
	o := hermesOpts(dir, "configured turn")
	o.hermesProfile, o.hermesSafeMode = "greenhouse-codex", true
	if _, err := runCliAgent(o); err != nil {
		t.Fatal(err)
	}
	o = hermesOpts(dir, "approved turn")
	o.yolo = true
	if _, err := runCliAgent(o); err != nil {
		t.Fatal(err)
	}
	runs := readArgLog(t, argLog)
	safe, yolo := runs[0], runs[1]
	if safe[argIndex(safe, "-p")+1] != "greenhouse-codex" || safe[argIndex(safe, "-p")+2] != "chat" || !hasArg(safe, "--safe-mode") || hasArg(safe, "--yolo") {
		t.Fatalf("safe %q", safe)
	}
	if hasArg(yolo, "--safe-mode") || !hasArg(yolo, "--yolo") {
		t.Fatalf("yolo %q", yolo)
	}
	o = hermesOpts(dir, "turn")
	o.hermesProfile = "--safe-mode"
	if _, err := runCliAgent(o); err == nil || !strings.Contains(err.Error(), "Hermes profile must use") {
		t.Fatalf("err %v", err)
	}
}

func TestHermesReasoningStaysOutOfAnswer(t *testing.T) {
	dir, argLog, _ := hermesFixture(t)
	log := &eventLog{}
	o := hermesOpts(dir, "second turn")
	o.emit, o.resumeID = log.emit, "sess-hermes-1"
	result, err := runCliAgent(o)
	if err != nil {
		t.Fatal(err)
	}
	args := readArgLog(t, argLog)[0]
	if args[argIndex(args, "--resume")+1] != "sess-hermes-1" || result.summary != "resumed answer" {
		t.Fatalf("args %q result %+v", args, result)
	}
	sawThinking := false
	for _, b := range log.blocks("text") {
		if b["type"] == "thinking" && strings.Contains(str(b["thinking"]), "weighing the options") {
			sawThinking = true
		}
		if b["type"] == "text" && regexp.MustCompile(`Reasoning|weighing the options`).MatchString(str(b["text"])) {
			t.Fatalf("reasoning emitted as answer: %v", b)
		}
	}
	if !sawThinking {
		t.Fatal("reasoning did not stream as thinking")
	}
}

func TestHermesModelSelection(t *testing.T) {
	dir, argLog, _ := hermesFixture(t)
	o := hermesOpts(dir, "which model?")
	o.model = "deepseek/deepseek-v4-pro"
	runCliAgent(o)
	runCliAgent(hermesOpts(dir, "no model"))
	runs := readArgLog(t, argLog)
	if runs[0][argIndex(runs[0], "-m")+1] != "deepseek/deepseek-v4-pro" || hasArg(runs[1], "-m") {
		t.Fatalf("runs %q", runs)
	}
}

func TestHermesRecoversFromCapacityFailures(t *testing.T) {
	for _, attempts := range []int{2, 3} {
		dir, argLog, _ := hermesFixture(t)
		result, err := runCliAgent(hermesOpts(dir, "are you there?", fmt.Sprintf("FAKE_HERMES_503=%d", attempts)))
		if err != nil {
			t.Fatal(err)
		}
		if n := len(readArgLog(t, argLog)); n != attempts || result.summary != "recovered after capacity error" {
			t.Fatalf("attempts %d result %+v", n, result)
		}
	}
	// A real answer that discusses HTTP 503 is not a capacity failure.
	dir, argLog, _ := hermesFixture(t)
	result, err := runCliAgent(hermesOpts(dir, "how should I handle 503s?", "FAKE_HERMES_TALKS_ABOUT_503=1"))
	if err != nil || len(readArgLog(t, argLog)) != 1 || !strings.Contains(result.summary, "retry when the API returns HTTP 503") {
		t.Fatalf("result %+v err %v", result, err)
	}
}

// ── Hermes profile routing ────────────────────────────────────

func TestHermesProfileRoutingRejectsInsecureConfig(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, ".cascade")
	os.Mkdir(dir, 0o700)
	config := filepath.Join(dir, "hermes-profile-commands.json")
	command := writeScript(t, filepath.Join(home, "adapter with spaces"), "echo 'fixture answer'\n")
	os.Chmod(command, 0o700)
	write := func(value any) {
		data, _ := json.Marshal(value)
		os.WriteFile(config, data, 0o600)
		os.Chmod(config, 0o600)
	}
	valid := map[string]any{"version": 1, "profiles": map[string]any{"along": map[string]any{"command": command}}}
	expect := func(profile, want string) {
		t.Helper()
		got, err := hermesProfileCommand(profile, config)
		if err != nil || got != want {
			t.Fatalf("%q: got %q err %v", profile, got, err)
		}
	}
	fails := func(pattern string) {
		t.Helper()
		if _, err := hermesProfileCommand("along", config); err == nil || !regexp.MustCompile(pattern).MatchString(err.Error()) {
			t.Fatalf("want %s, got %v", pattern, err)
		}
	}
	expect("along", "")
	write(valid)
	expect("along", command)
	expect("other", "")
	expect("", "")
	for _, value := range []any{nil, []any{}, map[string]any{"version": 2, "profiles": map[string]any{}},
		map[string]any{"version": 1, "profiles": []any{}}, map[string]any{"version": 1, "profiles": map[string]any{"along": nil}},
		map[string]any{"version": 1, "profiles": map[string]any{"along": map[string]any{"command": "relative"}}},
		map[string]any{"version": 1, "profiles": map[string]any{"along": map[string]any{"command": command, "args": []any{}}}},
		map[string]any{"version": 1, "profiles": map[string]any{"../bad": map[string]any{"command": command}}},
		map[string]any{"version": 1, "profiles": map[string]any{"along": map[string]any{"command": "/bad\x00path"}}}} {
		write(value)
		fails("routing:")
	}
	os.WriteFile(config, []byte("{not json"), 0o600)
	fails("routing:")
	write(valid)
	os.Chmod(config, 0o644)
	fails("private regular file")
	os.Chmod(config, 0o600)
	os.Chmod(dir, 0o777)
	fails("config directory")
	os.Chmod(dir, 0o700)
	real := filepath.Join(home, "real.json")
	os.Rename(config, real)
	os.Symlink(real, config)
	fails("securely open")
	os.Remove(real) // a dangling config link must not mean opt-out
	fails("securely open")
	os.Remove(config)
	os.Mkdir(config, 0o700)
	fails("private regular file")
	os.Remove(config)
	write(valid)
	os.Chmod(command, 0o600)
	fails("unavailable")
	write(map[string]any{"version": 1, "profiles": map[string]any{"along": map[string]any{"command": home}}})
	fails("regular file")
	os.Rename(dir, dir+"-real")
	os.Symlink(dir+"-real", dir)
	fails("config directory")
}

func TestHermesProfileRoutingPreservesArgvAndFailsClosed(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CASCADE_AGENT_PROCESS_DIR", filepath.Join(home, "leases"))
	dir := filepath.Join(home, ".cascade")
	os.Mkdir(dir, 0o700)
	config := filepath.Join(dir, "hermes-profile-commands.json")
	launchLog := filepath.Join(home, "launches")
	executable := func(file, name string) string {
		writeScript(t, file, fmt.Sprintf("{ echo %s; echo \"$ROUTE_TEST_MARKER|$HERMES_CASCADE_EVENTS\"; for a in \"$@\"; do printf '%%s\\n' \"$a\"; done; echo --END--; } >> %q\necho 'session_id: fixture-session' >&2\necho 'fixture answer'\n", name, launchLog))
		os.Chmod(file, 0o700)
		return file
	}
	command := executable(filepath.Join(home, "adapter with spaces"), "adapter")
	normal := executable(filepath.Join(home, "normal"), "normal")
	t.Setenv("HERMES_BIN", normal)
	write := func(cmd string) {
		data, _ := json.Marshal(map[string]any{"version": 1, "profiles": map[string]any{"along": map[string]any{"command": cmd}}})
		os.WriteFile(config, data, 0o600)
	}
	write(command)
	run := func(profile string) (cliAgentResult, error) {
		o := cliAgentOpts{agent: "hermes", prompt: `literal ; $(not-a-shell) "prompt"`, cwd: home, emit: (&eventLog{}).emit,
			hermesProfile: profile, resumeID: "existing-session", model: "fixture-model", hermesSafeMode: true, yolo: true,
			env: append(os.Environ(), "ROUTE_TEST_MARKER=unchanged")}
		return runCliAgent(o)
	}
	launches := func() [][]string { return readArgLog(t, launchLog) }
	result, err := run("along")
	if err != nil || result.summary != "fixture answer" || result.sessionID != "fixture-session" {
		t.Fatalf("result %+v err %v", result, err)
	}
	run("other")
	run("")
	records := launches()
	names := []string{records[0][0], records[1][0], records[2][0]}
	if strings.Join(names, ",") != "adapter,normal,normal" {
		t.Fatalf("names %v", names)
	}
	base := records[2][2:]
	if strings.Join(records[0][2:], "\x00") != strings.Join(append([]string{"-p", "along"}, base...), "\x00") ||
		strings.Join(records[1][2:], "\x00") != strings.Join(append([]string{"-p", "other"}, base...), "\x00") {
		t.Fatalf("records %q", records)
	}
	argv := records[0][2:]
	if strings.Join(argv[2:7], " ") != "chat -Q --resume existing-session -q" || strings.Join(argv[len(argv)-4:], " ") != "-m fixture-model --yolo --safe-mode" {
		t.Fatalf("argv %q", argv)
	}
	if records[0][1] != "unchanged|1" || records[0][1] != records[1][1] {
		t.Fatalf("env %q %q", records[0][1], records[1][1])
	}
	t.Setenv("HERMES_BIN", filepath.Join(home, "normal-missing"))
	if _, err := run("along"); err != nil { // no normal Hermes installation required
		t.Fatal(err)
	}
	t.Setenv("HERMES_BIN", normal)
	write(filepath.Join(home, "missing"))
	if _, err := run("along"); err == nil || !regexp.MustCompile(`routing:.*unavailable`).MatchString(err.Error()) {
		t.Fatalf("err %v", err)
	}
	if _, err := run("../invalid"); err == nil || !strings.Contains(err.Error(), "Hermes profile must") {
		t.Fatalf("err %v", err)
	}
	write(command)
	os.Remove(command)
	if _, err := run("along"); err == nil || !regexp.MustCompile(`routing:.*unavailable`).MatchString(err.Error()) {
		t.Fatalf("err %v", err)
	}
	os.WriteFile(command, []byte("#!/nonexistent/fizzer-test-interpreter\n"), 0o700)
	if _, err := run("along"); err == nil { // validation passes, but exec itself fails
		t.Fatal("expected exec failure")
	}
	write("relative")
	if _, err := run("along"); err == nil || !strings.Contains(err.Error(), "invalid profile mapping") {
		t.Fatalf("err %v", err)
	}
	if n := len(launches()); n != 4 {
		t.Fatalf("launches %d", n)
	}
	os.Remove(config) // explicit removal restores default routing on the next run
	if _, err := run("along"); err != nil || launches()[4][0] != "normal" {
		t.Fatalf("err %v", err)
	}
}

// ── end to end through executeLocalAgentRun ───────────────────

func TestLocalRunReportsCompletionAndCancellation(t *testing.T) {
	dir, childPid, _ := akronFixture(t)
	t.Setenv("CASCADE_AGENT_STATE_DIR", dir)
	t.Setenv("CASCADE_DATA_DIR", dir)
	t.Setenv("FIZZER_AGENT_ACCOUNT_CHILD", "1")
	statuses := func(events []agentRunEvent) []string {
		var out []string
		for _, ev := range events {
			if ev.Type == "status" {
				var p map[string]any
				json.Unmarshal([]byte(ev.PayloadJSON), &p)
				out = append(out, str(p["status"]))
			}
		}
		return out
	}
	var mu sync.Mutex
	var events []agentRunEvent
	emit := func(ev agentRunEvent) { mu.Lock(); events = append(events, ev); mu.Unlock() }
	t.Setenv("FAKE_AKRON_EVENTS", "1")
	result, err := executeLocalAgentRun(map[string]any{"runId": float64(7001), "agent": "akron-grok", "prompt": "hi", "cwd": dir}, nil, "", "", emit)
	if err != nil || str(result["sessionId"]) != "" {
		t.Fatalf("result %v err %v", result, err)
	}
	if got := statuses(events); strings.Join(got, ",") != "running,completed" {
		t.Fatalf("statuses %v", got)
	}
	os.Unsetenv("FAKE_AKRON_EVENTS")
	events = nil
	done := make(chan error, 1)
	go func() {
		_, err := executeLocalAgentRun(map[string]any{"runId": float64(7002), "agent": "akron-grok", "prompt": "hi", "cwd": dir}, nil, "", "", emit)
		done <- err
	}()
	descendant := readPid(t, childPid)
	if !cancelLocalAgentRun(7002) {
		t.Fatal("cancel returned false")
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	got := statuses(events)
	mu.Unlock()
	if got[len(got)-1] != "canceled" {
		t.Fatalf("statuses %v", got)
	}
	waitFor(t, func() bool { return pidGone(descendant) })
}

func TestNonChatRunsCarryNoteContextAndNoChatPanic(t *testing.T) {
	dir := t.TempDir()
	argLog := filepath.Join(dir, "args")
	t.Setenv("PI_BIN", writeScript(t, filepath.Join(dir, "fake-pi"), logArgs(argLog)+"echo '{\"type\":\"session\",\"id\":\"s\"}'\n"))
	t.Setenv("CASCADE_AGENT_STATE_DIR", dir)
	t.Setenv("CASCADE_DATA_DIR", dir)
	t.Setenv("FIZZER_AGENT_ACCOUNT_CHILD", "1")
	_, err := executeLocalAgentRun(map[string]any{"runId": float64(7003), "agent": "pi", "prompt": "do it", "cwd": dir}, nil, "", "", func(agentRunEvent) {})
	if err != nil {
		t.Fatal(err)
	}
	// The prompt spans lines, so check the raw log rather than per-line args.
	raw, _ := os.ReadFile(argLog)
	if !regexp.MustCompile(`(?s)\n\[Context: You are a local workspace assistant\..*cascade-note.*\]\n\ndo it\n--END--`).Match(raw) {
		t.Fatalf("log %q", raw)
	}
}
