package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

var deadCodexSession = regexp.MustCompile(`(?i)no rollout found|thread/resume failed|session not found`)
var activeWriter = regexp.MustCompile(`(?i)active writer`)

func isDeadCodexSession(text string) bool { return deadCodexSession.MatchString(text) }

func normalizeCodexEffort(value string) string {
	effort := strings.ToLower(strings.TrimSpace(value))
	switch effort {
	case "low", "medium", "high", "xhigh", "max", "ultra":
		return effort
	}
	return ""
}

func codexSandbox(o cliAgentOpts) string {
	if o.sandbox != "" {
		return o.sandbox
	}
	if o.yolo {
		return "danger-full-access"
	}
	return "workspace-write"
}

// A model of the form openrouter/<provider>/<model> runs Codex against
// OpenRouter's Responses endpoint instead of the default provider.
func openRouterModel(model string) string {
	trimmed := strings.TrimSpace(model)
	if rest, ok := strings.CutPrefix(trimmed, "openrouter/"); ok {
		return rest
	}
	return ""
}

func openRouterAPIKey() string {
	if key := strings.TrimSpace(os.Getenv("OPENROUTER_API_KEY")); key != "" {
		return key
	}
	return readTrimmed(homeJoin("openrouter"))
}

var openRouterProviderArgs = []string{
	"-c", `model_providers.openrouter.name="OpenRouter"`,
	"-c", `model_providers.openrouter.base_url="https://openrouter.ai/api/v1"`,
	"-c", `model_providers.openrouter.env_key="OPENROUTER_API_KEY"`,
	"-c", `model_providers.openrouter.wire_api="responses"`,
	"-c", `model_provider="openrouter"`,
}

func persistentCodexEnabled() bool {
	return os.Getenv("RUNNER_CODEX_PERSISTENT") != "0" && filepath.Base(cliAgentBin("codex")) == "codex"
}

func runCodex(o cliAgentOpts) (cliAgentResult, error) {
	openRouterID := openRouterModel(o.model)
	imagePaths, cleanup, err := writeTempImages(o.images)
	if err != nil {
		return cliAgentResult{}, err
	}
	defer cleanup()
	if persistentCodexEnabled() && openRouterID == "" {
		return codexServer.run(o, imagePaths)
	}
	return runCodexExec(o, imagePaths, openRouterID)
}

// runCodexExec drives `codex exec --json` and translates its JSONL events.
func runCodexExec(o cliAgentOpts, imagePaths []string, openRouterID string) (cliAgentResult, error) {
	// -i is variadic, so it must follow the positional prompt (and resume id).
	var imageArgs []string
	for _, p := range imagePaths {
		imageArgs = append(imageArgs, "-i", p)
	}
	effectiveModel := firstNonEmpty(openRouterID, o.model)
	var modelArgs, providerArgs, effortArgs, tierArgs, sandboxConfig []string
	if effectiveModel != "" {
		modelArgs = []string{"--model", effectiveModel}
	}
	env := o.env
	if openRouterID != "" {
		providerArgs = append(providerArgs, openRouterProviderArgs...)
		key := openRouterAPIKey()
		if key == "" {
			return cliAgentResult{}, errors.New("OpenRouter API key not found. Set OPENROUTER_API_KEY or create ~/openrouter.")
		}
		env = withEnv(env, "OPENROUTER_API_KEY="+key)
	}
	if o.remoteVault {
		providerArgs = append(providerArgs, "-c", "project_root_markers=[]")
	}
	if effort := normalizeCodexEffort(o.reasoningEffort); effort != "" {
		effortArgs = []string{"-c", fmt.Sprintf(`model_reasoning_effort="%s"`, effort)}
	}
	if o.priorityServiceTier {
		tierArgs = []string{"-c", `service_tier="priority"`}
	}
	sandbox := codexSandbox(o)
	if sandbox == "workspace-write" {
		sandboxConfig = []string{"-c", "sandbox_workspace_write.network_access=true"}
	}
	// `codex exec resume` rejects --sandbox, so resume sets it via -c.
	buildArgs := func(resume string) []string {
		var args []string
		if resume != "" {
			args = []string{"exec", "resume", "--json", "--skip-git-repo-check", "-c", "sandbox_mode=" + sandbox}
		} else {
			args = []string{"exec", "--json", "--skip-git-repo-check", "--sandbox", sandbox}
		}
		for _, group := range [][]string{sandboxConfig, providerArgs, effortArgs, tierArgs, modelArgs} {
			args = append(args, group...)
		}
		if resume != "" {
			args = append(args, resume)
		}
		args = append(args, o.prompt)
		return append(args, imageArgs...)
	}

	summary, sessionID := "", ""
	emittedText := false
	turns := 0
	emittedTools := map[string]bool{}
	if effectiveModel != "" {
		emitStats(o.emit, map[string]any{"model": effectiveModel})
	}
	toolUse := func(item map[string]any) {
		id := str(item["id"])
		if id == "" || emittedTools[id] {
			return
		}
		emittedTools[id] = true
		switch item["type"] {
		case "command_execution":
			emitToolUse(o.emit, id, "Bash", map[string]any{"command": str(item["command"])})
		case "file_change":
			file := str(item["path"])
			if file == "" {
				if changes, _ := item["changes"].([]any); len(changes) > 0 {
					file = str(asObject(changes[0])["path"])
				}
			}
			emitToolUse(o.emit, id, "Edit", map[string]any{"file_path": firstNonEmpty(file, "(files)")})
		default:
			emitToolUse(o.emit, id, str(item["type"]), map[string]any{})
		}
	}
	onLine := func(line string, _ bool) {
		ev, ok := jsonLine(line)
		if !ok {
			return
		}
		item := asObject(ev["item"])
		if ev["type"] == "turn.completed" {
			emitValue(o.emit, "assistant-turn-end", map[string]any{})
		}
		// Usage can appear on turn.completed or nested event_msg token_count payloads.
		if usage := asObject(ev["usage"]); ev["type"] == "turn.completed" && usage != nil {
			turns++
			emitStats(o.emit, statsFromUsage(usage, map[string]any{"model": o.model, "numTurns": turns}))
		} else if payload := asObject(ev["payload"]); ev["type"] == "event_msg" && payload != nil {
			if payload["type"] == "token_count" {
				info := asObject(payload["info"])
				if info == nil {
					info = payload
				}
				// Resumed sessions report cumulative and per-turn usage; show the turn.
				usage := asObject(info["last_token_usage"])
				if usage == nil {
					usage = asObject(info["total_token_usage"])
				}
				if usage == nil {
					usage = info
				}
				extra := map[string]any{"model": o.model}
				if turns > 0 {
					extra["numTurns"] = turns
				}
				emitStats(o.emit, statsFromUsage(usage, extra))
			}
		} else if usage != nil {
			emitStats(o.emit, statsFromUsage(usage, map[string]any{"model": o.model}))
		}
		switch ev["type"] {
		case "thread.started":
			if id := str(ev["thread_id"]); id != "" {
				sessionID = id
				emitSession(o.emit, id)
			}
		case "item.started":
			if item != nil && item["type"] != "agent_message" && item["type"] != "reasoning" {
				toolUse(item)
			}
		case "item.completed":
			if item == nil {
				return
			}
			switch item["type"] {
			case "agent_message":
				// Reasoning arrives separately, so an agent_message is safe to show in chat.
				text := str(item["text"])
				if text != "" {
					summary = text
				}
				prefix := ""
				if emittedText {
					prefix = "\n\n"
				}
				emitValue(o.emit, "text", map[string]any{"chatVisible": true,
					"message": map[string]any{"content": []any{map[string]any{"type": "text", "text": prefix + text}}}})
				if text != "" {
					emittedText = true
				}
			case "reasoning":
				emitBlocks(o.emit, "text", map[string]any{"type": "thinking", "text": str(item["text"])})
			default:
				toolUse(item)
				out := anyText(firstNonNil(item["aggregated_output"], item["output"], ""))
				code, hasCode := item["exit_code"].(float64)
				isError := hasCode && code != 0
				emitToolResult(o.emit, str(item["id"]), out, isError)
				if isError {
					autoPapercut(out, firstNonEmpty(str(item["type"]), str(item["name"]), "tool"), o.env)
				}
			}
		}
	}
	// A resumable session lives in Codex's local store, which can prune it.
	// The session is an optimization, so lose it and start fresh instead.
	var stderrText strings.Builder
	drive := func(args []string) (string, error) {
		return driveProcess(driveSpec{bin: cliAgentBin("codex"), args: args, cwd: o.cwd, env: env, label: "Codex",
			runID: o.runID, emit: o.emit, onLine: onLine, summary: func() string { return summary },
			onStderr: func(chunk string) { stderrText.WriteString(chunk) }})
	}
	retryFresh := func() (cliAgentResult, error) {
		if o.resumeID != "" && envValue(o.env, "CASCADE_IMPORTED_CODEX_SESSION") == o.resumeID {
			return cliAgentResult{}, errors.New("The imported Codex session could not be resumed. Its history was preserved; no replacement session was started.")
		}
		harnessNote(o.emit, "\x1b[33m# that session is gone from Codex's store — starting a fresh one\x1b[0m\r\n")
		stderrText.Reset()
		text, err := drive(buildArgs(""))
		if err != nil {
			return cliAgentResult{}, err
		}
		return cliAgentResult{summary: text, sessionID: sessionID}, nil
	}
	text, err := drive(buildArgs(o.resumeID))
	if err != nil {
		if o.resumeID != "" && isDeadCodexSession(stderrText.String()+"\n"+err.Error()) {
			return retryFresh()
		}
		return cliAgentResult{}, err
	}
	// A zero exit with the complaint only on stderr would otherwise say nothing.
	if o.resumeID != "" && sessionID == "" && isDeadCodexSession(stderrText.String()) {
		return retryFresh()
	}
	return cliAgentResult{summary: text, sessionID: sessionID}, nil
}

// ── persistent app-server ─────────────────────────────────────
// One long-lived protocol peer avoids rebuilding Codex's app-server every turn.

type rpcReply struct {
	result map[string]any
	err    error
}

type codexTurn struct {
	mu               sync.Mutex
	threadID, turnID string
	runID            int
	emit             runEmit
	summary          string
	emittedText      bool
	emittedTools     map[string]bool
	agentText        map[string]string
	idle             *time.Timer
	timing           *requestTiming
	done             chan error
}

type codexAppServer struct {
	mu          sync.Mutex
	cmd         *exec.Cmd
	stdin       io.WriteCloser
	stderr      string
	nextID      int
	ready       bool
	pending     map[int]chan rpcReply
	turns       map[string]*codexTurn
	early       map[string][]map[string]any
	threadLocks map[string]*sync.Mutex
}

var codexServer = &codexAppServer{}

func (s *codexAppServer) run(o cliAgentOpts, imagePaths []string) (cliAgentResult, error) {
	threadID := strings.TrimSpace(o.resumeID)
	if threadID == "" {
		return s.runUnlocked(o, imagePaths)
	}
	// Codex permits one writer per resumed thread; serialize retries and restarts.
	s.mu.Lock()
	if s.threadLocks == nil {
		s.threadLocks = map[string]*sync.Mutex{}
	}
	lock := s.threadLocks[threadID]
	if lock == nil {
		lock = &sync.Mutex{}
		s.threadLocks[threadID] = lock
	}
	s.mu.Unlock()
	lock.Lock()
	defer lock.Unlock()
	return s.runUnlocked(o, imagePaths)
}

// environmentOverrides passes the run's helper environment to Codex's shell
// tools; the shared server itself was started with this process's environment.
func environmentOverrides(env []string) map[string]string {
	base := map[string]string{}
	for _, entry := range os.Environ() {
		key, value, _ := strings.Cut(entry, "=")
		base[key] = value
	}
	clean := map[string]string{}
	for _, entry := range env {
		key, value, _ := strings.Cut(entry, "=")
		if existing, ok := base[key]; !ok || existing != value {
			clean[key] = value
		}
	}
	return clean
}

func (s *codexAppServer) runUnlocked(o cliAgentOpts, imagePaths []string) (cliAgentResult, error) {
	if err := s.ensureStarted(); err != nil {
		return cliAgentResult{}, err
	}
	sandbox := codexSandbox(o)
	config := map[string]any{"shell_environment_policy": map[string]any{"inherit": "all", "set": environmentOverrides(o.env)}}
	if o.remoteVault {
		config["project_root_markers"] = []any{}
	}
	if sandbox == "workspace-write" {
		config["sandbox_workspace_write"] = map[string]any{"network_access": true}
	}
	var model, tier any
	if o.model != "" {
		model = o.model
	}
	if o.priorityServiceTier {
		tier = "priority"
	}
	common := map[string]any{"cwd": o.cwd, "model": model, "serviceTier": tier, "approvalPolicy": "never", "sandbox": sandbox, "config": config}
	response, err := s.openThread(o, common)
	if err != nil {
		return cliAgentResult{}, err
	}
	threadID := firstNonEmpty(str(asObject(response["thread"])["id"]), o.resumeID)
	if threadID == "" {
		return cliAgentResult{}, errors.New("Codex app-server did not return a thread id.")
	}
	input := []any{map[string]any{"type": "text", "text": o.prompt, "text_elements": []any{}}}
	for _, p := range imagePaths {
		input = append(input, map[string]any{"type": "localImage", "path": p})
	}
	var effort any
	if e := normalizeCodexEffort(o.reasoningEffort); e != "" {
		effort = e
	}
	turnParams := func(thread string) map[string]any {
		return map[string]any{"threadId": thread, "input": input, "cwd": o.cwd, "model": model,
			"serviceTier": tier, "effort": effort, "approvalPolicy": "never"}
	}
	timing := newRequestTiming(o.emit, "codex_app_server_turn")
	started, err := s.request("turn/start", turnParams(threadID))
	if err != nil {
		if !activeWriter.MatchString(err.Error()) || (o.resumeID != "" && envValue(o.env, "CASCADE_IMPORTED_CODEX_SESSION") == o.resumeID) {
			timing.complete("failed")
			return cliAgentResult{}, err
		}
		harnessNote(o.emit, "\x1b[33m# Codex left this thread busy — interrupting its unfinished turn\x1b[0m\r\n")
		retryErr := err
		if s.interruptActiveTurn(threadID) {
			started, retryErr = s.requestWithActiveWriterRetry("turn/start", turnParams(threadID))
		}
		if retryErr != nil {
			if !activeWriter.MatchString(retryErr.Error()) {
				timing.complete("failed")
				return cliAgentResult{}, retryErr
			}
			go s.request("thread/unsubscribe", map[string]any{"threadId": threadID})
			harnessNote(o.emit, "\x1b[33m# Codex did not release that thread — continuing in a fresh session\x1b[0m\r\n")
			fresh, err := s.request("thread/start", common)
			if err == nil {
				threadID = str(asObject(fresh["thread"])["id"])
				if threadID == "" {
					err = errors.New("Codex app-server did not return a replacement thread id.")
				}
			}
			if err == nil {
				started, err = s.request("turn/start", turnParams(threadID))
			}
			if err != nil {
				timing.complete("failed")
				return cliAgentResult{}, err
			}
		}
	}
	emitSession(o.emit, threadID)
	harnessNote(o.emit, fmt.Sprintf("\x1b[2m# codex app-server · %s\x1b[0m\r\n", o.cwd))
	if o.model != "" {
		emitStats(o.emit, map[string]any{"model": o.model})
	}
	turnID := str(asObject(started["turn"])["id"])
	if turnID == "" {
		timing.complete("failed")
		return cliAgentResult{}, errors.New("Codex app-server did not return a turn id.")
	}
	turn := &codexTurn{threadID: threadID, turnID: turnID, runID: o.runID, emit: o.emit, emittedTools: map[string]bool{},
		agentText: map[string]string{}, timing: timing, done: make(chan error, 1)}
	idleTimeout := cliIdleTimeout()
	turn.idle = time.AfterFunc(idleTimeout, func() {
		go s.request("turn/interrupt", map[string]any{"threadId": threadID, "turnId": turnID})
		s.finishTurn(turnID, fmt.Errorf("Codex produced no output for %dms and was stopped.", idleTimeout.Milliseconds()))
	})
	s.mu.Lock()
	s.turns[turnID] = turn
	buffered := s.early[turnID]
	delete(s.early, turnID)
	s.mu.Unlock()
	setCliCancel(o.runID, func() {
		go s.request("turn/interrupt", map[string]any{"threadId": threadID, "turnId": turnID})
	})
	for _, message := range buffered {
		s.onMessage(message)
	}
	if err := <-turn.done; err != nil {
		return cliAgentResult{}, err
	}
	return cliAgentResult{summary: turn.summary, sessionID: threadID}, nil
}

func (s *codexAppServer) openThread(o cliAgentOpts, common map[string]any) (map[string]any, error) {
	if o.resumeID == "" {
		return s.request("thread/start", common)
	}
	params := map[string]any{"threadId": o.resumeID, "excludeTurns": true}
	for k, v := range common {
		params[k] = v
	}
	response, err := s.request("thread/resume", params)
	if err == nil {
		return response, nil
	}
	if envValue(o.env, "CASCADE_IMPORTED_CODEX_SESSION") == o.resumeID {
		return nil, err
	}
	if isDeadCodexSession(err.Error()) {
		harnessNote(o.emit, "\x1b[33m# that session is gone from Codex's store — starting a fresh one\x1b[0m\r\n")
		return s.request("thread/start", common)
	}
	if !activeWriter.MatchString(err.Error()) {
		return nil, err
	}
	harnessNote(o.emit, "\x1b[33m# Codex left this thread busy — interrupting its unfinished turn\x1b[0m\r\n")
	if s.interruptActiveTurn(o.resumeID) {
		response, err := s.requestWithActiveWriterRetry("thread/resume", params)
		if err == nil {
			return response, nil
		}
		if !activeWriter.MatchString(err.Error()) {
			return nil, err
		}
	}
	harnessNote(o.emit, "\x1b[33m# Codex did not release that thread — continuing in a fresh session\x1b[0m\r\n")
	return s.request("thread/start", common)
}

func (s *codexAppServer) interruptActiveTurn(threadID string) bool {
	response, err := s.request("thread/read", map[string]any{"threadId": threadID, "includeTurns": true})
	if err != nil {
		return false
	}
	turns, _ := asObject(response["thread"])["turns"].([]any)
	for i := len(turns) - 1; i >= 0; i-- {
		turn := asObject(turns[i])
		if turn["status"] == "inProgress" && str(turn["id"]) != "" {
			_, err := s.request("turn/interrupt", map[string]any{"threadId": threadID, "turnId": str(turn["id"])})
			return err == nil
		}
	}
	return false
}

func (s *codexAppServer) requestWithActiveWriterRetry(method string, params map[string]any) (map[string]any, error) {
	delay := 250 * time.Millisecond
	for attempt := 0; ; attempt++ {
		response, err := s.request(method, params)
		if err == nil || !activeWriter.MatchString(err.Error()) || attempt == 7 {
			return response, err
		}
		time.Sleep(delay)
		delay = min(delay*2, 2*time.Second)
	}
}

func (s *codexAppServer) ensureStarted() error {
	s.mu.Lock()
	if s.ready {
		s.mu.Unlock()
		return nil
	}
	if s.cmd == nil {
		cmd := exec.Command(cliAgentBin("codex"), "app-server", "--stdio")
		cmd.Dir = homeJoin()
		stdin, err := cmd.StdinPipe()
		if err != nil {
			s.mu.Unlock()
			return err
		}
		stdout, err := cmd.StdoutPipe()
		if err != nil {
			s.mu.Unlock()
			return err
		}
		stderr, err := cmd.StderrPipe()
		if err != nil {
			s.mu.Unlock()
			return err
		}
		if err := cmd.Start(); err != nil {
			s.mu.Unlock()
			return fmt.Errorf("Failed to launch Codex app-server: %v", err)
		}
		s.cmd, s.stdin, s.stderr = cmd, stdin, ""
		s.pending, s.turns, s.early = map[int]chan rpcReply{}, map[string]*codexTurn{}, map[string][]map[string]any{}
		go s.readStderr(cmd, stderr)
		go s.readStdout(cmd, stdout)
	}
	s.mu.Unlock()
	_, err := s.request("initialize", map[string]any{
		"clientInfo":   map[string]any{"name": "cascade-desktop", "title": "Cascade", "version": "0.2.0"},
		"capabilities": map[string]any{"experimentalApi": true, "requestAttestation": false},
	})
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.ready = true
	s.writeLocked(map[string]any{"method": "initialized"})
	s.mu.Unlock()
	return nil
}

func (s *codexAppServer) writeLocked(message map[string]any) error {
	if s.stdin == nil {
		return errors.New("Codex app-server is not running.")
	}
	line, _ := json.Marshal(message)
	_, err := s.stdin.Write(append(line, '\n'))
	return err
}

func (s *codexAppServer) request(method string, params map[string]any) (map[string]any, error) {
	s.mu.Lock()
	s.nextID++
	id := s.nextID
	reply := make(chan rpcReply, 1)
	if s.pending == nil {
		s.mu.Unlock()
		return nil, errors.New("Codex app-server is not running.")
	}
	s.pending[id] = reply
	message := map[string]any{"method": method, "id": id}
	if params != nil {
		message["params"] = params
	}
	if err := s.writeLocked(message); err != nil {
		delete(s.pending, id)
		s.mu.Unlock()
		return nil, errors.New("Codex app-server is not running.")
	}
	s.mu.Unlock()
	r := <-reply
	return r.result, r.err
}

func (s *codexAppServer) readStderr(cmd *exec.Cmd, r io.Reader) {
	buf := make([]byte, 4096)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			s.mu.Lock()
			if s.cmd == cmd {
				s.stderr += string(buf[:n])
				if len(s.stderr) > 16000 {
					s.stderr = s.stderr[len(s.stderr)-16000:]
				}
			}
			s.mu.Unlock()
		}
		if err != nil {
			return
		}
	}
}

func (s *codexAppServer) readStdout(cmd *exec.Cmd, r io.Reader) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 1024*1024), 64*1024*1024)
	for scanner.Scan() {
		if line := strings.TrimSpace(scanner.Text()); line != "" {
			if message, ok := jsonLine(line); ok {
				s.onMessage(message)
			}
		}
	}
	waitErr := cmd.Wait()
	s.mu.Lock()
	reason := fmt.Sprint(waitErr)
	if waitErr == nil {
		reason = "0"
	}
	err := fmt.Errorf("Codex app-server exited (%s). %s", reason, strings.TrimSpace(s.stderr))
	s.mu.Unlock()
	s.onExit(cmd, err)
}

func (s *codexAppServer) onMessage(message map[string]any) {
	id, hasID := message["id"].(float64)
	method := str(message["method"])
	_, hasResult := message["result"]
	errObj, hasErr := message["error"]
	if hasID && (hasResult || hasErr) {
		s.mu.Lock()
		reply := s.pending[int(id)]
		delete(s.pending, int(id))
		s.mu.Unlock()
		if reply == nil {
			return
		}
		if hasErr && errObj != nil {
			e := asObject(errObj)
			reply <- rpcReply{err: errors.New(firstNonEmpty(str(e["message"]), jsonString(errObj)))}
		} else {
			reply <- rpcReply{result: asObject(message["result"])}
		}
		return
	}
	if hasID && method != "" {
		response := map[string]any{"id": message["id"], "error": map[string]any{"code": -32601, "message": "Unsupported server request: " + method}}
		if strings.HasSuffix(method, "requestApproval") {
			response = map[string]any{"id": message["id"], "result": map[string]any{"decision": "decline"}}
		}
		s.mu.Lock()
		s.writeLocked(response)
		s.mu.Unlock()
		return
	}
	params := asObject(message["params"])
	if params == nil {
		params = map[string]any{}
	}
	turnID := firstNonEmpty(str(params["turnId"]), str(asObject(params["turn"])["id"]))
	threadID := str(params["threadId"])
	s.mu.Lock()
	var turn *codexTurn
	if turnID != "" {
		turn = s.turns[turnID]
	} else {
		for _, candidate := range s.turns {
			if candidate.threadID == threadID {
				turn = candidate
				break
			}
		}
	}
	// An explicit turn owns its event; a stale attempt never falls through to another turn.
	if turn != nil && threadID != "" && turn.threadID != threadID {
		s.mu.Unlock()
		return
	}
	if turn == nil {
		switch method {
		case "item/started", "item/completed", "item/agentMessage/delta", "turn/completed", "error":
			if turnID != "" {
				buffered := append(s.early[turnID], message)
				if len(buffered) > 100 {
					buffered = buffered[len(buffered)-100:]
				}
				s.early[turnID] = buffered
			}
		}
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()
	turn.mu.Lock()
	defer turn.mu.Unlock()
	turn.idle.Reset(cliIdleTimeout())
	item := asObject(params["item"])
	if (method == "item/started" || method == "item/completed") && item != nil && item["type"] != nil &&
		item["type"] != "userMessage" && item["type"] != "contextCompaction" {
		turn.timing.firstResponse()
	}
	switch method {
	case "item/agentMessage/delta":
		itemID, delta := str(params["itemId"]), str(params["delta"])
		if itemID != "" && delta != "" {
			turn.timing.firstResponse()
			s.emitAgentText(turn, itemID, turn.agentText[itemID]+delta)
		}
	case "item/started":
		s.emitItem(turn, item, false)
	case "item/completed":
		s.emitItem(turn, item, true)
	case "thread/tokenUsage/updated":
		usage := asObject(params["tokenUsage"])
		if usage == nil {
			usage = asObject(params["usage"])
		}
		emitStats(turn.emit, statsFromUsage(usage, nil))
	case "turn/completed":
		emitValue(turn.emit, "assistant-turn-end", map[string]any{})
		t := asObject(params["turn"])
		status := str(t["status"])
		turn.timing.complete(firstNonEmpty(status, "failed"))
		if status == "completed" {
			s.finishTurn(turnID, nil)
		} else {
			s.finishTurn(turnID, errors.New(firstNonEmpty(str(asObject(t["error"])["message"]), fmt.Sprintf("Codex turn %s.", firstNonEmpty(status, "failed")))))
		}
	case "error":
		message := firstNonEmpty(str(asObject(params["error"])["message"]), str(params["message"]))
		// Stream errors are progress while Codex retries the same turn.
		if params["willRetry"] == true {
			harnessNote(turn.emit, firstNonEmpty(message, "Codex retrying.")+"\r\n")
			return
		}
		turn.timing.complete("failed")
		s.finishTurn(turn.turnID, errors.New(firstNonEmpty(message, "Codex app-server error.")))
	}
}

func (s *codexAppServer) emitAgentText(turn *codexTurn, itemID, text string) {
	previous, seen := turn.agentText[itemID]
	// Completion repeats the full item; publish only its not-yet-streamed suffix.
	delta := text
	if seen {
		delta = ""
		if strings.HasPrefix(text, previous) {
			delta = text[len(previous):]
		}
	}
	turn.agentText[itemID] = text
	if delta == "" {
		return
	}
	if !seen && turn.emittedText {
		delta = "\n\n" + delta
	}
	emitValue(turn.emit, "text", map[string]any{"chatVisible": true,
		"message": map[string]any{"content": []any{map[string]any{"type": "text", "text": delta}}}})
	turn.emittedText = true
}

func codexAppToolUse(item map[string]any) (string, any) {
	switch item["type"] {
	case "commandExecution":
		return "Bash", map[string]any{"command": str(item["command"])}
	case "fileChange":
		file := "(files)"
		if changes, _ := item["changes"].([]any); len(changes) > 0 {
			file = firstNonEmpty(str(asObject(changes[0])["path"]), file)
		}
		return "Edit", map[string]any{"file_path": file}
	case "mcpToolCall":
		return firstNonEmpty(str(item["server"]), "mcp") + "." + firstNonEmpty(str(item["tool"]), "tool"), firstNonNil(item["arguments"], map[string]any{})
	}
	return firstNonEmpty(str(item["tool"]), str(item["type"])), firstNonNil(item["arguments"], map[string]any{})
}

func (s *codexAppServer) emitItem(turn *codexTurn, item map[string]any, completed bool) {
	kind := str(item["type"])
	if kind == "" {
		return
	}
	switch kind {
	case "agentMessage":
		if text := str(item["text"]); completed && text != "" {
			turn.summary = text
			s.emitAgentText(turn, str(item["id"]), text)
		}
		return
	case "reasoning":
		if !completed {
			return
		}
		var parts []string
		for _, key := range []string{"summary", "content"} {
			values, _ := item[key].([]any)
			for _, v := range values {
				if text := str(v); text != "" {
					parts = append(parts, text)
				}
			}
		}
		if text := strings.Join(parts, "\n"); text != "" {
			emitBlocks(turn.emit, "text", map[string]any{"type": "thinking", "text": text})
		}
		return
	case "userMessage", "plan", "contextCompaction":
		return
	}
	id := str(item["id"])
	if id == "" {
		return
	}
	if !turn.emittedTools[id] {
		turn.emittedTools[id] = true
		name, input := codexAppToolUse(item)
		emitToolUse(turn.emit, id, name, input)
	}
	if completed {
		output := firstNonNil(item["aggregatedOutput"], item["result"], item["error"], "")
		code, hasCode := item["exitCode"].(float64)
		isError := item["status"] == "failed" || (hasCode && code != 0)
		emitToolResult(turn.emit, id, anyText(output), isError)
	}
}

func (s *codexAppServer) finishTurn(turnID string, err error) {
	s.mu.Lock()
	turn := s.turns[turnID]
	delete(s.turns, turnID)
	s.mu.Unlock()
	if turn == nil {
		return
	}
	if err != nil {
		turn.timing.complete("failed")
	} else {
		turn.timing.complete("completed")
	}
	turn.idle.Stop()
	clearCliCancel(turn.runID)
	// A loaded thread holds an exclusive writer lease even while idle; release
	// it so another window or a rebuilt runner can resume the conversation.
	go s.request("thread/unsubscribe", map[string]any{"threadId": turn.threadID})
	turn.done <- err
}

func (s *codexAppServer) onExit(cmd *exec.Cmd, err error) {
	s.mu.Lock()
	// A deliberate shutdown can be followed at once by a replacement server.
	if s.cmd != cmd {
		s.mu.Unlock()
		return
	}
	pending := s.pending
	var turnIDs []string
	for id := range s.turns {
		turnIDs = append(turnIDs, id)
	}
	s.pending = nil
	s.mu.Unlock()
	for _, reply := range pending {
		reply <- rpcReply{err: err}
	}
	for _, id := range turnIDs {
		s.finishTurn(id, err)
	}
	s.mu.Lock()
	s.cmd, s.stdin, s.ready, s.stderr, s.early = nil, nil, false, "", map[string][]map[string]any{}
	s.mu.Unlock()
}

func (s *codexAppServer) shutdown() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cmd != nil && s.cmd.Process != nil {
		_ = s.cmd.Process.Kill()
	}
	s.cmd, s.stdin, s.ready = nil, nil, false
}
