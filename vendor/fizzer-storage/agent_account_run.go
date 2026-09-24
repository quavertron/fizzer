package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

type bridgeSession struct {
	cmd     *exec.Cmd
	socket  string
	session string
	errors  *tailBuffer
	stdin   io.WriteCloser
}

// tailBuffer keeps the last limit bytes written, safe for concurrent use.
type tailBuffer struct {
	mu    sync.Mutex
	data  []byte
	limit int
}

func (b *tailBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.data = append(b.data, p...)
	if len(b.data) > b.limit {
		b.data = append([]byte{}, b.data[len(b.data)-b.limit:]...)
	}
	return len(p), nil
}

func (b *tailBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return string(b.data)
}

type agentRunEvent struct {
	RunID       int    `json:"runId"`
	Seq         int    `json:"seq"`
	Type        string `json:"type"`
	PayloadJSON string `json:"payload_json"`
}

type agentRunResult struct {
	Result *json.RawMessage `json:"result,omitempty"`
	Error  string           `json:"error,omitempty"`
	Event  *agentRunEvent   `json:"event,omitempty"`
}

type runInput struct {
	Opts map[string]any `json:"opts"`
	API  *runAPI        `json:"api"`
	Root string         `json:"root"`
	// Remote mirror root (caller-prepared) when opts.remoteVault
	MirrorRoot string `json:"mirrorRoot,omitempty"`
}

type grant struct {
	Root       string `json:"root"`
	Socket     string `json:"socket"`
	Remote     bool   `json:"remote"`
	VaultID    string `json:"vaultId,omitempty"`
	MirrorRoot string `json:"mirrorRoot,omitempty"`
}

var (
	activeRuns          = map[int]*exec.Cmd{}
	canceledAccountRuns = map[int]bool{}
	activeMu            sync.Mutex
)

func startBridge(root, directory string, index int, remoteURL, remoteHeader string) (*bridgeSession, error) {
	bridgeBinary := alockBinary()
	if !fileExists(bridgeBinary) {
		return nil, fmt.Errorf("Agent write setup is incomplete: rerun the installer.")
	}
	socket := filepath.Join(directory, fmt.Sprintf("socket-%d", index))
	args := []string{"account", "serve", "--root", root, "--user", "fizzer", "--socket", socket, "--control-stdin"}
	if remoteURL != "" {
		args = append(args, "--remote-url", remoteURL, "--header-file", remoteHeader)
	}
	cmd := exec.Command(bridgeBinary, args...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, _ := cmd.StderrPipe()
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	s := &bridgeSession{cmd: cmd, socket: socket, stdin: stdin, errors: &tailBuffer{limit: 4000}}
	errCh := make(chan error, 1)
	done := make(chan struct{})
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			line := scanner.Text()
			var msg struct {
				Ready   bool   `json:"ready"`
				Session string `json:"session"`
			}
			if json.Unmarshal([]byte(line), &msg) == nil && msg.Ready {
				s.session = msg.Session
				close(done)
				// Keep draining so a chatty bridge never blocks on a full pipe.
				_, _ = io.Copy(io.Discard, stdout)
				return
			}
		}
		errCh <- fmt.Errorf("bridge exited before ready")
	}()
	stderrDone := make(chan struct{})
	go func() {
		defer close(stderrDone)
		_, _ = io.Copy(s.errors, stderr)
	}()

	select {
	case <-done:
		return s, nil
	case <-errCh:
		// Classify the exit from its complete stderr, not a partial read.
		select {
		case <-stderrDone:
		case <-time.After(time.Second):
		}
		msg := s.errors.String()
		if strings.Contains(msg, "alock bridge serve") && !strings.Contains(msg, "alock account serve") {
			return nil, fmt.Errorf("Installed alock is outdated (%s): this Fizzer version requires account/HTTP support. Update the native helper bundle using install-agent-writes.sh --update, then retry the run.", bridgeBinary)
		}
		if strings.Contains(msg, "alock: unknown command") {
			return nil, fmt.Errorf("An older alock daemon is still running. Update older alock copies on PATH, finish active edits, and allow the idle daemon to exit before retrying. The installed account bridge cannot use the older daemon.")
		}
		return nil, fmt.Errorf("Agent write bridge exited: %s", msg)
	case <-time.After(10 * time.Second):
		cmd.Process.Kill()
		return nil, fmt.Errorf("Agent write bridge startup timed out.")
	}
}

func (s *bridgeSession) conclude() {
	if s.stdin != nil {
		s.stdin.Write([]byte("conclude\n"))
	}
}

func agentAccountRunStdio(in io.Reader, emit func(agentRunEvent)) (*json.RawMessage, error) {
	var input runInput
	dec := json.NewDecoder(in)
	if err := dec.Decode(&input); err != nil {
		return nil, err
	}
	return runAccountOrchestrated(input, emit)
}

func runAccountOrchestrated(input runInput, emit func(agentRunEvent)) (*json.RawMessage, error) {
	opts := input.Opts
	api := input.API
	runID := 0
	if v, ok := opts["runId"].(float64); ok {
		runID = int(v)
	}
	seq := 0
	terminal := false
	status := func(value, summary string) {
		terminal = true
		seq++
		payload, _ := json.Marshal(map[string]string{"status": value, "summary": summary})
		emit(agentRunEvent{RunID: runID, Seq: seq, Type: "status", PayloadJSON: string(payload)})
	}

	root := input.Root
	remote := false
	if b, ok := opts["remoteVault"].(bool); ok {
		remote = b
	}
	if root == "" {
		var err error
		root, remote, err = prepareWorkspace(opts, api)
		if err != nil {
			if !terminal {
				status("failed", err.Error())
			}
			return nil, err
		}
	}
	opts["cwd"] = root
	opts["remoteVault"] = remote

	// Shared /tmp, not the per-user TMPDIR: the fizzer account must reach the bridge socket.
	tmp, err := filepath.EvalSymlinks("/tmp")
	if err != nil {
		status("failed", err.Error())
		return nil, err
	}
	directory, err := os.MkdirTemp(tmp, "faw-")
	if err != nil {
		status("failed", err.Error())
		return nil, err
	}
	defer os.RemoveAll(directory)
	os.Chmod(directory, 0o755)

	var bridges []*bridgeSession
	var grants []grant
	if remote {
		writeToken := ""
		if api != nil {
			writeToken = api.WriteToken
			if writeToken == "" {
				writeToken = api.Token
			}
		}
		header := filepath.Join(directory, "remote-authorization")
		os.WriteFile(header, []byte("Authorization: Bearer "+writeToken+"\n"), 0o600)
		origin := ""
		if api != nil {
			if api.Origin != "" {
				origin = originOf(api.Origin)
			} else {
				origin = originOf(api.URL)
			}
		}
		vaultID, _ := opts["vaultId"].(string)
		remoteURL := fmt.Sprintf("%s/api/vaults/%s/alock", strings.TrimRight(origin, "/"), vaultID)
		mirrorRoot := root
		if input.MirrorRoot != "" {
			mirrorRoot = input.MirrorRoot
		}
		b, err := startBridge("remote-vault", directory, 0, remoteURL, header)
		if err != nil {
			if !terminal {
				status("failed", err.Error())
			}
			return nil, err
		}
		bridges = append(bridges, b)
		grants = append(grants, grant{Root: "remote-vault", Socket: b.socket, Remote: true, VaultID: vaultID, MirrorRoot: mirrorRoot})
	} else {
		roots, err := writeAccessRoots(opts, api, root)
		if err != nil {
			if !terminal {
				status("failed", err.Error())
			}
			return nil, err
		}
		for i, allowedRoot := range roots {
			b, err := startBridge(allowedRoot, directory, i, "", "")
			if err != nil {
				if !terminal {
					status("failed", err.Error())
				}
				return nil, err
			}
			bridges = append(bridges, b)
			grants = append(grants, grant{Root: allowedRoot, Socket: b.socket})
		}
	}

	sessions := map[string]bool{}
	for i, b := range bridges {
		if i < len(grants) && !grants[i].Remote && b.session != "" {
			sessions[b.session] = true
		}
	}

	// Activity viewer (awatch) - optional; failure is non-fatal for the run
	activityClose := startAwatchViewer(func(events []map[string]any) {
		for _, event := range events {
			agent, _ := event["agent"].(string)
			if !sessions[agent] {
				continue
			}
			kind, _ := event["kind"].(string)
			if kind != "edit" && kind != "lock" {
				continue
			}
			// rewrite agent display name
			if author, ok := event["author"].(string); ok && author != "" {
				event["agent"] = author
			} else if a, ok := opts["chatAuthor"].(string); ok && a != "" {
				event["agent"] = a
			} else if a, ok := opts["agent"].(string); ok && a != "" {
				event["agent"] = a
			}
			// truncate lines
			for _, key := range []string{"old_lines", "new_lines"} {
				if lines, ok := event[key].([]any); ok {
					var kept []any
					bytes := 0
					truncated := false
					for _, line := range lines {
						s := fmt.Sprint(line)
						bytes += len(s) + 1
						if bytes > 32768 {
							truncated = true
							break
						}
						kept = append(kept, line)
					}
					event[key] = kept
					if truncated {
						event["truncated"] = true
					}
				}
			}
			seq++
			payload, _ := json.Marshal(event)
			emit(agentRunEvent{RunID: runID, Seq: seq, Type: "activity", PayloadJSON: string(payload)})
		}
	}, true)
	defer activityClose()

	// Read-only API proxy
	contextAPI, closeAPI := startReadOnlyAPI(api, opts["vaultId"])
	defer closeAPI()

	// Launch worker under sudo
	socket := ""
	if len(bridges) > 0 {
		socket = bridges[0].socket
	}
	argv := launchArguments(launchOptions{Socket: socket})
	worker, err := spawnWorker(argv, root)
	if err != nil {
		if !terminal {
			status("failed", err.Error())
		}
		return nil, err
	}
	activeMu.Lock()
	activeRuns[runID] = worker
	activeMu.Unlock()
	defer func() {
		activeMu.Lock()
		delete(activeRuns, runID)
		delete(canceledAccountRuns, runID)
		activeMu.Unlock()
		if worker.Process != nil && worker.ProcessState == nil {
			worker.Process.Signal(syscall.SIGTERM)
		}
	}()

	stdin, _ := worker.StdinPipe()
	stdout, _ := worker.StdoutPipe()
	var stderrBuf strings.Builder
	stderr, _ := worker.StderrPipe()
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := stderr.Read(buf)
			if n > 0 {
				stderrBuf.Write(buf[:n])
				if stderrBuf.Len() > 8000 {
					b := stderrBuf.String()
					stderrBuf.Reset()
					stderrBuf.WriteString(b[len(b)-8000:])
				}
			}
			if err != nil {
				return
			}
		}
	}()

	if err := worker.Start(); err != nil {
		if !terminal {
			status("failed", err.Error())
		}
		return nil, err
	}

	// Bridge exit → kill worker
	for _, b := range bridges {
		go func(br *bridgeSession) {
			br.cmd.Wait()
			if worker.Process != nil && worker.ProcessState == nil {
				worker.Process.Kill()
			}
		}(b)
	}

	// Send input
	inputJSON := map[string]any{
		"opts":   opts,
		"api":    contextAPI,
		"root":   root,
		"grants": grants,
	}
	data, _ := json.Marshal(inputJSON)
	stdin.Write(data)
	stdin.Close()

	// Read worker events
	var result *json.RawMessage
	var failure string
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 1024*1024), 32*1024*1024)
	for scanner.Scan() {
		var msg agentRunResult
		if json.Unmarshal(scanner.Bytes(), &msg) != nil {
			continue
		}
		if msg.Event != nil {
			if msg.Event.Type == "assistant-turn-end" {
				for _, b := range bridges {
					b.conclude()
				}
				continue
			}
			if n := Number(msg.Event.Seq); n > seq {
				seq = n
			}
			if msg.Event.Type == "status" {
				var payload struct {
					Status string `json:"status"`
				}
				json.Unmarshal([]byte(msg.Event.PayloadJSON), &payload)
				if payload.Status == "completed" || payload.Status == "failed" || payload.Status == "canceled" {
					if accountRunCanceled(runID) {
						continue
					}
					terminal = true
				}
			}
			seq++
			msg.Event.Seq = seq
			msg.Event.RunID = runID
			emit(*msg.Event)
		}
		if msg.Result != nil {
			result = msg.Result
		}
		if msg.Error != "" {
			failure = msg.Error
		}
	}
	waitErr := worker.Wait()
	exitCode := 0
	if waitErr != nil {
		if ee, ok := waitErr.(*exec.ExitError); ok {
			exitCode = ee.ExitCode()
		} else {
			exitCode = 1
		}
	}

	// Bridge cleanup
	for _, b := range bridges {
		if b.cmd.Process != nil && b.cmd.ProcessState == nil {
			b.cmd.Process.Signal(syscall.SIGTERM)
		}
	}
	for _, b := range bridges {
		if b.cmd.ProcessState == nil {
			done := make(chan struct{})
			go func() { b.cmd.Wait(); close(done) }()
			select {
			case <-done:
			case <-time.After(30 * time.Second):
				if b.cmd.Process != nil {
					b.cmd.Process.Kill()
				}
			}
		}
		if b.cmd.ProcessState != nil && b.cmd.ProcessState.ExitCode() != 0 {
			msg := fmt.Sprintf("Agent write history did not finish cleanly; pending recovery snapshots are retained. %s", b.errors.String())
			status("failed", msg)
			return result, fmt.Errorf("%s", msg)
		}
	}

	if accountRunCanceled(runID) {
		status("canceled", "Run canceled.")
		canceled := json.RawMessage(`{"canceled":true}`)
		return &canceled, nil
	}
	if exitCode == 0 && failure == "" {
		return result, nil
	}
	if failure != "" {
		return result, fmt.Errorf("%s", failure)
	}
	if stderrBuf.Len() > 0 {
		return result, fmt.Errorf("%s", stderrBuf.String())
	}
	return result, fmt.Errorf("Agent account worker exited (%d). Check setup and provider login.", exitCode)
}

func Number(v int) int { return v }

func urlParseFull(raw string) (string, error) {
	return originOf(raw), nil
}

func cancelAgentAccount(id int) bool {
	activeMu.Lock()
	defer activeMu.Unlock()
	cmd, ok := activeRuns[id]
	if !ok || cmd == nil || cmd.Process == nil {
		return false
	}
	canceledAccountRuns[id] = true
	cmd.Process.Signal(syscall.SIGTERM)
	return true
}

func accountRunCanceled(id int) bool {
	activeMu.Lock()
	defer activeMu.Unlock()
	return canceledAccountRuns[id]
}

// AgentAccountCLI dispatches `agent-account` subcommands.
func AgentAccountCLI(args []string) int {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "Usage: fizzer-storage agent-account <subcommand>")
		return 1
	}
	switch args[0] {
	case "enabled":
		if agentAccountEnabled() {
			fmt.Println("true")
		} else {
			fmt.Println("false")
		}
		return 0
	case "should-offer":
		if agentAccountShouldOffer() {
			fmt.Println("true")
		} else {
			fmt.Println("false")
		}
		return 0
	case "state":
		state := accountState{
			Enabled:     agentAccountEnabled(),
			ShouldOffer: agentAccountShouldOffer(),
		}
		resources := os.Getenv("FIZZER_RESOURCES_PATH")
		packaged := os.Getenv("FIZZER_PACKAGED") == "1"
		state.SetupCommand = setupCommand(packaged, resources)
		out, _ := json.Marshal(state)
		os.Stdout.Write(out)
		return 0
	case "decline":
		if err := declineAgentAccount(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		return 0
	case "setup-command":
		packaged := false
		resources := ""
		if len(args) > 1 && args[1] == "--packaged" {
			packaged = true
		}
		if len(args) > 2 {
			resources = args[2]
		} else {
			resources = os.Getenv("FIZZER_RESOURCES_PATH")
		}
		fmt.Println(setupCommand(packaged, resources))
		return 0
	case "resolve-workspace":
		if len(args) < 2 {
			fmt.Fprintln(os.Stderr, "resolve-workspace requires a path")
			return 1
		}
		root, err := resolveWorkspace(args[1])
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		fmt.Println(root)
		return 0
	case "worker":
		// Runs as the fizzer account: stdin {opts, api, root, grants}; stdout event/result lines.
		return runAgentAccountWorker(os.Stdin, os.Stdout)
	case "launch-argv":
		socket := ""
		if len(args) > 1 {
			socket = args[1]
		}
		argv := launchArguments(launchOptions{Socket: socket})
		out, _ := json.Marshal(argv)
		os.Stdout.Write(out)
		return 0
	case "run":
		// stdin: runInput JSON; stdout: agentRunEvent lines then final result/error line
		result, err := agentAccountRunStdio(os.Stdin, func(ev agentRunEvent) {
			line, _ := json.Marshal(map[string]any{"event": ev})
			os.Stdout.Write(append(line, '\n'))
		})
		if err != nil {
			out, _ := json.Marshal(map[string]string{"error": err.Error()})
			os.Stdout.Write(append(out, '\n'))
			return 1
		}
		payload := map[string]any{}
		if result != nil {
			var v any
			json.Unmarshal(*result, &v)
			payload["result"] = v
		}
		out, _ := json.Marshal(payload)
		os.Stdout.Write(append(out, '\n'))
		return 0
	case "cancel":
		if len(args) < 2 {
			return 1
		}
		var id int
		fmt.Sscanf(args[1], "%d", &id)
		if cancelAgentAccount(id) {
			return 0
		}
		return 1
	case "write-access", "save-write-access":
		// save-write-access <server> <vault> <agent> <scope> [folders...]
		if len(args) < 5 {
			return 1
		}
		policy := &writePolicy{Scope: args[4]}
		if len(args) > 5 {
			policy.Folders = args[5:]
		}
		if err := saveWriteAccess(args[1], args[2], args[3], policy); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		return 0
	case "write-access-roots":
		// write-access-roots <json> -> roots JSON on stdout
		// json: {opts, api, workspace}
		arg := ""
		if len(args) > 1 {
			arg = args[1]
		}
		data := []byte("{}")
		if arg != "" {
			var err error
			data, err = readInput(arg)
			if err != nil {
				fmt.Fprintln(os.Stderr, err)
				return 1
			}
		}
		var input struct {
			Opts      map[string]any `json:"opts"`
			API       *runAPI        `json:"api"`
			Workspace string         `json:"workspace"`
		}
		if err := json.Unmarshal(data, &input); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		roots, err := writeAccessRoots(input.Opts, input.API, input.Workspace)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		out, _ := json.Marshal(roots)
		os.Stdout.Write(out)
		return 0
	case "is-remote-vault":
		// is-remote-vault <json: {opts, api}> -> true/false
		arg := ""
		if len(args) > 1 {
			arg = args[1]
		}
		data, err := readInput(arg)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		var input struct {
			Opts map[string]any `json:"opts"`
			API  *runAPI        `json:"api"`
		}
		if err := json.Unmarshal(data, &input); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		if isRemoteVault(input.Opts, input.API) {
			fmt.Println("true")
		} else {
			fmt.Println("false")
		}
		return 0
	case "prepare-workspace":
		// prepare-workspace <json: {opts, api}> -> {root, remote}
		arg := ""
		if len(args) > 1 {
			arg = args[1]
		}
		data, err := readInput(arg)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		var input struct {
			Opts map[string]any `json:"opts"`
			API  *runAPI        `json:"api"`
		}
		if err := json.Unmarshal(data, &input); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		root, remote, err := prepareWorkspace(input.Opts, input.API)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			if errors.Is(err, fs.ErrNotExist) || strings.Contains(err.Error(), "no such file") {
				fmt.Fprintln(os.Stderr, "ENOENT")
			}
			return 1
		}
		out, _ := json.Marshal(map[string]any{"root": root, "remote": remote})
		os.Stdout.Write(out)
		return 0
	default:
		fmt.Fprintln(os.Stderr, "unknown agent-account subcommand:", args[0])
		return 1
	}
}
