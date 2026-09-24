package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var (
	hermesProfilePattern      = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)
	hermesReasoningOpen       = regexp.MustCompile(`^┌─+\s*Reasoning\s*─`)
	hermesReasoningClose      = regexp.MustCompile(`^└─+┘?$`)
	hermesQuietSession        = regexp.MustCompile(`(?i)^session_id:\s*(\S+)$`)
	hermesUpstreamUnavailable = regexp.MustCompile(`(?i)^(?:API call failed after \d+ retr(?:y|ies)\b|HTTP 5\d\d\b|(?:The )?requested model is temporarily unavailable\b)`)
)

// Hermes exhausts its own retries and then exits 0 with an upstream error as
// its answer. That counts only when the error is the entire reply, so a real
// answer that discusses HTTP 503 is never discarded.
func isHermesUpstreamFailure(output string) bool {
	var lines []string
	for _, line := range strings.Split(strings.TrimSpace(output), "\n") {
		if line = strings.TrimSpace(line); line != "" {
			lines = append(lines, line)
		}
	}
	if len(lines) == 0 || len(lines) > 2 {
		return false
	}
	for _, line := range lines {
		if !hermesUpstreamUnavailable.MatchString(line) {
			return false
		}
	}
	return true
}

func envInt(name string, fallback int) int {
	if v, err := strconv.Atoi(strings.TrimSpace(os.Getenv(name))); err == nil {
		return v
	}
	return fallback
}

func hermesProfileConfigPath() string {
	return homeJoin(".cascade", "hermes-profile-commands.json")
}

// hermesProfileCommand returns a locally opted-in launcher for a Hermes
// profile. Routes are never cached, and a broken route never falls back to
// ordinary Hermes.
func hermesProfileCommand(profile, configPath string) (string, error) {
	fail := func(reason string) (string, error) {
		// Never include configuration contents or underlying OS errors.
		return "", fmt.Errorf("Hermes profile command routing: %s.", reason)
	}
	if profile != "" && !hermesProfilePattern.MatchString(profile) {
		return fail("invalid profile")
	}
	file, err := openNoFollow(configPath)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return fail("cannot securely open config")
	}
	defer file.Close()
	directory, err := os.Lstat(filepath.Dir(configPath))
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return fail("cannot inspect config directory")
	}
	if !directory.IsDir() || directory.Mode()&os.ModeSymlink != 0 || !ownedByCurrentUser(directory) || directory.Mode().Perm()&0o022 != 0 {
		return fail("config directory must be owned by the current user and not writable by others")
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || !ownedByCurrentUser(info) || info.Mode().Perm()&0o077 != 0 {
		return fail("config must be a private regular file owned by the current user")
	}
	if info.Size() > 65536 {
		return fail("config exceeds 64 KiB")
	}
	var config map[string]json.RawMessage
	if json.NewDecoder(file).Decode(&config) != nil {
		return fail("config is invalid or configured command is unavailable")
	}
	var version float64
	var profiles map[string]map[string]json.RawMessage
	if json.Unmarshal(config["version"], &version) != nil || version != 1 || json.Unmarshal(config["profiles"], &profiles) != nil || profiles == nil {
		return fail("invalid config schema")
	}
	for key := range config {
		if key != "version" && key != "profiles" {
			return fail("invalid config schema")
		}
	}
	commands := map[string]string{}
	for name, mapping := range profiles {
		var command string
		if !hermesProfilePattern.MatchString(name) || len(mapping) != 1 || json.Unmarshal(mapping["command"], &command) != nil ||
			!filepath.IsAbs(command) || strings.ContainsRune(command, 0) {
			return fail("invalid profile mapping")
		}
		commands[name] = command
	}
	command, ok := commands[profile]
	if profile == "" || !ok {
		return "", nil
	}
	// A launcher may be a symlink; its resolved target must be an executable regular file.
	target, err := os.Stat(command)
	if err != nil {
		return fail("config is invalid or configured command is unavailable")
	}
	if !target.Mode().IsRegular() {
		return fail("configured command is not a regular file")
	}
	if !executableByCurrentUser(command) {
		return fail("config is invalid or configured command is unavailable")
	}
	return command, nil
}

func runHermes(o cliAgentOpts) (cliAgentResult, error) {
	profile := strings.TrimSpace(o.hermesProfile)
	if profile != "" && !hermesProfilePattern.MatchString(profile) {
		return cliAgentResult{}, errors.New("Hermes profile must use letters, numbers, dots, underscores, or dashes.")
	}
	command, err := hermesProfileCommand(profile, hermesProfileConfigPath())
	if err != nil {
		return cliAgentResult{}, err
	}
	if command == "" {
		if err := assertCliAgentAvailable("hermes"); err != nil {
			return cliAgentResult{}, err
		}
		command = cliAgentBin("hermes")
	}
	var args []string
	if profile != "" {
		args = append(args, "-p", profile)
	}
	args = append(args, "chat", "-Q")
	if o.resumeID != "" {
		args = append(args, "--resume", o.resumeID)
	}
	args = append(args, "-q", o.prompt)
	if model := strings.TrimSpace(o.model); model != "" {
		args = append(args, "-m", model)
	}
	if o.yolo {
		args = append(args, "--yolo")
	}
	if o.hermesSafeMode {
		args = append(args, "--safe-mode")
	}

	text, sessionID := "", o.resumeID
	// `-Q` still renders a box-drawn Reasoning panel on stdout; route it to
	// thinking blocks so it never lands in the chat message.
	inReasoning := false
	onStdoutLine := func(line string, carriageReturn bool) {
		if hermesReasoningOpen.MatchString(line) {
			inReasoning = true
			return
		}
		if inReasoning {
			if hermesReasoningClose.MatchString(line) {
				inReasoning = false
				return
			}
			// Panel body lines are CR-terminated; the first LF line resumes the answer.
			if carriageReturn {
				emitThinking(o.emit, line+"\n")
				return
			}
			inReasoning = false
		}
		text += line + "\n"
		emitText(o.emit, line+"\n")
	}
	onStderrLine := func(line string) {
		if match := hermesQuietSession.FindStringSubmatch(line); match != nil {
			sessionID = match[1]
			emitSession(o.emit, sessionID)
			return
		}
		ev, ok := jsonLine(line)
		if !ok {
			return
		}
		if ev["type"] == "reasoning.delta" && str(ev["text"]) != "" {
			emitThinking(o.emit, str(ev["text"]))
		} else if ev["type"] == "session_id" && str(ev["id"]) != "" {
			sessionID = str(ev["id"])
			emitSession(o.emit, sessionID)
		}
	}
	retries := max(0, envInt("RUNNER_HERMES_UPSTREAM_RETRIES", 50))
	backoff := atLeast(envMillis(3_000, "RUNNER_HERMES_UPSTREAM_BACKOFF_MS"), 250*time.Millisecond)
	backoffCap := max(backoff, envMillis(30_000, "RUNNER_HERMES_UPSTREAM_BACKOFF_CAP_MS"))
	summary := ""
	for attempt := 0; attempt < max(3, retries+1); attempt++ {
		summary, err = driveProcess(driveSpec{bin: command, args: args, cwd: o.cwd, env: o.env, label: "Hermes",
			runID: o.runID, emit: o.emit, onLine: onStdoutLine, summary: func() string { return strings.TrimSpace(text) },
			hermes: true, onStderrLine: onStderrLine, idleTimeout: hermesIdleTimeout()})
		if err != nil {
			// With no model or tool output the request was never observable,
			// so a fresh provider bridge is safe to retry.
			if !isCliIdleTimeout(err) || attempt >= 2 || strings.TrimSpace(text) != "" || isCanceledRun(o.runID) {
				return cliAgentResult{}, err
			}
			harnessNote(o.emit, fmt.Sprintf("\x1b[2m# provider returned no bytes; retrying Hermes (%d/2) with a fresh bridge\x1b[0m\r\n", attempt+1))
			continue
		}
		if (isHermesUpstreamFailure(summary) || isHermesUpstreamFailure(text)) && attempt < retries {
			wait := min(backoffCap, backoff*time.Duration(attempt+1))
			harnessNote(o.emit, fmt.Sprintf("\x1b[33m# hermes hit a transient upstream error (503); retrying (%d/%d) after %ds\x1b[0m\r\n", attempt+1, retries, int(wait.Round(time.Second)/time.Second)))
			text, inReasoning, summary = "", false, ""
			if sleepUnlessCanceled(o.runID, wait) {
				return cliAgentResult{}, errClaudeCanceled
			}
			continue
		}
		break
	}
	return cliAgentResult{summary: summary, sessionID: sessionID}, nil
}

// sleepUnlessCanceled waits, returning true early when the run is canceled.
func sleepUnlessCanceled(runID int, wait time.Duration) bool {
	deadline := time.Now().Add(wait)
	for time.Now().Before(deadline) {
		if isCanceledRun(runID) {
			return true
		}
		time.Sleep(min(100*time.Millisecond, time.Until(deadline)))
	}
	return isCanceledRun(runID)
}

// runAkronGrok runs Akron's Grok-backed Hermes loop. `-z` owns a fresh
// session, so it never claims resumability.
func runAkronGrok(o cliAgentOpts) (cliAgentResult, error) {
	args := []string{"--grok", "-z", o.prompt, "--yolo"}
	text := ""
	onStdoutLine := func(line string, _ bool) {
		text += line + "\n"
		emitText(o.emit, line+"\n")
	}
	onStderrLine := func(line string) {
		if ev, ok := jsonLine(line); ok && ev["type"] == "reasoning.delta" && str(ev["text"]) != "" {
			emitThinking(o.emit, str(ev["text"]))
		}
	}
	var summary string
	var err error
	for attempt := 0; attempt < 2; attempt++ {
		summary, err = driveProcess(driveSpec{bin: cliAgentBin("akron-grok"), args: args, cwd: o.cwd, env: o.env, label: "Akron --grok",
			runID: o.runID, emit: o.emit, onLine: onStdoutLine, summary: func() string { return strings.TrimSpace(text) },
			hermes: true, onStderrLine: onStderrLine, idleTimeout: akronIdleTimeout()})
		if err == nil {
			break
		}
		// Grok Build occasionally accepts a request but never returns a byte;
		// a fresh bridge succeeds, and nothing was emitted, so retrying is safe.
		if !isCliIdleTimeout(err) || attempt > 0 || isCanceledRun(o.runID) {
			return cliAgentResult{}, err
		}
		harnessNote(o.emit, "\x1b[2m# provider returned no bytes; retrying Akron once with a fresh bridge\x1b[0m\r\n")
		text = ""
	}
	return cliAgentResult{summary: summary}, nil
}
