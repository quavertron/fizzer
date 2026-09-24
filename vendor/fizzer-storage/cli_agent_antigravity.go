package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	agyPollInterval = 400 * time.Millisecond
	// Only treat "no new transcript lines" as done after a final planner response.
	agyIdleAfterFinalPolls = 8
	// Hard ceiling if the agent stalls mid-tool (~3 minutes with no new lines).
	agyStallPolls        = 450
	agyTranscriptWait    = 30 * time.Second
	agyManagedPrefix     = "fizzer-agy-full-"
	agyDefaultCLIProject = "default-cli-project"
)

var (
	agyMonologue        = regexp.MustCompile(`(?i)^(?:I will\b|I(?:'ll| am going to)\b|Let me\b)`)
	agyConversationGone = regexp.MustCompile(`(?i)(?:conversation|session)[^\n]*(?:not found|does not exist|unknown)`)
	agyPermissionDenied = regexp.MustCompile(`(?i)operation not permitted|permission denied|awaiting approval|user denied permission`)
	agyCommandFailed    = regexp.MustCompile(`(?i)command exited with code\s+[1-9]\d*`)
	agyQuotes           = regexp.MustCompile(`^"+|"+$`)
)

// cliGeminiHome locates the Gemini home the way the desktop runner always has,
// including the human's home when running as the separate agent account.
func cliGeminiHome() string {
	for _, name := range []string{"GEMINI_HOME", "ANTIGRAVITY_HOME"} {
		if dir := os.Getenv(name); dir != "" && fileExists(dir) {
			return dir
		}
	}
	if bin := os.Getenv("ANTIGRAVITY_BIN"); bin != "" {
		candidate := filepath.Clean(filepath.Join(filepath.Dir(bin), "..", ".."))
		if filepath.Base(candidate) == ".gemini" && fileExists(candidate) {
			return candidate
		}
	}
	userHome := homeJoin(".gemini")
	if fileExists(userHome) {
		return userHome
	}
	if sudoUser := os.Getenv("SUDO_USER"); sudoUser != "" {
		if human := filepath.Join("/Users", sudoUser, ".gemini"); fileExists(human) {
			return human
		}
	}
	return userHome
}

func antigravityBin() string {
	if bin := os.Getenv("ANTIGRAVITY_BIN"); bin != "" {
		return bin
	}
	return filepath.Join(cliGeminiHome(), "antigravity", "bin", "agentapi")
}

func antigravityTranscriptPath(conversationID string) string {
	primary := filepath.Join(cliGeminiHome(), "antigravity", "brain", conversationID, ".system_generated", "logs", "transcript.jsonl")
	if fileExists(primary) {
		return primary
	}
	cli := filepath.Join(cliGeminiHome(), "antigravity-cli", "brain", conversationID, ".system_generated", "logs", "transcript.jsonl")
	if fileExists(cli) {
		return cli
	}
	return primary
}

// Planner narration ("I will view…") is thinking, not a chat reply.
func agyIsPlannerMonologue(text string) bool {
	return agyMonologue.MatchString(strings.TrimSpace(text))
}

func canonicalPath(p string) string {
	abs, err := filepath.Abs(p)
	if err != nil {
		abs = p
	}
	if real, err := filepath.EvalSymlinks(abs); err == nil {
		return real
	}
	return abs
}

func fileURL(path string) string {
	return (&url.URL{Scheme: "file", Path: path}).String()
}

func fileURLPath(uri string) (string, bool) {
	parsed, err := url.Parse(uri)
	if err != nil || parsed.Scheme != "file" || parsed.Path == "" {
		return "", false
	}
	return parsed.Path, true
}

// selectAntigravityProject matches workspace roots, never permission strings
// or another project's name; the deepest (then primary) root wins.
func selectAntigravityProject(projects []map[string]any, cwd string) string {
	target := canonicalPath(cwd)
	bestID, bestDepth, bestPrimary := "", -1, false
	for _, project := range projects {
		id := str(project["id"])
		if id == "" || strings.HasPrefix(id, agyManagedPrefix) {
			continue
		}
		resources, _ := asObject(project["projectResources"])["resources"].([]any)
		for index, raw := range resources {
			uri := str(asObject(asObject(raw)["gitFolder"])["folderUri"])
			rootPath, ok := fileURLPath(uri)
			if !ok {
				continue
			}
			root := canonicalPath(rootPath)
			relative, err := filepath.Rel(root, target)
			if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
				continue
			}
			primary := index == 0
			if len(root) > bestDepth || (len(root) == bestDepth && primary && !bestPrimary) {
				bestID, bestDepth, bestPrimary = id, len(root), primary
			}
		}
	}
	return bestID
}

// antigravityFullHostProject is Fizzer's opt-in full-host project; it never
// alters the user's IDE project.
func antigravityFullHostProject(source map[string]any, cwd string) map[string]any {
	root := canonicalPath(cwd)
	sum := sha256.Sum256([]byte(str(source["id"]) + "\n" + root))
	settings := map[string]any{}
	for k, v := range asObject(source["settings"]) {
		settings[k] = v
	}
	for k, v := range map[string]any{
		"sandboxMode": false, "permissionPreset": "AGENT_PERMISSION_PRESET_TURBO",
		"fileAccessPolicy": "AGENT_SETTING_POLICY_ALLOW", "internetPolicy": "AGENT_SETTING_POLICY_ALLOW",
		"autoExecutionPolicy": "CASCADE_COMMANDS_AUTO_EXECUTION_EAGER", "artifactReviewMode": "ARTIFACT_REVIEW_MODE_TURBO",
	} {
		settings[k] = v
	}
	return map[string]any{
		"id":               agyManagedPrefix + hex.EncodeToString(sum[:])[:24],
		"name":             fmt.Sprintf("Fizzer runtime: %s (full host access)", filepath.Base(root)),
		"projectResources": map[string]any{"resources": []any{map[string]any{"gitFolder": map[string]any{"folderUri": fileURL(root), "allowWrite": true}}}},
		"permissionGrants": source["permissionGrants"],
		"settings":         settings,
	}
}

// antigravityChildEnv keeps connection/project context and drops nested agent
// provenance and stale executable overrides.
func antigravityChildEnv(base []string, discovered map[string]string) []string {
	var env []string
	for _, entry := range base {
		if !strings.HasPrefix(entry, "ANTIGRAVITY_") {
			env = append(env, entry)
		}
	}
	keys := make([]string, 0, len(discovered))
	for k := range discovered {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		env = append(env, k+"="+discovered[k])
	}
	return env
}

func readAntigravityProjects() []map[string]any {
	dir := filepath.Join(cliGeminiHome(), "config", "projects")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var projects []map[string]any
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasSuffix(name, ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			continue
		}
		var project map[string]any
		if json.Unmarshal(data, &project) != nil || project == nil {
			continue
		}
		if str(project["id"]) == "" {
			project["id"] = strings.TrimSuffix(name, ".json")
		}
		projects = append(projects, project)
	}
	return projects
}

// discoverAntigravityEnv finds the language server address, CSRF token and
// project for cwd; connection details come from base or EnsureAntigravityLS.
func discoverAntigravityEnv(cwd string, base []string) map[string]string {
	env := map[string]string{"ANTIGRAVITY_AGENT": "1"}
	projects := readAntigravityProjects()
	projectID := selectAntigravityProject(projects, cwd)
	if projectID == "" {
		projectID = agyDefaultCLIProject
		hasDefault := false
		for _, p := range projects {
			hasDefault = hasDefault || str(p["id"]) == agyDefaultCLIProject
		}
		if !hasDefault && len(projects) > 0 {
			projectID = str(projects[0]["id"])
		}
	}
	env["ANTIGRAVITY_PROJECT_ID"] = projectID
	for _, key := range []string{"ANTIGRAVITY_HOME", "ANTIGRAVITY_BIN"} {
		if v := envValue(base, key); v != "" {
			env[key] = v
		}
	}
	if addr, token := envValue(base, "ANTIGRAVITY_LS_ADDRESS"), envValue(base, "ANTIGRAVITY_CSRF_TOKEN"); addr != "" && token != "" {
		env["ANTIGRAVITY_LS_ADDRESS"], env["ANTIGRAVITY_CSRF_TOKEN"] = addr, token
		return env
	}
	if endpoint, err := EnsureAntigravityLS(); err == nil && endpoint.Address != "" && endpoint.CSRF != "" {
		env["ANTIGRAVITY_LS_ADDRESS"], env["ANTIGRAVITY_CSRF_TOKEN"] = endpoint.Address, endpoint.CSRF
	}
	return env
}

// agyLSRequest sends every control call to the server that launched the conversation.
func agyLSRequest(endpoint string, body map[string]any, env []string) (map[string]any, error) {
	addr, token := envValue(env, "ANTIGRAVITY_LS_ADDRESS"), envValue(env, "ANTIGRAVITY_CSRF_TOKEN")
	if addr == "" || token == "" {
		return nil, errors.New("Antigravity language server connection is missing.")
	}
	host := addr
	if !strings.Contains(host, "://") {
		host = "http://" + host
	}
	payload, _ := json.Marshal(body)
	req, err := http.NewRequest(http.MethodPost, strings.TrimRight(host, "/")+"/exa.language_server_pb.LanguageServerService/"+endpoint, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Codeium-Csrf-Token", token)
	resp, err := (&http.Client{Timeout: 4 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	var result map[string]any
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, fmt.Errorf("Antigravity %s: %s", endpoint, firstNonEmpty(str(result["message"]), fmt.Sprint(resp.StatusCode)))
	}
	return result, nil
}

var antigravityTiers = map[string]bool{"flash_lite": true, "flash": true, "pro": true}

var (
	agyLite     = regexp.MustCompile(`(?i)flash_lite|flash-lite|extra-low|flash.*\(low\)|m187\b|m50\b|gemini-2\.5-flash-lite|gemini-3\.1-flash-lite`)
	agyFlash    = regexp.MustCompile(`(?i)flash.*\(high\)|flash.*\(medium\)|m132\b|m20\b|m18\b|m21\b|gemini-3-flash|gemini-3\.8-flash|gemini-3\.5-flash|gemini-2\.5-flash|gemini-3\.1-flash`)
	agyProFam   = regexp.MustCompile(`(?i)gemini-2\.5-pro|gemini-3\.1-pro|gemini-pro|pro-high|pro-low|m36\b|m16\b|m37\b|\(high\)|\(low\)`)
	agyPro      = regexp.MustCompile(`(?i)pro`)
	agyProWord  = regexp.MustCompile(`(?i)\bpro\b`)
	agyFlashAny = regexp.MustCompile(`(?i)flash`)
	agyOther    = regexp.MustCompile(`(?i)claude|opus|sonnet|gpt|oss|anthropic`)
	agySlot     = regexp.MustCompile(`(?i)model_placeholder_m`)
)

// resolveAntigravityModelTier maps configured model ids, enums and labels to
// the only --model tiers agentapi accepts.
func resolveAntigravityModelTier(model string) string {
	raw := strings.TrimSpace(model)
	if raw == "" {
		return ""
	}
	if before, _, found := strings.Cut(raw, "|"); found {
		raw = strings.TrimSpace(before)
	}
	lower := strings.ToLower(raw)
	switch {
	case antigravityTiers[lower]:
		return lower
	case agyLite.MatchString(raw):
		return "flash_lite"
	case agyFlash.MatchString(raw) || lower == "flash":
		return "flash"
	case agyProFam.MatchString(raw) && agyPro.MatchString(raw):
		return "pro"
	case agyProWord.MatchString(raw) && !agyFlashAny.MatchString(raw):
		return "pro"
	case agyOther.MatchString(raw), agySlot.MatchString(raw):
		// agentapi only has tiers; other providers' slots use pro.
		return "pro"
	}
	return ""
}

func agyToolFriendlyName(name string) string {
	names := map[string]string{
		"list_dir": "List Directory", "list_directory": "List Directory", "view_file": "View File",
		"write_to_file": "Write File", "replace_file_content": "Edit File", "multi_replace_file_content": "Edit File",
		"grep_search": "Search Workspace", "run_command": "Bash", "search_web": "Web Search", "code_action": "Code Action",
		"generate_image": "Generate Image", "invoke_subagent": "Subagent", "ask_question": "Ask Question",
		"read_browser_page": "Browser", "open_browser_url": "Browser",
	}
	n := strings.TrimSpace(name)
	return firstNonEmpty(names[n], names[strings.ToLower(n)], n, "Tool")
}

func clip(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

func agyPreviewInput(input map[string]any) string {
	for _, key := range []string{"Command", "command", "DirectoryPath", "FilePath", "file_path", "path", "Query", "pattern", "Url", "url"} {
		if v, ok := input[key].(string); ok && strings.TrimSpace(v) != "" {
			// agentapi sometimes double-quotes JSON string values.
			return clip(agyQuotes.ReplaceAllString(v, ""), 200)
		}
	}
	return clip(jsonString(input), 200)
}

func agyNormalizeToolArgs(args any) map[string]any {
	out := map[string]any{}
	for k, v := range asObject(args) {
		if s, ok := v.(string); ok {
			out[k] = agyQuotes.ReplaceAllString(s, "")
		} else {
			out[k] = v
		}
	}
	return out
}

// antigravityRun tracks what a cancel must stop: the conversation and any live agentapi child.
type antigravityRun struct {
	mu             sync.Mutex
	canceled       bool
	conversationID string
	env            []string
	child          *exec.Cmd
}

func (r *antigravityRun) cancel() {
	r.mu.Lock()
	r.canceled = true
	conversation, env, child := r.conversationID, r.env, r.child
	r.conversationID = ""
	r.mu.Unlock()
	if conversation != "" {
		_, _ = agyLSRequest("CancelCascadeInvocation", map[string]any{"cascadeId": conversation, "killBackgroundTasks": true}, env)
	}
	if child != nil {
		terminateProcess(child, false)
	}
}

func (r *antigravityRun) isCanceled() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.canceled
}

// runAgentAPI runs agentapi once and returns its single JSON stdout blob.
func runAgentAPI(bin string, args []string, o cliAgentOpts, env []string, run *antigravityRun) (string, error) {
	if envValue(env, "ANTIGRAVITY_LS_ADDRESS") == "" || envValue(env, "ANTIGRAVITY_CSRF_TOKEN") == "" {
		return "", errors.New("Antigravity language server not found (ANTIGRAVITY_LS_ADDRESS / CSRF). Open the Antigravity app and sign in, then retry.")
	}
	harnessNote(o.emit, fmt.Sprintf("\x1b[2m$ %s %s\x1b[0m\r\n", bin, quoteArgs(args)))
	harnessNote(o.emit, fmt.Sprintf("\x1b[2m# antigravity ls %s · project %s\x1b[0m\r\n", envValue(env, "ANTIGRAVITY_LS_ADDRESS"), firstNonEmpty(envValue(env, "ANTIGRAVITY_PROJECT_ID"), "?")))
	timing := newRequestTiming(o.emit, "agentapi_process_stdout")
	cmd := exec.Command(bin, args...)
	cmd.Dir, cmd.Env = o.cwd, env
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &firstByteWriter{w: &stdout, first: timing.firstResponse}
	cmd.Stderr = &teeWriter{w: &stderr, tee: func(chunk string) { harnessNote(o.emit, "\x1b[31m"+chunk+"\x1b[0m") }}
	if err := cmd.Start(); err != nil {
		timing.complete("launch_failed")
		return "", fmt.Errorf("agentapi could not start: %v", err)
	}
	run.mu.Lock()
	run.child = cmd
	run.mu.Unlock()
	waitErr := cmd.Wait()
	run.mu.Lock()
	run.child = nil
	run.mu.Unlock()
	code, signaled := exitStatus(cmd, waitErr)
	switch {
	case signaled:
		timing.complete("signaled")
	case code == 0:
		timing.complete("completed")
	default:
		timing.complete("failed")
	}
	codeText := "?"
	if !signaled {
		codeText = fmt.Sprint(code)
	}
	harnessNote(o.emit, fmt.Sprintf("\x1b[2m# agentapi exit %s\x1b[0m\r\n", codeText))
	if !signaled && code == 0 {
		return stdout.String(), nil
	}
	detail := strings.TrimSpace(firstNonEmpty(stderr.String(), stdout.String()))
	if len(detail) > 800 {
		detail = detail[len(detail)-800:]
	}
	if signaled {
		codeText = "null"
	}
	if detail != "" {
		return "", fmt.Errorf("agentapi exited %s: %s", codeText, detail)
	}
	return "", fmt.Errorf("agentapi exited %s", codeText)
}

type firstByteWriter struct {
	w     io.Writer
	first func()
}

func (f *firstByteWriter) Write(p []byte) (int, error) {
	if len(p) > 0 {
		f.first()
	}
	return f.w.Write(p)
}

type teeWriter struct {
	w   io.Writer
	tee func(string)
}

func (t *teeWriter) Write(p []byte) (int, error) {
	t.tee(string(p))
	return t.w.Write(p)
}

func writeAntigravityHelperContext(conversationID string, runID int, env []string) {
	base := map[string]any{}
	if path := envValue(env, "CASCADE_HELPER_CONFIG"); path != "" && fileExists(path) {
		if data, err := os.ReadFile(path); err == nil {
			_ = json.Unmarshal(data, &base)
		}
	} else if runID > 0 {
		if data, err := os.ReadFile(filepath.Join(fizzerDir(), "run-contexts", fmt.Sprintf("%d.json", runID))); err == nil {
			_ = json.Unmarshal(data, &base)
		}
	}
	token := strings.TrimSpace(firstNonEmpty(envValue(env, "CASCADE_NOTE_TOKEN"), str(base["token"])))
	if token == "" {
		token = readTrimmed(filepath.Join(fizzerDir(), "token"))
	}
	payload := map[string]any{}
	for k, v := range base {
		payload[k] = v
	}
	payload["url"] = firstNonEmpty(envValue(env, "CASCADE_NOTE_URL"), str(base["url"]), "https://cscd.online")
	payload["token"] = token
	payload["vaultId"] = firstNonEmpty(envValue(env, "CASCADE_NOTE_VAULT"), str(base["vaultId"]))
	payload["chatChannelId"] = firstNonEmpty(envValue(env, "CASCADE_CHAT_CHANNEL"), str(base["chatChannelId"]))
	payload["chatMessageId"] = firstNonEmpty(envValue(env, "CASCADE_CHAT_MESSAGE"), str(base["chatMessageId"]))
	payload["chatTriggeringMessageId"] = firstNonEmpty(envValue(env, "CASCADE_CHAT_TRIGGERING_MESSAGE"), str(base["chatTriggeringMessageId"]))
	payload["chatAuthor"] = firstNonEmpty(envValue(env, "CASCADE_CHAT_AUTHOR"), str(base["chatAuthor"]))
	if runID > 0 {
		payload["runId"] = runID
	}
	payload["updatedAt"] = time.Now().UTC().Format(time.RFC3339Nano)
	if conversationID != "" {
		writeJSONFile(filepath.Join(fizzerDir(), "conversations", conversationID+".json"), payload)
	}
	writeJSONFile(filepath.Join(fizzerDir(), "agent-helper-context.json"), payload)
}

func sameJSON(a, b any) bool { return jsonString(a) == jsonString(b) }

func projectChanged(current, desired map[string]any) bool {
	for _, key := range []string{"settings", "permissionGrants", "projectResources"} {
		if !sameJSON(current[key], desired[key]) {
			return true
		}
	}
	return false
}

func mergeProject(current, desired map[string]any, id string) map[string]any {
	merged := map[string]any{}
	for k, v := range current {
		merged[k] = v
	}
	for k, v := range desired {
		merged[k] = v
	}
	merged["id"] = id
	return merged
}

func findProjectByName(name, fallback string) string {
	for _, project := range readAntigravityProjects() {
		if str(project["name"]) == name && str(project["id"]) != "" {
			return str(project["id"])
		}
	}
	return fallback
}

// prepareAntigravityProject resolves the live project for cwd. Permission
// policy stays with the user's IDE except for Fizzer's opt-in full-host project.
func prepareAntigravityProject(o cliAgentOpts, env []string) ([]string, error) {
	projectID := firstNonEmpty(envValue(env, "ANTIGRAVITY_PROJECT_ID"), agyDefaultCLIProject)
	env = withEnv(env, "ANTIGRAVITY_PROJECT_ID="+projectID)
	live, err := agyLSRequest("ReadProject", map[string]any{"id": projectID}, env)
	if err != nil {
		// An inherited address/token pair may belong to a dead parent session.
		refreshed := antigravityChildEnv(o.env, discoverAntigravityEnv(o.cwd, nil))
		addr := envValue(refreshed, "ANTIGRAVITY_LS_ADDRESS")
		if addr == "" || (addr == envValue(env, "ANTIGRAVITY_LS_ADDRESS") && envValue(refreshed, "ANTIGRAVITY_CSRF_TOKEN") == envValue(env, "ANTIGRAVITY_CSRF_TOKEN")) {
			return nil, err
		}
		env = withEnv(refreshed, "ANTIGRAVITY_PROJECT_ID="+projectID)
		if live, err = agyLSRequest("ReadProject", map[string]any{"id": projectID}, env); err != nil {
			return nil, err
		}
	}
	if asObject(live["project"]) == nil {
		if fallback, err := agyLSRequest("ReadProject", map[string]any{"id": agyDefaultCLIProject}, env); err == nil && asObject(fallback["project"]) != nil {
			live, projectID = fallback, agyDefaultCLIProject
			env = withEnv(env, "ANTIGRAVITY_PROJECT_ID="+projectID)
		}
	}
	project := asObject(live["project"])
	root := canonicalPath(o.cwd)
	if project == nil {
		project = map[string]any{
			"id":               projectID,
			"name":             "CLI Project: " + filepath.Base(root),
			"projectResources": map[string]any{"resources": []any{map[string]any{"gitFolder": map[string]any{"folderUri": fileURL(root), "allowWrite": true}}}},
			"permissionGrants": map[string]any{"permissionGrants": map[string]any{"allow": []any{"read_file(*)", "write_file(*)", "command(*)"}}},
			"settings": map[string]any{
				"fileAccessPolicy": "AGENT_SETTING_POLICY_ALLOW", "internetPolicy": "AGENT_SETTING_POLICY_ALLOW",
				"autoExecutionPolicy": "CASCADE_COMMANDS_AUTO_EXECUTION_EAGER", "artifactReviewMode": "ARTIFACT_REVIEW_MODE_TURBO",
			},
		}
		_, _ = agyLSRequest("CreateProject", map[string]any{"project": project}, env)
	}
	if selectAntigravityProject([]map[string]any{project}, o.cwd) != projectID {
		resources, _ := asObject(project["projectResources"])["resources"].([]any)
		hasRoot := false
		for _, raw := range resources {
			if p, ok := fileURLPath(str(asObject(asObject(raw)["gitFolder"])["folderUri"])); ok && canonicalPath(p) == root {
				hasRoot = true
			}
		}
		if !hasRoot {
			projectResources := map[string]any{}
			for k, v := range asObject(project["projectResources"]) {
				projectResources[k] = v
			}
			projectResources["resources"] = append(append([]any{}, resources...), map[string]any{"gitFolder": map[string]any{"folderUri": fileURL(root), "allowWrite": true}})
			project["projectResources"] = projectResources
			_, _ = agyLSRequest("UpdateProject", map[string]any{"project": project}, env)
		}
	}
	if !o.yolo {
		return env, nil
	}
	full := antigravityFullHostProject(project, o.cwd)
	targetID := findProjectByName(str(full["name"]), str(full["id"]))
	current, err := agyLSRequest("ReadProject", map[string]any{"id": targetID}, env)
	if err != nil {
		return nil, err
	}
	if current["notFoundOnDisk"] == true {
		created := full
		created["id"] = targetID
		if _, createErr := agyLSRequest("CreateProject", map[string]any{"project": created}, env); createErr != nil {
			// Another run may already have created this project.
			existingID := findProjectByName(str(full["name"]), targetID)
			existing, err := agyLSRequest("ReadProject", map[string]any{"id": existingID}, env)
			if err != nil || asObject(existing["project"]) == nil {
				return nil, createErr
			}
			if projectChanged(asObject(existing["project"]), full) {
				if _, err := agyLSRequest("UpdateProject", map[string]any{"project": mergeProject(asObject(existing["project"]), full, existingID)}, env); err != nil {
					return nil, err
				}
			}
			targetID = existingID
		}
	} else {
		if asObject(current["project"]) == nil {
			return nil, errors.New("Antigravity did not return the full-host runtime project.")
		}
		if projectChanged(asObject(current["project"]), full) {
			if _, err := agyLSRequest("UpdateProject", map[string]any{"project": mergeProject(asObject(current["project"]), full, targetID)}, env); err != nil {
				return nil, err
			}
		}
	}
	return withEnv(env, "ANTIGRAVITY_PROJECT_ID="+targetID), nil
}

func countTranscriptLines(path string) int {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	count := 0
	for _, line := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(line) != "" {
			count++
		}
	}
	return count
}

// runAntigravity runs agentapi and streams transcript.jsonl as structured blocks.
func runAntigravity(o cliAgentOpts) (cliAgentResult, error) {
	bin := antigravityBin()
	env := antigravityChildEnv(o.env, discoverAntigravityEnv(o.cwd, o.env))
	env, err := prepareAntigravityProject(o, env)
	if err != nil {
		return cliAgentResult{}, err
	}
	resumeID := o.resumeID
	if resumeID != "" {
		prior, err := agyLSRequest("GetConversationMetadata", map[string]any{"conversationId": resumeID}, env)
		switch {
		case err != nil && !(agyConversationGone.MatchString(err.Error()) || strings.Contains(strings.ToLower(err.Error()), "not_found")):
			return cliAgentResult{}, err
		case err != nil:
			resumeID = ""
			harnessNote(o.emit, "\x1b[2m# saved Antigravity conversation is gone; starting fresh\x1b[0m\r\n")
		case str(asObject(prior["metadata"])["projectId"]) == "":
			return cliAgentResult{}, errors.New("Cannot verify the saved Antigravity conversation permission mode.")
		case str(asObject(prior["metadata"])["projectId"]) != envValue(env, "ANTIGRAVITY_PROJECT_ID"):
			harnessNote(o.emit, "\x1b[2m# workspace or permission mode changed; starting a fresh Antigravity conversation\x1b[0m\r\n")
			resumeID = ""
		}
	}
	writeAntigravityHelperContext(resumeID, o.runID, o.env)

	run := &antigravityRun{env: env}
	setCliCancel(o.runID, run.cancel)
	defer clearCliCancel(o.runID)

	// Snapshot the transcript so only new turns stream.
	processed := 0
	if resumeID != "" {
		processed = countTranscriptLines(antigravityTranscriptPath(resumeID))
	}
	tier := resolveAntigravityModelTier(o.model)
	newConversation := func() []string {
		args := []string{"new-conversation"}
		if tier != "" {
			args = append(args, "--model="+tier)
		}
		return append(args, o.prompt)
	}
	args := newConversation()
	if resumeID != "" {
		args = []string{"send-message", resumeID, o.prompt}
	}
	if o.model != "" && tier != "" && o.model != tier {
		harnessNote(o.emit, fmt.Sprintf("\x1b[2m# model %s → agentapi tier %s\x1b[0m\r\n", o.model, tier))
	} else if tier != "" {
		emitStats(o.emit, map[string]any{"model": tier})
	}

	conversationID := ""
	for attempt := 0; attempt < 2; attempt++ {
		output, err := runAgentAPI(bin, args, o, env, run)
		if err == nil {
			var result map[string]any
			if json.Unmarshal([]byte(output), &result) != nil {
				err = fmt.Errorf("Failed to parse agentapi JSON output: %s", clip(output, 500))
			} else if e := str(result["error"]); e != "" {
				err = errors.New(e)
			} else {
				response := asObject(result["response"])
				conversationID = firstNonEmpty(str(asObject(response["newConversation"])["conversationId"]), str(asObject(response["sendMessage"])["recipientId"]))
				if conversationID == "" {
					err = errors.New("No conversationId returned by agentapi.")
				}
			}
		}
		if err == nil {
			break
		}
		if attempt == 0 && resumeID != "" && agyConversationGone.MatchString(err.Error()) {
			harnessNote(o.emit, "\x1b[2m# saved Antigravity conversation is gone; starting a new conversation\x1b[0m\r\n")
			args, processed = newConversation(), 0
			continue
		}
		return cliAgentResult{}, err
	}
	writeAntigravityHelperContext(conversationID, o.runID, o.env)
	run.mu.Lock()
	canceledEarly := run.canceled
	if !canceledEarly {
		run.conversationID = conversationID
	}
	run.mu.Unlock()
	if canceledEarly {
		go agyLSRequest("CancelCascadeInvocation", map[string]any{"cascadeId": conversationID, "killBackgroundTasks": true}, env)
		return cliAgentResult{summary: "Run canceled by user.", sessionID: conversationID}, nil
	}

	finished := false
	defer func() {
		if !finished && !run.isCanceled() {
			_, _ = agyLSRequest("CancelCascadeInvocation", map[string]any{"cascadeId": conversationID, "killBackgroundTasks": true}, env)
		}
	}()
	emitSession(o.emit, conversationID)
	harnessNote(o.emit, fmt.Sprintf("\x1b[2m# conversation %s\x1b[0m\r\n", conversationID))
	transcript := antigravityTranscriptPath(conversationID)
	deadline := time.Now().Add(agyTranscriptWait)
	for !fileExists(transcript) {
		if time.Now().After(deadline) {
			return cliAgentResult{}, fmt.Errorf("Transcript file was not created at %s", transcript)
		}
		if run.isCanceled() {
			return cliAgentResult{summary: "Run canceled by user.", sessionID: conversationID}, nil
		}
		time.Sleep(agyPollInterval)
		transcript = antigravityTranscriptPath(conversationID)
	}

	t := &agyTranscript{o: o, conversationID: conversationID, processed: processed, emittedTools: map[string]bool{}, bypass: map[string]bool{}}
	statusPolls := 0
	for !t.done {
		if run.isCanceled() {
			return cliAgentResult{summary: firstNonEmpty(t.summary, "Run canceled by user."), sessionID: conversationID}, nil
		}
		t.check(transcript)
		// A transcript can stop after a failed tool or quota error; ask the
		// provider whether it stopped rather than inventing completion.
		statusPolls++
		if !t.done && t.stallPolls > 0 && statusPolls%15 == 0 {
			if state, err := agyLSRequest("GetCascadeTrajectory", map[string]any{"cascadeId": conversationID}, env); err == nil && state["status"] == "CASCADE_RUN_STATUS_IDLE" {
				t.check(transcript)
				if !t.sawFinal || len(t.pendingTools) > 0 {
					if len(t.bypass) > 0 {
						t.failure = "Antigravity stopped with a sandbox permission request pending. Review the request in its IDE before retrying."
					} else {
						t.failure = firstNonEmpty(t.lastToolError, "Antigravity stopped without returning a response. Check its IDE for a provider error or pending permission.")
					}
				}
				t.done = true
			}
		}
		if !t.done {
			time.Sleep(agyPollInterval)
		}
	}
	if t.failure != "" {
		return cliAgentResult{}, errors.New(t.failure)
	}
	finished = true
	summary := t.summary
	// No user-visible success placeholder: an empty summary drops the chat shell.
	if !t.emittedText || strings.TrimSpace(summary) == "" || agyIsPlannerMonologue(summary) {
		summary = ""
	}
	harnessNote(o.emit, fmt.Sprintf("\x1b[2m# done · %d transcript lines\x1b[0m\r\n", t.processed))
	return cliAgentResult{summary: summary, sessionID: conversationID}, nil
}

type agyTranscript struct {
	o                                     cliAgentOpts
	conversationID                        string
	processed, stallPolls, idleAfterFinal int
	done, sawFinal, emittedText           bool
	summary, failure, lastToolError       string
	pendingTools                          []string
	emittedTools, bypass                  map[string]bool
}

func (t *agyTranscript) shiftTool() string {
	if len(t.pendingTools) == 0 {
		return ""
	}
	id := t.pendingTools[0]
	t.pendingTools = t.pendingTools[1:]
	return id
}

func (t *agyTranscript) check(path string) {
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	content := string(data)
	// The writer may split a record across polls; consume complete lines only.
	content = content[:strings.LastIndexByte(content, '\n')+1]
	var lines []string
	for _, line := range strings.Split(content, "\n") {
		if strings.TrimSpace(line) != "" {
			lines = append(lines, line)
		}
	}
	if len(lines) <= t.processed {
		t.stallPolls++
		if t.sawFinal && len(t.pendingTools) == 0 {
			t.idleAfterFinal++
			if t.idleAfterFinal >= agyIdleAfterFinalPolls {
				t.done = true
			}
		} else if t.stallPolls >= agyStallPolls {
			t.failure = firstNonEmpty(t.lastToolError, "Antigravity stopped making progress before returning a response.")
			harnessNote(t.o.emit, fmt.Sprintf("\x1b[33m# stall timeout after %ds with no transcript progress\x1b[0m\r\n", int((agyStallPolls*agyPollInterval)/time.Second)))
			t.done = true
		}
		return
	}
	t.stallPolls, t.idleAfterFinal = 0, 0
	emit := t.o.emit
	for i := t.processed; i < len(lines); i++ {
		step, ok := jsonLine(lines[i])
		if !ok {
			continue
		}
		source := str(step["source"])
		kind := strings.ToUpper(str(step["type"]))
		status := strings.ToUpper(str(step["status"]))
		if kind == "CONVERSATION_HISTORY" || kind == "USER_INPUT" || kind == "SYSTEM_MESSAGE" {
			continue
		}
		if source == "MODEL" && kind == "PLANNER_RESPONSE" {
			text := strings.TrimSpace(str(step["content"]))
			toolCalls, _ := step["tool_calls"].([]any)
			thinking := len(toolCalls) > 0 || agyIsPlannerMonologue(text)
			if text != "" {
				if thinking {
					// Narration before tools is thinking only, never chat body or summary.
					emitThinking(emit, text)
					harnessNote(emit, fmt.Sprintf("\x1b[2m# thinking\x1b[0m\r\n\x1b[2m%s\x1b[0m\r\n", clip(text, 500)))
				} else {
					t.summary = text
					sep := ""
					if t.emittedText {
						sep = "\n\n"
					}
					emitText(emit, sep+text)
					t.emittedText = true
					harnessNote(emit, text+"\r\n")
				}
			}
			for _, raw := range toolCalls {
				tc := asObject(raw)
				stepIndex := fmt.Sprint(i)
				if v, ok := step["step_index"].(float64); ok {
					stepIndex = fmt.Sprint(int(v))
				}
				toolID := firstNonEmpty(str(tc["id"]), fmt.Sprintf("agy-%s-%s-%d", t.conversationID, stepIndex, len(t.pendingTools)))
				if t.emittedTools[toolID] {
					continue
				}
				t.emittedTools[toolID] = true
				t.pendingTools = append(t.pendingTools, toolID)
				name := agyToolFriendlyName(firstNonEmpty(str(tc["name"]), "tool"))
				input := agyNormalizeToolArgs(tc["args"])
				if strings.EqualFold(firstNonEmpty(str(input["BypassSandbox"]), str(asObject(tc["args"])["BypassSandbox"])), "true") {
					t.bypass[toolID] = true
				}
				emitToolUse(emit, toolID, name, input)
				preview := agyPreviewInput(input)
				if preview != "" {
					preview = " " + preview
				}
				harnessNote(emit, fmt.Sprintf("\x1b[36m▶ %s\x1b[0m%s\r\n", name, preview))
			}
			// True completion: the planner finished with no more tools.
			t.sawFinal = status == "DONE" && len(toolCalls) == 0 && text != "" && !thinking
			continue
		}
		if source != "MODEL" && source != "SYSTEM" {
			continue
		}
		if kind == "ERROR_MESSAGE" || status == "ERROR" {
			message := clip(firstNonEmpty(str(step["content"]), "Antigravity error"), 2000)
			if kind == "ERROR_MESSAGE" {
				t.failure, t.done = message, true
			} else {
				t.lastToolError = message
			}
			harnessNote(emit, fmt.Sprintf("\x1b[31m✖ %s\x1b[0m\r\n", message))
			if toolID := t.shiftTool(); toolID != "" {
				delete(t.bypass, toolID)
				emitToolResult(emit, toolID, message, true)
			}
			continue
		}
		// Tool execution results (VIEW_FILE, RUN_COMMAND, …).
		if kind != "PLANNER_RESPONSE" && kind != "EPHEMERAL_MESSAGE" && kind != "CHECKPOINT" {
			out := str(step["content"])
			toolID := t.shiftTool()
			if toolID == "" {
				stepIndex := fmt.Sprint(i)
				if v, ok := step["step_index"].(float64); ok {
					stepIndex = fmt.Sprint(int(v))
				}
				toolID = "agy-result-" + stepIndex
			}
			delete(t.bypass, toolID)
			isError := status == "ERROR" || agyCommandFailed.MatchString(out) || agyPermissionDenied.MatchString(out)
			if isError {
				t.lastToolError = truncateText(out, 2000)
			}
			emitToolResult(emit, toolID, out, isError)
			if isError {
				autoPapercut(out, firstNonEmpty(kind, "tool"), t.o.env)
			}
			preview := clip(strings.TrimSpace(papercutSpace.ReplaceAllString(out, " ")), 160)
			color := "\x1b[2m"
			if isError {
				color = "\x1b[31m"
			}
			if preview != "" {
				preview = ": " + preview
			}
			harnessNote(emit, fmt.Sprintf("%s◀ %s%s\x1b[0m\r\n", color, kind, preview))
			t.sawFinal = false
		}
	}
	t.processed = len(lines)
	if t.sawFinal && len(t.pendingTools) == 0 {
		t.idleAfterFinal = max(t.idleAfterFinal, 1)
	}
}
