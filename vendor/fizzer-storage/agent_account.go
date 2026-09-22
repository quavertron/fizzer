package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

type accountState struct {
	Enabled      bool `json:"enabled"`
	ShouldOffer  bool `json:"shouldOffer"`
	SetupCommand string `json:"setupCommand,omitempty"`
}

func agentAccountDir() string {
	if dir := os.Getenv("CASCADE_DATA_DIR"); dir != "" {
		return dir
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".fizzer")
}

func agentAccountSupported() bool {
	return runtime.GOOS == "darwin" || runtime.GOOS == "linux"
}

func agentAccountEnabled() bool {
	return agentAccountSupported() && fileExists(filepath.Join(agentAccountDir(), "agent-writes-enabled"))
}

func agentAccountShouldOffer() bool {
	if !agentAccountSupported() {
		return false
	}
	dir := agentAccountDir()
	return !fileExists(filepath.Join(dir, "agent-writes-enabled")) &&
		!fileExists(filepath.Join(dir, "agent-writes-declined"))
}

func declineAgentAccount() error {
	dir := agentAccountDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "agent-writes-declined"), []byte("1\n"), 0o600)
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}

func setupCommand(packaged bool, resourcesPath string) string {
	var directory string
	if packaged && resourcesPath != "" {
		directory = filepath.Join(resourcesPath, "embedded-runtime", "agent-account-setup")
	} else {
		// Dev checkout: sibling of the vendor tree.
		exe, err := os.Executable()
		if err == nil {
			directory = filepath.Join(filepath.Dir(exe), "..", "..")
		} else {
			directory = "."
		}
	}
	command := "bash " + shellQuote(filepath.Join(directory, "install-agent-writes.sh"))
	if packaged && resourcesPath != "" {
		command += " " + shellQuote(filepath.Join(directory, "alock"))
	}
	return command
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func resolveWorkspace(selected string) (string, error) {
	home, _ := os.UserHomeDir()
	expanded := selected
	if selected == "~" {
		expanded = home
	} else if strings.HasPrefix(selected, "~/") {
		expanded = filepath.Join(home, selected[2:])
	}
	if _, err := os.Stat(expanded); os.IsNotExist(err) {
		if expanded == "/data" || strings.HasPrefix(expanded, "/data/") ||
			expanded == "/var/lib/cascade" || strings.HasPrefix(expanded, "/var/lib/cascade/") {
			local := os.Getenv("FIZZER_AGENT_WORKSPACE")
			if local == "" {
				local = home
			}
			return filepath.EvalSymlinks(local)
		}
		legacy := strings.Replace(expanded, string(os.PathSeparator)+".fizzer"+string(os.PathSeparator),
			string(os.PathSeparator)+".cascade"+string(os.PathSeparator), 1)
		if legacy != expanded && fileExists(legacy) {
			expanded = legacy
		}
	}
	return filepath.EvalSymlinks(expanded)
}

type runAPI struct {
	URL        string `json:"url"`
	Origin     string `json:"origin"`
	Token      string `json:"token"`
	WriteToken string `json:"writeToken"`
}

func isRemoteVault(opts map[string]any, api *runAPI) bool {
	if v, ok := opts["remoteVault"].(bool); ok && v {
		return true
	}
	if api == nil || api.URL == "" {
		return false
	}
	u, err := url.Parse(api.Origin)
	if err != nil || u.Host == "" {
		u, err = url.Parse(api.URL)
		if err != nil {
			return false
		}
	}
	host := u.Hostname()
	return host != "localhost" && host != "127.0.0.1" && host != "::1"
}

func prepareWorkspace(opts map[string]any, api *runAPI) (root string, remote bool, err error) {
	if isRemoteVault(opts, api) {
		if api == nil || api.URL == "" || (api.WriteToken == "" && api.Token == "" || opts["vaultId"] == nil) {
			return "", false, fmt.Errorf("Remote vault workspace requires an authenticated mirror connection")
		}
		// Mirror root is prepared by the caller (JS) for remote vaults; Go only validates.
		return "", true, fmt.Errorf("remote vault workspace must be prepared by the caller")
	}
	selected := ""
	if v, ok := opts["cwd"].(string); ok && strings.TrimSpace(v) != "" {
		selected = v
	} else if v, ok := opts["vaultRoot"].(string); ok && strings.TrimSpace(v) != "" {
		selected = v
	} else {
		selected, _ = os.Getwd()
	}
	root, err = resolveWorkspace(selected)
	if err != nil {
		return "", false, err
	}
	info, err := os.Stat(root)
	if err != nil || !info.IsDir() {
		return "", false, fmt.Errorf("Agent workspace is not a directory: %s", root)
	}
	return root, false, nil
}

func installedAlock() string {
	if bin := os.Getenv("FIZZER_ALOCK_BIN"); bin != "" {
		return bin
	}
	return "/usr/local/libexec/fizzer/alock"
}

func alockBinary() string {
	if bin := installedAlock(); bin != "" && fileExists(bin) {
		return bin
	}
	candidates := []string{}
	if p := os.Getenv("FIZZER_ALOCK_BIN"); p != "" {
		candidates = append(candidates, p)
	}
	if exe, err := os.Executable(); err == nil {
		candidates = append(candidates, filepath.Join(filepath.Dir(exe), "alock"))
	}
	candidates = append(candidates,
		"/usr/local/libexec/fizzer/alock",
		filepath.Join(repoRoot(), ".native-tools", "alock"))
	for _, c := range candidates {
		if fileExists(c) {
			return c
		}
	}
	return "alock"
}

func repoRoot() string {
	exe, err := os.Executable()
	if err != nil {
		return "."
	}
	// vendor/fizzer-storage/fizzer-storage → repo root is ../../
	return filepath.Join(filepath.Dir(exe), "..", "..")
}

type launchOptions struct {
	Node           string
	Worker         string
	Socket         string
	ResourcesPath  string
	RepoRoot       string
}

func launchArguments(opts launchOptions) []string {
	env := os.Environ()
	providerBinaries := []string{}
	providerNames := []string{
		"CLAUDE_BIN", "CODEX_BIN", "GROK_BIN", "COPILOT_BIN", "HERMES_BIN", "AKRON_BIN", "OMP_BIN", "PI_BIN",
		"ANTIGRAVITY_BIN", "ANTIGRAVITY_HOME", "ANTIGRAVITY_LS_ADDRESS", "ANTIGRAVITY_CSRF_TOKEN",
		"ANTIGRAVITY_PROJECT_ID", "ANTIGRAVITY_AGENTAPI_EXE",
		"FIZZER_STORAGE_BIN",
	}
	for _, name := range providerNames {
		if v := os.Getenv(name); v != "" {
			providerBinaries = append(providerBinaries, name+"="+v)
		}
	}
	home, _ := os.UserHomeDir()
	if !hasPrefix(providerBinaries, "ANTIGRAVITY_BIN=") {
		candidate := filepath.Join(home, ".gemini", "antigravity", "bin", "agentapi")
		if fileExists(candidate) {
			providerBinaries = append(providerBinaries, "ANTIGRAVITY_BIN="+candidate)
		}
	}
	if !hasPrefix(providerBinaries, "ANTIGRAVITY_HOME=") {
		candidate := filepath.Join(home, ".gemini")
		if fileExists(candidate) {
			providerBinaries = append(providerBinaries, "ANTIGRAVITY_HOME="+candidate)
		}
	}
	if !hasPrefix(providerBinaries, "FIZZER_STORAGE_BIN=") {
		var candidates []string
		if opts.ResourcesPath != "" {
			candidates = append(candidates, filepath.Join(opts.ResourcesPath, "embedded-runtime", "agent-account-setup", "fizzer-storage"))
		}
		if opts.RepoRoot != "" {
			candidates = append(candidates, filepath.Join(opts.RepoRoot, ".native-tools", "fizzer-storage"))
		}
		candidates = append(candidates, "/usr/local/libexec/fizzer/fizzer-storage")
		for _, c := range candidates {
			if fileExists(c) {
				providerBinaries = append(providerBinaries, "FIZZER_STORAGE_BIN="+c)
				break
			}
		}
	}

	authEnv := []string{}
	for _, name := range []string{"CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"} {
		value := os.Getenv(name)
		if value == "" {
			file := filepath.Join(agentAccountDir(), "anthropic-api-key")
			if name == "CLAUDE_CODE_OAUTH_TOKEN" {
				file = filepath.Join(agentAccountDir(), "claude-oauth-token")
			}
			if data, err := os.ReadFile(file); err == nil {
				value = strings.TrimSpace(string(data))
			}
		}
		if value != "" {
			authEnv = append(authEnv, name+"="+value)
		}
	}

	path := os.Getenv("PATH")
	if path == "" {
		path = "/usr/local/bin:/usr/bin:/bin"
	}
	args := []string{"-n", "-H", "-u", "fizzer", "--", "/usr/bin/env",
		"PATH=" + path,
		"ELECTRON_RUN_AS_NODE=1", "FIZZER_AGENT_ACCOUNT_CHILD=1",
		"FIZZER_BRIDGE_SOCKET=" + opts.Socket, "FIZZER_ALOCK_BIN=" + installedAlock(),
	}
	args = append(args, authEnv...)
	args = append(args, providerBinaries...)
	args = append(args, opts.Node, opts.Worker)
	return args
}

func hasPrefix(values []string, prefix string) bool {
	for _, v := range values {
		if strings.HasPrefix(v, prefix) {
			return true
		}
	}
	return false
}

type writePolicy struct {
	Scope   string   `json:"scope"`
	Folders []string `json:"folders"`
}

func policyPath(server, vault, agent string) (string, error) {
	if server == "" || vault == "" || agent == "" {
		return "", fmt.Errorf("Server, vault and agent registration ID are required.")
	}
	u, err := url.Parse(server)
	if err != nil {
		return "", err
	}
	key, _ := json.Marshal([]string{strings.ToLower(u.Scheme + "://" + u.Host), vault, agent})
	sum := sha256.Sum256(key)
	return filepath.Join(agentAccountDir(), "agent-write-access", hex.EncodeToString(sum[:])+".json"), nil
}

func validatePolicy(data []byte) (*writePolicy, error) {
	var policy writePolicy
	if err := json.Unmarshal(data, &policy); err != nil {
		return nil, err
	}
	if policy.Scope != "workspace" && policy.Scope != "human" && policy.Scope != "folders" {
		return nil, fmt.Errorf("Invalid agent write scope.")
	}
	if policy.Scope == "folders" {
		if len(policy.Folders) == 0 {
			return nil, fmt.Errorf("Folder access requires absolute directory paths.")
		}
		for _, f := range policy.Folders {
			if !filepath.IsAbs(f) {
				return nil, fmt.Errorf("Folder access requires absolute directory paths.")
			}
		}
	}
	return &policy, nil
}

func saveWriteAccess(server, vault, agent string, policy *writePolicy) error {
	if _, err := validatePolicy(mustJSON(policy)); err != nil {
		return err
	}
	target, err := policyPath(server, vault, agent)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return err
	}
	tmp := target + "." + fmt.Sprint(os.Getpid())
	if err := os.WriteFile(tmp, append(mustJSON(policy), '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, target)
}

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

func writeAccessRoots(opts map[string]any, api *runAPI, workspace string) ([]string, error) {
	candidates := []string{filepath.Join(agentAccountDir(), "agent-write-access-default.json")}
	if reg, _ := opts["chatRegistrationId"].(string); reg != "" {
		if vault, _ := opts["vaultId"].(string); vault != "" && api != nil && api.URL != "" {
			if p, err := policyPath(api.URL, vault, reg); err == nil {
				candidates = append([]string{p}, candidates...)
			}
		}
	}
	var policy *writePolicy
	for _, file := range candidates {
		data, err := os.ReadFile(file)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return nil, err
		}
		p, err := validatePolicy(data)
		if err != nil {
			if !os.IsNotExist(err) {
				return nil, err
			}
			continue
		}
		policy = p
		break
	}
	if policy == nil {
		return []string{workspace}, nil
	}
	switch policy.Scope {
	case "workspace":
		return []string{workspace}, nil
	case "human":
		return []string{"/"}, nil
	default:
		seen := map[string]bool{}
		var roots []string
		for _, f := range policy.Folders {
			real, err := filepath.EvalSymlinks(f)
			if err != nil {
				real = f
			}
			if !seen[real] {
				seen[real] = true
				roots = append(roots, real)
			}
		}
		return roots, nil
	}
}

func ensureAgentAccountBinary() string {
	if bin := os.Getenv("FIZZER_STORAGE_BIN"); bin != "" {
		return bin
	}
	return "fizzer-storage"
}

func spawnWorker(argv []string, cwd string) (*exec.Cmd, error) {
	cmd := exec.Command("/usr/bin/sudo", argv...)
	cmd.Dir = cwd
	return cmd, nil
}
