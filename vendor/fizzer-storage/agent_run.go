package main

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

var (
	agentClaudeMu    sync.Mutex
	activeClaude     = map[int]*exec.Cmd{}
	canceledAgentRun = map[int]bool{}
)

func agentRunRegistryDir() string {
	return filepath.Join(fizzerDir(), "agent-runs")
}

func agentRunPidPath(runID int) string {
	return filepath.Join(agentRunRegistryDir(), fmt.Sprintf("%d.json", runID))
}

func writeRunPid(runID int) {
	if runID <= 0 {
		return
	}
	dir := agentRunRegistryDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return
	}
	payload, _ := json.Marshal(map[string]any{
		"pid":       os.Getpid(),
		"startedAt": time.Now().UTC().Format(time.RFC3339),
	})
	_ = os.WriteFile(agentRunPidPath(runID), payload, 0o600)
}

func clearRunPid(runID int) {
	if runID <= 0 {
		return
	}
	_ = os.Remove(agentRunPidPath(runID))
}

func readRunPid(runID int) int {
	data, err := os.ReadFile(agentRunPidPath(runID))
	if err != nil {
		return 0
	}
	var rec struct {
		PID int `json:"pid"`
	}
	if json.Unmarshal(data, &rec) != nil {
		return 0
	}
	return rec.PID
}

func reapOrphanedAgentRuns() {
	dir := agentRunRegistryDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		path := filepath.Join(dir, entry.Name())
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var rec struct {
			PID int `json:"pid"`
		}
		if json.Unmarshal(data, &rec) != nil {
			_ = os.Remove(path)
			continue
		}
		if rec.PID == os.Getpid() || !pidAlive(rec.PID) {
			_ = os.Remove(path)
		}
	}
}

func cleanupRunHelperConfig(runID int) {
	if runID <= 0 {
		return
	}
	_ = os.Remove(runHelperConfigPath(runID))
}

func readUsedChatSend(runID int) bool {
	if runID <= 0 {
		return false
	}
	data, err := os.ReadFile(runHelperConfigPath(runID))
	if err != nil {
		return false
	}
	var parsed struct {
		UsedChatSend  bool   `json:"usedChatSend"`
		ChatChannelID string `json:"chatChannelId"`
		VaultID       string `json:"vaultId"`
		Token         string `json:"token"`
	}
	if json.Unmarshal(data, &parsed) != nil {
		return false
	}
	if !parsed.UsedChatSend {
		return false
	}
	return strings.TrimSpace(parsed.ChatChannelID) != "" || strings.TrimSpace(parsed.VaultID) != "" || strings.TrimSpace(parsed.Token) != ""
}

func cancelLocalAgentRun(runID int) bool {
	if cancelAgentAccount(runID) {
		return true
	}
	agentClaudeMu.Lock()
	canceledAgentRun[runID] = true
	cmd := activeClaude[runID]
	delete(activeClaude, runID)
	agentClaudeMu.Unlock()
	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Signal(syscall.SIGTERM)
		return true
	}
	pid := readRunPid(runID)
	if pid > 0 && pid != os.Getpid() && pidAlive(pid) {
		p, err := os.FindProcess(pid)
		if err == nil {
			_ = p.Signal(syscall.SIGTERM)
			return true
		}
	}
	return false
}

func agentIsClaude(opts map[string]any) bool {
	return str(opts["agent"]) == "claude-code"
}

func shouldUseAccountOrchestration() bool {
	return os.Getenv("FIZZER_AGENT_ACCOUNT_CHILD") != "1" && agentAccountEnabled()
}

func executeLocalAgentRun(opts map[string]any, api *runAPI, root, mirrorRoot string, emit func(agentRunEvent)) (map[string]any, error) {
	runID := int(numberOf(opts["runId"]))
	if runID <= 0 {
		return nil, fmt.Errorf("Invalid run id")
	}
	defer cleanupRunHelperConfig(runID)
	agent := strings.TrimSpace(str(opts["agent"]))
	if agent == "" {
		return nil, fmt.Errorf("Agent is required")
	}
	prompt := strings.TrimSpace(str(opts["prompt"]))
	if prompt == "" {
		return nil, fmt.Errorf("Prompt is required")
	}

	seq := 0
	terminal := false
	var mu sync.Mutex
	nextEmit := func(kind, payloadJSON string) {
		mu.Lock()
		seq++
		current := seq
		mu.Unlock()
		emit(agentRunEvent{RunID: runID, Seq: current, Type: kind, PayloadJSON: payloadJSON})
	}
	status := func(value, summary string, extra map[string]any) {
		mu.Lock()
		if terminal {
			mu.Unlock()
			return
		}
		terminal = true
		seq++
		current := seq
		mu.Unlock()
		payload := map[string]any{"status": value, "summary": summary}
		for k, v := range extra {
			payload[k] = v
		}
		if value == "completed" && readUsedChatSend(runID) {
			payload["suppressChatBody"] = true
		}
		body, _ := json.Marshal(payload)
		emit(agentRunEvent{RunID: runID, Seq: current, Type: "status", PayloadJSON: string(body)})
	}

	if shouldUseAccountOrchestration() {
		writeRunPid(runID)
		defer clearRunPid(runID)
		input := runInput{Opts: opts, API: api, Root: root, MirrorRoot: mirrorRoot}
		result, err := runAccountOrchestrated(input, emit)
		if err != nil {
			return nil, err
		}
		out := map[string]any{}
		if result != nil {
			var v any
			_ = json.Unmarshal(*result, &v)
			if m, ok := v.(map[string]any); ok {
				return m, nil
			}
			out["result"] = v
		}
		return out, nil
	}

	writeRunPid(runID)
	defer clearRunPid(runID)

	body, _ := json.Marshal(map[string]string{"status": "running"})
	nextEmit("status", string(body))
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	stopHeartbeat := make(chan struct{})
	defer close(stopHeartbeat)
	go func() {
		for {
			select {
			case <-stopHeartbeat:
				return
			case <-heartbeat.C:
				nextEmit("heartbeat", "{}")
			}
		}
	}()

	agentClaudeMu.Lock()
	delete(canceledAgentRun, runID)
	agentClaudeMu.Unlock()

	if agentIsClaude(opts) {
		result, err := runClaudeNative(opts, nextEmit, status)
		if err != nil {
			agentClaudeMu.Lock()
			wasCanceled := canceledAgentRun[runID]
			delete(canceledAgentRun, runID)
			agentClaudeMu.Unlock()
			if wasCanceled {
				status("canceled", "Run canceled.", nil)
				return map[string]any{"canceled": true}, nil
			}
			status("failed", err.Error(), nil)
			return nil, err
		}
		extra := map[string]any{}
		if result["sessionId"] != nil {
			extra["sessionId"] = result["sessionId"]
		}
		status("completed", str(result["summary"]), extra)
		return map[string]any{"sessionId": result["sessionId"]}, nil
	}

	result, err := runCliAgentBridge(opts, nextEmit, status)
	if err != nil {
		agentClaudeMu.Lock()
		wasCanceled := canceledAgentRun[runID]
		delete(canceledAgentRun, runID)
		agentClaudeMu.Unlock()
		if wasCanceled {
			status("canceled", "Run canceled.", nil)
			return map[string]any{}, nil
		}
		status("failed", err.Error(), nil)
		return nil, err
	}
	extra := map[string]any{}
	if result["sessionId"] != nil {
		extra["sessionId"] = result["sessionId"]
	}
	status("completed", str(result["summary"]), extra)
	return map[string]any{"sessionId": result["sessionId"]}, nil
}

type claudeRunResult struct {
	Summary  string
	Session  string
	Canceled bool
	Timeout  bool
}

func claudeDefaultModel() string {
	if v := strings.TrimSpace(os.Getenv("RUNNER_MODEL")); v != "" {
		return v
	}
	return "claude-sonnet-5"
}

func claudeDefaultEffort(chat bool) string {
	if chat {
		if v := strings.TrimSpace(os.Getenv("RUNNER_CHAT_EFFORT")); v != "" {
			return normalizeClaudeEffort(v, "medium")
		}
	}
	if v := strings.TrimSpace(os.Getenv("RUNNER_EFFORT")); v != "" {
		return normalizeClaudeEffort(v, "medium")
	}
	return "medium"
}

func normalizeClaudeEffort(value, fallback string) string {
	effort := strings.ToLower(strings.TrimSpace(value))
	switch effort {
	case "low", "medium", "high", "xhigh", "max":
		return effort
	}
	return fallback
}

func isChatRun(opts map[string]any) bool {
	if v := str(opts["chatChannelId"]); v != "" {
		return true
	}
	chat, _ := opts["chat"].(map[string]any)
	return str(chat["channelId"]) != ""
}

func noteCapabilityContext(opts map[string]any) string {
	helperDir := resolveWrapperDir()
	vaultID := strings.TrimSpace(str(opts["vaultId"]))
	vaultLine := ""
	if vaultID != "" {
		vaultLine = " Vault: " + vaultID + "."
	}
	return "Live notes: `cascade-note` (not local .md; creates unlisted by default — use `--listed` only if the user asks for sidebar); durable memory: `cascade-note memory`; optional scratchpad: `cascade-scratchpad jot` for reusable root causes, decisions, or dead ends. Read and improve useful task-vault knowledge with judgment, including unexpected connections; preserve uncertainty and existing work within authorized scope." + vaultLine + " Helpers on PATH and in " + helperDir + "."
}

const claudeAgentContext = "You are a local workspace assistant. Use normal filesystem edits for requested local work. Respect auth boundaries and only handle secrets the user explicitly provides for this task."

const chatBrevityContext = "You are a chat participant, not a coding CLI. Reply like a person in a chat channel: a few short sentences of plain prose, lead with the outcome. Do NOT format the reply as a report — no headings, no bold/italic emphasis, no bullet lists, no em-dash asides, and no restating the question. Keep it to one short paragraph where possible; use a blank line only to separate genuinely distinct points, never after every sentence. Put reasoning, step narration, and detail in thinking or the run trace, not the message. Do not confuse a mentioned @handle with the message author."

const chatContextToolContext = "Your channel transcript is append-only. A continued turn contains only new room activity and an exact message cursor. Use the pre-authorized `cascade-chat history --around-message-id <id> --include-reply-context` or `cascade-chat search <query>` tool when that delta is insufficient; never require a repeated sliding-window transcript."

func helperNames() []string {
	return []string{"cascade-note", "cascade-chat", "cascade-scratchpad"}
}

func userBinDir() string {
	if v := os.Getenv("CASCADE_AGENT_BIN_DIR"); v != "" {
		return v
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local", "bin")
}

func agentStateDir() string {
	if v := os.Getenv("CASCADE_AGENT_STATE_DIR"); v != "" {
		return v
	}
	if v := os.Getenv("CASCADE_USER_DATA_DIR"); v != "" {
		return v
	}
	return fizzerDir()
}

func helperConfigPath() string {
	return filepath.Join(agentStateDir(), "agent-helper-context.json")
}

func runHelperConfigPath(runID int) string {
	if runID > 0 {
		return filepath.Join(agentStateDir(), "run-contexts", fmt.Sprintf("%d.json", runID))
	}
	return helperConfigPath()
}

func resolveWrapperDir() string {
	exe, err := os.Executable()
	candidates := []string{}
	if err == nil {
		dir := filepath.Dir(exe)
		candidates = append(candidates,
			filepath.Join(dir, "..", "..", "cli-agents"),
			filepath.Join(dir, "..", "..", "dist", "cli-agents"),
			filepath.Join(dir, "..", "cli-agents"),
			filepath.Join(dir, "..", "dist", "cli-agents"),
		)
	}
	home, _ := os.UserHomeDir()
	candidates = append(candidates,
		filepath.Join(home, "cli-agents"),
		filepath.Join(home, "dist", "cli-agents"),
	)
	for _, dir := range candidates {
		if fileExists(filepath.Join(dir, "cascade-note")) {
			return dir
		}
	}
	if len(candidates) > 0 {
		return candidates[0]
	}
	return "cli-agents"
}

func currentNoteToken() string {
	token := ""
	if noteAPI.Configured {
		token = noteAPI.Token
	} else {
		token = noteAPI.Token
	}
	if token == "" {
		token = os.Getenv("CASCADE_NOTE_TOKEN")
	}
	if token == "" || isExpiredJWT(token) {
		if disk := readTrimmed(filepath.Join(fizzerDir(), "token")); disk != "" && !isExpiredJWT(disk) {
			token = disk
		}
	}
	return token
}

func currentNoteURL() string {
	if noteAPI.Configured && noteAPI.URL != "" {
		return strings.TrimRight(noteAPI.URL, "/")
	}
	if noteAPI.URL != "" {
		return strings.TrimRight(noteAPI.URL, "/")
	}
	if v := os.Getenv("CASCADE_NOTE_URL"); v != "" {
		return strings.TrimRight(v, "/")
	}
	return "https://cscd.online"
}

func writeHelperConfig(opts map[string]any, runID int) string {
	token := currentNoteToken()
	chat, _ := opts["chat"].(map[string]any)
	payload := map[string]any{
		"url":                     currentNoteURL(),
		"token":                   token,
		"vaultId":                 firstNonEmpty(str(opts["vaultId"]), os.Getenv("CASCADE_NOTE_VAULT")),
		"chatChannelId":           firstNonEmpty(str(opts["chatChannelId"]), str(chat["channelId"]), os.Getenv("CASCADE_CHAT_CHANNEL")),
		"chatMessageId":           firstNonEmpty(str(opts["chatMessageId"]), str(chat["messageId"]), os.Getenv("CASCADE_CHAT_MESSAGE")),
		"chatTriggeringMessageId": firstNonEmpty(str(opts["chatTriggeringMessageId"]), str(chat["triggeringMessageId"]), os.Getenv("CASCADE_CHAT_TRIGGERING_MESSAGE")),
		"chatAuthor":              firstNonEmpty(str(opts["chatAuthor"]), str(chat["author"]), os.Getenv("CASCADE_CHAT_AUTHOR")),
		"agentId":                 str(opts["agent"]),
		"agentMemoryKey":          str(opts["agentMemoryKey"]),
		"registrationId":          str(opts["chatRegistrationId"]),
		"workItemId":              str(opts["workItemId"]),
		"helperDir":               resolveWrapperDir(),
		"updatedAt":               time.Now().UTC().Format(time.RFC3339),
	}
	if runID > 0 {
		payload["runId"] = runID
	}
	configPath := runHelperConfigPath(runID)
	writeJSONFile(configPath, payload)
	if configPath != helperConfigPath() {
		writeJSONFile(helperConfigPath(), payload)
	}
	return configPath
}

func writeJSONFile(path string, payload map[string]any) {
	data, _ := json.MarshalIndent(payload, "", "  ")
	_ = os.MkdirAll(filepath.Dir(path), 0o700)
	_ = os.WriteFile(path, append(data, '\n'), 0o600)
}

func buildRunHelperEnv(opts map[string]any, runID int) []string {
	configPath := writeHelperConfig(opts, runID)
	env := os.Environ()
	env = append(env,
		"CASCADE_NOTE_URL="+currentNoteURL(),
		"CASCADE_NOTE_TOKEN="+currentNoteToken(),
		"CASCADE_HELPER_CONFIG="+configPath,
		"CASCADE_HELPER_DIR="+resolveWrapperDir(),
	)
	if vault := str(opts["vaultId"]); vault != "" {
		env = append(env, "CASCADE_NOTE_VAULT="+vault)
	}
	if ch := firstNonEmpty(str(opts["chatChannelId"]), str(opts["chat"].(map[string]any)["channelId"])); ch != "" {
		env = append(env, "CASCADE_CHAT_CHANNEL="+ch)
	}
	if msg := firstNonEmpty(str(opts["chatMessageId"]), str(opts["chat"].(map[string]any)["messageId"])); msg != "" {
		env = append(env, "CASCADE_CHAT_MESSAGE="+msg)
	}
	if author := str(opts["chatAuthor"]); author != "" {
		env = append(env, "CASCADE_CHAT_AUTHOR="+author)
	}
	if work := str(opts["workItemId"]); work != "" {
		env = append(env, "CASCADE_WORK_ITEM_ID="+work)
	}
	if runID > 0 {
		env = append(env, fmt.Sprintf("CASCADE_RUN_ID=%d", runID))
	}
	path := os.Getenv("PATH")
	helperDir := resolveWrapperDir()
	if !pathContains(path, helperDir) {
		path = helperDir + string(os.PathListSeparator) + path
	}
	for _, dir := range []string{userBinDir(), homeJoin(".bun", "bin"), homeJoin(".npm-global", "bin"), homeJoin("node_modules", ".bin")} {
		if dirExists(dir) && !pathContains(path, dir) {
			path = dir + string(os.PathListSeparator) + path
		}
	}
	env = append(env, "PATH="+path)
	return env
}

func homeJoin(parts ...string) string {
	home, _ := os.UserHomeDir()
	return filepath.Join(append([]string{home}, parts...)...)
}

func pathContains(path, dir string) bool {
	for _, p := range strings.Split(path, string(os.PathListSeparator)) {
		if p == dir {
			return true
		}
	}
	return false
}

func dirExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

func helperAllowedTools() []string {
	helperDir := resolveWrapperDir()
	var commands []string
	for _, name := range helperNames() {
		commands = append(commands, name, filepath.Join(helperDir, name), filepath.Join(userBinDir(), name))
	}
	var rules []string
	for _, command := range commands {
		rules = append(rules, "Bash("+command+")", "Bash("+command+" *)")
	}
	return rules
}

func resolveAgentCwd(inputCwd, vaultRoot string) string {
	expanded := expandHomePath(inputCwd)
	if expanded != "" {
		if info, err := os.Stat(expanded); err == nil && info.IsDir() {
			if abs, err := filepath.Abs(expanded); err == nil {
				return abs
			}
			return expanded
		}
	}
	root := strings.TrimSpace(vaultRoot)
	if root != "" {
		if info, err := os.Stat(root); err == nil && info.IsDir() {
			if abs, err := filepath.Abs(root); err == nil {
				return abs
			}
			return root
		}
	}
	home, _ := os.UserHomeDir()
	return home
}

func runClaudeNative(opts map[string]any, emit func(string, string), status func(string, string, map[string]any)) (map[string]any, error) {
	runID := int(numberOf(opts["runId"]))
	agentClaudeMu.Lock()
	delete(canceledAgentRun, runID)
	agentClaudeMu.Unlock()

	result, err := runClaudeOnce(opts, emit, status, "")
	if err == nil {
		return map[string]any{"summary": result.Summary, "sessionId": result.Session}, nil
	}
	if isCanceledRun(runID) {
		return nil, errClaudeCanceled
	}
	if result != nil && result.Timeout {
		harnessNote(emit, "\x1b[2m# Claude did not start — retrying once\x1b[0m\r\n")
		result, err = runClaudeOnce(opts, emit, status, "")
		if err == nil {
			return map[string]any{"summary": result.Summary, "sessionId": result.Session}, nil
		}
		if isCanceledRun(runID) {
			return nil, errClaudeCanceled
		}
	}
	return nil, err
}

var errClaudeCanceled = fmt.Errorf("Run canceled.")

func isCanceledRun(runID int) bool {
	agentClaudeMu.Lock()
	defer agentClaudeMu.Unlock()
	return canceledAgentRun[runID]
}

func harnessNote(emit func(string, string), data string) {
	if data != "" {
		emit("harness", jsonString(map[string]string{"data": data}))
	}
}

func jsonString(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func claudeImages(opts map[string]any) []map[string]any {
	raw, ok := opts["images"].([]any)
	if !ok {
		return nil
	}
	var images []map[string]any
	for _, item := range raw {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		mediaType, _ := m["media_type"].(string)
		data, _ := m["data"].(string)
		if mediaType == "" || data == "" {
			continue
		}
		images = append(images, map[string]any{"media_type": mediaType, "data": data})
	}
	return images
}

type requestTiming struct {
	emit      func(string, string)
	requestID string
	boundary  string
	started   time.Time
	responded bool
	completed bool
}

func newRequestTiming(emit func(string, string), boundary string) *requestTiming {
	id := make([]byte, 12)
	_, _ = rand.Read(id)
	t := &requestTiming{
		emit:      emit,
		requestID: hex.EncodeToString(id),
		boundary:  boundary,
		started:   time.Now(),
	}
	t.record("request_start", "", false)
	return t
}

func (t *requestTiming) record(phase, outcome string, hasOutcome bool) {
	payload := map[string]any{
		"requestId":  t.requestID,
		"boundary":   t.boundary,
		"phase":      phase,
		"observedAt": time.Now().UTC().Format(time.RFC3339Nano),
		"elapsedMs":  float64(time.Since(t.started).Microseconds()) / 1000.0,
	}
	if hasOutcome {
		payload["outcome"] = outcome
	}
	body, _ := json.Marshal(payload)
	t.emit("timing", string(body))
}

func (t *requestTiming) firstResponse() {
	if t.responded || t.completed {
		return
	}
	t.responded = true
	t.record("first_response", "", false)
}

func (t *requestTiming) complete(outcome string) {
	if t.completed {
		return
	}
	t.completed = true
	t.record("completion", outcome, true)
}

func runClaudeOnce(opts map[string]any, emit func(string, string), status func(string, string, map[string]any), resumeHint string) (*claudeRunResult, error) {
	runID := int(numberOf(opts["runId"]))
	model := strings.TrimSpace(str(opts["model"]))
	if model == "" {
		model = claudeDefaultModel()
	}
	chatRun := isChatRun(opts)
	effort := normalizeClaudeEffort(str(opts["reasoningEffort"]), claudeDefaultEffort(chatRun))
	resume := str(opts["resumeSessionId"])
	if resumeHint != "" {
		resume = resumeHint
	}
	cwd := resolveAgentCwd(str(opts["cwd"]), str(opts["vaultRoot"]))
	prompt := str(opts["prompt"])
	images := claudeImages(opts)

	bin := os.Getenv("CLAUDE_BIN")
	if bin == "" {
		bin = "claude"
	}
	args := []string{
		"--print", "--verbose",
		"--output-format", "stream-json",
		"--include-partial-messages",
		"--model", model,
		"--effort", effort,
	}
	if truthy(opts["yolo"]) {
		args = append(args, "--permission-mode", "bypassPermissions", "--allow-dangerously-skip-permissions")
	} else {
		args = append(args, "--permission-mode", "acceptEdits")
	}
	args = append(args, "--allowedTools", strings.Join(helperAllowedTools(), ","))
	if chatRun {
		args = append(args, "--append-system-prompt", chatBrevityContext+" "+chatContextToolContext)
	} else {
		args = append(args, "--append-system-prompt", claudeAgentContext+" "+noteCapabilityContext(opts))
	}
	if resume != "" {
		args = append(args, "--resume", resume)
	}
	if len(images) > 0 {
		args = append(args, "--input-format", "stream-json")
	} else {
		args = append(args, prompt)
	}

	cmd := exec.Command(bin, args...)
	cmd.Dir = cwd
	cmd.Env = buildRunHelperEnv(opts, runID)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	var stderr strings.Builder
	cmd.Stderr = &stderrBuf{&stderr}

	timing := newRequestTiming(emit, "claude_cli_stdout")
	if err := cmd.Start(); err != nil {
		timing.complete("launch_failed")
		return nil, fmt.Errorf("%s could not be started: %w. Is it installed and on PATH?", bin, err)
	}
	agentClaudeMu.Lock()
	activeClaude[runID] = cmd
	agentClaudeMu.Unlock()
	defer func() {
		agentClaudeMu.Lock()
		delete(activeClaude, runID)
		agentClaudeMu.Unlock()
	}()

	if len(images) > 0 {
		content := []any{map[string]any{"type": "text", "text": prompt}}
		for _, img := range images {
			content = append(content, map[string]any{"type": "image", "source": map[string]any{
				"type": "base64", "media_type": img["media_type"], "data": img["data"],
			}})
		}
		line, _ := json.Marshal(map[string]any{
			"type":               "user",
			"message":            map[string]any{"role": "user", "content": content},
			"parent_tool_use_id": nil,
			"session_id":         resume,
		})
		_, _ = stdin.Write(append(line, '\n'))
	}
	_ = stdin.Close()

	harnessNote(emit, fmt.Sprintf("\x1b[2m# claude-code %s · %s\x1b[0m\r\n", model, cwd))
	emit("harness", jsonString(map[string]string{"data": ""}))
	emitStats(emit, map[string]any{"model": model})

	finished := make(chan error, 1)
	go func() { finished <- cmd.Wait() }()

	startupTimer := time.NewTimer(45 * time.Second)
	defer startupTimer.Stop()
	sawMessage := false
	startupTimedOut := false
	go func() {
		<-startupTimer.C
		agentClaudeMu.Lock()
		alive := activeClaude[runID] == cmd && !canceledAgentRun[runID]
		agentClaudeMu.Unlock()
		if alive && !sawMessage {
			startupTimedOut = true
			_ = cmd.Process.Signal(syscall.SIGTERM)
		}
	}()

	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 1024*1024), 32*1024*1024)
	summary := ""
	sessionID := ""
	streamed := strings.Builder{}
	latestAssistant := strings.Builder{}

	for scanner.Scan() {
		line := scanner.Text()
		if strings.TrimSpace(line) == "" {
			continue
		}
		var message map[string]any
		if json.Unmarshal([]byte(line), &message) != nil {
			continue
		}
		sawMessage = true
		timing.firstResponse()
		if !startupTimer.Stop() {
			select {
			case <-startupTimer.C:
			default:
			}
		}
		if sid := str(message["session_id"]); sid != "" && sid != sessionID {
			sessionID = sid
			emit("session", jsonString(map[string]string{"sessionId": sid}))
		}
		msgType := str(message["type"])
		switch msgType {
		case "stream_event":
			event, _ := message["event"].(map[string]any)
			handleClaudeStreamEvent(event, emit, &streamed, &latestAssistant)
		case "assistant":
			emit("assistant-turn-end", "{}")
		case "result":
			summary = firstNonEmpty(str(message["result"]), str(message["subtype"]), summary)
			emitStats(emit, claudeResultStats(message, model))
			harnessNote(emit, fmt.Sprintf("\x1b[2m# result %s\x1b[0m\r\n", firstNonEmpty(str(message["subtype"]), str(message["result"]), "done")))
		case "system":
			harnessNote(emit, fmt.Sprintf("\x1b[2m# system %s\x1b[0m\r\n", str(message["subtype"])))
		case "rate_limit_event":
			// optional telemetry; skip for now
		}
		payload := jsonString(message)
		emit(classifyClaudeMessage(msgType), payload)
		if msgType == "result" {
			summary = firstNonEmpty(str(message["result"]), str(message["subtype"]), summary)
		}
	}

	waitErr := <-finished
	agentClaudeMu.Lock()
	wasCanceled := canceledAgentRun[runID]
	delete(canceledAgentRun, runID)
	agentClaudeMu.Unlock()

	if wasCanceled {
		timing.complete("signaled")
		return &claudeRunResult{Canceled: true, Session: sessionID}, errClaudeCanceled
	}
	if startupTimedOut {
		timing.complete("signaled")
		return &claudeRunResult{Timeout: true, Session: sessionID}, fmt.Errorf("Claude produced no startup event; retrying the session.")
	}
	if waitErr != nil && !sawMessage {
		timing.complete("failed")
		return nil, fmt.Errorf("%s", strings.TrimSpace(stderr.String()))
	}
	if waitErr != nil && !isExitOk(waitErr) {
		timing.complete("failed")
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = summary
		}
		if msg == "" {
			msg = fmt.Sprintf("Claude CLI exited: %v", waitErr)
		}
		return nil, fmt.Errorf("%s", msg)
	}
	timing.complete("completed")
	finalSummary := summary
	if chatRun {
		if v := strings.TrimSpace(latestAssistant.String()); v != "" {
			finalSummary = v
		} else if v := strings.TrimSpace(streamed.String()); v != "" {
			finalSummary = v
		}
	} else if finalSummary == "" {
		finalSummary = strings.TrimSpace(streamed.String())
	}
	return &claudeRunResult{Summary: finalSummary, Session: sessionID}, nil
}

type stderrBuf struct {
	b *strings.Builder
}

func (s *stderrBuf) Write(p []byte) (int, error) {
	return s.b.Write(p)
}

func isExitOk(err error) bool {
	if err == nil {
		return true
	}
	if ee, ok := err.(*exec.ExitError); ok {
		return ee.ExitCode() == 0
	}
	return false
}

func classifyClaudeMessage(t string) string {
	switch t {
	case "assistant":
		return "text"
	case "result":
		return "result"
	case "system":
		return "system"
	case "":
		return "message"
	}
	return t
}

func handleClaudeStreamEvent(event map[string]any, emit func(string, string), streamed, latestAssistant *strings.Builder) {
	if event == nil {
		return
	}
	switch str(event["type"]) {
	case "message_start":
		latestAssistant.Reset()
	case "content_block_start":
		block, _ := event["content_block"].(map[string]any)
		switch str(block["type"]) {
		case "thinking", "redacted_thinking":
			if str(block["type"]) == "redacted_thinking" {
				emit("text", jsonString(map[string]any{"message": map[string]any{"content": []any{map[string]string{"type": "redacted_thinking"}}}}))
				harnessNote(emit, "\x1b[2m[redacted]\x1b[0m")
			}
		case "tool_use":
			id := str(block["id"])
			if id == "" {
				id = fmt.Sprintf("tool-%d", time.Now().UnixMilli())
			}
			name := firstNonEmpty(str(block["name"]), "tool")
			input, _ := block["input"].(map[string]any)
			if input == nil {
				input = map[string]any{}
			}
			emit("text", jsonString(map[string]any{"message": map[string]any{"content": []any{map[string]any{
				"type": "tool_use", "id": id, "name": name, "input": input,
			}}}}))
			preview := formatToolInput(input)
			if len(preview) > 200 {
				preview = preview[:200]
			}
			if preview != "" {
				harnessNote(emit, fmt.Sprintf("\x1b[36m▶ %s\x1b[0m %s\r\n", name, preview))
			}
		case "text":
			emit("text", jsonString(map[string]any{
				"chatVisible": true,
				"message":     map[string]any{"content": []any{map[string]string{"type": "text", "text": "\n\n"}}},
			}))
			harnessNote(emit, "\r\n\r\n")
			streamed.WriteString("\n\n")
		}
	case "content_block_delta":
		delta, _ := event["delta"].(map[string]any)
		switch str(delta["type"]) {
		case "thinking_delta":
			if t := str(delta["thinking"]); t != "" {
				emit("text", jsonString(map[string]any{"message": map[string]any{"content": []any{map[string]string{"type": "thinking", "thinking": t}}}}))
				harnessNote(emit, "\x1b[2m"+t+"\x1b[0m")
			}
		case "text_delta":
			if t := str(delta["text"]); t != "" {
				emit("text", jsonString(map[string]any{
					"chatVisible": true,
					"message":     map[string]any{"content": []any{map[string]string{"type": "text", "text": t}}},
				}))
				harnessNote(emit, t)
				streamed.WriteString(t)
				latestAssistant.WriteString(t)
			}
		}
	case "content_block_stop":
		harnessNote(emit, "\r\n")
	}
}

func formatToolInput(input any) string {
	switch t := input.(type) {
	case nil:
		return ""
	case string:
		return t
	default:
		b, err := json.Marshal(t)
		if err != nil {
			return fmt.Sprint(t)
		}
		return string(b)
	}
}

func emitStats(emit func(string, string), stats map[string]any) {
	clean := map[string]any{}
	for k, v := range stats {
		if v == nil {
			continue
		}
		if s, ok := v.(string); ok && s == "" {
			continue
		}
		clean[k] = v
	}
	if len(clean) == 0 {
		return
	}
	body, _ := json.Marshal(clean)
	harnessNote(emit, fmt.Sprintf("\x1b[2m# cascade-stats %s\x1b[0m\r\n", body))
}

func claudeResultStats(message map[string]any, model string) map[string]any {
	usage, _ := message["usage"].(map[string]any)
	modelUsage, _ := message["modelUsage"].(map[string]any)
	if modelUsage == nil {
		modelUsage = map[string]any{}
	}
	mu, _ := modelUsage[model].(map[string]any)
	if mu == nil {
		for _, v := range modelUsage {
			if m, ok := v.(map[string]any); ok {
				mu = m
				break
			}
		}
	}
	stats := map[string]any{"model": model}
	if usage != nil {
		if v, ok := numOrUndef(usage["input_tokens"]); ok {
			stats["inputTokens"] = v
		}
		if v, ok := numOrUndef(usage["output_tokens"]); ok {
			stats["outputTokens"] = v
		}
		if v, ok := numOrUndef(usage["cache_read_input_tokens"]); ok {
			stats["cacheReadTokens"] = v
		}
		if v, ok := numOrUndef(usage["cache_creation_input_tokens"]); ok {
			stats["cacheWriteTokens"] = v
		}
	}
	if v, ok := numOrUndef(message["total_cost_usd"]); ok {
		stats["totalCostUsd"] = v
	}
	if v, ok := numOrUndef(message["num_turns"]); ok {
		stats["numTurns"] = v
	}
	if v, ok := numOrUndef(message["duration_ms"]); ok {
		stats["durationMs"] = v
	}
	if mu != nil {
		if v, ok := numOrUndef(mu["contextWindow"]); ok {
			stats["contextWindow"] = v
		}
	}
	return stats
}

func numOrUndef(v any) (any, bool) {
	switch t := v.(type) {
	case float64:
		return t, true
	case int:
		return float64(t), true
	case string:
		if t == "" {
			return nil, false
		}
		var f float64
		if _, err := fmt.Sscanf(t, "%g", &f); err == nil {
			return f, true
		}
	}
	return nil, false
}

func cliAgentBridgePath() string {
	return filepath.Join(repoRoot(), "scripts", "cli-agent-bridge.mjs")
}

func runCliAgentBridge(opts map[string]any, emit func(string, string), status func(string, string, map[string]any)) (map[string]any, error) {
	runID := int(numberOf(opts["runId"]))
	bridge := cliAgentBridgePath()
	if !fileExists(bridge) {
		return nil, fmt.Errorf("CLI agent bridge is missing: %s", bridge)
	}
	nodeBin := os.Getenv("FIZZER_NODE_BIN")
	if nodeBin == "" {
		nodeBin = "node"
	}
	cmd := exec.Command(nodeBin, bridge)
	cmd.Dir = resolveAgentCwd(str(opts["cwd"]), str(opts["vaultRoot"]))
	cmd.Env = buildRunHelperEnv(opts, runID)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	var stderr strings.Builder
	cmd.Stderr = &stderrBuf{&stderr}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("Failed to launch CLI agent bridge: %w", err)
	}
	agentClaudeMu.Lock()
	activeClaude[runID] = cmd
	agentClaudeMu.Unlock()
	defer func() {
		agentClaudeMu.Lock()
		delete(activeClaude, runID)
		agentClaudeMu.Unlock()
	}()

	payload, _ := json.Marshal(opts)
	if _, err := stdin.Write(payload); err != nil {
		_ = cmd.Process.Kill()
		return nil, err
	}
	_ = stdin.Close()

	var result map[string]any
	var failure string
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 1024*1024), 32*1024*1024)
	for scanner.Scan() {
		var msg struct {
			Event  *agentRunEvent `json:"event"`
			Result map[string]any `json:"result"`
			Error  string         `json:"error"`
		}
		if json.Unmarshal(scanner.Bytes(), &msg) != nil {
			continue
		}
		if msg.Event != nil {
			emit(msg.Event.Type, msg.Event.PayloadJSON)
		}
		if msg.Result != nil {
			result = msg.Result
		}
		if msg.Error != "" {
			failure = msg.Error
		}
	}
	waitErr := cmd.Wait()
	if isCanceledRun(runID) {
		return map[string]any{}, errClaudeCanceled
	}
	if failure != "" {
		return nil, fmt.Errorf("%s", failure)
	}
	if waitErr != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = fmt.Sprintf("CLI agent bridge exited: %v", waitErr)
		}
		return nil, fmt.Errorf("%s", msg)
	}
	if result == nil {
		result = map[string]any{}
	}
	return result, nil
}

type agentRunStartInput struct {
	Opts       map[string]any `json:"opts"`
	API        *runAPI        `json:"api"`
	Root       string         `json:"root"`
	MirrorRoot string         `json:"mirrorRoot"`
}

func AgentRunCLI(args []string) int {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "Usage: fizzer-storage agent-run <start|cancel|reap> [json]")
		return 1
	}
	switch args[0] {
	case "start":
		arg := ""
		if len(args) > 1 {
			arg = args[1]
		}
		data, err := readInput(arg)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			return 1
		}
		var input agentRunStartInput
		if err := json.Unmarshal(data, &input); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			return 1
		}
		if input.Opts == nil {
			fmt.Fprintln(os.Stderr, "Error: opts is required")
			return 1
		}
		if input.API == nil {
			input.API = &runAPI{URL: apiBaseFromEnv(), Origin: apiBaseFromEnv(), Token: resolveToken()}
		}
		api := input.API
		if api.Token == "" {
			api.Token = resolveToken()
		}
		setNoteAPIConfig(api.URL, api.Token, firstNonEmpty(api.Origin, api.URL), api.WriteToken)

		runID := int(numberOf(input.Opts["runId"]))
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGTERM)
		defer signal.Stop(sigCh)
		go func() {
			<-sigCh
			if runID > 0 {
				cancelLocalAgentRun(runID)
			}
		}()

		out := bufio.NewWriter(os.Stdout)
		emit := func(ev agentRunEvent) {
			line, _ := json.Marshal(map[string]any{"event": ev})
			_, _ = out.Write(append(line, '\n'))
			_ = out.Flush()
		}
		result, runErr := executeLocalAgentRun(input.Opts, api, input.Root, input.MirrorRoot, emit)
		if runErr != nil {
			payload, _ := json.Marshal(map[string]string{"error": runErr.Error()})
			_, _ = out.Write(append(payload, '\n'))
			_ = out.Flush()
			if runErr == errClaudeCanceled {
				return 0
			}
			return 1
		}
		payload, _ := json.Marshal(map[string]any{"result": result})
		_, _ = out.Write(append(payload, '\n'))
		_ = out.Flush()
		return 0
	case "cancel":
		runID := 0
		if len(args) > 1 {
			if strings.HasPrefix(args[1], "{") {
				var input struct {
					RunID int `json:"runId"`
				}
				_ = json.Unmarshal([]byte(args[1]), &input)
				runID = input.RunID
			} else {
				fmt.Sscanf(args[1], "%d", &runID)
			}
		}
		if runID <= 0 {
			fmt.Fprintln(os.Stderr, "Error: runId is required")
			return 1
		}
		if cancelLocalAgentRun(runID) {
			return 0
		}
		return 1
	case "reap":
		reapOrphanedAgentRuns()
		return 0
	default:
		fmt.Fprintln(os.Stderr, "unknown agent-run subcommand:", args[0])
		return 1
	}
}
