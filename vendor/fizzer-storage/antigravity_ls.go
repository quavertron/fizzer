package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
)

// Discovery file written by language_server -persistent_mode under GeminiDir.
type lsDiscovery struct {
	PID        int    `json:"pid"`
	HTTPSPort  int    `json:"httpsPort"`
	HTTPPort   int    `json:"httpPort"`
	LSPort     int    `json:"lspPort"`
	LSVersion  string `json:"lsVersion"`
	CSRFToken  string `json:"csrfToken"`
}

type lsEndpoint struct {
	Address string `json:"address"`
	CSRF    string `json:"csrf"`
}

func geminiHome() string {
	if home := os.Getenv("ANTIGRAVITY_HOME"); home != "" {
		return home
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".gemini")
}

func lsDaemonDir() string {
	return filepath.Join(geminiHome(), "antigravity", "daemon")
}

func languageServerBin() string {
	if bin := os.Getenv("ANTIGRAVITY_LS_BIN"); bin != "" {
		return bin
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	candidates := []string{
		"/Applications/Antigravity.app/Contents/Resources/bin/language_server",
		filepath.Join(home, ".gemini", "antigravity", "bin", "language_server"),
	}
	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate
		}
	}
	return ""
}

func tcpAlive(address string) bool {
	conn, err := net.DialTimeout("tcp", address, 250*time.Millisecond)
	if err != nil {
		return false
	}
	conn.Close()
	return true
}

func pidAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return process.Signal(syscall.Signal(0)) == nil
}

func readDiscoveryFiles() []lsDiscovery {
	entries, err := os.ReadDir(lsDaemonDir())
	if err != nil {
		return nil
	}
	var found []lsDiscovery
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasPrefix(entry.Name(), "ls_") || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(lsDaemonDir(), entry.Name()))
		if err != nil {
			continue
		}
		var disc lsDiscovery
		if json.Unmarshal(data, &disc) != nil {
			continue
		}
		found = append(found, disc)
	}
	return found
}

func discoveryEndpoint(disc lsDiscovery) (lsEndpoint, bool) {
	if disc.CSRFToken == "" || disc.HTTPPort <= 0 {
		return lsEndpoint{}, false
	}
	if !pidAlive(disc.PID) {
		return lsEndpoint{}, false
	}
	address := fmt.Sprintf("127.0.0.1:%d", disc.HTTPPort)
	if !tcpAlive(address) {
		return lsEndpoint{}, false
	}
	return lsEndpoint{Address: address, CSRF: disc.CSRFToken}, true
}

// findLiveLS returns address+csrf for a language_server already listening,
// preferring the persistent-mode discovery file over process scanning.
func findLiveLS() (lsEndpoint, bool) {
	for _, disc := range readDiscoveryFiles() {
		if endpoint, ok := discoveryEndpoint(disc); ok {
			return endpoint, true
		}
	}
	if runtime.GOOS != "darwin" {
		return lsEndpoint{}, false
	}
	// App-spawned LS may not write a discovery file: fall back to ps + lsof.
	ps, err := exec.Command("ps", "-axww", "-o", "pid=,command=").Output()
	if err != nil {
		return lsEndpoint{}, false
	}
	for _, line := range strings.Split(string(ps), "\n") {
		if !strings.Contains(line, "/language_server ") && !strings.HasSuffix(line, "/language_server") {
			continue
		}
		tokenMatch := strings.Fields(line)
		token := ""
		pid := 0
		for i, field := range tokenMatch {
			if (field == "--csrf_token" || field == "-csrf_token") && i+1 < len(tokenMatch) {
				token = tokenMatch[i+1]
			}
			if i == 0 {
				fmt.Sscanf(field, "%d", &pid)
			}
		}
		if token == "" || pid == 0 || !pidAlive(pid) {
			continue
		}
		lsof, err := exec.Command("lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", fmt.Sprintf("%d", pid)).Output()
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(lsof), "\n") {
			idx := strings.Index(line, "127.0.0.1:")
			if idx < 0 || !strings.Contains(line, "(LISTEN)") {
				continue
			}
			rest := line[idx+len("127.0.0.1:"):]
			end := strings.IndexAny(rest, " \t")
			if end < 0 {
				continue
			}
			port := 0
			if _, err := fmt.Sscanf(rest[:end], "%d", &port); err != nil || port <= 0 {
				continue
			}
			address := fmt.Sprintf("127.0.0.1:%d", port)
			// The LS also listens for gRPC on HTTPS; only the HTTP port
			// answers LanguageServerService JSON-RPC.
			if tcpAlive(address) && httpRPCLive(lsEndpoint{Address: address, CSRF: token}) {
				return lsEndpoint{Address: address, CSRF: token}, true
			}
		}
	}
	return lsEndpoint{}, false
}

func randomCSRF() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(buf)
}

// projectsStoreReady probes ReadProject; standalone LS starts HTTP before the
// hub projects store finishes initializing.
func projectsStoreReady(endpoint lsEndpoint) bool {
	payload, ok := readProjectProbe(endpoint)
	if !ok {
		return false
	}
	return !bytes.Contains(payload, []byte("projects store not initialized"))
}

// httpRPCLive reports whether address speaks LanguageServerService JSON-RPC.
func httpRPCLive(endpoint lsEndpoint) bool {
	_, ok := readProjectProbe(endpoint)
	return ok
}

func readProjectProbe(endpoint lsEndpoint) ([]byte, bool) {
	client := &http.Client{Timeout: 500 * time.Millisecond}
	body := strings.NewReader(`{"id":"default-cli-project"}`)
	req, err := http.NewRequest(http.MethodPost,
		"http://"+endpoint.Address+"/exa.language_server_pb.LanguageServerService/ReadProject", body)
	if err != nil {
		return nil, false
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Codeium-Csrf-Token", endpoint.CSRF)
	resp, err := client.Do(req)
	if err != nil {
		return nil, false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, false
	}
	payload, err := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if err != nil {
		return nil, false
	}
	// Plain HTTP 404 page or empty body means this is not the JSON-RPC port.
	if len(payload) == 0 || bytes.Contains(payload, []byte("404 page not found")) {
		return nil, false
	}
	return payload, true
}

// spawnStandaloneLS starts language_server without the desktop app.
// -standalone -headless is required: without them the process blocks on an
// IDE stdin handshake and never binds its HTTP ports.
func spawnStandaloneLS(csrf string) (*exec.Cmd, error) {
	bin := languageServerBin()
	if bin == "" {
		return nil, fmt.Errorf("language_server binary not found")
	}
	args := []string{
		"-standalone",
		"-headless",
		"-persistent_mode",
		// hub subclient initializes the projects store used by agentapi.
		"-subclient_type", "hub",
		"-csrf_token", csrf,
		"-app_data_dir", "antigravity",
		"-api_server_url", "https://generativelanguage.googleapis.com",
		"-cloud_code_endpoint", "https://daily-cloudcode-pa.googleapis.com",
		"-override_ide_name", "antigravity",
		"-override_ide_version", "2.15.1",
		"-override_user_agent_name", "antigravity",
		"-enable_sidecars",
	}
	cmd := exec.Command(bin, args...)
	cmd.Stdout = nil
	cmd.Stderr = nil
	cmd.Stdin = nil
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	go cmd.Process.Release()
	return cmd, nil
}

// EnsureAntigravityLS discovers a live language_server or spawns a standalone
// headless one. No desktop app required.
func EnsureAntigravityLS() (lsEndpoint, error) {
	if endpoint, ok := findLiveLS(); ok {
		// Wait for an in-flight init before spawning a second server.
		deadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(deadline) {
			if projectsStoreReady(endpoint) {
				return endpoint, nil
			}
			time.Sleep(200 * time.Millisecond)
			if live, still := findLiveLS(); still {
				endpoint = live
			} else {
				break
			}
		}
		if projectsStoreReady(endpoint) {
			return endpoint, nil
		}
	}
	csrf := randomCSRF()
	if _, err := spawnStandaloneLS(csrf); err != nil {
		return lsEndpoint{}, err
	}
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		for _, disc := range readDiscoveryFiles() {
			if disc.CSRFToken != csrf {
				continue
			}
			if endpoint, ok := discoveryEndpoint(disc); ok && projectsStoreReady(endpoint) {
				return endpoint, nil
			}
		}
		if endpoint, ok := findLiveLS(); ok && endpoint.CSRF == csrf && projectsStoreReady(endpoint) {
			return endpoint, nil
		}
		time.Sleep(200 * time.Millisecond)
	}
	return lsEndpoint{}, fmt.Errorf("language_server did not become ready")
}
