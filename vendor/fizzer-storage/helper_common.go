package main

// Agent helper CLIs (cascade-note, cascade-chat, cascade-scratchpad). The
// fizzer-storage binary answers to these names, so agents call them on PATH
// with no Node runtime.

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"syscall"
	"time"
)

const helperDefaultURL = "https://cscd.online"

var helperCommands = map[string]func(h *helper){
	"cascade-note":       runCascadeNote,
	"cascade-chat":       runCascadeChat,
	"cascade-scratchpad": runCascadeScratchpad,
}

// helperArgs keeps the helpers' permissive flag/value rules: --flag value,
// a bare --flag is true, and aliases map fixed flags to fixed values.
type helperArgs struct {
	pos  []string
	vals map[string]any
}

func parseHelperArgs(argv []string, aliases map[string][2]any) helperArgs {
	flags := map[string][2]any{"json": {"json", true}, "help": {"help", true}}
	for k, v := range aliases {
		flags[k] = v
	}
	args := helperArgs{vals: map[string]any{}}
	for i := 0; i < len(argv); i++ {
		arg := argv[i]
		switch {
		case arg == "-h":
			args.vals["help"] = true
		case strings.HasPrefix(arg, "--"):
			key := arg[2:]
			if flag, ok := flags[key]; ok {
				args.vals[flag[0].(string)] = flag[1]
			} else if i+1 >= len(argv) || strings.HasPrefix(argv[i+1], "--") {
				args.vals[key] = true
			} else {
				args.vals[key] = argv[i+1]
				i++
			}
		default:
			args.pos = append(args.pos, arg)
		}
	}
	return args
}

func (a helperArgs) has(key string) bool { _, ok := a.vals[key]; return ok }

// str returns the flag's string value, "true" for a bare flag, else empty.
func (a helperArgs) str(key string) string {
	switch v := a.vals[key].(type) {
	case string:
		return v
	case bool:
		if v {
			return "true"
		}
	}
	return ""
}

// value returns a flag's string value, or "" when it is absent or bare.
func (a helperArgs) value(key string) (string, bool) {
	v, ok := a.vals[key].(string)
	return v, ok
}

func (a helperArgs) flag(key string) bool { return a.vals[key] == true }

func (a helperArgs) positional(i int) string {
	if i < len(a.pos) {
		return a.pos[i]
	}
	return ""
}

func (a helperArgs) rest(from int) string {
	if from >= len(a.pos) {
		return ""
	}
	return strings.Join(a.pos[from:], " ")
}

type helperHTTPError struct {
	method, path, message, code string
	status                      int
	details                     any
}

func (e *helperHTTPError) Error() string { return e.message }

func newHelperHTTPError(method, path string, status int, text, message, arrow string) *helperHTTPError {
	var details any = map[string]any{}
	var parsed any
	if text != "" {
		// Keep the server's own bytes so recovery details keep their field order.
		var compact bytes.Buffer
		if json.Unmarshal([]byte(text), &parsed) != nil || json.Compact(&compact, []byte(text)) != nil {
			details = map[string]any{"raw": text}
		} else {
			details = json.RawMessage(compact.Bytes())
		}
	}
	d := asObject(parsed)
	description := text
	if str(d["code"]) == "revision_conflict" {
		description = string(details.(json.RawMessage))
	} else if e := str(d["error"]); e != "" {
		description = e
	}
	if message == "" {
		message = fmt.Sprintf("%s %s %s %d: %s", method, path, arrow, status, description)
	}
	code := "http_error"
	if c, ok := d["code"].(string); ok {
		code = c
	}
	return &helperHTTPError{method: method, path: path, status: status, message: message, code: code, details: details}
}

// helperNetError is a request that got no HTTP response.
type helperNetError struct{ cause error }

func (e *helperNetError) Error() string { return "fetch failed (" + e.cause.Error() + ")" }

func (e *helperNetError) code() string {
	switch {
	case errors.Is(e.cause, syscall.ECONNREFUSED):
		return "ECONNREFUSED"
	case errors.Is(e.cause, syscall.ECONNRESET):
		return "ECONNRESET"
	}
	return "network_error"
}

type helperExit struct{ code int }

type helper struct {
	command string
	args    helperArgs
	stdin   io.Reader
	stdout  io.Writer
	stderr  io.Writer
	config  map[string]any
	client  *http.Client
}

// fail reports an error (JSON on stderr with --json) and ends the helper.
func (h *helper) fail(v any) {
	message, code := fmt.Sprint(v), "cli_error"
	var httpErr *helperHTTPError
	var netErr *helperNetError
	if err, ok := v.(error); ok {
		message = err.Error()
		if errors.As(err, &httpErr) {
			code = httpErr.code
		} else if errors.As(err, &netErr) {
			code = netErr.code()
		}
	}
	if h.args.flag("json") {
		payload := map[string]any{"command": h.command, "code": code, "message": message, "exitCode": 1}
		if httpErr != nil {
			payload["status"], payload["method"], payload["path"], payload["details"] = httpErr.status, httpErr.method, httpErr.path, httpErr.details
		}
		fmt.Fprintln(h.stderr, jsonString(map[string]any{"error": payload}))
	} else {
		fmt.Fprintf(h.stderr, "%s: %s\n", h.command, message)
	}
	panic(helperExit{1})
}

func (h *helper) failf(format string, a ...any) { h.fail(fmt.Sprintf(format, a...)) }

func (h *helper) exit(code int) { panic(helperExit{code}) }

func (h *helper) print(human string, v any) {
	if h.args.flag("json") {
		fmt.Fprintln(h.stdout, jsonString(v))
	} else {
		fmt.Fprintln(h.stdout, human)
	}
}

// runHelper runs one helper invocation and returns its exit code.
func runHelper(name string, argv []string, stdin io.Reader, stdout, stderr io.Writer) (code int) {
	run, ok := helperCommands[name]
	if !ok {
		fmt.Fprintf(stderr, "unknown helper %q\n", name)
		return 1
	}
	aliases := map[string]map[string][2]any{
		"cascade-chat":       {"include-reply-context": {"include-reply-context", true}},
		"cascade-scratchpad": {"unconsolidated": {"unconsolidated", true}, "win": {"result", "win"}, "loss": {"result", "loss"}, "neutral": {"result", "neutral"}},
	}[name]
	h := &helper{command: name, args: parseHelperArgs(argv, aliases), stdin: stdin, stdout: stdout, stderr: stderr, client: &http.Client{}}
	defer func() {
		if r := recover(); r != nil {
			exit, ok := r.(helperExit)
			if !ok {
				panic(r)
			}
			code = exit.code
		}
	}()
	run(h)
	return 0
}

// isHelperTokenExpired matches the helpers' rule: only a JWT with an exp claim can expire.
func isHelperTokenExpired(token string) bool {
	if token == "" {
		return true
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return false
	}
	data, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return false
	}
	var payload map[string]any
	if json.Unmarshal(data, &payload) != nil {
		return false
	}
	exp, ok := payload["exp"].(float64)
	return ok && float64(time.Now().UnixMilli())/1000 > exp-10
}

func readHelperDiskToken() string {
	if v, set := os.LookupEnv("CASCADE_NOTE_TOKEN"); set && v == "" {
		return ""
	}
	if token := readTrimmed(filepath.Join(fizzerDir(), "token")); token != "" && !isHelperTokenExpired(token) {
		return token
	}
	return ""
}

// helperContextPath finds this run's helper context: the explicit config, the
// run id, the Antigravity conversation, then the newest recent run context.
func helperContextPath() string {
	if p := strings.TrimSpace(os.Getenv("CASCADE_HELPER_CONFIG")); p != "" {
		return p
	}
	if runID := strings.TrimSpace(os.Getenv("CASCADE_RUN_ID")); runID != "" {
		return filepath.Join(fizzerDir(), "run-contexts", runID+".json")
	}
	if conversation := strings.TrimSpace(os.Getenv("ANTIGRAVITY_CONVERSATION_ID")); conversation != "" {
		if p := filepath.Join(fizzerDir(), "conversations", conversation+".json"); fileExists(p) {
			return p
		}
	}
	defaultPath := filepath.Join(fizzerDir(), "agent-helper-context.json")
	runDir := filepath.Join(fizzerDir(), "run-contexts")
	entries, _ := os.ReadDir(runDir)
	var newest string
	var newestTime time.Time
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		if info, err := entry.Info(); err == nil && info.ModTime().After(newestTime) {
			newest, newestTime = filepath.Join(runDir, entry.Name()), info.ModTime()
		}
	}
	var defaultTime time.Time
	if info, err := os.Stat(defaultPath); err == nil {
		defaultTime = info.ModTime()
	}
	if newest != "" && newestTime.After(time.Now().Add(-15*time.Minute)) && newestTime.After(defaultTime) {
		return newest
	}
	return defaultPath
}

func readHelperContext() map[string]any {
	data, err := os.ReadFile(helperContextPath())
	if err != nil {
		return map[string]any{}
	}
	var parsed map[string]any
	if json.Unmarshal(data, &parsed) != nil || parsed == nil {
		return map[string]any{}
	}
	return parsed
}

func (h *helper) configString(key string) string { return strings.TrimSpace(str(h.config[key])) }

func resolveHelperToken(argsToken, configToken string) string {
	if argsToken != "" {
		return strings.TrimSpace(argsToken)
	}
	envToken := strings.TrimSpace(os.Getenv("CASCADE_NOTE_TOKEN"))
	if envToken != "" && !isHelperTokenExpired(envToken) {
		return envToken
	}
	configToken = strings.TrimSpace(configToken)
	if configToken != "" && !isHelperTokenExpired(configToken) {
		return configToken
	}
	if disk := readHelperDiskToken(); disk != "" {
		return disk
	}
	explicit := firstNonEmpty(envToken, configToken)
	if v, set := os.LookupEnv("CASCADE_NOTE_TOKEN"); explicit != "" && !(set && v == "") {
		return explicit
	}
	return ""
}

func (h *helper) baseURL(ignoreArgsURL bool) string {
	fromArgs := ""
	if !ignoreArgsURL {
		fromArgs = h.args.str("url")
	}
	raw := strings.TrimSpace(firstNonEmpty(fromArgs, h.configString("url"), os.Getenv("CASCADE_NOTE_URL"), helperDefaultURL))
	return strings.TrimSuffix(raw, "/")
}

func (h *helper) token(base string) string {
	if token := resolveHelperToken(h.args.str("token"), h.configString("token")); token != "" {
		return token
	}
	user := strings.TrimSpace(os.Getenv("CASCADE_NOTE_USER"))
	pass := os.Getenv("CASCADE_NOTE_PASS")
	if user == "" || pass == "" {
		h.fail("no credentials. Set CASCADE_NOTE_TOKEN, or CASCADE_NOTE_USER + CASCADE_NOTE_PASS.")
	}
	body, _ := json.Marshal(map[string]string{"username": user, "password": pass})
	resp, err := h.client.Post(base+"/api/auth/login", "application/json", bytes.NewReader(body))
	if err != nil {
		h.fail(err)
	}
	defer resp.Body.Close()
	text, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		h.fail(newHelperHTTPError("POST", "/api/auth/login", resp.StatusCode, string(text), fmt.Sprintf("login failed (%d): %s", resp.StatusCode, text), "->"))
	}
	var parsed map[string]any
	json.Unmarshal(text, &parsed)
	token := str(parsed["token"])
	if token == "" {
		h.fail("login response had no token")
	}
	return token
}

type helperAPI struct {
	h                *helper
	base, token      string
	arrow            string
	runHeader        bool
	retryLocalRefuse bool
}

func isLoopback(base string) bool {
	parsed, err := url.Parse(base)
	if err != nil {
		return false
	}
	switch parsed.Hostname() {
	case "localhost", "127.0.0.1", "::1":
		return true
	}
	return false
}

// call sends one API request and fails the helper on a non-2xx response.
func (a *helperAPI) call(method, path string, body any, headers map[string]string) map[string]any {
	var payload []byte
	if body != nil {
		payload, _ = json.Marshal(body)
	}
	var resp *http.Response
	for attempt := 0; ; attempt++ {
		req, err := http.NewRequest(method, a.base+path, bytes.NewReader(payload))
		if err != nil {
			a.h.fail(err)
		}
		req.Header.Set("Authorization", "Bearer "+a.token)
		if runID := strings.TrimSpace(os.Getenv("CASCADE_RUN_ID")); a.runHeader && runID != "" {
			req.Header.Set("x-cascade-run-id", runID)
		}
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		resp, err = a.h.client.Do(req)
		if err == nil {
			break
		}
		// A refused loopback connection sent no request; retry that local
		// restart briefly, never an ambiguous write or an HTTP rejection.
		if !a.retryLocalRefuse || !isLoopback(a.base) || !errors.Is(err, syscall.ECONNREFUSED) || attempt >= 2 {
			a.h.fail(&helperNetError{err})
		}
		time.Sleep(time.Duration(250*(attempt+1)) * time.Millisecond)
	}
	defer resp.Body.Close()
	text, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		a.h.fail(newHelperHTTPError(method, path, resp.StatusCode, string(text), "", a.arrow))
	}
	var parsed any
	if len(text) > 0 {
		if json.Unmarshal(text, &parsed) != nil {
			parsed = map[string]any{"raw": string(text)}
		}
	}
	if m, ok := parsed.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}

func (a *helperAPI) get(path string) map[string]any { return a.call("GET", path, nil, nil) }

func (h *helper) readStdin() string {
	if file, ok := h.stdin.(*os.File); ok {
		if info, err := file.Stat(); err == nil && info.Mode()&os.ModeCharDevice != 0 {
			return ""
		}
	}
	data, _ := io.ReadAll(h.stdin)
	return string(data)
}

func (h *helper) resolveVault(api *helperAPI, multipleHint string) string {
	if explicit := strings.TrimSpace(firstNonEmpty(h.args.str("vault"), h.configString("vaultId"), os.Getenv("CASCADE_NOTE_VAULT"))); explicit != "" {
		return explicit
	}
	vaults := objects(api.get("/api/vaults")["vaults"])
	if len(vaults) == 0 {
		h.fail("no vaults found for this account.")
	}
	if len(vaults) == 1 {
		return str(vaults[0]["id"])
	}
	var lines []string
	for _, v := range vaults {
		lines = append(lines, fmt.Sprintf("  %s  %s", str(v["id"]), str(v["name"])))
	}
	h.failf("multiple vaults %s:\n%s", multipleHint, strings.Join(lines, "\n"))
	return ""
}

func objects(v any) []map[string]any {
	items, _ := v.([]any)
	out := make([]map[string]any, 0, len(items))
	for _, item := range items {
		if m, ok := item.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

// encodeURIComponent escapes everything except A-Z a-z 0-9 - _ . ! ~ * ' ( ),
// exactly as the JavaScript function of that name.
func encodeURIComponent(s string) string {
	var b strings.Builder
	for _, c := range []byte(s) {
		if 'A' <= c && c <= 'Z' || 'a' <= c && c <= 'z' || '0' <= c && c <= '9' || strings.IndexByte("-_.!~*'()", c) >= 0 {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

func queryString(pairs ...string) string {
	values := url.Values{}
	for i := 0; i+1 < len(pairs); i += 2 {
		if pairs[i+1] != "" {
			values.Set(pairs[i], pairs[i+1])
		}
	}
	return values.Encode()
}

func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

var helperEscapedBackticks = regexp.MustCompile("\\\\+`")

// ── multi-call helper links ───────────────────────────────────

// helperLinkDir holds cascade-* names pointing at this binary, so agents find
// the helpers on PATH without a Node runtime.
func helperLinkDir() string {
	return filepath.Join(agentStateDir(), "helpers")
}

func ensureHelperLinks() string {
	dir := helperLinkDir()
	exe, err := os.Executable()
	if err != nil {
		return dir
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return dir
	}
	for _, name := range helperNames() {
		link := filepath.Join(dir, name)
		if current, err := os.Readlink(link); err == nil && current == exe {
			continue
		}
		temporary := fmt.Sprintf("%s.%d.tmp", link, os.Getpid())
		_ = os.Remove(temporary)
		if os.Symlink(exe, temporary) == nil {
			_ = os.Rename(temporary, link)
		}
	}
	return dir
}
