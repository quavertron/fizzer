package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// ── Grok ──────────────────────────────────────────────────────
// `grok --output-format streaming-json` streams thought/text tokens then an
// end event; its tools run silently.

var (
	grokKeyPrefix = regexp.MustCompile(`"?key_prefix":"[^"]*"`)
	grokRTPrefix  = regexp.MustCompile(`"?rt_prefix":"[^"]*"`)
	grokBearer    = regexp.MustCompile(`(?i)Bearer\s+[A-Za-z0-9._~+/=-]+`)
	grokNoise     = regexp.MustCompile(`(?i)api error|forbidden|permission-denied|unauthorized|rate|paywall|subscription`)
)

func redactGrokDiagnostic(input string) string {
	input = grokKeyPrefix.ReplaceAllStringFunc(input, func(m string) string {
		return strings.SplitN(m, ":", 2)[0] + `:"[redacted]"`
	})
	input = grokRTPrefix.ReplaceAllStringFunc(input, func(m string) string {
		return strings.SplitN(m, ":", 2)[0] + `:"[redacted]"`
	})
	return grokBearer.ReplaceAllString(input, "Bearer [redacted]")
}

func extractGrokDiagnostic(debugFile string) string {
	data, err := os.ReadFile(debugFile)
	if err != nil {
		return ""
	}
	var lines []string
	for _, line := range regexp.MustCompile(`\r?\n`).Split(string(data), -1) {
		if line != "" {
			lines = append(lines, line)
		}
	}
	if len(lines) > 300 {
		lines = lines[len(lines)-300:]
	}
	var candidates []string
	for _, line := range lines {
		ev, ok := jsonLine(line)
		if !ok {
			if grokNoise.MatchString(line) {
				candidates = append(candidates, redactGrokDiagnostic(line))
			}
			continue
		}
		ctx := asObject(ev["ctx"])
		status := firstPresent(ctx["status_code"], ctx["http_status"])
		message := firstPresent(ctx["message"], ctx["error"])
		if status != nil || message != nil || ev["lvl"] == "error" {
			summary := map[string]any{"level": ev["lvl"], "message": ev["msg"], "status": status, "detail": message}
			candidates = append(candidates, redactGrokDiagnostic(jsonString(summary)))
		}
	}
	if len(candidates) > 3 {
		candidates = candidates[len(candidates)-3:]
	}
	return strings.Join(candidates, "\n")
}

func firstPresent(values ...any) any {
	for _, v := range values {
		if v != nil && v != false && v != "" && v != float64(0) {
			return v
		}
	}
	return nil
}

func runGrok(o cliAgentOpts) (cliAgentResult, error) {
	id := o.runID
	if id <= 0 {
		id = os.Getpid()
	}
	debugFile := filepath.Join(os.TempDir(), fmt.Sprintf("cascade-grok-%d-%d.jsonl", id, time.Now().UnixMilli()))
	defer os.Remove(debugFile)
	args := []string{"--single", o.prompt, "--output-format", "streaming-json", "--debug-file", debugFile, "--always-approve", "--cwd", o.cwd}
	if o.model != "" {
		args = append(args, "--model", o.model)
	}
	if o.resumeID != "" {
		args = append([]string{"--resume", o.resumeID}, args...)
	}
	text, sessionID := "", ""
	// Grok tools run silently, so any non-text event between answers marks a turn boundary.
	emittedText, lastWasText := false, false
	thoughtChars, textChars := 0, 0
	if o.model != "" {
		emitStats(o.emit, map[string]any{"model": o.model})
	}
	onLine := func(line string, _ bool) {
		ev, ok := jsonLine(line)
		if !ok {
			return
		}
		if usage := asObject(ev["usage"]); usage != nil {
			emitStats(o.emit, statsFromUsage(usage, map[string]any{"model": o.model}))
		}
		switch ev["type"] {
		case "thought":
			chunk := str(ev["data"])
			thoughtChars += len(chunk)
			emitThinking(o.emit, chunk)
			lastWasText = false
		case "text":
			chunk := str(ev["data"])
			sep := ""
			if !lastWasText && emittedText {
				sep = "\n\n"
			}
			emitText(o.emit, sep+chunk)
			text += sep + chunk
			textChars += len(chunk)
			if chunk != "" {
				emittedText, lastWasText = true, true
			}
		case "end":
			if sid := str(ev["sessionId"]); sid != "" {
				sessionID = sid
			}
			usage := asObject(ev["usage"])
			if usage == nil {
				usage = asObject(ev["stats"])
			}
			if usage != nil {
				emitStats(o.emit, statsFromUsage(usage, map[string]any{"model": o.model}))
			} else if thoughtChars > 0 || textChars > 0 {
				// ~4 chars/token when the CLI omits usage.
				emitStats(o.emit, map[string]any{"model": o.model,
					"inputTokens": max(1, (len(o.prompt)+2)/4), "outputTokens": (thoughtChars + textChars + 2) / 4})
			}
		}
	}
	summary, err := driveProcess(driveSpec{bin: cliAgentBin("grok"), args: args, cwd: o.cwd, env: o.env, label: "Grok",
		runID: o.runID, emit: o.emit, onLine: onLine, summary: func() string { return text }})
	if err != nil {
		if diagnostic := extractGrokDiagnostic(debugFile); diagnostic != "" {
			return cliAgentResult{}, fmt.Errorf("%s\n\nGrok diagnostic:\n%s", err.Error(), diagnostic)
		}
		return cliAgentResult{}, err
	}
	return cliAgentResult{summary: summary, sessionID: sessionID}, nil
}

// ── Copilot ───────────────────────────────────────────────────

func friendlyToolName(name string) string {
	switch name {
	case "read", "view_file":
		return "View File"
	case "write", "write_to_file", "create":
		return "Write File"
	case "edit", "replace_file_content", "multi_replace_file_content":
		return "Edit File"
	case "grep", "grep_search":
		return "Search Workspace"
	case "bash", "run_command":
		return "Bash"
	}
	return name
}

func runCopilot(o cliAgentOpts) (cliAgentResult, error) {
	args := []string{"-p", o.prompt, "--output-format", "json", "--yolo"}
	if o.model != "" {
		args = append(args, "--model", o.model)
	}
	if o.resumeID != "" {
		args = append([]string{"--session-id", o.resumeID}, args...)
	}
	summary, reasoning, sessionID := "", "", ""
	emittedTools := map[string]bool{}
	emittedText, lastWasText := false, false
	separator := func() string {
		if !lastWasText && emittedText {
			return "\n\n"
		}
		return ""
	}
	plain := func(line string) {
		summary = line
		emitText(o.emit, line+"\n")
	}
	toolUse := func(id, name string, input any) {
		if id == "" || emittedTools[id] {
			return
		}
		emittedTools[id] = true
		emitToolUse(o.emit, id, friendlyToolName(name), input)
		lastWasText = false
	}
	onLine := func(line string, _ bool) {
		if !strings.HasPrefix(line, "{") {
			plain(line)
			return
		}
		ev, ok := jsonLine(line)
		if !ok {
			plain(line)
			return
		}
		data := asObject(ev["data"])
		switch ev["type"] {
		case "assistant.reasoning_delta":
			if delta := str(data["deltaContent"]); delta != "" {
				reasoning += delta
				emitThinking(o.emit, delta)
				lastWasText = false
			}
		case "assistant.reasoning":
			if content := str(data["content"]); content != "" {
				if reasoning == "" {
					emitThinking(o.emit, content)
				}
				reasoning = content
				lastWasText = false
			}
		case "assistant.message_delta":
			if delta := str(data["deltaContent"]); delta != "" {
				sep := separator()
				summary += sep + delta
				emitText(o.emit, sep+delta)
				emittedText, lastWasText = true, true
			}
		case "assistant.message":
			if data == nil {
				return
			}
			if content := str(data["content"]); content != "" {
				hadDeltas := summary != ""
				summary = content
				if !hadDeltas {
					emitText(o.emit, separator()+content)
					emittedText, lastWasText = true, true
				}
			}
			requests, _ := data["toolRequests"].([]any)
			for _, raw := range requests {
				req := asObject(raw)
				toolUse(str(req["toolCallId"]), str(req["name"]), req["arguments"])
			}
		case "tool.execution_start":
			toolUse(str(data["toolCallId"]), str(data["toolName"]), data["arguments"])
		case "tool.execution_complete":
			id := str(data["toolCallId"])
			if id == "" {
				return
			}
			result := asObject(data["result"])
			out := firstNonNil(result["content"], result["detailedContent"], "")
			isError := data["success"] == false
			emitToolResult(o.emit, id, anyText(out), isError)
			if isError {
				autoPapercut(anyText(out), firstNonEmpty(str(data["toolName"]), "tool"), o.env)
			}
			lastWasText = false
		case "result":
			if sid := str(ev["sessionId"]); sid != "" {
				sessionID = sid
				emitSession(o.emit, sid)
			}
		}
	}
	text, err := driveProcess(driveSpec{bin: cliAgentBin("copilot"), args: args, cwd: o.cwd, env: o.env, label: "Copilot",
		runID: o.runID, emit: o.emit, onLine: onLine, summary: func() string { return summary }})
	if err != nil {
		return cliAgentResult{}, err
	}
	return cliAgentResult{summary: text, sessionID: firstNonEmpty(sessionID, o.resumeID)}, nil
}

func firstNonNil(values ...any) any {
	for _, v := range values {
		if v != nil {
			return v
		}
	}
	return nil
}

// anyText renders a tool output value the way JavaScript's String() did.
func anyText(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case float64, bool:
		return fmt.Sprint(t)
	}
	data, _ := json.Marshal(v)
	return string(data)
}

// ── Pi family (OMP, Pi) ───────────────────────────────────────

func runPiJSONAgent(o cliAgentOpts, bin, label string, args []string) (cliAgentResult, error) {
	summary, sessionID := "", ""
	emittedTools := map[string]bool{}
	emittedText, lastWasText := false, false
	toolUse := func(id, name string, input any) {
		if id == "" || emittedTools[id] {
			return
		}
		emittedTools[id] = true
		emitToolUse(o.emit, id, friendlyToolName(name), input)
		lastWasText = false
	}
	onLine := func(line string, _ bool) {
		if !strings.HasPrefix(line, "{") {
			return
		}
		ev, ok := jsonLine(line)
		if !ok {
			return
		}
		switch ev["type"] {
		case "session":
			if id := str(ev["id"]); id != "" {
				sessionID = id
				emitSession(o.emit, id)
			}
		case "message_update":
			ame := asObject(ev["assistantMessageEvent"])
			switch str(ame["type"]) {
			case "thinking_delta":
				if delta := str(ame["delta"]); delta != "" {
					emitThinking(o.emit, delta)
					lastWasText = false
				}
			case "text_delta":
				if delta := str(ame["delta"]); delta != "" {
					sep := ""
					if !lastWasText && emittedText {
						sep = "\n\n"
					}
					summary += sep + delta
					emitText(o.emit, sep+delta)
					emittedText, lastWasText = true, true
				}
			case "toolcall_end":
				if tc := asObject(ame["toolCall"]); tc != nil {
					toolUse(str(tc["id"]), str(tc["name"]), tc["arguments"])
				}
			}
		case "tool_execution_start":
			toolUse(str(ev["toolCallId"]), str(ev["toolName"]), ev["args"])
		case "tool_execution_end":
			id := str(ev["toolCallId"])
			if id == "" {
				return
			}
			result := asObject(ev["result"])
			out := firstNonNil(result["content"], result["detailedContent"], "")
			content := ""
			switch t := out.(type) {
			case []any:
				parts := make([]string, len(t))
				for i, item := range t {
					if m, ok := item.(map[string]any); ok {
						if text := str(m["text"]); text != "" {
							parts[i] = text
						} else {
							parts[i] = anyText(m)
						}
					} else {
						parts[i] = anyText(item)
					}
				}
				content = strings.Join(parts, "\n")
			default:
				content = anyText(t)
			}
			emitToolResult(o.emit, id, content, ev["isError"] == true || ev["success"] == false)
			lastWasText = false
		}
	}
	text, err := driveProcess(driveSpec{bin: bin, args: args, cwd: o.cwd, env: o.env, label: label,
		runID: o.runID, emit: o.emit, onLine: onLine, summary: func() string { return summary }})
	if err != nil {
		return cliAgentResult{}, err
	}
	return cliAgentResult{summary: text, sessionID: firstNonEmpty(sessionID, o.resumeID)}, nil
}

func runOmp(o cliAgentOpts) (cliAgentResult, error) {
	paths, cleanup, err := writeTempImages(o.images)
	if err != nil {
		return cliAgentResult{}, err
	}
	defer cleanup()
	args := []string{o.prompt, "--mode", "json", "--allow-home"}
	for _, file := range paths {
		args = append(args, "@"+file)
	}
	if o.model != "" {
		args = append(args, "--model", o.model)
	}
	if o.resumeID != "" {
		args = append([]string{"--resume", o.resumeID}, args...)
	}
	return runPiJSONAgent(o, cliAgentBin("omp"), "OMP", args)
}

func runPi(o cliAgentOpts) (cliAgentResult, error) {
	paths, cleanup, err := writeTempImages(o.images)
	if err != nil {
		return cliAgentResult{}, err
	}
	defer cleanup()
	args := []string{"--mode", "json", "--approve"}
	if o.resumeID != "" {
		args = append(args, "--session", o.resumeID)
	}
	if o.model != "" {
		args = append(args, "--model", o.model)
	}
	for _, file := range paths {
		args = append(args, "@"+file)
	}
	args = append(args, o.prompt)
	return runPiJSONAgent(o, cliAgentBin("pi"), "Pi", args)
}
