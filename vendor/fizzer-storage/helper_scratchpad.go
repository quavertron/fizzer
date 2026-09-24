package main

import (
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"
)

var scratchpadKinds = []string{"observation", "outcome", "dead-end", "decision", "todo", "papercut"}

const scratchpadUsage = `cascade-scratchpad - agent work journal, skills, open threads, and outcomes

Usage:
  cascade-scratchpad jot [text...]             append a journal entry (stdin / --text / --content ok)
  cascade-scratchpad papercut [text...]        log tool friction / bullshit (dead-end shaped; auto-used by runners)
  cascade-scratchpad journal                   list journal entries
  cascade-scratchpad done --through <id>       mark entries consolidated
  cascade-scratchpad status                    unconsolidated count + open threads + last consolidation
  cascade-scratchpad open [intent...]          list open threads, or open one (intent via args/--text)
  cascade-scratchpad close <id>                close an open thread (--reason optional)
  cascade-scratchpad skill write --title T     save an executable procedure (body via stdin;
                                               first line = when to use it, rest = the steps)
  cascade-scratchpad skill list                list your skills + shared skills (with win rates)
  cascade-scratchpad recall <query...>         mid-task: find matching notes/skills when stuck
  cascade-scratchpad outcome <note-title>      record result of applying a note/skill
                                               (--win | --loss | --neutral)
  cascade-scratchpad promote <note-title>      share a memory/skill note with all agents

Options:
  --kind <k>         observation | outcome | dead-end | decision | todo (jot; default observation)
  --text <t>         jot/open: inline body (alias of --content; positional args / stdin also ok)
  --blocked <t>      open: what is blocking (optional)
  --next <t>         open: next try (optional)
  --pointer <t>      open: pointer e.g. journal#31, path, command (optional)
  --reason <t>       close: why this thread is done/abandoned (optional)
  --closed           open list: include closed threads
  --agent <key>      agent key (default: this run's agent)
  --unconsolidated   journal: only entries not yet consolidated
  --since <id>       journal: entries with id > <id>
  --limit <n>        journal/open: max entries (default 100 / 50)
  --through <id>     done: consolidate entries up to and including <id>
  --title <t>        skill write: skill title
  --content <text>   skill write / jot / open: inline body (stdin is safer for multiline)
  --win|--loss|--neutral  outcome: how applying the note went
  --vault <id>       vault id (default $CASCADE_NOTE_VAULT)
  --url <base>       API base (default $CASCADE_NOTE_URL, else cscd.online)
  --token <jwt>      bearer token (default $CASCADE_NOTE_TOKEN)
  --json             machine-readable output; errors are JSON on stderr

Scratchpad is optional. Preserve reusable root causes, decisions, or dead ends;
skip routine progress. Open threads are private and agent-managed.
Read a skill before applying it: cascade-note get <title>

Env: CASCADE_NOTE_URL, CASCADE_NOTE_TOKEN, CASCADE_NOTE_USER,
     CASCADE_NOTE_PASS, CASCADE_NOTE_VAULT, CASCADE_RUN_ID, CASCADE_HELPER_CONFIG`

var papercutPrefix = regexp.MustCompile(`(?i)^papercut:`)
var leadingAt = regexp.MustCompile(`^@+`)

// inlineBody accepts --text or --content; a bare flag is an error, never the body "true".
func (h *helper) inlineBody(hint string) string {
	for _, key := range []string{"text", "content"} {
		if h.args.flag(key) {
			h.failf("--%s needs a value%s", key, hint)
		}
		if v, ok := h.args.value(key); ok && strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

func (h *helper) runIDField() (int, bool) {
	raw := firstNonEmpty(h.configString("runId"), os.Getenv("CASCADE_RUN_ID"))
	if id, err := strconv.Atoi(strings.TrimSpace(raw)); err == nil && id > 0 {
		return id, true
	}
	return 0, false
}

func pluralEntry(n float64) string {
	if n == 1 {
		return "y"
	}
	return "ies"
}

func skillRecord(stats map[string]any, requireUses bool) string {
	if stats == nil {
		return ""
	}
	wins, losses, uses := numberOf(stats["wins"]), numberOf(stats["losses"]), numberOf(stats["uses"])
	decided := wins + losses
	if requireUses {
		if uses <= 0 {
			return ""
		}
		if decided > 0 {
			return fmt.Sprintf(" (won %s/%s)", str(wins), str(decided))
		}
		return fmt.Sprintf(" (used %sx)", str(uses))
	}
	if decided > 0 {
		return fmt.Sprintf(" (won %s/%s)", str(wins), str(decided))
	}
	return ""
}

func runCascadeScratchpad(h *helper) {
	cmd := h.args.positional(0)
	if cmd == "" && !h.args.flag("help") && h.args.flag("json") {
		h.fail("missing command. Run with --help.")
	}
	if cmd == "" || h.args.flag("help") {
		fmt.Fprintln(h.stdout, scratchpadUsage)
		if cmd == "" {
			h.exit(1)
		}
		h.exit(0)
	}
	switch cmd {
	case "jot", "papercut", "journal", "done", "status", "skill", "outcome", "promote", "recall", "open", "close":
	default:
		h.failf(`unknown command "%s". Run with --help.`, cmd)
	}
	h.config = readHelperContext()
	base := h.baseURL(false)
	api := &helperAPI{h: h, base: base, token: h.token(base), arrow: "->"}
	vault := h.resolveVault(api, "- pass --vault <id>")
	agentKey := strings.TrimSpace(leadingAt.ReplaceAllString(firstNonEmpty(h.args.str("agent"), h.configString("agentMemoryKey"), h.configString("chatAuthor"), h.configString("agentId")), ""))
	prefix := "/api/vaults/" + vault + "/scratchpad"
	withQuery := func(path, query string) string {
		if query == "" {
			return path + "?"
		}
		return path + "?" + query
	}

	switch cmd {
	case "jot", "papercut":
		// Agents often guess --text; accept positional, --text, --content or stdin.
		flagBody := h.inlineBody(` (e.g. jot --kind dead-end --text "…").`)
		body := firstNonEmpty(strings.TrimSpace(h.args.rest(1)), flagBody)
		if body == "" {
			body = strings.TrimSpace(h.readStdin())
		}
		if body == "" {
			h.failf("%s needs text (positional args, --text/--content, or stdin).", cmd)
		}
		kind := firstNonEmpty(h.args.str("kind"), "observation")
		if cmd == "papercut" {
			kind = "papercut"
		}
		valid := false
		for _, k := range scratchpadKinds {
			valid = valid || k == kind
		}
		if !valid {
			h.failf("--kind must be one of: %s", strings.Join(scratchpadKinds, ", "))
		}
		if cmd == "papercut" && !papercutPrefix.MatchString(body) {
			body = "papercut: " + body
		}
		payload := map[string]any{"body": body, "kind": kind, "agentKey": agentKey}
		if id, ok := h.runIDField(); ok {
			payload["runId"] = id
		}
		entry := asObject(api.call("POST", prefix+"/journal", payload, nil)["entry"])
		h.print(fmt.Sprintf("jotted #%s [%s]", str(entry["id"]), str(entry["kind"])), entry)
	case "journal":
		query := queryString("agent", agentKey, "unconsolidated", map[bool]string{true: "1"}[h.args.has("unconsolidated")],
			"since", h.args.str("since"), "limit", h.args.str("limit"))
		entries := objects(api.get(withQuery(prefix+"/journal", query))["entries"])
		var lines []string
		for _, e := range entries {
			flag := "*"
			if str(e["consolidatedAt"]) != "" {
				flag = " "
			}
			agent := ""
			if key := str(e["agentKey"]); key != "" {
				agent = " @" + key
			}
			lines = append(lines, fmt.Sprintf("%s#%s [%s] %s%s\n    %s", flag, str(e["id"]), str(e["kind"]), str(e["createdAt"]), agent, strings.ReplaceAll(str(e["body"]), "\n", "\n    ")))
		}
		human := strings.Join(lines, "\n")
		if len(entries) == 0 {
			human = "(journal empty)"
		}
		h.print(human, entries)
	case "done":
		through, err := strconv.ParseFloat(h.args.str("through"), 64)
		if err != nil || through <= 0 {
			h.fail("done needs --through <entry id>.")
		}
		result := api.call("POST", prefix+"/consolidate", map[string]any{"throughId": through, "agentKey": agentKey}, nil)
		marked := numberOf(result["marked"])
		h.print(fmt.Sprintf("consolidated %s entr%s through #%s", str(marked), pluralEntry(marked), str(through)), result)
	case "skill":
		switch h.args.positional(1) {
		case "write":
			title := strings.TrimSpace(h.args.str("title"))
			if title == "" {
				h.fail("skill write needs --title.")
			}
			body, ok := h.args.value("content")
			if !ok {
				body = h.readStdin()
			}
			if body = strings.TrimSpace(body); body == "" {
				h.fail("skill write needs a body via stdin or --content (first line: when to use it).")
			}
			note := asObject(api.call("POST", prefix+"/skills", map[string]any{"title": title, "body": body, "agentKey": agentKey}, nil)["note"])
			h.print("skill saved: "+str(note["title"]), note)
		case "list":
			skills := objects(api.get(withQuery(prefix+"/skills", queryString("agent", agentKey)))["skills"])
			var lines []string
			for _, s := range skills {
				shared := ""
				if s["shared"] == true {
					shared = "[shared] "
				}
				lines = append(lines, fmt.Sprintf("%s%s%s\n    %s", shared, str(s["title"]), skillRecord(asObject(s["stats"]), true), str(s["description"])))
			}
			human := strings.Join(lines, "\n")
			if len(skills) == 0 {
				human = "(no skills yet)"
			}
			h.print(human, skills)
		default:
			h.fail("skill needs a subcommand: write | list.")
		}
	case "recall":
		query := strings.TrimSpace(h.args.rest(1))
		if query == "" {
			query = strings.TrimSpace(h.readStdin())
		}
		if query == "" {
			h.fail("recall needs a query (arguments or stdin).")
		}
		hits := objects(api.get(withQuery(prefix+"/recall", queryString("q", query, "agent", agentKey, "limit", h.args.str("limit"))))["hits"])
		var lines []string
		for _, hit := range hits {
			shared := ""
			if hit["shared"] == true {
				shared = " shared"
			}
			lines = append(lines, fmt.Sprintf("[%s%s] %s%s\n    %s", str(hit["kind"]), shared, str(hit["title"]), skillRecord(asObject(hit["stats"]), false), str(hit["snippet"])))
		}
		human := strings.Join(lines, "\n")
		if len(hits) == 0 {
			human = fmt.Sprintf(`(nothing recalled for "%s")`, query)
		}
		h.print(human, hits)
	case "outcome":
		ref := strings.TrimSpace(h.args.rest(1))
		if ref == "" {
			h.fail("outcome needs a note title or id.")
		}
		result := h.args.str("result")
		if result == "" {
			h.fail("outcome needs --win, --loss, or --neutral.")
		}
		outcome := asObject(api.call("POST", prefix+"/outcome", map[string]any{"noteRef": ref, "result": result, "agentKey": agentKey}, nil)["outcome"])
		h.print(fmt.Sprintf(`recorded %s for "%s" (now %s/%s wins)`, result, str(outcome["title"]), str(outcome["wins"]), str(outcome["uses"])), outcome)
	case "promote":
		ref := strings.TrimSpace(h.args.rest(1))
		if ref == "" {
			h.fail("promote needs a note title or id.")
		}
		result := api.call("POST", prefix+"/promote", map[string]any{"noteRef": ref, "agentKey": agentKey}, nil)
		kind := str(result["kind"])
		target := "memory"
		if kind == "skill" {
			target = "skills"
		}
		h.print(fmt.Sprintf(`promoted %s "%s" to shared agent %s`, kind, str(asObject(result["note"])["title"]), target), result)
	case "open":
		flagBody := h.inlineBody(".")
		intent := firstNonEmpty(strings.TrimSpace(h.args.rest(1)), flagBody)
		if intent == "" {
			query := queryString("agent", agentKey, "closed", map[bool]string{true: "1"}[h.args.has("closed")], "limit", h.args.str("limit"))
			threads := objects(api.get(withQuery(prefix+"/threads", query))["threads"])
			var lines []string
			for _, t := range threads {
				flag := "*"
				if str(t["closedAt"]) != "" {
					flag = " "
				}
				bits := []string{fmt.Sprintf("%s#%s %s", flag, str(t["id"]), str(t["intent"]))}
				for _, part := range [][2]string{{"blockedOn", "blocked: "}, {"nextTry", "next: "}, {"pointer", "ptr: "}} {
					if v := str(t[part[0]]); v != "" {
						bits = append(bits, part[1]+v)
					}
				}
				if closed := str(t["closedAt"]); closed != "" {
					reason := ""
					if r := str(t["closeReason"]); r != "" {
						reason = " (" + r + ")"
					}
					bits = append(bits, "closed "+closed+reason)
				}
				lines = append(lines, strings.Join(bits, " | "))
			}
			human := strings.Join(lines, "\n")
			if len(threads) == 0 {
				human = "(no open threads)"
			}
			h.print(human, threads)
			return
		}
		payload := map[string]any{"intent": intent, "agentKey": agentKey}
		for flag, key := range map[string]string{"blocked": "blockedOn", "next": "nextTry", "pointer": "pointer"} {
			v, _ := h.args.value(flag)
			payload[key] = v
		}
		if id, ok := h.runIDField(); ok {
			payload["runId"] = id
		}
		thread := asObject(api.call("POST", prefix+"/threads", payload, nil)["thread"])
		h.print(fmt.Sprintf("opened #%s: %s", str(thread["id"]), str(thread["intent"])), thread)
	case "close":
		id, err := strconv.ParseFloat(firstNonEmpty(h.args.positional(1), h.args.str("id")), 64)
		if err != nil || id <= 0 {
			h.fail(`close needs a thread id: close <id> [--reason "…"].`)
		}
		payload := map[string]any{"agentKey": agentKey}
		if reason, ok := h.args.value("reason"); ok {
			payload["reason"] = reason
		} else if text, ok := h.args.value("text"); ok {
			payload["reason"] = text
		}
		thread := asObject(api.call("POST", fmt.Sprintf("%s/threads/%s/close", prefix, str(id)), payload, nil)["thread"])
		reason := ""
		if r := str(thread["closeReason"]); r != "" {
			reason = " (" + r + ")"
		}
		h.print(fmt.Sprintf("closed #%s%s", str(thread["id"]), reason), thread)
	default: // status
		status := asObject(api.get(withQuery(prefix+"/status", queryString("agent", agentKey)))["status"])
		human := "unconsolidated: " + str(status["unconsolidated"])
		if status["openThreads"] != nil {
			human += "\nopen threads: " + str(status["openThreads"])
		}
		if v := str(status["oldestUnconsolidatedAt"]); v != "" {
			human += "\noldest: " + v
		}
		if v := str(status["lastConsolidationAt"]); v != "" {
			human += "\nlast consolidation: " + v
		}
		h.print(human, status)
	}
}
