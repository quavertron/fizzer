package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/signal"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"unicode/utf8"
)

// The account worker runs as the fizzer Unix account (via sudo) and drives one
// agent run whose file writes go through the human-authorized alock bridges.

var controlChars = regexp.MustCompile(`[\x00-\x1f\x7f]`)

func accountWorkerInstruction(root string, grants []grant) string {
	alock := firstNonEmpty(os.Getenv("FIZZER_ALOCK_BIN"), "/usr/local/libexec/fizzer/alock")
	grantsJSON, _ := json.Marshal(grants)
	return fmt.Sprintf("\nFile writes are coordinated by alock. You run as the fizzer Unix account. Working directory: %s. Human-authorized bridges: %s. Use %s account stage --socket SOCKET --path RELATIVE_PATH --lines START-END --author AUTHOR, edit only the returned temporary file with your normal editor, then account commit --socket SOCKET --ticket TICKET --file TEMP_PATH --author AUTHOR. The proposal metadata stays beside the temp file as .alock. Local paths are relative to the selected root; for root / omit the leading slash. Remote-vault grants address paths relative to that vault: provide --base LOCAL_BASELINE_FILE or --sha256 CONTENT_SHA256 when staging. The remote daemon is authoritative. Each remote grant supplies mirrorRoot: read baseline files there and pass them with --base. Rclone refreshes that read-only mirror from the server; submit all edits over the remote bridge, never through a local bridge or by modifying mirror files. Stage before editing. Normal locks survive commits until each assistant turn concludes. Use --persistent SECONDS only when needed (maximum 600); these locks survive conclude until their deadline. Commit renews an expired/unclaimed lock only if the complete master content is unchanged and the range is available. On conflict, reread and reconcile. A rejected local commit leaves your edited temp file intact. Configured syntax checks gate acceptance. Use account abort --socket SOCKET --ticket TICKET to release an abandoned proposal. Never chmod project files or bypass the bridge.\n",
		jsonString(root), grantsJSON, alock)
}

// accountWorkerAuthor is the alock author: control characters removed, at most 32 bytes.
func accountWorkerAuthor(opts map[string]any) string {
	author := strings.TrimSpace(controlChars.ReplaceAllString(firstNonEmpty(str(opts["chatAuthor"]), str(opts["agent"]), "fizzer"), ""))
	if author == "" {
		author = "fizzer"
	}
	for len(author) > 32 {
		_, size := utf8.DecodeLastRuneInString(author)
		author = author[:len(author)-size]
	}
	return author
}

func runAgentAccountWorker(in io.Reader, out io.Writer) int {
	var mu sync.Mutex
	output := func(v any) {
		mu.Lock()
		defer mu.Unlock()
		line, _ := json.Marshal(v)
		out.Write(append(line, '\n'))
	}
	var input struct {
		Opts   map[string]any `json:"opts"`
		API    *runAPI        `json:"api"`
		Root   string         `json:"root"`
		Grants []grant        `json:"grants"`
	}
	if err := json.NewDecoder(in).Decode(&input); err != nil || input.Opts == nil {
		output(map[string]string{"error": fmt.Sprintf("invalid worker input: %v", err)})
		return 1
	}
	opts := input.Opts
	runID := int(numberOf(opts["runId"]))
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM)
	go func() {
		<-signals
		cancelLocalAgentRun(runID)
		codexServer.shutdown()
		os.Exit(143)
	}()
	if len(input.Grants) > 0 {
		socket := input.Grants[0].Socket
		for _, g := range input.Grants {
			if g.Remote {
				socket = g.Socket
				break
			}
		}
		os.Setenv("FIZZER_ALOCK_ACTIVITY_SOCKET", socket)
	}
	api := input.API
	if api == nil {
		api = &runAPI{}
	}
	setNoteAPIConfig(api.URL, api.Token, api.URL, "")
	author := accountWorkerAuthor(opts)
	quoted := "'" + strings.ReplaceAll(author, "'", `'\''`) + "'"
	opts["prompt"] = str(opts["prompt"]) + accountWorkerInstruction(input.Root, input.Grants) +
		fmt.Sprintf("\nUse --author %s for every account stage and commit command above.\n", quoted)
	result, err := executeLocalAgentRun(opts, api, input.Root, "", func(ev agentRunEvent) { output(map[string]any{"event": ev}) })
	codexServer.shutdown()
	if err != nil {
		output(map[string]string{"error": err.Error()})
		return 1
	}
	output(map[string]any{"result": result})
	return 0
}
