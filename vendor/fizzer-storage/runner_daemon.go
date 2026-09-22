package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"
)

type noteAPIState struct {
	URL        string
	Token      string
	Origin     string
	WriteToken string
	Configured bool
}

var noteAPI noteAPIState

func setNoteAPIConfig(url, token, origin, writeToken string) {
	noteAPI = noteAPIState{URL: url, Token: token, Origin: origin, WriteToken: writeToken, Configured: url != "" || token != ""}
}

type runnerDaemon struct {
	apiBase      string
	token        string
	instanceID   string
	client       *socketIOClient
	activeRuns   map[int]map[string]any
	triggering   map[string]bool
	mu           sync.Mutex
	lastConnErr  string
	connected    bool
	loginTimer   *time.Timer
	dispatchStop chan struct{}
}

func apiBaseFromEnv() string {
	base := os.Getenv("API_URL")
	if base == "" {
		base = os.Getenv("API_BASE")
	}
	if base == "" {
		base = "http://localhost:3000"
	}
	return strings.TrimRight(base, "/")
}

func remoteMirroringEnabled(apiBase string) bool {
	if os.Getenv("FIZZER_REMOTE_MIRROR") == "1" {
		return true
	}
	u, err := url.Parse(apiBase)
	if err != nil {
		return false
	}
	host := strings.ToLower(u.Hostname())
	return host != "localhost" && host != "127.0.0.1" && host != "::1" && host != "[::1]"
}

func RunnerCLI(_ []string) int {
	d := &runnerDaemon{
		apiBase:      apiBaseFromEnv(),
		instanceID:   fmt.Sprintf("headless-runner-%d-%s", os.Getpid(), base36Now()),
		activeRuns:   map[int]map[string]any{},
		triggering:   map[string]bool{},
		dispatchStop: make(chan struct{}),
	}
	return d.run()
}

func base36Now() string {
	n := time.Now().UnixNano()
	const digits = "0123456789abcdefghijklmnopqrstuvwxyz"
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{digits[n%36]}, b...)
		n /= 36
	}
	return string(b)
}

func (d *runnerDaemon) adopt() string {
	active := &d.token
	next := adoptToken(active)
	if next != "" && noteAPI.Token != next {
		setNoteAPIConfig(d.apiBase, next, d.apiBase, "")
	}
	return d.token
}

func (d *runnerDaemon) run() int {
	logf("Target API: %s", d.apiBase)
	logf("Runner login follows the current local session and renews before it expires.")
	if remoteMirroringEnabled(d.apiBase) {
		logf("Remote mirroring is enabled but vault-mirror stays in Electron for now; skipping local mirror setup.")
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	d.adopt()
	if d.token == "" {
		logf("No runner login yet. Waiting for a local session.")
	}

	client := newSocketIOClient(d.apiBase, d.token)
	d.client = client
	client.On("runner:registered", func(args []json.RawMessage, _ func(...any)) {
		d.mu.Lock()
		d.lastConnErr = ""
		d.connected = true
		d.mu.Unlock()
		data := ""
		if len(args) > 0 {
			data = truncate(string(args[0]), 200)
		}
		logf("Successfully registered with backend. Desktop runner is ONLINE. %s", data)
		go d.refreshLogin()
		go d.checkPendingDispatches()
	})
	client.On("run:delegate", func(args []json.RawMessage, _ func(...any)) {
		if len(args) == 0 {
			return
		}
		var payload map[string]any
		if err := json.Unmarshal(args[0], &payload); err != nil {
			errorLogf("Malformed run:delegate: %v", err)
			return
		}
		d.handleDelegate(payload)
	})
	client.On("run:cancel", func(args []json.RawMessage, ack func(...any)) {
		if len(args) == 0 {
			if ack != nil {
				ack(map[string]any{"success": false})
			}
			return
		}
		var data struct {
			RunID float64 `json:"runId"`
		}
		_ = json.Unmarshal(args[0], &data)
		runID := int(data.RunID)
		logf("[Run #%d] Cancellation requested", runID)
		ok := cancelLocalAgentRun(runID)
		d.mu.Lock()
		delete(d.activeRuns, runID)
		d.mu.Unlock()
		if ack != nil {
			ack(map[string]any{"success": ok})
		}
		logf("[Run #%d] Cancellation acknowledged (success: %v)", runID, ok)
	})
	client.On("workspace:prepare", func(args []json.RawMessage, ack func(...any)) {
		if len(args) == 0 {
			if ack != nil {
				ack(prepareResult{OK: false, Error: "Missing workspace options"})
			}
			return
		}
		var opts map[string]any
		if err := json.Unmarshal(args[0], &opts); err != nil {
			if ack != nil {
				ack(prepareResult{OK: false, Error: err.Error()})
			}
			return
		}
		label := str(opts["channelId"])
		if label == "" {
			label = str(opts["repository"])
		}
		logf("Workspace prepare requested: %s", label)
		result := PrepareWorkspace(opts)
		if ack != nil {
			ack(result)
		}
	})

	go client.connectAndServe(ctx, func() {
		d.adopt()
		client.SetToken(d.token)
		ids := d.activeRunIDs()
		logf("Connected to %s/runners. Registering runner instance (%s)...", d.apiBase, d.instanceID)
		_ = client.Emit("runner:register", map[string]any{
			"activeRunIds":     ids,
			"runnerInstanceId": d.instanceID,
		})
	})

	go d.dispatchLoop()
	d.scheduleLoginMaintenance(ctx)

	<-ctx.Done()
	d.cleanup()
	return 0
}

func (d *runnerDaemon) activeRunIDs() []int {
	d.mu.Lock()
	defer d.mu.Unlock()
	ids := make([]int, 0, len(d.activeRuns))
	for id := range d.activeRuns {
		ids = append(ids, id)
	}
	return ids
}

func (d *runnerDaemon) handleDelegate(payload map[string]any) {
	runID := int(numberOf(payload["runId"]))
	agent := str(payload["agent"])
	if agent == "" {
		agent = "unknown"
	}
	logf("[Run #%d] Received delegation for agent %q", runID, agent)
	d.mu.Lock()
	d.activeRuns[runID] = payload
	d.mu.Unlock()

	api := &runAPI{URL: d.apiBase, Origin: d.apiBase, Token: d.token}
	emit := func(ev agentRunEvent) {
		if !d.client.IsConnected() {
			return
		}
		var parsed any
		if err := json.Unmarshal([]byte(ev.PayloadJSON), &parsed); err != nil {
			errorLogf("[Run #%d] Malformed event payload: %v", runID, err)
			return
		}
		_ = d.client.Emit("runner:runEvent", map[string]any{
			"runId":   ev.RunID,
			"type":    ev.Type,
			"payload": parsed,
		})
	}

	writeRunPid(runID)
	defer clearRunPid(runID)

	result, err := executeLocalAgentRun(payload, api, "", "", emit)
	d.mu.Lock()
	delete(d.activeRuns, runID)
	d.mu.Unlock()
	if err != nil {
		errorLogf("[Run #%d] Failed: %v", runID, err)
		return
	}
	session := ""
	if result != nil {
		session = str(result["sessionId"])
	}
	if session != "" {
		logf("[Run #%d] Completed successfully (session: %s)", runID, session)
	} else {
		logf("[Run #%d] Completed successfully", runID)
	}
}

func (d *runnerDaemon) refreshLogin() {
	current := d.adopt()
	now := time.Now().Unix()
	exp := decodeTokenExp(current)
	if current == "" || exp <= now || exp-now > int64(loginRenewalWindowSeconds) {
		return
	}
	refreshLogin(d.apiBase, current)
	d.adopt()
}

func (d *runnerDaemon) scheduleLoginMaintenance(ctx context.Context) {
	if d.loginTimer != nil {
		d.loginTimer.Stop()
	}
	token := d.adopt()
	now := time.Now().Unix()
	exp := decodeTokenExp(token)
	renewalAt := exp - int64(loginRenewalWindowSeconds)
	delay := 30 * time.Second
	refresh := false
	if token != "" && exp > now && now >= renewalAt {
		delay = time.Hour
		refresh = true
	} else if token != "" && now < renewalAt {
		delay = time.Duration(renewalAt-now) * time.Second
		if delay > 6*time.Hour {
			delay = 6 * time.Hour
		}
	}
	d.loginTimer = time.AfterFunc(delay, func() {
		select {
		case <-ctx.Done():
			return
		default:
		}
		if d.client != nil && !d.client.IsConnected() {
			_ = d.adopt()
			d.client.SetToken(d.token)
		}
		if refresh {
			d.refreshLogin()
		}
		d.scheduleLoginMaintenance(ctx)
	})
}

func (d *runnerDaemon) dispatchLoop() {
	ticker := time.NewTicker(4 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-d.dispatchStop:
			return
		case <-ticker.C:
			d.checkPendingDispatches()
		}
	}
}

func (d *runnerDaemon) checkPendingDispatches() {
	if d.client == nil || !d.client.IsConnected() {
		return
	}
	d.adopt()
	if d.token == "" {
		return
	}
	client := &http.Client{Timeout: 20 * time.Second}
	vaults, err := d.getJSON(client, "/api/vaults", nil)
	if err != nil {
		return
	}
	list, _ := vaults["vaults"].([]any)
	for _, raw := range list {
		vault, _ := raw.(map[string]any)
		vaultID := str(vault["id"])
		if vaultID == "" {
			continue
		}
		notesBody, err := d.getJSON(client, "/api/vaults/"+url.PathEscape(vaultID)+"/notes", nil)
		if err != nil {
			continue
		}
		notes, _ := notesBody["notes"].([]any)
		for _, noteRaw := range notes {
			note, _ := noteRaw.(map[string]any)
			if !truthy(note["is_chat_channel"]) && !truthy(note["isChatChannel"]) {
				continue
			}
			channelID := str(note["id"])
			pending, err := d.getJSON(client, "/api/vaults/"+url.PathEscape(vaultID)+"/channels/"+url.PathEscape(channelID)+"/agent-dispatches/pending", nil)
			if err != nil {
				continue
			}
			dispatches, _ := pending["dispatches"].([]any)
			for _, dispatchRaw := range dispatches {
				dispatch, _ := dispatchRaw.(map[string]any)
				if dispatch["runId"] != nil {
					continue
				}
				dispatchID := str(dispatch["id"])
				if dispatchID == "" {
					continue
				}
				d.mu.Lock()
				if d.triggering[dispatchID] {
					d.mu.Unlock()
					continue
				}
				d.triggering[dispatchID] = true
				d.mu.Unlock()
				d.triggerDispatch(client, vaultID, channelID, note, dispatch, dispatchID)
			}
		}
	}
}

func (d *runnerDaemon) triggerDispatch(client *http.Client, vaultID, channelID string, note, dispatch map[string]any, dispatchID string) {
	registration, _ := dispatch["registration"].(map[string]any)
	agentID := str(registration["agentId"])
	if agentID == "" {
		agentID = "claude-code"
	}
	message, _ := dispatch["message"].(map[string]any)
	channelTitle := str(note["title"])
	if channelTitle == "" {
		channelTitle = channelID
	}
	displayName := str(registration["displayName"])
	if displayName == "" {
		displayName = "Agent"
	}
	logf("Found pending dispatch %s in #%s for agent %s", dispatchID, channelTitle, firstNonEmpty(str(registration["displayName"]), agentID))

	agentMessageID := fmt.Sprintf("msg-agent-%d-%s", time.Now().UnixMilli(), base36Now()[:6])
	runBody := map[string]any{
		"prompt":  firstNonEmpty(str(message["body"]), "Hello"),
		"note_id": nil,
		"agent":   agentID,
	}
	if v := str(registration["model"]); v != "" {
		runBody["model"] = v
	}
	if v := str(registration["cwd"]); v != "" {
		runBody["cwd"] = v
	}
	runBody["yolo"] = registration["yolo"] == true
	if v := registration["id"]; v != nil {
		runBody["registrationId"] = v
	}
	runBody["chatDispatchId"] = dispatchID
	runBody["chat"] = map[string]any{
		"channelId":           channelID,
		"messageId":           agentMessageID,
		"triggeringMessageId": dispatch["messageId"],
		"author":              displayName,
	}

	status, body, err := d.postJSON(client, "/api/vaults/"+url.PathEscape(vaultID)+"/runs", runBody)
	if err != nil || status < 200 || status >= 300 {
		msg := ""
		if body != nil {
			msg = str(body["error"])
		}
		errorLogf("Failed to initiate run for dispatch %s: %s %s", dispatchID, fmt.Sprint(status), msg)
		d.mu.Lock()
		delete(d.triggering, dispatchID)
		d.mu.Unlock()
		return
	}
	run, _ := body["run"].(map[string]any)
	logf("Initiated run #%s for dispatch %s", str(run["id"]), dispatchID)
}

func (d *runnerDaemon) getJSON(client *http.Client, path string, extra map[string]string) (map[string]any, error) {
	req, err := http.NewRequest(http.MethodGet, d.apiBase+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+d.token)
	req.Header.Set("Accept", "application/json")
	for k, v := range extra {
		req.Header.Set(k, v)
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("status %d", res.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (d *runnerDaemon) postJSON(client *http.Client, path string, payload map[string]any) (int, map[string]any, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return 0, nil, err
	}
	req, err := http.NewRequest(http.MethodPost, d.apiBase+path, bytes.NewReader(body))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Authorization", "Bearer "+d.token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	res, err := client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	var out map[string]any
	_ = json.Unmarshal(data, &out)
	return res.StatusCode, out, nil
}

func (d *runnerDaemon) cleanup() {
	logf("Shutting down runner daemon...")
	if d.loginTimer != nil {
		d.loginTimer.Stop()
	}
	close(d.dispatchStop)
	if d.client != nil {
		d.client.Close()
	}
	reapOrphanedAgentRuns()
}

func numberOf(v any) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case int:
		return float64(t)
	case json.Number:
		f, _ := t.Float64()
		return f
	default:
		return 0
	}
}

func truthy(v any) bool {
	switch t := v.(type) {
	case bool:
		return t
	case string:
		return t != "" && t != "0" && !strings.EqualFold(t, "false")
	default:
		return false
	}
}
