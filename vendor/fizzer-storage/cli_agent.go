package main

// Local non-Claude CLI agents (Codex, Grok, Copilot, Hermes, Akron, OMP, Pi,
// Antigravity). Each provider's JSONL stream is translated into the content
// blocks the chat UI renders; terminal status stays with executeLocalAgentRun.

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

type runEmit func(kind, payloadJSON string)

func emitValue(emit runEmit, kind string, value any) {
	if emit != nil {
		emit(kind, jsonString(value))
	}
}

func emitBlocks(emit runEmit, kind string, blocks ...map[string]any) {
	content := make([]any, len(blocks))
	for i, block := range blocks {
		content[i] = block
	}
	emitValue(emit, kind, map[string]any{"message": map[string]any{"content": content}})
}

func emitThinking(emit runEmit, text string) {
	emitBlocks(emit, "text", map[string]any{"type": "thinking", "thinking": text})
}

func emitText(emit runEmit, text string) {
	emitBlocks(emit, "text", map[string]any{"type": "text", "text": text})
}

func emitToolUse(emit runEmit, id, name string, input any) {
	if input == nil {
		input = map[string]any{}
	}
	emitBlocks(emit, "text", map[string]any{"type": "tool_use", "id": id, "name": name, "input": input})
}

func emitToolResult(emit runEmit, id, content string, isError bool) {
	emitBlocks(emit, "user", map[string]any{"type": "tool_result", "tool_use_id": id, "content": truncateText(content, 8000), "is_error": isError})
}

func emitSession(emit runEmit, id string) {
	emitValue(emit, "session", map[string]string{"sessionId": id})
}

func truncateText(s string, n int) string {
	if len(s) > n {
		return s[:n] + "\n…(truncated)"
	}
	return s
}

// ── configuration ─────────────────────────────────────────────

func envMillis(fallback int, names ...string) time.Duration {
	for _, name := range names {
		if v, err := strconv.Atoi(strings.TrimSpace(os.Getenv(name))); err == nil && v > 0 {
			return time.Duration(v) * time.Millisecond
		}
	}
	return time.Duration(fallback) * time.Millisecond
}

func atLeast(d, min time.Duration) time.Duration {
	if d < min {
		return min
	}
	return d
}

// A CLI is stopped only after this long with no output at all, not after this long running.
func cliIdleTimeout() time.Duration {
	return envMillis(1_800_000, "RUNNER_CLI_IDLE_TIMEOUT", "RUNNER_CLI_TIMEOUT")
}

func cliHeartbeat() time.Duration {
	return atLeast(envMillis(15_000, "RUNNER_CLI_HEARTBEAT_MS"), 10*time.Millisecond)
}

// Akron's Grok bridge can hold a stream open forever without a response byte.
func akronIdleTimeout() time.Duration {
	return atLeast(envMillis(120_000, "RUNNER_AKRON_IDLE_TIMEOUT_MS"), time.Second)
}

// Hermes can spend real time planning before its first byte.
func hermesIdleTimeout() time.Duration {
	return atLeast(envMillis(180_000, "RUNNER_HERMES_IDLE_TIMEOUT_MS"), time.Second)
}

type cliIdleTimeoutError struct{ message string }

func (e *cliIdleTimeoutError) Error() string { return e.message }

func isCliIdleTimeout(err error) bool {
	var idle *cliIdleTimeoutError
	return errors.As(err, &idle)
}

// ── binaries and availability ─────────────────────────────────

var cliAgentLabels = map[string]string{
	"codex": "Codex", "grok": "Grok", "antigravity": "Antigravity", "copilot": "Copilot",
	"hermes": "Hermes", "akron-grok": "Akron --grok", "omp": "OMP", "pi": "Pi",
}

func resolveCliBin(envKey, fallback string) string {
	if v := os.Getenv(envKey); strings.TrimSpace(v) != "" {
		return v
	}
	return fallback
}

func cliAgentBin(agent string) string {
	switch agent {
	case "codex":
		return resolveCliBin("CODEX_BIN", "codex")
	case "grok":
		return resolveCliBin("GROK_BIN", "grok")
	case "copilot":
		return resolveCliBin("COPILOT_BIN", "copilot")
	case "hermes":
		return resolveCliBin("HERMES_BIN", "hermes")
	case "akron-grok":
		return resolveCliBin("AKRON_BIN", "akron")
	case "omp":
		return resolveCliBin("OMP_BIN", "omp")
	case "pi":
		return resolveCliBin("PI_BIN", "pi")
	case "antigravity":
		return antigravityBin()
	}
	return agent
}

var (
	cliAvailabilityMu    sync.Mutex
	cliAvailabilityCache = map[string]struct {
		available bool
		checked   time.Time
	}{}
)

func cliBinaryExists(bin string) bool {
	cliAvailabilityMu.Lock()
	defer cliAvailabilityMu.Unlock()
	if cached, ok := cliAvailabilityCache[bin]; ok && time.Since(cached.checked) < time.Minute {
		return cached.available
	}
	available := false
	if filepath.IsAbs(bin) {
		info, err := os.Stat(bin)
		available = err == nil && info.Mode().IsRegular()
	} else {
		_, err := exec.LookPath(bin)
		available = err == nil
	}
	cliAvailabilityCache[bin] = struct {
		available bool
		checked   time.Time
	}{available, time.Now()}
	return available
}

func unavailableCliMessage(agent, bin string) string {
	variable := strings.ToUpper(strings.Replace(agent, "-", "_", 1)) + "_BIN"
	if agent == "akron-grok" {
		variable = "AKRON_BIN"
	}
	return fmt.Sprintf("%s ('%s') is not installed or not on PATH. CLI agents run in the Cascade desktop app on this computer — install the CLI locally, or set %s for the desktop app.", cliAgentLabels[agent], bin, variable)
}

func assertCliAgentAvailable(agent string) error {
	if bin := cliAgentBin(agent); !cliBinaryExists(bin) {
		return errors.New(unavailableCliMessage(agent, bin))
	}
	return nil
}

// ── cancellation ──────────────────────────────────────────────

var (
	cliMu      sync.Mutex
	cliCancels = map[int]func(){}
)

func setCliCancel(runID int, cancel func()) {
	if runID <= 0 {
		return
	}
	cliMu.Lock()
	cliCancels[runID] = cancel
	cliMu.Unlock()
}

func clearCliCancel(runID int) {
	cliMu.Lock()
	delete(cliCancels, runID)
	cliMu.Unlock()
}

// cancelCliRun stops one CLI run, including launcher descendants such as Akron's.
func cancelCliRun(runID int) bool {
	cliMu.Lock()
	cancel := cliCancels[runID]
	delete(cliCancels, runID)
	cliMu.Unlock()
	if cancel != nil {
		cancel()
		return true
	}
	return cancelCliRunFromLease(runID)
}

// ── stats ─────────────────────────────────────────────────────

func numFrom(v any) (float64, bool) {
	switch t := v.(type) {
	case float64:
		return t, true
	case int:
		return float64(t), true
	case string:
		if f, err := strconv.ParseFloat(strings.TrimSpace(t), 64); err == nil {
			return f, true
		}
	}
	return 0, false
}

func firstNum(u map[string]any, keys ...string) (float64, bool) {
	for _, key := range keys {
		if v, ok := u[key]; ok && v != nil {
			return numFrom(v)
		}
	}
	return 0, false
}

// statsFromUsage pulls token fields from the usage blobs CLIs report.
func statsFromUsage(u map[string]any, extra map[string]any) map[string]any {
	stats := map[string]any{}
	if u != nil {
		input, hasInput := firstNum(u, "input_tokens", "inputTokens", "prompt_tokens")
		cached, hasCached := firstNum(u, "cached_input_tokens", "cache_read_input_tokens", "cacheReadTokens", "cachedInputTokens")
		output, hasOutput := firstNum(u, "output_tokens", "outputTokens", "completion_tokens")
		if !hasOutput {
			// Codex sometimes splits reasoning tokens out of output_tokens.
			if reasoning, ok := firstNum(u, "reasoning_output_tokens", "reasoningOutputTokens"); ok {
				output, hasOutput = reasoning, true
			}
		}
		if hasInput {
			stats["inputTokens"] = input
		}
		if hasOutput {
			stats["outputTokens"] = output
		}
		if hasCached {
			stats["cacheReadTokens"] = cached
		}
		if v, ok := firstNum(u, "cache_creation_input_tokens", "cacheWriteTokens"); ok {
			stats["cacheWriteTokens"] = v
		}
		// Prefer explicit context totals; else input (+ cache) approximates window fill.
		if total, ok := firstNum(u, "total_tokens", "totalTokens"); ok {
			stats["contextUsed"] = total
		} else if hasInput || hasCached {
			stats["contextUsed"] = input + cached
		}
		if v, ok := firstNum(u, "total_cost_usd", "cost_usd", "cost"); ok {
			stats["totalCostUsd"] = v
		}
	}
	for k, v := range extra {
		stats[k] = v
	}
	return stats
}

func asObject(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

// ── temp images ───────────────────────────────────────────────

var imageExtensions = map[string]string{"image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif", "image/webp": "webp"}

func writeTempImages(images []map[string]any) ([]string, func(), error) {
	if len(images) == 0 {
		return nil, func() {}, nil
	}
	dir, err := os.MkdirTemp("", "cascade-img-")
	if err != nil {
		return nil, func() {}, err
	}
	cleanup := func() { os.RemoveAll(dir) }
	var paths []string
	for i, img := range images {
		ext := imageExtensions[str(img["media_type"])]
		if ext == "" {
			ext = "png"
		}
		data, err := base64.StdEncoding.DecodeString(str(img["data"]))
		if err != nil {
			cleanup()
			return nil, func() {}, err
		}
		file := filepath.Join(dir, fmt.Sprintf("image-%d.%s", i, ext))
		if err := os.WriteFile(file, data, 0o600); err != nil {
			cleanup()
			return nil, func() {}, err
		}
		paths = append(paths, file)
	}
	return paths, cleanup, nil
}

// ── process driving ───────────────────────────────────────────

type driveSpec struct {
	bin, label, cwd string
	args, env       []string
	runID           int
	emit            runEmit
	onLine          func(line string, carriageReturn bool)
	summary         func() string
	onStderr        func(chunk string)
	// Hermes launchers own provider bridges and tool descendants: run them in
	// their own process group, parse NDJSON events from stderr, and heartbeat.
	hermes       bool
	onStderrLine func(line string)
	idleTimeout  time.Duration
}

func quoteArgs(args []string) string {
	out := make([]string, len(args))
	for i, a := range args {
		if strings.ContainsAny(a, " \t\n\r") {
			out[i] = jsonString(a)
		} else {
			out[i] = a
		}
	}
	return strings.Join(out, " ")
}

type streamChunk struct {
	stderr bool
	data   string
	eof    bool
}

// driveProcess runs a CLI, feeds stdout lines to onLine, tees both pipes into
// harness events, and stops it after idleTimeout of silence.
func driveProcess(spec driveSpec) (string, error) {
	idleTimeout := spec.idleTimeout
	if idleTimeout <= 0 {
		idleTimeout = cliIdleTimeout()
	}
	timing := newRequestTiming(spec.emit, "cli_process_stdout")
	if spec.hermes {
		harnessNote(spec.emit, fmt.Sprintf("\x1b[2m# launching %s harness\x1b[0m\r\n", spec.label))
	}
	env := spec.env
	if env == nil {
		env = os.Environ()
	}
	leaseToken := ""
	if spec.hermes {
		leaseToken = randomHex(16)
		env = append(append([]string{}, env...), "HERMES_CASCADE_EVENTS=1", "CASCADE_AGENT_PROCESS_TOKEN="+leaseToken)
		if spec.runID > 0 {
			env = append(env, fmt.Sprintf("CASCADE_RUN_ID=%d", spec.runID))
		}
	}
	cmd := exec.Command(spec.bin, spec.args...)
	cmd.Dir = spec.cwd
	cmd.Env = env
	if spec.hermes {
		setProcessGroup(cmd)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return "", err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return "", err
	}
	if err := cmd.Start(); err != nil {
		timing.complete("launch_failed")
		return "", fmt.Errorf("%s ('%s') could not be started: %v. Is it installed and on PATH?", spec.label, spec.bin, err)
	}
	terminate := func() { terminateProcess(cmd, spec.hermes) }
	setCliCancel(spec.runID, terminate)
	if spec.hermes && spec.runID > 0 {
		writeAgentProcessLease(spec.runID, cmd.Process.Pid, leaseToken, spec.label)
	}
	cleanUp := func() {
		clearCliCancel(spec.runID)
		if spec.hermes && spec.runID > 0 {
			clearAgentProcessLease(spec.runID)
		}
	}

	harnessNote(spec.emit, fmt.Sprintf("\x1b[2m$ %s %s\x1b[0m\r\n", spec.bin, quoteArgs(spec.args)))
	harnessNote(spec.emit, fmt.Sprintf("\x1b[2m# cwd %s\x1b[0m\r\n", spec.cwd))

	chunks := make(chan streamChunk, 64)
	pump := func(r io.Reader, isStderr bool) {
		buf := make([]byte, 32*1024)
		for {
			n, err := r.Read(buf)
			if n > 0 {
				chunks <- streamChunk{stderr: isStderr, data: string(buf[:n])}
			}
			if err != nil {
				chunks <- streamChunk{stderr: isStderr, eof: true}
				return
			}
		}
	}
	go pump(stdout, false)
	go pump(stderr, true)

	var stderrText strings.Builder
	stdoutBuf, stderrBuf := "", ""
	consumeStderrLine := func(line string) {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			return
		}
		if spec.hermes && (strings.HasPrefix(trimmed, "{") || hermesSessionLine.MatchString(trimmed)) {
			if spec.onStderrLine != nil {
				spec.onStderrLine(trimmed)
			}
		} else {
			stderrText.WriteString(trimmed + "\n")
		}
	}
	idle := time.NewTimer(idleTimeout)
	defer idle.Stop()
	var heartbeat <-chan time.Time
	if spec.hermes {
		ticker := time.NewTicker(cliHeartbeat())
		defer ticker.Stop()
		heartbeat = ticker.C
	}
	quietSince := time.Now()
	open := 2
	for open > 0 {
		select {
		case c := <-chunks:
			if c.eof {
				open--
				continue
			}
			quietSince = time.Now()
			if !idle.Stop() {
				select {
				case <-idle.C:
				default:
				}
			}
			idle.Reset(idleTimeout)
			if !c.stderr {
				timing.firstResponse()
				harnessNote(spec.emit, c.data)
				stdoutBuf += c.data
				for {
					nl := strings.IndexByte(stdoutBuf, '\n')
					if nl < 0 {
						break
					}
					line := stdoutBuf[:nl]
					stdoutBuf = stdoutBuf[nl+1:]
					// Hermes redraws its reasoning box with CR-terminated lines.
					carriageReturn := strings.HasSuffix(line, "\r")
					if trimmed := strings.TrimSpace(line); trimmed != "" && spec.onLine != nil {
						spec.onLine(trimmed, carriageReturn)
					}
				}
				continue
			}
			if !spec.hermes {
				stderrText.WriteString(c.data)
			}
			if spec.onStderr != nil {
				spec.onStderr(c.data)
			}
			harnessNote(spec.emit, "\x1b[31m"+c.data+"\x1b[0m")
			if spec.hermes {
				stderrBuf += c.data
				for {
					nl := strings.IndexByte(stderrBuf, '\n')
					if nl < 0 {
						break
					}
					consumeStderrLine(stderrBuf[:nl])
					stderrBuf = stderrBuf[nl+1:]
				}
			}
		case <-heartbeat:
			if quiet := time.Since(quietSince); quiet >= cliHeartbeat() {
				seconds := int(quiet.Round(time.Second) / time.Second)
				if seconds < 1 {
					seconds = 1
				}
				harnessNote(spec.emit, fmt.Sprintf("\x1b[2m# %s still working · %ds without provider output\x1b[0m\r\n", spec.label, seconds))
			}
		case <-idle.C:
			timing.complete("idle_timeout")
			cleanUp()
			terminate()
			go func() {
				for range chunks {
				}
			}()
			go cmd.Wait()
			return "", &cliIdleTimeoutError{fmt.Sprintf("%s produced no output for %dms and was stopped.", spec.label, idleTimeout.Milliseconds())}
		}
	}
	waitErr := cmd.Wait()
	cleanUp()
	code, signaled := exitStatus(cmd, waitErr)
	switch {
	case signaled:
		timing.complete("signaled")
	case code == 0:
		timing.complete("completed")
	default:
		timing.complete("failed")
	}
	if trailing := strings.TrimSpace(stdoutBuf); trailing != "" && spec.onLine != nil {
		spec.onLine(trailing, false)
	}
	consumeStderrLine(stderrBuf)
	codeText := "?"
	if !signaled {
		codeText = strconv.Itoa(code)
	}
	harnessNote(spec.emit, fmt.Sprintf("\x1b[2m# exit %s\x1b[0m\r\n", codeText))
	if !signaled && code == 0 {
		summary := ""
		if spec.summary != nil {
			summary = spec.summary()
		}
		return summary, nil
	}
	lines := strings.Split(strings.TrimSpace(stderrText.String()), "\n")
	if len(lines) > 5 {
		lines = lines[len(lines)-5:]
	}
	detail := strings.TrimSpace(strings.Join(lines, "\n"))
	if signaled {
		codeText = "null"
	}
	message := fmt.Sprintf("%s exited with code %s.", spec.label, codeText)
	if detail != "" {
		message += "\n" + detail
	}
	return "", errors.New(message)
}

var hermesSessionLine = regexp.MustCompile(`(?i)^session_id:\s*`)

func exitStatus(cmd *exec.Cmd, waitErr error) (code int, signaled bool) {
	if cmd.ProcessState == nil {
		return -1, false
	}
	if status, ok := processSignaled(cmd.ProcessState); ok {
		return -1, status
	}
	return cmd.ProcessState.ExitCode(), false
}

// ── papercuts ─────────────────────────────────────────────────

var (
	papercutMu     sync.Mutex
	papercutCounts = map[string]int{}
	papercutRecent = map[string]string{}
	papercutSpace  = regexp.MustCompile(`\s+`)
)

// autoPapercut jots a tool failure into the scratchpad journal without relying
// on the model to remember; it never affects the run.
func autoPapercut(body, tool string, env []string) {
	text := strings.TrimSpace(papercutSpace.ReplaceAllString(body, " "))
	if len(text) > 1500 {
		text = text[:1500]
	}
	if len(text) < 24 {
		return
	}
	lower := strings.ToLower(text)
	if strings.HasPrefix(lower, "canceled by user") || strings.HasPrefix(lower, "interrupt") || strings.HasPrefix(lower, "aborted") {
		return
	}
	if regexp.MustCompile(`(?i)permission.?denied|user.?rejected`).MatchString(text) && len(text) < 80 {
		return
	}
	key := firstNonEmpty(envValue(env, "CASCADE_RUN_ID"), envValue(env, "CASCADE_HELPER_CONFIG"), "local")
	limit := 12
	if v, err := strconv.Atoi(os.Getenv("CASCADE_PAPERCUT_MAX_PER_RUN")); err == nil {
		limit = min(max(v, 1), 40)
	}
	head := text
	if len(head) > 200 {
		head = head[:200]
	}
	papercutMu.Lock()
	if papercutCounts[key] >= limit || papercutRecent[key] == head {
		papercutMu.Unlock()
		return
	}
	papercutRecent[key] = head
	papercutCounts[key]++
	papercutMu.Unlock()
	label := text
	if tool != "" {
		label = tool + ": " + text
	}
	cmd := exec.Command(storageExecutable(), "cascade-scratchpad", "papercut", "--text", label)
	cmd.Env = env
	if cmd.Start() == nil {
		go cmd.Wait()
	}
}

func envValue(env []string, key string) string {
	for i := len(env) - 1; i >= 0; i-- {
		if value, ok := strings.CutPrefix(env[i], key+"="); ok {
			return value
		}
	}
	return ""
}

func withEnv(env []string, pairs ...string) []string {
	out := append([]string{}, env...)
	for _, pair := range pairs {
		key, _, _ := strings.Cut(pair, "=")
		kept := out[:0]
		for _, existing := range out {
			if !strings.HasPrefix(existing, key+"=") {
				kept = append(kept, existing)
			}
		}
		out = append(kept, pair)
	}
	return out
}

func withoutEnv(env []string, keys ...string) []string {
	var out []string
	for _, entry := range env {
		drop := false
		for _, key := range keys {
			if strings.HasPrefix(entry, key+"=") {
				drop = true
				break
			}
		}
		if !drop {
			out = append(out, entry)
		}
	}
	return out
}

func storageExecutable() string {
	if exe, err := os.Executable(); err == nil {
		return exe
	}
	return "fizzer-storage"
}

// ── dispatch ──────────────────────────────────────────────────

type cliAgentOpts struct {
	agent, prompt, cwd, resumeID, model, reasoningEffort, sandbox, hermesProfile string
	images                                                                       []map[string]any
	runID                                                                        int
	priorityServiceTier, yolo, hermesSafeMode, remoteVault                       bool
	env                                                                          []string
	emit                                                                         runEmit
}

type cliAgentResult struct {
	summary, sessionID string
}

func runCliAgent(o cliAgentOpts) (cliAgentResult, error) {
	// Hermes availability depends on its profile's local executable route.
	if o.agent != "hermes" {
		if err := assertCliAgentAvailable(o.agent); err != nil {
			return cliAgentResult{}, err
		}
	}
	switch o.agent {
	case "codex":
		return runCodex(o)
	case "grok":
		return runGrok(o)
	case "copilot":
		return runCopilot(o)
	case "hermes":
		return runHermes(o)
	case "akron-grok":
		return runAkronGrok(o)
	case "omp":
		return runOmp(o)
	case "pi":
		return runPi(o)
	case "antigravity":
		return runAntigravity(o)
	}
	return cliAgentResult{}, fmt.Errorf("Unknown agent: %s", o.agent)
}

// runLocalCliAgent prepares one non-Claude run the way the desktop runner did.
func runLocalCliAgent(opts map[string]any, emit runEmit) (map[string]any, error) {
	runID := int(numberOf(opts["runId"]))
	agent := strings.TrimSpace(str(opts["agent"]))
	selfContained := str(opts["contextMode"]) == "self-contained"
	env := os.Environ()
	if !selfContained {
		env = buildRunHelperEnv(opts, runID)
	}
	env = withEnv(env, fmt.Sprintf("CASCADE_RUN_ID=%d", runID))
	remote := truthy(opts["remoteVault"])
	if remote {
		env = withEnv(env, "FIZZER_REMOTE_VAULT=1")
	} else {
		env = withoutEnv(env, "FIZZER_REMOTE_VAULT")
	}
	resume := str(opts["resumeSessionId"])
	if agent == "codex" && truthy(opts["importedCodexSession"]) && resume != "" {
		if err := assertCodexSessionIdle(codexIdleOptions{ID: resume}); err != nil {
			return nil, err
		}
		env = withEnv(env, "CASCADE_IMPORTED_CODEX_SESSION="+resume)
	}
	prompt := str(opts["prompt"])
	if !isChatRun(opts) && !selfContained {
		prompt = "[Context: " + claudeAgentContext + " " + noteCapabilityContext(opts) + "]\n\n" + prompt
	}
	sandbox := ""
	if selfContained && str(opts["sandbox"]) == "read-only" {
		sandbox = "read-only"
	}
	result, err := runCliAgent(cliAgentOpts{
		agent:               agent,
		prompt:              prompt,
		cwd:                 resolveAgentCwd(str(opts["cwd"]), str(opts["vaultRoot"])),
		resumeID:            resume,
		images:              claudeImages(opts),
		model:               str(opts["model"]),
		reasoningEffort:     str(opts["reasoningEffort"]),
		priorityServiceTier: opts["priorityServiceTier"] == true,
		sandbox:             sandbox,
		yolo:                opts["yolo"] == true,
		hermesProfile:       str(opts["hermesProfile"]),
		hermesSafeMode:      opts["hermesSafeMode"] == true,
		remoteVault:         remote,
		runID:               runID,
		env:                 env,
		emit:                emit,
	})
	if err != nil {
		return nil, err
	}
	out := map[string]any{"summary": result.summary}
	if result.sessionID != "" {
		out["sessionId"] = result.sessionID
	}
	return out, nil
}

func jsonLine(line string) (map[string]any, bool) {
	var v map[string]any
	if json.Unmarshal([]byte(line), &v) != nil {
		return nil, false
	}
	return v, true
}
