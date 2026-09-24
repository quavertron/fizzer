package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"math"
	mathrand "math/rand/v2"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const chatUsage = `cascade-chat — read/send live Cascade chat

Usage:
  cascade-chat context get             read account-wide app guidance and revision
  cascade-chat context set --file PATH --revision REV   replace guidance (conflicts return 409)
  cascade-chat history                 recent messages for the current channel
  cascade-chat attachment              write a message's images/files to disk
                        (--message-id <id>; default: newest message with media)
  cascade-chat send --message <text> [--file preview.html]    send a standalone message with optional HTML
  cascade-chat send --to @agent --reply-to <message-id> --relation <type> --message <instruction>
                                        create a typed single-agent handoff
  cascade-chat continuation              read unfinished coordinator responsibility
  cascade-chat continuation --status pending|waiting|completed|canceled --revision N --summary TEXT
  cascade-chat members                  list people-callable agent teammates
  cascade-chat mission start --title T [--message BRIEF]
  cascade-chat mission list [--json]
  cascade-chat mission diagnose --task <id> [--mission <id|current>] [--json]
  cascade-chat mission status [--mission <id|current>] [--json | --detail]
  cascade-chat mission interpret --mission <id> [--detail] [--file <path|->]  read or atomically save understanding and explanation
  cascade-chat mission history --mission <id>
  cascade-chat mission delegate --mission <id> --to @agent --task T --purpose P --message I [--brief-note <id>] [--after <task-id,...>] [--priority N] [--effort E] [--isolated]
  cascade-chat mission child --task T --message P [--mission current] [--effort E]
  cascade-chat mission join            inspect child results; end turn to wait and resume for integration
  cascade-chat mission steer --task <id> --message <instruction>
  cascade-chat mission update --task <id> --status <status> [--summary S] [--review-outcome accepted|changes_requested] [--verification-passed true|false] [--finding]
  cascade-chat mission retry --task <id> [--summary S]
  cascade-chat mission link-recovery --task <original-id> --source-task <recovery-id> --source-run <id> --target-run <id> --target-attempt <n> --objective <original-objective> --verification <observed-evidence>
  cascade-chat mission approve --mission <id> --expected-revisions '{"note-id":1}'
  cascade-chat mission note create --mission <id> --kind milestone|feature --title T --content TEXT [--parent-note-id <id>]
  cascade-chat mission note list --mission <id>
  cascade-chat mission finish --mission <id> --verification <observed-evidence> [--summary S]
  cascade-chat avatar --file <path>     upload this agent's profile picture
  cascade-chat avatar --url <https-url> use an existing uploaded note image
                        (also --avatar-url; --url here is the image, not API base)
  cascade-chat distill                 condense chat into a vault note
  cascade-chat search <query>          short matching excerpts; full messages via history

  --message <text>          message body for send; mission start uses it as the brief/request
  --mission <id|current>    mission id for mission commands
  --task <id|title>         task id (update) or title (delegate)
  --to <@handle>            target agent for send handoff or mission delegate
  --purpose <type>          research|implementation|review|fix|integration|verification
  --brief-note <id>         linked mission brief/note id for a delegated task
  --review-outcome <value>  accepted|changes_requested for a completed review task
  --verification-passed <b> true|false for a completed verification task
  --expected-revisions <j>  JSON object mapping note IDs to revisions for approval
  --kind <type>             milestone|feature for a mission note
  --content <text>          content for a mission note
  --parent-note-id <id>     parent mission note
  --reply-to <message-id>   source message for a typed send handoff
  --relation <type>         builds_on|review_request|question|contradiction|decision
  --status <status>         pending|running|completed|failed|blocked|canceled
  --task-status <states>    list task filter: comma-separated statuses (default open: pending,running,failed,blocked)
  --detail                  original full JSON for mission list/status/interpret
                            compact list defaults to open missions; --status accepts comma-separated
                            active,reviewing,attention,blocked,completed,canceled or open|all
  --finding                 request coordinator interpretation of a significant finding or question
  --summary <text>          concise task/mission outcome
  --verification <text>     coordinator-observed checks and artifact/live evidence required to finish
  --after <task-id,...>     wait for these mission tasks to complete
  --priority <-100..100>    schedule higher-priority ready work first
  --effort <level>          per-task reasoning effort override
  --isolated                prepare a dedicated worktree instead of the channel cwd
  --changes-file <path|->   JSON change request metadata for send (- reads stdin)
  --raw-message             preserve literal backslash-n sequences in --message
  --url <https-url>         profile picture URL for avatar
  --file <path>            avatar PNG, JPEG, GIF or WebP (max 2MB)
  --clear                   remove this agent's profile picture
  --author <name>           author for send (default current agent/user)
  --message-id <id>         full history message or attachment source
  --out <dir>               directory for written attachments (default temp dir)
  --before-message-id <id>  only messages before this message
  --around-message-id <id>  window centered around this message
  --limit <n>               max messages (default 12)
  --include-reply-context   include parent reply snippets
  --reply-depth <n>         parent chain depth with --include-reply-context (default 1)
  --from <msg-id>           distill range start
  --to <msg-id>             distill range end
  --last <n>                distill last N messages
  --note <id|title>         distill target note (append/merge)
  --mode create|append|merge  distill mode (default create)
  --title <t>               distill create title
  --confirm                 required for merge write
  --scope chat|all          search scope (default chat)
  --url <base>              API base (default $CASCADE_NOTE_URL, else cscd.online)
  --token <jwt>             bearer token (default $CASCADE_NOTE_TOKEN)
  --json                    machine-readable output; errors are JSON on stderr

Env: CASCADE_NOTE_URL, CASCADE_NOTE_TOKEN, CASCADE_NOTE_VAULT,
     CASCADE_CHAT_CHANNEL, CASCADE_CHAT_MESSAGE, CASCADE_CHAT_TRIGGERING_MESSAGE, CASCADE_CHAT_AUTHOR,
     CASCADE_HELPER_CONFIG`

// Detailed contracts live beside the command parser; other commands reuse their usage lines.
var chatCommandHelp = map[string]string{
	"search": `cascade-chat search <query> [--scope chat|all] [--limit N] [--json]

Returns short matching excerpts in search rank order, with message identity.
Read a full chat hit (including older messages) with:
  cascade-chat history --channel <channelId> --message-id <id>
Use --around-message-id <id> --include-reply-context for a recent context window.`,
	"mission interpret": `cascade-chat mission interpret --mission <id|current> [--detail] [--file <path|->]

Read current revision, fingerprint, understanding and evidence without --file.
Identical objective/agenda values use {contextRef:[path,...]} pointing to the full
value in this same response. Resolve references before editing saved input.
Use --detail for original full JSON. Every read fetches current server state.
Save a JSON object with --file PATH, or read JSON from stdin with --file -.
Reads require the owning coordinator; writes also require a live coordinator run.
Mission workers cannot record interpretation. The helper supplies coordinatorRegistrationId.

Accepted JSON fields:
  revision: required integer from the latest read (including 0).
  fingerprint: string from that read; required when an evidence batch is pending.
    Omission means "". Copy the returned value, never invent a fingerprint.
  assessment: string replacing the saved assessment; other types leave it unchanged.
  questions: array of objects with a nonempty string id. Use stable ids across saves.
    answer and status affect whether a question remains outstanding. A nonempty
    answer, or status answered|fulfilled|canceled|stopped|declined, closes its agenda item.
  commitments: array of objects with a nonempty string id. Use stable ids across saves.
    status: open|fulfilled|canceled (new items default to open).
    accepted: false excludes an unaccepted proposal from the active agenda.
    dueAt: optional ISO8601 timestamp for a promised wake.
    Extra question/commitment metadata is preserved; it does not grant authority.
  evidenceReferences: array, appended to saved references with duplicates removed.
  body: optional string; nonblank text publishes an actual channel explanation.
  noMaterialChange: true acknowledges quietly; omit body for this mode.
  correctsMessageId: optional id of a previous explanation for this objective.

Merge semantics: question/commitment objects merge by id, retaining omitted fields
and items. Empty arrays do not delete history. Mark fulfilled/canceled explicitly.
Other top-level fields are not saved as understanding. Input must stay under 64KB.

Minimal quiet save (valid at revision 0 with no pending fingerprint; replace both
values with the latest read before writing):
  printf '%s\n' '{"revision":0,"fingerprint":"","noMaterialChange":true}' | cascade-chat mission interpret --mission <id> --file -
To publish, replace noMaterialChange with body: "Your concise explanation".
The result includes the new revision, messageId and noMaterialChange. A quiet save
creates no chat message. Do not repeat a published body or narrate a quiet ack;
end with [no-reply] unless a separate direct owner answer remains.

Errors: malformed/empty JSON or non-object input; stale revision (read and merge);
changed evidence fingerprint (read again); stopped mission/interpretation; wrong
coordinator or worker run; invalid stable ids, commitment status/dueAt or references;
invalid correction id; input over 64KB. A pending batch requires body or explicit
noMaterialChange:true; body and noMaterialChange:true are mutually exclusive.
API failures include HTTP status and reason. An identical retry of a saved input
returns its prior result; changing input at an already-used revision conflicts.`,
	"mission list": `cascade-chat mission list [--status <filter>] [--task-status <filter>] [--json | --detail]

Default: compact ownership rows for open missions and open tasks across the
current vault. The workspace endpoint returns linked note summaries and task
evidence; filters are applied by the helper.
  --status open|all|<comma-separated statuses>
    open (default): active,reviewing,attention,blocked; also completed,canceled.
  --task-status open|all|<comma-separated statuses>
    open (default): pending,running,failed,blocked; also completed,canceled.
    Filters task rows, not the enclosing missions; empty missions remain visible.
  --json    compact JSON array, with the same filters.
  --detail  full historical JSON; no filters allowed.

Example: cascade-chat mission list --status open --task-status running --json
Use mission status --mission <id> --detail for one mission's full detail.
Invalid statuses and --detail combined with filters are errors.`,
	"mission status": `cascade-chat mission status [--mission <id|current>] [--json | --detail]
Read current mission and task state, including phase, brief, notes, owners,
attempts and blockers. Explicit mission IDs use the vault workspace endpoint.
Every invocation fetches current server state; no unchanged-state cache.`,
	"mission diagnose": `cascade-chat mission diagnose --task <id> [--mission <id|current>] [--json]
Read-only comparison of task/run projection, forwarded provider events and runner presence.
Shows ownership, timestamps and freshness (120 seconds); no prompts or event payloads.
Execution remains unknown: recent events and a connected runner do not prove a live turn.
Missing, inaccessible and unreachable evidence is explicit. No retry or recovery actions.`,
	"mission history": `cascade-chat mission history --mission <id> [--json]

Read the mission event history. An explicit id is required; current is not accepted.
--json returns the full events array.
Example: cascade-chat mission history --mission <id> --json`,
	"send": `cascade-chat send --message <text> [--changes-file <path|->]
cascade-chat send --to @agent --reply-to <message-id> --relation <type> --message <instruction>

Without --message, message text is read from stdin. --raw-message preserves literal
backslash-n sequences in inline text. --changes-file - reads JSON metadata from
stdin and requires an explicit --message so stdin has only one consumer.
Metadata is a JSON object with required files array: each file has path, additions,
and deletions. Optional commit and ref are strings. Empty paths are filtered;
counts are converted to nonnegative numbers. Approvals start empty.
Example: printf '%s\n' '{"files":[{"path":"README.md","additions":1,"deletions":0}]}' | cascade-chat send --message 'Updated docs' --changes-file -
Malformed/empty JSON and a missing files array are errors.
Typed handoffs require all three routing flags, a registered agent, and relation
builds_on|review_request|question|contradiction|decision; no --changes-file allowed.`,
}

func (h *helper) chatCommandHelp() string {
	pos := append([]string{}, h.args.pos...)
	if len(pos) > 0 && pos[0] == "attachments" {
		pos[0] = "attachment"
	}
	if len(pos) > 1 && pos[0] == "mission" && pos[1] == "show" {
		return chatCommandHelp["mission status"]
	}
	n := 1
	if len(pos) > 0 && (pos[0] == "mission" || pos[0] == "context") {
		n = 2
	}
	key := strings.Join(pos[:min(n, len(pos))], " ")
	if key == "" {
		return chatUsage
	}
	if help, ok := chatCommandHelp[key]; ok {
		return help
	}
	var lines []string
	for _, line := range strings.Split(chatUsage, "\n") {
		if strings.HasPrefix(line, "  cascade-chat "+key+" ") {
			lines = append(lines, strings.TrimLeft(line, " "))
		}
	}
	if len(lines) == 0 {
		h.failf(`unknown command "%s". Run with --help.`, key)
	}
	return strings.Join(lines, "\n") + "\n\nUse --help after a subcommand for its options."
}

// markChatSendUsed records that this run already posted, so the runner
// suppresses its duplicate reply bubble. A context-less file is never written.
func (h *helper) markChatSendUsed() {
	base := map[string]any{}
	for k, v := range h.config {
		base[k] = v
	}
	if strings.TrimSpace(firstNonEmpty(str(base["chatChannelId"]), str(base["vaultId"]), str(base["token"]), os.Getenv("CASCADE_CHAT_CHANNEL"), os.Getenv("CASCADE_NOTE_VAULT"))) == "" {
		return
	}
	base["usedChatSend"] = true
	base["chatSendCount"] = numberOf(base["chatSendCount"]) + 1
	base["updatedAt"] = time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	path := helperContextPath()
	data, _ := json.MarshalIndent(base, "", "  ")
	_ = os.MkdirAll(filepath.Dir(path), 0o700)
	if os.WriteFile(path, data, 0o600) == nil {
		_ = os.Chmod(path, 0o600)
	}
}

func (h *helper) optionString(key, envKey, configKey string) string {
	env := ""
	if envKey != "" {
		env = os.Getenv(envKey)
	}
	return strings.TrimSpace(firstNonEmpty(h.args.str(key), h.configString(configKey), env))
}

func (h *helper) optionInt(key string, fallback int) int {
	raw, ok := h.args.value(key)
	if !ok || raw == "" {
		return fallback
	}
	value, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
	if err != nil || math.IsInf(value, 0) || value < 1 {
		h.failf("--%s must be a positive number.", key)
	}
	return int(math.Floor(value))
}

func (h *helper) readJSONInput(source any, flag string) map[string]any {
	path, ok := source.(string)
	if !ok {
		h.failf("%s requires a path or - for stdin.", flag)
	}
	var raw string
	if path == "-" {
		raw = h.readStdin()
	} else {
		data, err := os.ReadFile(path)
		if err != nil {
			h.fail(err)
		}
		raw = string(data)
	}
	if strings.TrimSpace(raw) == "" {
		h.failf("%s: empty JSON input.", flag)
	}
	var parsed any
	if json.Unmarshal([]byte(raw), &parsed) != nil {
		h.failf("%s: malformed JSON input.", flag)
	}
	object, ok := parsed.(map[string]any)
	if !ok {
		h.failf("%s must contain a JSON object.", flag)
	}
	return object
}

var agentMessageAuthor = regexp.MustCompile(`(?i)^agent-(.+)-\d+-[a-z0-9]+$`)

func (h *helper) inferAuthor() string {
	if explicit := h.optionString("author", "CASCADE_CHAT_AUTHOR", "chatAuthor"); explicit != "" {
		return explicit
	}
	current := strings.TrimSpace(firstNonEmpty(h.args.str("current-message"), os.Getenv("CASCADE_CHAT_MESSAGE"), h.configString("chatMessageId")))
	if match := agentMessageAuthor.FindStringSubmatch(current); match != nil {
		return match[1]
	}
	return firstNonEmpty(os.Getenv("USER"), "agent")
}

func bodyPreview(message map[string]any) string {
	body := strings.TrimSpace(whitespaceRuns.ReplaceAllString(str(message["body"]), " "))
	if body != "" {
		if utf8.RuneCountInString(body) > 240 {
			return string([]rune(body)[:239]) + "..."
		}
		return body
	}
	if images, _ := message["images"].([]any); len(images) > 0 {
		return fmt.Sprintf("[%d image(s)]", len(images))
	}
	if attachments, _ := message["attachments"].([]any); len(attachments) > 0 {
		return fmt.Sprintf("[%d attachment(s)]", len(attachments))
	}
	return "(empty)"
}

// mediaSummary lists a message's media so history never hides that evidence exists.
func mediaSummary(message map[string]any) string {
	images, _ := message["images"].([]any)
	count := len(images)
	if count == 0 && message["hasImages"] == true {
		count = 1
	}
	var parts []string
	if count > 0 {
		plural := "s"
		if count == 1 {
			plural = ""
		}
		parts = append(parts, fmt.Sprintf("%d image%s", count, plural))
	}
	var names []string
	for _, item := range objects(message["attachments"]) {
		if name := str(item["name"]); name != "" {
			names = append(names, name)
		}
	}
	if len(names) > 0 {
		parts = append(parts, strings.Join(names, ", "))
	}
	return strings.Join(parts, ", ")
}

var imageExtensionsForChat = map[string]string{"image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif",
	"image/webp": "webp", "image/bmp": "bmp", "image/svg+xml": "svg"}

var (
	dataURLPattern  = regexp.MustCompile(`(?s)^data:([^;,]+);base64,(.+)$`)
	unsafeExtension = regexp.MustCompile(`[^\w.-]`)
	namedFile       = regexp.MustCompile(`(?i)\.[a-z0-9]+$`)
	httpURL         = regexp.MustCompile(`(?i)^https?://`)
)

// writeAttachment decodes a data URL in place or downloads an http(s) source.
func (h *helper) writeAttachment(source map[string]any, dir, base, token, apiBase string) map[string]any {
	raw := strings.TrimSpace(str(source["url"]))
	if match := dataURLPattern.FindStringSubmatch(raw); match != nil {
		ext := imageExtensionsForChat[match[1]]
		if ext == "" {
			_, sub, _ := strings.Cut(match[1], "/")
			ext = unsafeExtension.ReplaceAllString(firstNonEmpty(sub, "bin"), "")
		}
		file := filepath.Join(dir, base+"."+ext)
		data, _ := base64.StdEncoding.DecodeString(match[2])
		os.WriteFile(file, data, 0o644)
		return map[string]any{"path": file, "media_type": match[1], "name": firstNonEmpty(str(source["name"]), filepath.Base(file))}
	}
	href := raw
	if strings.HasPrefix(raw, "/") && !strings.HasPrefix(raw, "//") {
		if parsed, err := url.Parse(apiBase); err == nil {
			if ref, err := parsed.Parse(raw); err == nil {
				href = ref.String()
			}
		}
	}
	if !httpURL.MatchString(href) {
		return nil
	}
	req, _ := http.NewRequest("GET", href, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := h.client.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil
	}
	mediaType := firstNonEmpty(str(source["media_type"]), resp.Header.Get("content-type"), "application/octet-stream")
	name := str(source["name"])
	file := filepath.Join(dir, base+"."+firstNonEmpty(imageExtensionsForChat[strings.SplitN(mediaType, ";", 2)[0]], "bin"))
	if name != "" && namedFile.MatchString(name) {
		file = filepath.Join(dir, strings.NewReplacer("/", "_", "\\", "_").Replace(name))
	}
	data, _ := io.ReadAll(resp.Body)
	os.WriteFile(file, data, 0o644)
	return map[string]any{"path": file, "media_type": mediaType, "name": firstNonEmpty(name, filepath.Base(file))}
}

// normalizeInlineMessage decodes shell-literal \n in inline text; stdin stays byte-for-byte.
func normalizeInlineMessage(value any, preserve bool) string {
	text := str(value)
	if value == nil || value == false {
		text = ""
	}
	if preserve {
		return text
	}
	return strings.ReplaceAll(strings.ReplaceAll(text, `\r\n`, "\n"), `\n`, "\n")
}

func replyChain(message map[string]any, byID map[string]map[string]any, depth int) []any {
	chain := []any{}
	current := message
	for i := 0; i < depth; i++ {
		ref := asObject(current["replyTo"])
		id := str(ref["messageId"])
		if id == "" {
			break
		}
		parent := byID[id]
		preview := str(ref["preview"])
		if parent != nil {
			preview = bodyPreview(parent)
		}
		chain = append(chain, map[string]any{"messageId": id, "author": firstNonEmpty(str(ref["author"]), str(parent["author"])),
			"mention": str(ref["mention"]), "preview": preview})
		current = parent
	}
	return chain
}

// fetchLimit asks for headroom beyond the window: reply context and anchors
// need older rows, without defaulting to the whole channel.
func (h *helper) fetchLimit() int {
	limit := h.optionInt("limit", 12)
	if h.optionString("before-message-id", "", "") != "" || h.optionString("around-message-id", "", "") != "" {
		return min(500, max(120, limit*4))
	}
	headroom := 4
	if h.args.flag("include-reply-context") {
		headroom = h.optionInt("reply-depth", 1) * 10
	}
	return min(500, limit+headroom)
}

func (h *helper) selectWindow(messages []map[string]any) []map[string]any {
	limit := h.optionInt("limit", 12)
	last := func(pool []map[string]any) []map[string]any {
		return pool[max(0, len(pool)-limit):]
	}
	find := func(id string) int {
		for i, m := range messages {
			if str(m["id"]) == id {
				return i
			}
		}
		return -1
	}
	if before := h.optionString("before-message-id", "", ""); before != "" {
		if i := find(before); i >= 0 {
			return last(messages[:i])
		}
		return last(messages)
	}
	if around := h.optionString("around-message-id", "", ""); around != "" {
		if i := find(around); i >= 0 {
			start := max(0, i-(limit-1)/2)
			return messages[start:min(len(messages), start+limit)]
		}
	}
	return last(messages)
}

func (h *helper) decorateMessages(all, selected []map[string]any) []any {
	byID := map[string]map[string]any{}
	for _, m := range all {
		byID[str(m["id"])] = m
	}
	includeReplies := h.args.flag("include-reply-context")
	depth := h.optionInt("reply-depth", 1)
	out := []any{}
	for _, m := range selected {
		images, _ := m["images"].([]any)
		if images == nil {
			images = []any{}
		}
		attachments, _ := m["attachments"].([]any)
		if attachments == nil {
			attachments = []any{}
		}
		decorated := map[string]any{"id": m["id"], "author": m["author"], "createdAt": m["createdAt"], "body": str(m["body"]),
			"status": str(m["status"]), "agentId": str(m["agentId"]), "registrationId": str(m["registrationId"]),
			"runId": firstNonNil(truthyOrNil(m["runId"])), "replyTo": firstNonNil(truthyOrNil(m["replyTo"])),
			"images": images, "hasImages": m["hasImages"] == true || len(images) > 0, "attachments": attachments}
		if includeReplies {
			decorated["replyContext"] = replyChain(m, byID, depth)
		}
		out = append(out, decorated)
	}
	return out
}

func truthyOrNil(v any) any {
	if v == nil || v == false || v == "" || v == float64(0) {
		return nil
	}
	return v
}

func formatChatHuman(messages []any) string {
	if len(messages) == 0 {
		return "(no messages)"
	}
	var blocks []string
	for _, raw := range messages {
		m := asObject(raw)
		text := fmt.Sprintf("[%s] %s (%s)", str(m["createdAt"]), str(m["author"]), str(m["id"]))
		if reply := asObject(m["replyTo"]); reply != nil {
			text += fmt.Sprintf("\n  reply_to: %s (%s) \"%s\"", firstNonEmpty(str(reply["author"]), str(reply["mention"]), "unknown"), str(reply["messageId"]), str(reply["preview"]))
		}
		if chain, _ := m["replyContext"].([]any); len(chain) > 0 {
			var lines []string
			for _, item := range chain {
				c := asObject(item)
				lines = append(lines, fmt.Sprintf("    - %s (%s): %s", str(c["author"]), str(c["messageId"]), str(c["preview"])))
			}
			text += "\n  reply_context:\n" + strings.Join(lines, "\n")
		}
		text += "\n  " + bodyPreview(m)
		// A captioned screenshot used to render caption-only, so media is its own marker.
		if media := mediaSummary(m); media != "" {
			text += fmt.Sprintf("\n  attached: %s — open with: cascade-chat attachment --message-id %s", media, str(m["id"]))
		}
		blocks = append(blocks, text)
	}
	return strings.Join(blocks, "\n\n")
}

func randomUUID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6], b[8] = (b[6]&0x0f)|0x40, (b[8]&0x3f)|0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

func randomBase36(n int) string {
	const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
	out := make([]byte, n)
	for i := range out {
		out[i] = alphabet[mathrand.IntN(len(alphabet))]
	}
	return string(out)
}

func (h *helper) writeJSONLine(v any) { fmt.Fprintln(h.stdout, jsonString(v)) }

func (h *helper) writeIndented(v any) {
	data, _ := json.MarshalIndent(v, "", "  ")
	fmt.Fprintln(h.stdout, string(data))
}

// messageInput reads --message, or stdin when it is absent or bare.
func (h *helper) messageInput() (string, bool) {
	if v, ok := h.args.value("message"); ok {
		return normalizeInlineMessage(v, h.args.flag("raw-message")), false
	}
	return h.readStdin(), true
}

func runCascadeChat(h *helper) {
	raw := h.args.positional(0)
	if raw == "" && !h.args.flag("help") && h.args.flag("json") {
		h.fail("missing command. Run with --help.")
	}
	if raw == "" || h.args.flag("help") {
		if h.args.flag("help") {
			fmt.Fprintln(h.stdout, h.chatCommandHelp())
			h.exit(0)
		}
		fmt.Fprintln(h.stdout, chatUsage)
		h.exit(1)
	}
	cmd := raw
	if raw == "attachments" {
		cmd = "attachment"
	}
	switch cmd {
	case "context", "history", "send", "members", "continuation", "mission", "avatar", "distill", "search", "attachment":
	default:
		h.failf(`unknown command "%s". Run with --help.`, raw)
	}
	h.config = readHelperContext()
	vault := h.optionString("vault", "CASCADE_NOTE_VAULT", "vaultId")
	channel := h.optionString("channel", "CASCADE_CHAT_CHANNEL", "chatChannelId")
	if cmd != "context" && vault == "" {
		h.fail("missing vault. Pass --vault or set CASCADE_NOTE_VAULT.")
	}
	if cmd != "context" && cmd != "search" && channel == "" {
		h.fail("missing channel. Pass --channel or set CASCADE_CHAT_CHANNEL.")
	}
	// Avatar uses --url for the picture, not the API base.
	base := h.baseURL(cmd == "avatar")
	token := h.token(base)
	api := &helperAPI{h: h, base: base, token: token, arrow: "->", runHeader: true, retryLocalRefuse: true}
	channelBase := fmt.Sprintf("/api/vaults/%s/channels/%s", vault, channel)

	switch cmd {
	case "context":
		action := firstNonEmpty(h.args.positional(1), "get")
		if action != "get" && action != "set" {
			h.fail("Use context get or context set --file PATH --revision REV.")
		}
		method := "GET"
		var body any
		if action == "set" {
			if h.args.str("file") == "" || h.args.str("revision") == "" {
				h.fail("Context set requires --file and --revision from context get.")
			}
			data, err := os.ReadFile(h.args.str("file"))
			if err != nil {
				h.fail(err)
			}
			if len(data) > 12000 {
				h.fail("App context must be at most 12000 bytes.")
			}
			method, body = "PUT", map[string]any{"content": string(data), "revision": h.args.str("revision")}
		}
		h.writeIndented(api.call(method, "/api/app-context", body, nil))
	case "members":
		var members []any
		var lines []string
		for _, agent := range objects(api.get(channelBase + "/agents")["agents"]) {
			member := map[string]any{"id": agent["id"], "displayName": agent["displayName"], "mention": agent["mention"], "agentId": agent["agentId"],
				"model": str(agent["model"]), "orchestrator": agent["orchestrator"] == true, "taggableByAgents": agent["taggableByAgents"] == true}
			members = append(members, member)
			line := fmt.Sprintf("@%s  %s  %s", str(agent["mention"]), str(agent["displayName"]), str(agent["agentId"]))
			if model := str(agent["model"]); model != "" {
				line += " · " + model
			}
			if agent["orchestrator"] == true {
				line += " · coordinator"
			}
			lines = append(lines, line)
		}
		if members == nil {
			members = []any{}
		}
		if h.args.flag("json") {
			h.writeJSONLine(members)
		} else {
			fmt.Fprintln(h.stdout, firstNonEmpty(strings.Join(lines, "\n"), "(no agents)"))
		}
	case "continuation":
		endpoint := channelBase + "/continuation"
		status := strings.TrimSpace(h.args.str("status"))
		if status == "" {
			h.writeIndented(api.get(endpoint))
			return
		}
		switch status {
		case "pending", "waiting", "completed", "canceled":
		default:
			status = ""
		}
		revision := h.args.str("revision")
		if status == "" || !nonNegativeInts.MatchString(revision) {
			h.fail("continuation needs --status pending|waiting|completed|canceled and --revision <integer>. Read `cascade-chat continuation` for the latest revision and reconcile before saving.")
		}
		rev, _ := strconv.ParseFloat(revision, 64)
		h.writeIndented(api.call("POST", endpoint, map[string]any{"status": status, "revision": rev, "summary": h.args.str("summary")}, nil))
	case "mission":
		runChatMission(h, api, vault, channel)
	case "avatar":
		registration := h.configString("registrationId")
		if registration == "" {
			h.fail("avatar can only be used from a registered agent chat run.")
		}
		clear := h.args.flag("clear")
		avatarURL := ""
		if !clear {
			avatarURL = strings.TrimSpace(firstNonEmpty(h.args.str("avatar-url"), h.args.str("url")))
		}
		if file := h.args.str("file"); file != "" && !clear {
			mediaType := map[string]string{".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp"}[strings.ToLower(filepath.Ext(file))]
			if mediaType == "" {
				h.fail("avatar must be PNG, JPEG, GIF or WebP")
			}
			info, err := os.Stat(file)
			if err != nil {
				h.fail(err)
			}
			if info.Size() > 2*1024*1024 {
				h.fail("avatar must be at most 2MB")
			}
			data, _ := os.ReadFile(file)
			avatarURL = "data:" + mediaType + ";base64," + base64.StdEncoding.EncodeToString(data)
		}
		if !clear && avatarURL == "" {
			h.fail("missing --file <path> or --url <https-url>, or use --clear.")
		}
		if !clear && h.args.str("file") == "" && !httpURL.MatchString(avatarURL) {
			h.fail("profile picture must be an http(s) URL")
		}
		result := api.call("PUT", fmt.Sprintf("%s/agents/%s/avatar", channelBase, encodeURIComponent(registration)), map[string]any{"avatarUrl": avatarURL}, nil)
		if str(asObject(result["registration"])["avatarUrl"]) != "" {
			fmt.Fprintln(h.stdout, "profile picture updated")
		} else {
			fmt.Fprintln(h.stdout, "profile picture cleared")
		}
	case "search":
		q := strings.TrimSpace(h.args.rest(1))
		if q == "" {
			h.fail("search needs a query.")
		}
		scope := firstNonEmpty(strings.TrimSpace(h.args.str("scope")), "chat")
		path := fmt.Sprintf("/api/vaults/%s/search?q=%s&scope=%s&limit=%d", vault, encodeURIComponent(q), encodeURIComponent(scope), h.optionInt("limit", 30))
		if channel != "" {
			path += "&channel=" + encodeURIComponent(channel)
		}
		results := objects(api.get(path)["results"])
		if h.args.flag("json") {
			h.writeJSONLine(results)
			return
		}
		var blocks []string
		for _, r := range results {
			line := fmt.Sprintf("[%s] %s  %s", firstNonEmpty(str(r["type"]), "?"), str(r["id"]), str(r["title"]))
			if c := str(r["channelId"]); c != "" {
				line += "  channel=" + c
			}
			if ts := str(r["timestamp"]); ts != "" {
				line += "  " + ts
			}
			blocks = append(blocks, line+"\n  "+str(r["snippet"]))
		}
		fmt.Fprintln(h.stdout, firstNonEmpty(strings.Join(blocks, "\n\n"), "(no matches)"))
	case "distill":
		payload := map[string]any{"mode": firstNonEmpty(strings.TrimSpace(h.args.str("mode")), "create"), "confirm": h.args.flag("confirm")}
		for flag, key := range map[string]string{"from": "fromMessageId", "to": "toMessageId", "note": "note", "title": "title"} {
			if v := strings.TrimSpace(h.args.str(flag)); v != "" {
				payload[key] = v
			}
		}
		if h.args.has("last") {
			payload["lastN"] = h.optionInt("last", 30)
		}
		result := api.call("POST", channelBase+"/distill", payload, nil)
		note := asObject(result["note"])
		switch {
		case h.args.flag("json"):
			h.writeJSONLine(result)
		case result["status"] == "needs_confirm":
			fmt.Fprintf(h.stdout, "merge draft ready for note %s. Re-run with --confirm to write.\n", str(result["priorNoteId"]))
			if draft := str(result["draft"]); draft != "" {
				if runes := []rune(draft); len(runes) > 2000 {
					fmt.Fprint(h.stdout, string(runes[:2000])+"\n…\n")
				} else {
					fmt.Fprint(h.stdout, draft+"\n")
				}
			}
		case result["status"] == "exists":
			fmt.Fprintf(h.stdout, "already distilled → %s  %s\nUse --mode append to add more.\n", firstNonEmpty(str(note["id"]), str(result["priorNoteId"])), str(note["title"]))
		default:
			fmt.Fprintf(h.stdout, "distilled (%s) → %s  %s\n", str(result["mode"]), str(note["id"]), str(note["title"]))
		}
	case "attachment":
		runChatAttachment(h, api, channelBase, token, base)
	case "send":
		runChatSend(h, api, vault, channel, channelBase)
	default: // history
		listPath := channelBase + "/messages"
		if id := h.optionString("message-id", "", ""); id != "" {
			message := asObject(api.get(listPath + "/" + encodeURIComponent(id))["message"])
			output := h.decorateMessages([]map[string]any{message}, []map[string]any{message})
			if h.args.flag("json") {
				h.writeJSONLine(output)
			} else {
				fmt.Fprintln(h.stdout, formatChatHuman(output))
			}
			return
		}
		requested := h.fetchLimit()
		messages := objects(api.get(fmt.Sprintf("%s?limit=%d", listPath, requested))["messages"])
		// Only pay for the full channel when the anchor really was not in the page.
		anchor := firstNonEmpty(h.optionString("before-message-id", "", ""), h.optionString("around-message-id", "", ""))
		if anchor != "" && requested < 500 {
			found := false
			for _, m := range messages {
				found = found || str(m["id"]) == anchor
			}
			if !found {
				messages = objects(api.get(listPath + "?limit=500")["messages"])
			}
		}
		output := h.decorateMessages(messages, h.selectWindow(messages))
		if h.args.flag("json") {
			h.writeJSONLine(output)
		} else {
			fmt.Fprintln(h.stdout, formatChatHuman(output))
		}
	}
}

func runChatAttachment(h *helper, api *helperAPI, channelBase, token, base string) {
	// The list payload strips heavy data URLs, so the file comes from the detail endpoint.
	messagesPath := channelBase + "/messages"
	messageID := h.optionString("message-id", "", "")
	if messageID == "" {
		messages := objects(api.get(messagesPath + "?limit=120")["messages"])
		for i := len(messages) - 1; i >= 0; i-- {
			if mediaSummary(messages[i]) != "" {
				messageID = str(messages[i]["id"])
				break
			}
		}
		if messageID == "" {
			h.fail("no message with an attachment found.")
		}
	}
	req, _ := http.NewRequest("GET", base+messagesPath+"/"+encodeURIComponent(messageID), nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := h.client.Do(req)
	if err != nil || resp.StatusCode < 200 || resp.StatusCode > 299 {
		h.failf("message %s not found in this channel.", messageID)
	}
	var parsed map[string]any
	json.NewDecoder(resp.Body).Decode(&parsed)
	resp.Body.Close()
	target := asObject(parsed["message"])
	if target == nil {
		h.failf("message %s not found in this channel.", messageID)
	}
	outDir := h.optionString("out", "", "")
	if outDir == "" {
		outDir, _ = os.MkdirTemp("", "cascade-attachment-")
	}
	os.MkdirAll(outDir, 0o755)
	var sources []map[string]any
	images, _ := target["images"].([]any)
	for i, src := range images {
		sources = append(sources, map[string]any{"url": src, "name": "", "index": i})
	}
	for i, item := range objects(target["attachments"]) {
		source := map[string]any{}
		for k, v := range item {
			source[k] = v
		}
		source["index"] = len(images) + i
		sources = append(sources, source)
	}
	var written []any
	for _, source := range sources {
		if saved := h.writeAttachment(source, outDir, fmt.Sprintf("%s-%v", str(target["id"]), source["index"]), token, base); saved != nil {
			written = append(written, saved)
		}
	}
	if len(written) == 0 {
		h.failf("message %s has no readable attachment.", str(target["id"]))
	}
	if h.args.flag("json") {
		h.writeJSONLine(map[string]any{"messageId": target["id"], "files": written})
		return
	}
	fmt.Fprintf(h.stdout, "%s (%s): %d file(s)\n", str(target["id"]), str(target["author"]), len(written))
	for _, file := range written {
		f := asObject(file)
		fmt.Fprintf(h.stdout, "  %s  %s\n", str(f["path"]), str(f["media_type"]))
	}
}

var (
	htmlFile        = regexp.MustCompile(`(?i)\.html?$`)
	chatRelations   = map[string]bool{"builds_on": true, "review_request": true, "question": true, "contradiction": true, "decision": true}
	spaceSeparators = regexp.MustCompile(`\s+`)
)

func runChatSend(h *helper, api *helperAPI, vault, channel, channelBase string) {
	_, messageGiven := h.args.value("message")
	if h.args.str("changes-file") == "-" && !messageGiven {
		h.fail("--changes-file - requires --message <text>; stdin cannot supply both.")
	}
	rawBody, _ := h.messageInput()
	body := strings.TrimSpace(rawBody)
	if body == "" {
		h.fail("missing message. Pass --message <text> or pipe text on stdin.")
	}
	registration := h.configString("registrationId")
	agentID := h.configString("agentId")
	target := h.optionString("to", "", "")
	source := h.optionString("reply-to", "", "")
	relation := h.optionString("relation", "", "")
	if target != "" || source != "" || relation != "" {
		if h.args.str("file") != "" {
			h.fail("--file cannot be combined with a typed handoff.")
		}
		if target == "" || source == "" || relation == "" {
			h.fail("typed handoff requires --to, --reply-to, and --relation.")
		}
		if !chatRelations[relation] {
			h.failf("invalid --relation: %s", relation)
		}
		if registration == "" {
			h.fail("typed handoff requires an active registered-agent context.")
		}
		if _, ok := h.args.value("changes-file"); ok {
			h.fail("--changes-file cannot be combined with a typed handoff.")
		}
		requestID := fmt.Sprintf("collab-%s-%d-%s", firstNonEmpty(agentID, "agent"), time.Now().UnixMilli(), randomBase36(6))
		result := api.call("POST", fmt.Sprintf("%s/messages/%s/collaborate", channelBase, encodeURIComponent(source)),
			map[string]any{"target": target, "relationship": relation, "instruction": body, "requestId": requestID, "registrationId": registration}, nil)
		sentID := firstNonEmpty(str(asObject(result["message"])["id"]), requestID)
		fmt.Fprintf(h.stdout, "asked %s via %s (%s)\n", target, relation, sentID)
		return
	}
	author := firstNonEmpty(h.optionString("author", "CASCADE_CHAT_AUTHOR", "chatAuthor"), h.inferAuthor())
	if author == "" && registration == "" {
		author = "Agent"
	}
	idPrefix := agentID
	if idPrefix == "" {
		idPrefix = "msg"
		if author != "" && author != "Agent" {
			idPrefix = spaceSeparators.ReplaceAllString(strings.ToLower(author), "-")
		}
	}
	message := map[string]any{"id": fmt.Sprintf("agent-%s-%d-%s", idPrefix, time.Now().UnixMilli(), randomBase36(6)),
		"channelId": channel, "author": author, "body": body, "createdAt": time.Now().UTC().Format("2006-01-02T15:04:05.000Z")}
	if agentID != "" {
		message["agentId"] = agentID
	}
	if registration != "" {
		message["registrationId"] = registration
	}
	if changes, ok := h.args.value("changes-file"); ok {
		parsed := h.readJSONInput(changes, "--changes-file")
		files, ok := parsed["files"].([]any)
		if !ok {
			h.fail("--changes-file must contain a JSON object with a files array.")
		}
		var entries []any
		for _, raw := range files {
			f := asObject(raw)
			path := str(f["path"])
			if f["path"] == nil {
				path = ""
			}
			if path == "" {
				continue
			}
			entries = append(entries, map[string]any{"path": path, "additions": math.Max(0, jsNumber(f["additions"])), "deletions": math.Max(0, jsNumber(f["deletions"]))})
		}
		if entries == nil {
			entries = []any{}
		}
		request := map[string]any{"files": entries, "approvals": []any{}}
		if c := truthyOrNil(parsed["commit"]); c != nil {
			request["commit"] = str(c)
		}
		if r := truthyOrNil(parsed["ref"]); r != nil {
			request["ref"] = str(r)
		}
		message["changeRequest"] = request
	}
	if h.args.has("file") {
		file, ok := h.args.value("file")
		if !ok || !htmlFile.MatchString(file) {
			h.fail("--file requires a .html or .htm file.")
		}
		info, err := os.Stat(file)
		if err != nil || !info.Mode().IsRegular() || info.Size() < 1 || info.Size() > 1048576 {
			h.fail("HTML file must be 1 byte to 1 MiB.")
		}
		data, _ := os.ReadFile(file)
		if !utf8.Valid(data) {
			h.fail("HTML must be UTF-8.")
		}
		asset := api.call("POST", channelBase+"/html-assets-v1", map[string]any{"media_type": "text/html", "filename": filepath.Base(file),
			"data": base64.StdEncoding.EncodeToString(data)}, nil)
		assetURL := str(asset["url"])
		if !strings.HasPrefix(assetURL, "/api/notes/"+channel+"/assets/") {
			h.fail("Upload returned an invalid channel asset URL.")
		}
		message["attachments"] = []any{map[string]any{"url": assetURL, "name": filepath.Base(file), "media_type": "text/html", "data": ""}}
	}
	result := api.call("POST", channelBase+"/messages", message, nil)
	sentID := firstNonEmpty(str(asObject(result["message"])["id"]), str(message["id"]))
	// Suppress the runner's duplicate reply bubble for this run.
	h.markChatSendUsed()
	fmt.Fprintf(h.stdout, "sent %s\n", sentID)
}

// jsNumber mirrors Number(x) || 0.
func jsNumber(v any) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case bool:
		if t {
			return 1
		}
	case string:
		if f, err := strconv.ParseFloat(strings.TrimSpace(t), 64); err == nil {
			return f
		}
	}
	return 0
}

// ── missions ──────────────────────────────────────────────────

func runChatMission(h *helper, api *helperAPI, vault, channel string) {
	sub := strings.ToLower(firstNonEmpty(h.args.positional(1), "status"))
	registration := h.configString("registrationId")
	missionRef := firstNonEmpty(strings.TrimSpace(firstNonEmpty(h.args.str("mission"), h.args.positional(2))), "current")
	channelBase := fmt.Sprintf("/api/vaults/%s/channels/%s", vault, channel)
	missionsBase := channelBase + "/missions"
	vaultMissions := fmt.Sprintf("/api/vaults/%s/missions", encodeURIComponent(vault))
	requireCoordinator := func(message string) {
		if registration == "" {
			h.fail(message)
		}
	}
	instruction := func() string {
		raw, _ := h.messageInput()
		return strings.TrimSpace(raw)
	}
	switch sub {
	case "start":
		requireCoordinator("mission start can only be used from a registered coordinator run.")
		title := strings.TrimSpace(h.args.str("title"))
		if title == "" {
			h.fail("mission start needs --title <text>.")
		}
		root := strings.TrimSpace(firstNonEmpty(h.args.str("root"), h.configString("chatTriggeringMessageId"), os.Getenv("CASCADE_CHAT_TRIGGERING_MESSAGE")))
		if root == "" {
			h.fail("mission start needs an existing root message (--root or the triggering message).")
		}
		coordinatorID := ""
		for _, member := range objects(api.get(fmt.Sprintf("/api/vaults/%s/channels/%s/agents", encodeURIComponent(vault), encodeURIComponent(channel)))["agents"]) {
			if str(member["id"]) == registration {
				coordinatorID = strings.TrimSpace(str(member["vaultAgentId"]))
			}
		}
		if coordinatorID == "" {
			h.failf("mission start could not resolve coordinator registration %s to a vault identity.", registration)
		}
		var brief any = title
		if h.args.flag("message") {
			brief = h.readStdin()
		} else if v, ok := h.args.value("message"); ok {
			brief = v
		}
		content := firstNonEmpty(strings.TrimSpace(normalizeInlineMessage(brief, h.args.flag("raw-message"))), title)
		result := api.call("POST", vaultMissions, map[string]any{"id": randomUUID(), "title": title, "coordinatorIdentityId": coordinatorID,
			"briefContent": content, "channelId": channel, "rootMessageId": root, "coordinatorRegistrationId": registration}, nil)
		mission := asObject(result["mission"])
		if h.args.flag("json") {
			h.writeJSONLine(mission)
		} else {
			fmt.Fprintf(h.stdout, "mission %s started: %s\n", str(mission["id"]), str(mission["title"]))
		}
	case "diagnose":
		task := strings.TrimSpace(h.args.str("task"))
		if task == "" {
			h.fail("mission diagnose needs --task <id>.")
		}
		printDiagnosis(h, diagnoseTask(h, api, missionsBase, vault, missionRef, task))
	case "status", "show":
		endpoint := fmt.Sprintf("%s/%s", vaultMissions, encodeURIComponent(missionRef))
		if missionRef == "current" {
			endpoint = fmt.Sprintf("/api/vaults/%s/channels/%s/missions/current", encodeURIComponent(vault), encodeURIComponent(channel))
		}
		mission := asObject(api.get(endpoint)["mission"])
		if h.args.flag("json") || h.args.flag("detail") {
			if h.args.flag("detail") {
				h.writeJSONLine(mission)
				return
			}
			compact := map[string]any{}
			for k, v := range mission {
				if k != "authority" {
					compact[k] = v
				}
			}
			ids := []any{}
			for _, source := range objects(mission["authority"]) {
				ids = append(ids, source["id"])
			}
			compact["authorityMessageIds"] = ids
			compact["detailCommand"] = fmt.Sprintf("cascade-chat mission status --mission %s --detail", str(mission["id"]))
			h.writeJSONLine(compact)
			return
		}
		var tasks []string
		for _, task := range objects(mission["tasks"]) {
			status := str(task["status"])
			mark := "·"
			if status == "completed" {
				mark = "✓"
			} else if status == "failed" || status == "blocked" {
				mark = "!"
			}
			line := fmt.Sprintf("  %s %s  %s — @%s (%s)", mark, str(task["id"]), str(task["title"]), firstNonEmpty(str(task["assigneeMention"]), str(task["assignee"])), status)
			if summary := str(task["summary"]); summary != "" {
				line += "\n      " + summary
			}
			tasks = append(tasks, line)
		}
		fmt.Fprintf(h.stdout, "%s  %s  %s\n%s\n", firstNonEmpty(str(mission["status"]), str(mission["phase"]), "unknown"), str(mission["id"]), str(mission["title"]),
			firstNonEmpty(strings.Join(tasks, "\n"), "  (no tasks)"))
	case "list":
		runMissionList(h, api, vaultMissions)
	case "interpret":
		requireCoordinator("mission interpret requires a registered coordinator.")
		endpoint := fmt.Sprintf("%s/%s/interpretation", missionsBase, encodeURIComponent(missionRef))
		if !h.args.has("file") || h.args.vals["file"] == false {
			result := api.get(endpoint + "?coordinator=" + encodeURIComponent(registration))
			if !h.args.flag("detail") {
				compactInterpretation(result)
			}
			h.writeJSONLine(result)
			return
		}
		input := h.readJSONInput(h.args.vals["file"], "--file")
		input["coordinatorRegistrationId"] = registration
		result := api.call("POST", endpoint, input, nil)
		if truthyOrNil(result["messageId"]) != nil {
			h.markChatSendUsed()
		}
		h.writeJSONLine(result)
	case "history":
		if missionRef == "current" {
			h.fail("mission history needs --mission <id>.")
		}
		result := api.get(fmt.Sprintf("%s/%s/history", missionsBase, encodeURIComponent(missionRef)))
		events := objects(result["events"])
		if h.args.flag("json") {
			if events == nil {
				events = []map[string]any{}
			}
			h.writeJSONLine(events)
			return
		}
		var lines []string
		for _, ev := range events {
			transition := firstNonEmpty(str(ev["toStatus"]), strings.ReplaceAll(str(ev["kind"]), "_", " "))
			if str(ev["fromStatus"]) != "" && str(ev["toStatus"]) != "" {
				transition = str(ev["fromStatus"]) + " → " + str(ev["toStatus"])
			}
			attempt := ""
			if a := numberOf(ev["attempt"]); a > 0 {
				attempt = fmt.Sprintf(" · attempt %s", str(a+1))
			}
			line := fmt.Sprintf("%s  %s%s  %s", str(ev["createdAt"]), transition, attempt, firstNonEmpty(str(ev["title"]), str(ev["kind"])))
			if summary := str(ev["summary"]); summary != "" {
				line += "\n    " + summary
			}
			lines = append(lines, line)
		}
		fmt.Fprintln(h.stdout, firstNonEmpty(strings.Join(lines, "\n"), "(no mission events)"))
	case "approve":
		if missionRef == "current" {
			h.fail("mission approve needs --mission <id>.")
		}
		raw := strings.TrimSpace(h.args.str("expected-revisions"))
		if raw == "" {
			h.fail("mission approve needs --expected-revisions <JSON>.")
		}
		var revisions any
		if json.Unmarshal([]byte(raw), &revisions) != nil {
			h.fail("mission approve expected revisions must be valid JSON.")
		}
		if _, ok := revisions.(map[string]any); !ok {
			h.fail("mission approve expected revisions must be a JSON object.")
		}
		result := api.call("POST", fmt.Sprintf("%s/%s/approve", vaultMissions, encodeURIComponent(missionRef)), map[string]any{"expectedRevisions": revisions}, nil)
		if h.args.flag("json") {
			h.writeJSONLine(firstNonNil(result["mission"], result))
		} else {
			fmt.Fprintf(h.stdout, "mission %s approved\n", firstNonEmpty(str(asObject(result["mission"])["id"]), missionRef))
		}
	case "note", "notes":
		action := strings.ToLower(firstNonEmpty(h.args.positional(2), "list"))
		if h.args.str("mission") == "" {
			missionRef = "current"
		}
		if missionRef == "current" {
			h.failf("mission note %s needs --mission <id>.", action)
		}
		endpoint := fmt.Sprintf("%s/%s", vaultMissions, encodeURIComponent(missionRef))
		if action == "list" {
			notes := objects(asObject(api.get(endpoint)["mission"])["notes"])
			if h.args.flag("json") {
				if notes == nil {
					notes = []map[string]any{}
				}
				h.writeJSONLine(notes)
				return
			}
			var lines []string
			for _, note := range notes {
				lines = append(lines, fmt.Sprintf("%s %s  r%s  %s", str(note["kind"]), firstNonEmpty(str(note["noteId"]), str(note["id"])), str(note["revision"]), str(note["title"])))
			}
			fmt.Fprintln(h.stdout, firstNonEmpty(strings.Join(lines, "\n"), "(no mission notes)"))
			return
		}
		if action != "create" {
			h.fail("mission note use create or list.")
		}
		kind := strings.ToLower(strings.TrimSpace(h.args.str("kind")))
		if kind != "milestone" && kind != "feature" {
			h.fail("mission note create needs --kind milestone|feature.")
		}
		title := strings.TrimSpace(h.args.str("title"))
		if title == "" {
			h.fail("mission note create needs --title <text>.")
		}
		var content any = h.args.vals["content"]
		if !h.args.has("content") {
			if h.args.flag("message") {
				content = h.readStdin()
			} else {
				content = h.args.vals["message"]
			}
		}
		text := strings.TrimSpace(normalizeInlineMessage(content, h.args.flag("raw-message")))
		if text == "" {
			h.fail("mission note create needs --content <text> or stdin.")
		}
		var parent any
		if p := strings.TrimSpace(h.args.str("parent-note-id")); p != "" {
			parent = p
		}
		result := api.call("POST", endpoint+"/notes", map[string]any{"id": randomUUID(), "kind": kind, "parentNoteId": parent, "title": title, "content": text}, nil)
		if h.args.flag("json") {
			h.writeJSONLine(result)
		} else {
			note := asObject(result["note"])
			fmt.Fprintf(h.stdout, "mission note %s created\n", firstNonEmpty(str(note["noteId"]), str(note["id"]), "created"))
		}
	case "child":
		title := strings.TrimSpace(firstNonEmpty(h.args.str("task"), h.args.str("title")))
		if title == "" {
			h.fail("mission child needs --task <title>.")
		}
		prompt := firstNonEmpty(instruction(), title)
		result := api.call("POST", fmt.Sprintf("%s/%s/children", missionsBase, encodeURIComponent(missionRef)),
			map[string]any{"title": title, "prompt": prompt, "reasoningEffort": strings.ToLower(strings.TrimSpace(h.args.str("effort")))}, nil)
		if h.args.flag("json") {
			h.writeJSONLine(result)
		} else {
			task := asObject(result["task"])
			fmt.Fprintf(h.stdout, "child %s: %s (isolated worktree)\n", str(task["id"]), str(task["title"]))
		}
	case "join":
		h.writeJSONLine(api.call("POST", missionsBase+"/children/join", map[string]any{}, nil))
	case "delegate":
		requireCoordinator("mission delegate can only be used from a registered coordinator run.")
		if h.args.flag("anonymous") {
			h.fail("mission delegate no longer supports anonymous self-delegation; assign a named agent with --to.")
		}
		assignee := strings.TrimSpace(h.args.str("to"))
		title := strings.TrimSpace(firstNonEmpty(h.args.str("task"), h.args.str("title")))
		purpose := strings.ToLower(strings.TrimSpace(h.args.str("purpose")))
		if assignee == "" {
			h.fail("mission delegate needs --to <@agent>.")
		}
		if title == "" {
			h.fail("mission delegate needs --task <title>.")
		}
		switch purpose {
		case "research", "implementation", "review", "fix", "integration", "verification":
		default:
			h.fail("mission delegate needs --purpose research|implementation|review|fix|integration|verification.")
		}
		dependsOn := []any{}
		for _, item := range strings.Split(h.args.str("after"), ",") {
			if item = strings.TrimSpace(item); item != "" {
				dependsOn = append(dependsOn, item)
			}
		}
		mode := "shared"
		if h.args.flag("isolated") {
			mode = "isolated"
		}
		payload := map[string]any{"coordinatorRegistrationId": registration, "title": title, "purpose": purpose, "assignee": assignee,
			"prompt": firstNonEmpty(instruction(), title), "dependsOn": dependsOn, "priority": jsNumber(h.args.vals["priority"]),
			"reasoningEffort": strings.ToLower(strings.TrimSpace(h.args.str("effort"))), "workspaceMode": mode}
		if h.args.has("brief-note") {
			payload["briefNoteId"] = strings.TrimSpace(h.args.str("brief-note"))
		}
		result := api.call("POST", fmt.Sprintf("%s/%s/tasks", missionsBase, encodeURIComponent(missionRef)), payload, nil)
		task := asObject(result["task"])
		if h.args.flag("json") {
			h.writeJSONLine(map[string]any{"mission": result["mission"], "task": result["task"]})
		} else {
			verb := "scheduled"
			if result["scheduled"] == true {
				verb = "dispatched"
			}
			fmt.Fprintf(h.stdout, "%s %s to @%s: %s\n", verb, str(task["id"]), firstNonEmpty(str(task["assigneeMention"]), str(task["assignee"])), str(task["title"]))
		}
	case "steer":
		requireCoordinator("mission steer requires a registered coordinator.")
		taskID := strings.TrimSpace(h.args.str("task"))
		if taskID == "" {
			h.fail("mission steer needs --task <id>.")
		}
		message := instruction()
		if message == "" {
			h.fail("mission steer needs --message <instruction> or stdin.")
		}
		var task map[string]any
		for _, mission := range objects(api.get(missionsBase + "?coordinator=" + encodeURIComponent(registration))["missions"]) {
			for _, candidate := range objects(mission["tasks"]) {
				if task == nil && str(candidate["id"]) == taskID {
					task = candidate
				}
			}
		}
		if task == nil {
			h.fail("Task not found among this coordinator’s missions.")
		}
		result := api.call("POST", fmt.Sprintf("%s/tasks/%s/steer", missionsBase, encodeURIComponent(taskID)),
			map[string]any{"coordinatorRegistrationId": registration, "message": message, "attempt": task["attempt"], "runId": task["runId"]}, nil)
		steering := asObject(result["steering"])
		if h.args.flag("json") {
			h.writeJSONLine(steering)
		} else {
			fmt.Fprintf(h.stdout, "%s steering %s: %s\n", str(steering["status"]), str(steering["id"]), str(steering["detail"]))
		}
	case "update", "retry":
		taskID := strings.TrimSpace(firstNonEmpty(h.args.str("task"), h.args.positional(2)))
		status := "pending"
		if sub == "update" {
			status = strings.ToLower(strings.TrimSpace(h.args.str("status")))
		}
		if taskID == "" {
			h.failf("mission %s needs --task <id>.", sub)
		}
		switch status {
		case "pending", "running", "completed", "failed", "blocked", "canceled":
		default:
			h.fail("mission update needs --status pending|running|completed|failed|blocked|canceled.")
		}
		payload := map[string]any{"status": status, "summary": strings.TrimSpace(h.args.str("summary"))}
		if truthyOrNil(h.args.vals["finding"]) != nil {
			payload["finding"] = true
		}
		if h.args.has("review-outcome") {
			outcome := strings.ToLower(strings.TrimSpace(h.args.str("review-outcome")))
			if outcome != "accepted" && outcome != "changes_requested" {
				h.fail("mission update --review-outcome must be accepted|changes_requested.")
			}
			payload["reviewOutcome"] = outcome
		}
		if h.args.has("verification-passed") {
			value, ok := h.args.value("verification-passed")
			normalized := strings.ToLower(strings.TrimSpace(value))
			if !ok || (normalized != "true" && normalized != "false") {
				h.fail("mission update --verification-passed must be true|false.")
			}
			payload["verificationPassed"] = normalized == "true"
		}
		result := api.call("PATCH", fmt.Sprintf("%s/tasks/%s", missionsBase, encodeURIComponent(taskID)), payload, nil)
		if h.args.flag("json") {
			h.writeJSONLine(result["mission"])
		} else if sub == "retry" {
			fmt.Fprintf(h.stdout, "task %s queued for retry\n", taskID)
		} else {
			fmt.Fprintf(h.stdout, "task %s → %s\n", taskID, status)
		}
	case "link-recovery":
		requireCoordinator("mission link-recovery requires a registered coordinator.")
		taskID := strings.TrimSpace(h.args.str("task"))
		if taskID == "" || h.args.str("source-task") == "" || h.args.str("source-run") == "" || !h.args.has("target-attempt") || h.args.str("objective") == "" || h.args.str("verification") == "" {
			h.fail("link-recovery needs --task, --source-task, --source-run, --target-attempt, --objective, and --verification; use --target-run for an original bound run.")
		}
		var targetRun any
		if h.args.str("target-run") != "" {
			targetRun = jsNumberStrict(h.args.str("target-run"))
		}
		result := api.call("POST", fmt.Sprintf("%s/tasks/%s/recovery-evidence", missionsBase, encodeURIComponent(taskID)), map[string]any{
			"coordinatorRegistrationId": registration, "sourceTaskId": h.args.str("source-task"), "sourceRunId": jsNumberStrict(h.args.str("source-run")),
			"targetRunId": targetRun, "targetAttempt": jsNumberStrict(h.args.str("target-attempt")), "objective": h.args.str("objective"), "verification": h.args.str("verification"),
		}, nil)
		if h.args.flag("json") {
			h.writeJSONLine(result["mission"])
		} else {
			fmt.Fprintf(h.stdout, "recovery evidence linked to %s\n", taskID)
		}
	case "finish", "cancel":
		requireCoordinator(fmt.Sprintf("mission %s can only be used from a registered coordinator run.", sub))
		status := "completed"
		if sub == "cancel" {
			status = "canceled"
		}
		result := api.call("POST", fmt.Sprintf("%s/%s/finish", missionsBase, encodeURIComponent(missionRef)), map[string]any{"coordinatorRegistrationId": registration,
			"status": status, "summary": strings.TrimSpace(h.args.str("summary")), "verification": strings.TrimSpace(h.args.str("verification"))}, nil)
		mission := asObject(result["mission"])
		if h.args.flag("json") {
			h.writeJSONLine(mission)
		} else {
			fmt.Fprintf(h.stdout, "mission %s → %s\n", str(mission["id"]), str(mission["status"]))
		}
	default:
		h.failf(`unknown mission command "%s". Use start|list|status|diagnose|history|interpret|delegate|child|join|steer|update|retry|link-recovery|approve|note|finish|cancel.`, sub)
	}
}

// jsNumberStrict mirrors Number(x): NaN when it does not parse.
func jsNumberStrict(s string) any {
	if f, err := strconv.ParseFloat(strings.TrimSpace(s), 64); err == nil {
		return f
	}
	return nil
}

// compactInterpretation replaces evidence values identical to the saved
// understanding with a contextRef pointing at the full value.
func compactInterpretation(result map[string]any) {
	evidence := asObject(result["evidence"])
	agenda := asObject(evidence["agenda"])
	understanding := asObject(result["understanding"])
	for _, pair := range []struct {
		target map[string]any
		key    string
		value  any
		path   []any
	}{
		{evidence, "objective", result["objective"], []any{"objective"}},
		{agenda, "questions", understanding["questions"], []any{"understanding", "questions"}},
		{agenda, "commitments", understanding["commitments"], []any{"understanding", "commitments"}},
	} {
		if pair.value == nil || pair.target == nil {
			continue
		}
		reference := map[string]any{"contextRef": pair.path}
		if sameJSON(pair.target[pair.key], pair.value) && len(jsonString(reference)) < len(jsonString(pair.value)) {
			pair.target[pair.key] = reference
		}
	}
}

func runMissionList(h *helper, api *helperAPI, vaultMissions string) {
	if h.args.flag("detail") && (h.args.has("status") || h.args.has("task-status")) {
		h.fail("--detail cannot be combined with list filters.")
	}
	missions := objects(api.get(vaultMissions)["missions"])
	filter := func(flag, open string, allowed []string) []string {
		value := h.args.str(flag)
		if h.args.flag("detail") || value == "" || value == "all" {
			return nil
		}
		requested := strings.Split(open, ",")
		if value != "open" {
			requested = nil
			for _, state := range strings.Split(value, ",") {
				requested = append(requested, strings.TrimSpace(state))
			}
		}
		for _, state := range requested {
			valid := false
			for _, a := range allowed {
				valid = valid || a == state
			}
			if !valid {
				h.failf("Invalid --%s; use open, all, or comma-separated %s.", flag, strings.Join(allowed, ","))
			}
		}
		return requested
	}
	in := func(list []string, v string) bool {
		for _, s := range list {
			if s == v {
				return true
			}
		}
		return false
	}
	if states := filter("status", "active,reviewing,attention,blocked", []string{"planning", "executing", "closed", "active", "reviewing", "attention", "blocked", "completed", "canceled"}); states != nil {
		var kept []map[string]any
		for _, m := range missions {
			if in(states, firstNonEmpty(str(m["status"]), str(m["phase"]))) {
				kept = append(kept, m)
			}
		}
		missions = kept
	}
	if states := filter("task-status", "pending,running,failed,blocked", []string{"pending", "running", "completed", "failed", "blocked", "canceled"}); states != nil {
		for i, m := range missions {
			copied := map[string]any{}
			for k, v := range m {
				copied[k] = v
			}
			tasks := []any{}
			for _, t := range objects(m["tasks"]) {
				if in(states, str(t["status"])) {
					tasks = append(tasks, t)
				}
			}
			copied["tasks"] = tasks
			missions[i] = copied
		}
	}
	if missions == nil {
		missions = []map[string]any{}
	}
	if h.args.flag("json") || h.args.flag("detail") {
		h.writeJSONLine(missions)
		return
	}
	var lines []string
	for _, m := range missions {
		owner := firstNonEmpty(str(m["coordinatorMention"]), str(m["coordinatorIdentityId"]), "unknown")
		rows := []string{fmt.Sprintf("%-10s  %s  %s  · %s", firstNonEmpty(str(m["status"]), str(m["phase"]), "unknown"), str(m["id"]), str(m["title"]), owner)}
		for _, t := range objects(m["tasks"]) {
			rows = append(rows, fmt.Sprintf("  %-10s  %s  %s  · %s", str(t["status"]), str(t["id"]), str(t["title"]), firstNonEmpty(str(t["assigneeMention"]), str(t["assigneeRegistrationId"]), "unknown")))
		}
		lines = append(lines, strings.Join(rows, "\n"))
	}
	fmt.Fprintln(h.stdout, firstNonEmpty(strings.Join(lines, "\n"), "(no missions)"))
}

// ── diagnose ──────────────────────────────────────────────────
// Diagnostics never replay requests or print server error bodies, which may contain prompts.

type diagnostic struct {
	state      string
	httpStatus int
	data       map[string]any
}

func diagnosticGet(h *helper, api *helperAPI, endpoint string) diagnostic {
	req, err := http.NewRequest("GET", api.base+endpoint, nil)
	if err != nil {
		return diagnostic{state: "unreachable"}
	}
	req.Header.Set("Authorization", "Bearer "+api.token)
	req.Header.Set("x-cascade-run-id", os.Getenv("CASCADE_RUN_ID"))
	client := &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		return diagnostic{state: "unreachable"}
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		return diagnostic{state: "unreachable"}
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		state := "unreachable"
		if resp.StatusCode == 401 || resp.StatusCode == 403 || resp.StatusCode == 404 {
			state = "inaccessible"
		}
		return diagnostic{state: state, httpStatus: resp.StatusCode}
	}
	var data map[string]any
	if json.NewDecoder(resp.Body).Decode(&data) != nil {
		return diagnostic{state: "unreachable"}
	}
	return diagnostic{state: "available", data: data}
}

var sqliteTimestamp = regexp.MustCompile(`^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$`)

// diagnosticTime normalizes a timestamp; SQLite timestamps are UTC without a suffix.
func diagnosticTime(value any, now time.Time) map[string]any {
	unknown := map[string]any{"at": nil, "ageSeconds": nil, "freshness": "unknown"}
	var at time.Time
	switch v := value.(type) {
	case float64:
		at = time.UnixMilli(int64(v))
	case string:
		s := v
		if sqliteTimestamp.MatchString(s) {
			s = strings.Replace(s, " ", "T", 1) + "Z"
		}
		parsed, err := time.Parse(time.RFC3339Nano, s)
		if err != nil {
			return unknown
		}
		at = parsed
	default:
		return unknown
	}
	age := now.Sub(at).Seconds()
	freshness := "stale"
	if age < 0 {
		freshness = "unknown"
	} else if age <= 120 {
		freshness = "fresh"
	}
	return map[string]any{"at": at.UTC().Format("2006-01-02T15:04:05.000Z"), "ageSeconds": math.Round(age), "freshness": freshness}
}

func diagnoseTask(h *helper, api *helperAPI, base, vault, missionRef, taskID string) map[string]any {
	snapshot := diagnosticGet(h, api, base+"/"+encodeURIComponent(missionRef))
	if snapshot.state != "available" {
		return map[string]any{"projection": diagnosticState(snapshot), "execution": "unknown"}
	}
	mission := asObject(snapshot.data["mission"])
	var task map[string]any
	for _, t := range objects(mission["tasks"]) {
		if task == nil && str(t["id"]) == taskID {
			task = t
		}
	}
	if task == nil {
		return map[string]any{"projection": map[string]any{"state": "inaccessible"}, "execution": "unknown"}
	}
	runID := str(task["runId"])
	runResult, eventsResult, runnerResult := diagnostic{state: "missing"}, diagnostic{state: "missing"}, diagnostic{state: "unknown"}
	if truthyOrNil(task["runId"]) != nil {
		done := make(chan struct{}, 3)
		go func() { runResult = diagnosticGet(h, api, "/api/runs/"+encodeURIComponent(runID)); done <- struct{}{} }()
		go func() {
			eventsResult = diagnosticGet(h, api, "/api/runs/"+encodeURIComponent(runID)+"/events")
			done <- struct{}{}
		}()
		go func() { runnerResult = diagnosticGet(h, api, "/api/me/desktop-runner"); done <- struct{}{} }()
		for i := 0; i < 3; i++ {
			<-done
		}
	}
	now := time.Now()
	run := asObject(runResult.data["run"])
	// Reject inconsistent responses rather than attach evidence to another run or vault.
	matched := run != nil && str(run["id"]) == runID && str(run["vault_id"]) == vault
	var events []map[string]any
	if matched {
		for _, ev := range objects(eventsResult.data["events"]) {
			if str(ev["run_id"]) == runID {
				events = append(events, ev)
			}
		}
	}
	eventTime := func(ev map[string]any) time.Time {
		if at, ok := diagnosticTime(ev["ts"], now)["at"].(string); ok {
			t, _ := time.Parse(time.RFC3339Nano, at)
			return t
		}
		return time.Time{}
	}
	latest := func(types ...string) map[string]any {
		var candidates []map[string]any
		for _, ev := range events {
			if len(types) == 0 || in(types, str(ev["type"])) {
				candidates = append(candidates, ev)
			}
		}
		sort.SliceStable(candidates, func(i, j int) bool { return eventTime(candidates[i]).After(eventTime(candidates[j])) })
		if len(candidates) == 0 {
			return nil
		}
		return candidates[0]
	}
	provider := latest("harness", "text", "session")
	lastEvent := latest()
	findings := []any{}
	if matched && str(task["status"]) != str(run["status"]) {
		findings = append(findings, "task_run_status_mismatch")
	}
	if matched && in([]string{"completed", "failed", "canceled"}, str(run["status"])) && provider != nil {
		finished, _ := diagnosticTime(run["finished_at"], now)["at"].(string)
		finishedAt, _ := time.Parse(time.RFC3339Nano, finished)
		if eventTime(provider).After(finishedAt) {
			findings = append(findings, "provider_event_after_run_finished")
		}
	}
	if run != nil && !matched {
		findings = append(findings, "run_identity_mismatch")
	}
	var runInfo map[string]any
	switch {
	case matched:
		runInfo = map[string]any{"state": "available", "id": run["id"], "status": run["status"], "provider": run["agent"],
			"sessionId": truthyOrNil(run["session_id"]), "conversationId": truthyOrNil(run["conversation_id"]),
			"ownership": "authenticated account (run API enforced)", "started": diagnosticTime(run["started_at"], now), "finished": diagnosticTime(run["finished_at"], now)}
	case run != nil:
		runInfo = map[string]any{"state": "identity_mismatch"}
	default:
		runInfo = diagnosticState(runResult)
	}
	evidenceState := "unknown"
	if matched {
		evidenceState = eventsResult.state
	}
	var connected any
	if v, ok := runnerResult.data["online"]; ok {
		connected = v
	}
	var lastEventTS, providerTS any
	if lastEvent != nil {
		lastEventTS = lastEvent["ts"]
	}
	if provider != nil {
		providerTS = provider["ts"]
	}
	return map[string]any{
		"observedAt": now.UTC().Format("2006-01-02T15:04:05.000Z"), "freshnessThresholdSeconds": 120, "missionId": mission["id"],
		"task": map[string]any{"id": task["id"], "status": task["status"], "assignee": truthyOrNil(task["assignee"]), "assigneeMention": truthyOrNil(task["assigneeMention"]),
			"parentTaskId": truthyOrNil(task["parentTaskId"]), "attempt": task["attempt"], "runId": truthyOrNil(task["runId"]), "updated": diagnosticTime(task["updatedAt"], now)},
		"run":              runInfo,
		"providerEvidence": map[string]any{"state": evidenceState, "source": "forwarded run events", "lastEvent": diagnosticTime(lastEventTS, now), "lastProviderEvent": diagnosticTime(providerTS, now)},
		"runner":           map[string]any{"state": runnerResult.state, "scope": "authenticated account", "connected": connected, "lastSeen": diagnosticTime(runnerResult.data["lastSeenAt"], now)},
		"execution":        "unknown", "findings": findings,
		"limitation": "No independent live provider probe is exposed. Forwarded events can lag or stop after settlement; runner presence is not proof of active execution.",
	}
}

func in(list []string, v string) bool {
	for _, s := range list {
		if s == v {
			return true
		}
	}
	return false
}

func diagnosticState(d diagnostic) map[string]any {
	state := map[string]any{"state": d.state}
	if d.httpStatus != 0 {
		state["httpStatus"] = d.httpStatus
	}
	return state
}

func printDiagnosis(h *helper, result map[string]any) {
	if h.args.flag("json") {
		h.writeJSONLine(result)
		return
	}
	task := asObject(result["task"])
	if task == nil {
		fmt.Fprintf(h.stdout, "projection: %s; execution: unknown\n", str(asObject(result["projection"])["state"]))
		return
	}
	stamp := func(v any) string {
		t := asObject(v)
		return fmt.Sprintf("%s (%s)", firstNonEmpty(str(t["at"]), "unknown"), firstNonEmpty(str(t["freshness"]), "unknown"))
	}
	run, evidence, runner := asObject(result["run"]), asObject(result["providerEvidence"]), asObject(result["runner"])
	connected := "unknown"
	if runner["connected"] != nil {
		connected = fmt.Sprint(runner["connected"])
	}
	findings := []string{}
	for _, f := range result["findings"].([]any) {
		findings = append(findings, str(f))
	}
	lines := []string{
		fmt.Sprintf("task %s: %s; owner %s; attempt %s", str(task["id"]), str(task["status"]), firstNonEmpty(str(task["assigneeMention"]), str(task["assignee"]), "unknown"), str(task["attempt"])),
		fmt.Sprintf("mission %s; parent %s; task updated %s", str(result["missionId"]), firstNonEmpty(str(task["parentTaskId"]), "none"), stamp(task["updated"])),
		fmt.Sprintf("run %s: %s; provider %s; session %s", firstNonEmpty(str(task["runId"]), "none"), firstNonEmpty(str(run["status"]), str(run["state"])), firstNonEmpty(str(run["provider"]), "unknown"), firstNonEmpty(str(run["sessionId"]), "unknown")),
		fmt.Sprintf("run ownership: %s; conversation %s; finished %s", firstNonEmpty(str(run["ownership"]), "unknown"), firstNonEmpty(str(run["conversationId"]), "unknown"), stamp(run["finished"])),
		fmt.Sprintf("forwarded provider evidence: %s; last provider event %s; last event %s", str(evidence["state"]), stamp(evidence["lastProviderEvent"]), stamp(evidence["lastEvent"])),
		fmt.Sprintf("account runner: %s; connected %s; last seen %s", str(runner["state"]), connected, stamp(runner["lastSeen"])),
		fmt.Sprintf("execution: unknown; findings: %s; freshness threshold 120s", firstNonEmpty(strings.Join(findings, ", "), "none")),
		str(result["limitation"]),
	}
	fmt.Fprintln(h.stdout, strings.Join(lines, "\n"))
}
