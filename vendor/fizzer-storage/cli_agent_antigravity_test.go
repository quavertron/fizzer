//go:build unix

package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func agyProject(id string, roots ...string) map[string]any {
	var resources []any
	for _, root := range roots {
		resources = append(resources, map[string]any{"gitFolder": map[string]any{"folderUri": fileURL(root)}})
	}
	return map[string]any{"id": id, "projectResources": map[string]any{"resources": resources}}
}

func TestAntigravityProjectSelection(t *testing.T) {
	unrelated := agyProject("unrelated", "/work/other")
	unrelated["permissionGrants"] = map[string]any{"allow": []any{"read_file(/work/My Vault)"}}
	projects := []map[string]any{unrelated, agyProject("polluted", "/work/repo", "/work/My Vault"),
		agyProject("vault", "/work/My Vault"), agyProject("parent", "/work"), agyProject("fizzer-agy-full-test", "/elsewhere")}
	for cwd, want := range map[string]string{"/work/My Vault/notes": "vault", "/work/My Vault-copy": "parent", "/elsewhere": ""} {
		if got := selectAntigravityProject(projects, cwd); got != want {
			t.Fatalf("%s: got %q want %q", cwd, got, want)
		}
	}
}

func TestAntigravityChildEnvDropsProvenance(t *testing.T) {
	env := antigravityChildEnv([]string{"PATH=/bin", "CASCADE_NOTE_TOKEN=test-helper", "ANTIGRAVITY_PROJECT_ID=wrong",
		"ANTIGRAVITY_CONVERSATION_ID=gone", "ANTIGRAVITY_SOURCE_METADATA=stale", "ANTIGRAVITY_TRAJECTORY_ID=gone",
		"ANTIGRAVITY_AGENTAPI_EXE=/wrong/agy", "ANTIGRAVITY_CSRF_TOKEN=old"},
		map[string]string{"ANTIGRAVITY_PROJECT_ID": "right", "ANTIGRAVITY_CSRF_TOKEN": "new"})
	want := "PATH=/bin CASCADE_NOTE_TOKEN=test-helper ANTIGRAVITY_CSRF_TOKEN=new ANTIGRAVITY_PROJECT_ID=right"
	if got := strings.Join(env, " "); got != want {
		t.Fatalf("got %s", got)
	}
}

func TestAntigravityRunnerRegressions(t *testing.T) {
	scratch := t.TempDir()
	t.Setenv("HOME", scratch)
	for _, name := range []string{"GEMINI_HOME", "ANTIGRAVITY_HOME"} {
		t.Setenv(name, "")
	}
	bin := filepath.Join(scratch, "agentapi")
	transcript := filepath.Join(scratch, ".gemini/antigravity/brain/fresh/.system_generated/logs/transcript.jsonl")
	projects := filepath.Join(scratch, ".gemini/config/projects")
	os.MkdirAll(projects, 0o755)
	os.MkdirAll(filepath.Dir(transcript), 0o755)
	correct := agyProject("correct", scratch)
	correct["permissionGrants"] = map[string]any{"v2Migrated": true, "permissionGrants": map[string]any{"deny": []any{"write_file(secret)"}, "ask": []any{"command(curl)"}}}
	config, _ := json.Marshal(correct)
	os.WriteFile(filepath.Join(projects, "correct.json"), config, 0o644)
	argLog := filepath.Join(scratch, "args")
	childProjects := filepath.Join(scratch, "child-projects")
	writeScript(t, bin, logArgs(argLog)+`
echo "$ANTIGRAVITY_PROJECT_ID" >> "$FAKE_PROJECTS"
if [ "$1" = send-message ]; then echo '{"error":"conversation \"gone\" not found"}'; exit 0; fi
printf '%s' "$FAKE_STEPS" > "$FAKE_TRANSCRIPT"
echo '{"response":{"newConversation":{"conversationId":"fresh"}}}'
`)
	t.Setenv("ANTIGRAVITY_BIN", bin)

	var mu sync.Mutex
	var requests []string
	serverProjects := map[string]any{"correct": correct}
	providerStatus := "CASCADE_RUN_STATUS_RUNNING"
	metadataUnavailable := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		endpoint := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
		data, _ := io.ReadAll(r.Body)
		var body map[string]any
		json.Unmarshal(data, &body)
		mu.Lock()
		defer mu.Unlock()
		requests = append(requests, endpoint)
		if r.Header.Get("X-Codeium-Csrf-Token") != "fake-token" {
			t.Errorf("csrf %q", r.Header.Get("X-Codeium-Csrf-Token"))
		}
		reply := func(status int, v any) { w.WriteHeader(status); json.NewEncoder(w).Encode(v) }
		switch endpoint {
		case "CreateProject", "UpdateProject":
			project := asObject(body["project"])
			serverProjects[str(project["id"])] = project
			reply(200, map[string]any{})
		case "ReadProject":
			if project, ok := serverProjects[str(body["id"])]; ok {
				reply(200, map[string]any{"project": project})
			} else {
				reply(200, map[string]any{"notFoundOnDisk": true})
			}
		case "GetConversationMetadata":
			if metadataUnavailable {
				reply(500, map[string]any{"message": "temporary server failure"})
			} else if body["conversationId"] == "full-session" {
				reply(200, map[string]any{"metadata": map[string]any{"projectId": str(antigravityFullHostProject(correct, scratch)["id"])}})
			} else {
				reply(200, map[string]any{"metadata": map[string]any{"projectId": "correct"}})
			}
		default:
			reply(200, map[string]any{"status": providerStatus})
		}
	}))
	defer server.Close()
	setStatus := func(s string) { mu.Lock(); providerStatus = s; mu.Unlock() }
	resetRequests := func() { mu.Lock(); requests = nil; mu.Unlock() }
	gotRequests := func() string { mu.Lock(); defer mu.Unlock(); return strings.Join(requests, ",") }

	planner := func(content string, tools ...any) map[string]any {
		if tools == nil {
			tools = []any{}
		}
		return map[string]any{"source": "MODEL", "type": "PLANNER_RESPONSE", "status": "DONE", "content": content, "tool_calls": tools}
	}
	run := func(steps []map[string]any, adjust func(*cliAgentOpts)) (cliAgentResult, error) {
		var lines strings.Builder
		for _, step := range steps {
			data, _ := json.Marshal(step)
			lines.Write(append(data, '\n'))
		}
		o := cliAgentOpts{agent: "antigravity", prompt: "test", cwd: scratch, emit: (&eventLog{}).emit, env: append(os.Environ(),
			"ANTIGRAVITY_LS_ADDRESS="+strings.TrimPrefix(server.URL, "http://"), "ANTIGRAVITY_CSRF_TOKEN=fake-token",
			"FAKE_TRANSCRIPT="+transcript, "FAKE_PROJECTS="+childProjects, "FAKE_STEPS="+lines.String())}
		if adjust != nil {
			adjust(&o)
		}
		return runCliAgent(o)
	}
	lastLine := func(file string) string {
		data, _ := os.ReadFile(file)
		lines := strings.Split(strings.TrimSpace(string(data)), "\n")
		return lines[len(lines)-1]
	}

	t.Run("quota errors surface immediately and cancel the provider", func(t *testing.T) {
		resetRequests()
		_, err := run([]map[string]any{{"source": "MODEL", "type": "ERROR_MESSAGE", "status": "DONE", "content": "Individual quota reached. Resets in 2 hours."}}, nil)
		if err == nil || !strings.Contains(err.Error(), "Individual quota reached") {
			t.Fatalf("err %v", err)
		}
		if got := gotRequests(); got != "ReadProject,CancelCascadeInvocation" {
			t.Fatalf("requests %s", got)
		}
	})

	t.Run("a missing saved session retries once and keeps permissions", func(t *testing.T) {
		result, err := run([]map[string]any{planner("Answered.")}, func(o *cliAgentOpts) { o.resumeID = "gone" })
		if err != nil || result.summary != "Answered." {
			t.Fatalf("result %+v err %v", result, err)
		}
		runs := readArgLog(t, argLog)
		if runs[len(runs)-2][0] != "send-message" || runs[len(runs)-1][0] != "new-conversation" {
			t.Fatalf("runs %q", runs)
		}
		if data, _ := os.ReadFile(filepath.Join(projects, "correct.json")); string(data) != string(config) {
			t.Fatal("project config changed")
		}
		if fileExists(filepath.Join(scratch, ".gemini/config/config.json")) {
			t.Fatal("global config written")
		}
	})

	t.Run("a failed command is reported when the provider stops without an answer", func(t *testing.T) {
		setStatus("CASCADE_RUN_STATUS_IDLE")
		defer setStatus("CASCADE_RUN_STATUS_RUNNING")
		_, err := run([]map[string]any{
			planner("", map[string]any{"name": "run_command", "args": map[string]any{"CommandLine": "cascade-chat --help"}}),
			{"source": "MODEL", "type": "GENERIC", "status": "DONE", "content": "The command exited with code 1. EPERM: operation not permitted, open cascade-chat"},
		}, nil)
		if err == nil || !strings.Contains(err.Error(), "EPERM") {
			t.Fatalf("err %v", err)
		}
	})

	t.Run("a tool error can recover with a real answer", func(t *testing.T) {
		result, err := run([]map[string]any{
			planner("", map[string]any{"name": "run_command", "args": map[string]any{}}),
			{"source": "MODEL", "type": "GENERIC", "status": "ERROR", "content": "Command failed"},
			planner("Recovered answer."),
		}, nil)
		if err != nil || result.summary != "Recovered answer." {
			t.Fatalf("result %+v err %v", result, err)
		}
	})

	t.Run("blank planner output is not a successful completion", func(t *testing.T) {
		setStatus("CASCADE_RUN_STATUS_IDLE")
		defer setStatus("CASCADE_RUN_STATUS_RUNNING")
		if _, err := run([]map[string]any{planner("")}, nil); err == nil || !strings.Contains(err.Error(), "without returning a response") {
			t.Fatalf("err %v", err)
		}
	})

	t.Run("full host uses an isolated project and scoped runs never reuse it", func(t *testing.T) {
		full, err := run([]map[string]any{planner("Full host answer.")}, func(o *cliAgentOpts) { o.yolo = true })
		if err != nil || full.summary != "Full host answer." {
			t.Fatalf("result %+v err %v", full, err)
		}
		managed := antigravityFullHostProject(correct, scratch)
		mu.Lock()
		stored := asObject(serverProjects[str(managed["id"])])
		unchanged := sameJSON(serverProjects["correct"], correct)
		mu.Unlock()
		settings := asObject(stored["settings"])
		if settings["sandboxMode"] != false || settings["permissionPreset"] != "AGENT_PERMISSION_PRESET_TURBO" ||
			!sameJSON(stored["permissionGrants"], correct["permissionGrants"]) || !unchanged {
			t.Fatalf("stored %v", stored)
		}
		if got := lastLine(childProjects); got != str(managed["id"]) {
			t.Fatalf("child project %s", got)
		}
		scoped, err := run([]map[string]any{planner("Scoped answer.")}, func(o *cliAgentOpts) { o.resumeID = "full-session" })
		if err != nil || scoped.summary != "Scoped answer." {
			t.Fatalf("result %+v err %v", scoped, err)
		}
		runs := readArgLog(t, argLog)
		if runs[len(runs)-1][0] != "new-conversation" || lastLine(childProjects) != "correct" {
			t.Fatalf("runs %q", runs[len(runs)-1])
		}
	})

	t.Run("an unverifiable session is never resumed", func(t *testing.T) {
		before, _ := os.ReadFile(argLog)
		mu.Lock()
		metadataUnavailable = true
		mu.Unlock()
		defer func() { mu.Lock(); metadataUnavailable = false; mu.Unlock() }()
		if _, err := run([]map[string]any{planner("Must not launch.")}, func(o *cliAgentOpts) { o.resumeID = "full-session" }); err == nil || !strings.Contains(err.Error(), "temporary server failure") {
			t.Fatalf("err %v", err)
		}
		if after, _ := os.ReadFile(argLog); string(after) != string(before) {
			t.Fatal("agentapi launched")
		}
	})

	t.Run("a record split between polls is not lost", func(t *testing.T) {
		record, _ := json.Marshal(planner("Complete record."))
		result, err := run(nil, func(o *cliAgentOpts) {
			o.emit = func(kind, _ string) {
				if kind == "session" {
					os.WriteFile(transcript, record[:30], 0o644)
					time.AfterFunc(700*time.Millisecond, func() {
						f, _ := os.OpenFile(transcript, os.O_APPEND|os.O_WRONLY, 0)
						f.Write(append(record[30:], '\n'))
						f.Close()
					})
				}
			}
		})
		if err != nil || result.summary != "Complete record." {
			t.Fatalf("result %+v err %v", result, err)
		}
	})

	t.Run("cancel after agentapi exits stops the provider", func(t *testing.T) {
		resetRequests()
		result, err := run([]map[string]any{planner("", map[string]any{"name": "run_command", "args": map[string]any{}})}, func(o *cliAgentOpts) {
			o.runID = 90421
			o.emit = func(kind, _ string) {
				if kind == "session" {
					cancelCliRun(90421)
				}
			}
		})
		if err != nil || result.summary != "Run canceled by user." {
			t.Fatalf("result %+v err %v", result, err)
		}
		if got := gotRequests(); got != "ReadProject,CancelCascadeInvocation" {
			t.Fatalf("requests %s", got)
		}
	})
}
