package main

import (
	"fmt"
	"os"
	"regexp"
	"strings"
)

const noteUsage = `cascade-note — note CRUD against a live Cascade instance

Usage:
  cascade-note wiki status|enable|disable  upkeep settings (enable: --channel ID --registration ID)
  cascade-note vault list                list vault IDs and names
  cascade-note vault delete <id> --confirm-name <name> --authority-message <id>
                                        delete an inactive vault under an owner mission
  cascade-note list                      vaults, or notes with --vault
  cascade-note search <query>            search notes in a vault
  cascade-note get|read <id|title>       print a note's content
  cascade-note create --title T [--listed] body via stdin (recommended) / --content-file / --content
  cascade-note edit <id|title>           replace body (stdin / --content-file / --content)
  cascade-note append <id|title>         append body  (stdin / --content-file / --content)
  cascade-note rename <id|title> --title T
  cascade-note move <id|title> --folder <id|name>  list and move a note into a folder
  cascade-note folder list                         list vault folders
  cascade-note folder create <name> [--parent <id|name>]
  cascade-note folder reorder <id|name> --position <n> [--parent <id|name>]
  cascade-note delete <id|title>         permanently delete a note
  cascade-note backlinks <id|title>      note + chat backlinks for a note
  cascade-note memory show               what agent memory would inject
  cascade-note memory list               list this agent's scratchpad notes
  cascade-note memory read <id|title>    read one scratchpad note
  cascade-note memory write --title T    create a scratchpad note (body via stdin)
  cascade-note memory update <id|title>  replace a scratchpad note
  cascade-note memory delete <id|title>  delete a scratchpad note
  cascade-note memory remember           alias for memory write
  cascade-note memory enable|disable     toggle agent memory for the vault

Body input (pick one):
  stdin             pipe it, e.g.  cascade-note create --title T <<'EOF' ... EOF
  --content-file P  read body from file P   (safe for any content)
  --content C       inline — AVOID for markdown: the shell eats backticks/quotes

Options:
  --vault <id>     vault id   (default $CASCADE_NOTE_VAULT, else sole vault)
  --title <t>      note title (create / rename / memory)
  --folder <id>    folder id or unique name (create / move)
  --parent <id>    parent folder id or unique name (folder create)
  --listed         put create in the sidebar tree (default is unlisted / chat-only)
  --unlisted       explicit unlisted (default for create; kept for compatibility)
  --scope notes|chat|all   search scope (default notes)
  --topic <text>   channel topic for memory show
  --memory         scope create to _agent/memory (agent memory folder)
  --allow-empty    permit an empty body (otherwise empty is rejected)
  --url <base>     API base   (default $CASCADE_NOTE_URL, else cscd.online)
  --token <jwt>    bearer token (default $CASCADE_NOTE_TOKEN)
  --json           machine-readable output; errors are JSON on stderr

Prefer stdin or --content-file; --content is unsafe for backticks/markdown.

Env: CASCADE_NOTE_URL, CASCADE_NOTE_TOKEN, CASCADE_NOTE_USER,
     CASCADE_NOTE_PASS, CASCADE_NOTE_VAULT, CASCADE_HELPER_CONFIG`

var (
	noteUUIDPrefix  = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-`)
	titleWordSplit  = regexp.MustCompile(`[\s\-_/\\.:,;+&]+`)
	folderUnsafe    = regexp.MustCompile(`[<>:"/\\|?*\x00-\x1f]+`)
	whitespaceRuns  = regexp.MustCompile(`\s+`)
	nonNegativeInts = regexp.MustCompile(`^\d+$`)
)

type noteCLI struct {
	*helper
	api *helperAPI
}

// resolveNote finds a note by id, else a unique exact, partial or fuzzy title.
func (n *noteCLI) resolveNote(vault, ref string) string {
	if noteUUIDPrefix.MatchString(ref) {
		return ref
	}
	// Filter server-side; older servers ignore the filters, so match locally too.
	q := "/api/vaults/" + vault + "/notes?"
	needle := strings.ToLower(ref)
	var exact []map[string]any
	for _, note := range objects(n.api.get(q + "title=" + encodeURIComponent(ref))["notes"]) {
		if strings.ToLower(str(note["title"])) == needle {
			exact = append(exact, note)
		}
	}
	if len(exact) == 1 {
		return str(exact[0]["id"])
	}
	if len(exact) > 1 {
		n.failf(`title "%s" is ambiguous (%d notes); pass the note id.`, ref, len(exact))
	}
	var partial []map[string]any
	for _, note := range objects(n.api.get(q + "title_contains=" + encodeURIComponent(ref))["notes"]) {
		if strings.Contains(strings.ToLower(str(note["title"])), needle) {
			partial = append(partial, note)
		}
	}
	if len(partial) == 1 {
		return str(partial[0]["id"])
	}
	if len(partial) > 1 {
		n.failf(`"%s" matches %d notes; pass the note id.`, ref, len(partial))
	}
	if len([]rune(needle)) >= 2 {
		var fuzzy []map[string]any
		for _, note := range objects(n.api.get("/api/vaults/" + vault + "/notes")["notes"]) {
			if fuzzyTitleMatch(str(note["title"]), needle) {
				fuzzy = append(fuzzy, note)
			}
		}
		if len(fuzzy) == 1 {
			return str(fuzzy[0]["id"])
		}
		if len(fuzzy) > 1 {
			var lines []string
			for _, note := range fuzzy {
				lines = append(lines, fmt.Sprintf("  %s  %s", str(note["id"]), str(note["title"])))
			}
			n.failf("\"%s\" matches multiple notes; pass the note id:\n%s", ref, strings.Join(lines, "\n"))
		}
	}
	n.failf(`no note matching "%s" in vault %s.`, ref, vault)
	return ""
}

// fuzzyTitleMatch accepts a title word that prefixes the needle (or vice versa)
// or differs from it by at most one character over the needle's length.
func fuzzyTitleMatch(title, needle string) bool {
	n := []rune(needle)
	for _, word := range titleWordSplit.Split(strings.ToLower(title), -1) {
		if strings.HasPrefix(word, needle) || strings.HasPrefix(needle, word) {
			return true
		}
		w := []rune(word)
		if len(w) >= len(n) && len(n) >= 3 {
			diff := 0
			for i := range n {
				if w[i] != n[i] {
					diff++
				}
			}
			if diff <= 1 {
				return true
			}
		}
	}
	return false
}

func (n *noteCLI) folders(vault string) []map[string]any {
	return objects(n.api.get("/api/vaults/" + vault + "/folders")["folders"])
}

func (n *noteCLI) resolveFolder(vault, ref string) map[string]any {
	folders := n.folders(vault)
	var byID, byName []map[string]any
	for _, folder := range folders {
		if str(folder["id"]) == ref {
			byID = append(byID, folder)
		}
		if strings.EqualFold(str(folder["name"]), ref) {
			byName = append(byName, folder)
		}
	}
	if len(byID) == 1 {
		return byID[0]
	}
	if len(byName) == 1 {
		return byName[0]
	}
	if len(byName) > 1 {
		n.failf(`folder "%s" is ambiguous (%d folders); pass the folder id.`, ref, len(byName))
	}
	n.failf(`no folder matching "%s" in vault %s.`, ref, vault)
	return nil
}

func sanitizeAgentFolderName(name string) string {
	s := strings.TrimSpace(leadingAt.ReplaceAllString(firstNonEmpty(name, "agent"), ""))
	s = whitespaceRuns.ReplaceAllString(folderUnsafe.ReplaceAllString(s, "-"), "-")
	if runes := []rune(s); len(runes) > 64 {
		s = string(runes[:64])
	}
	return firstNonEmpty(s, "agent")
}

func (n *noteCLI) memoryAgentKey() string {
	key := strings.TrimSpace(firstNonEmpty(n.args.str("agent"), n.configString("agentMemoryKey")))
	if key == "" {
		n.fail("memory commands need the current agent context, or --agent <handle>.")
	}
	return key
}

func (n *noteCLI) memoryNotes(vault string) []map[string]any {
	key := strings.ToLower(sanitizeAgentFolderName(n.memoryAgentKey()))
	folders := n.folders(vault)
	find := func(parent any, name string) map[string]any {
		for _, folder := range folders {
			if strings.ToLower(str(folder["name"])) != name {
				continue
			}
			if (parent == nil && (folder["parent_id"] == nil || folder["parent_id"] == "")) || (parent != nil && str(folder["parent_id"]) == str(parent)) {
				return folder
			}
		}
		return nil
	}
	root := find(nil, "_agent")
	if root == nil {
		return nil
	}
	agentRoot := find(root["id"], key)
	if agentRoot == nil {
		return nil
	}
	memory := find(agentRoot["id"], "memory")
	if memory == nil {
		return nil
	}
	return objects(n.api.get("/api/vaults/" + vault + "/notes?folder_id=" + encodeURIComponent(str(memory["id"])))["notes"])
}

func (n *noteCLI) resolveMemoryNote(vault, ref string) map[string]any {
	notes := n.memoryNotes(vault)
	lower := strings.ToLower(ref)
	var exact, partial []map[string]any
	for _, note := range notes {
		if str(note["id"]) == ref {
			return note
		}
		title := strings.ToLower(str(note["title"]))
		if title == lower {
			exact = append(exact, note)
		}
		if strings.Contains(title, lower) {
			partial = append(partial, note)
		}
	}
	if len(exact) == 1 {
		return exact[0]
	}
	if len(exact) > 1 {
		n.failf(`memory title "%s" is ambiguous; pass its id.`, ref)
	}
	if len(partial) == 1 {
		return partial[0]
	}
	if len(partial) > 1 {
		n.failf(`"%s" matches %d memories; pass an id.`, ref, len(partial))
	}
	n.failf(`no memory matching "%s" in this agent's scratchpad.`, ref)
	return nil
}

func (n *noteCLI) bodyContent() string {
	var content string
	switch {
	case n.args.has("content-file"):
		file, ok := n.args.value("content-file")
		if !ok {
			n.fail("--content-file needs a file path.")
		}
		data, err := os.ReadFile(file)
		if err != nil {
			n.failf(`cannot read --content-file "%s": %v`, file, err)
		}
		content = string(data)
	case n.args.has("content"):
		// A bare --content is a silent empty-body trap; reject it.
		v, ok := n.args.value("content")
		if !ok {
			n.fail("--content needs a value. For markdown/multiline bodies pipe via stdin or use --content-file (the shell corrupts backticks/quotes in --content).")
		}
		content = v
	default:
		content = n.readStdin()
	}
	if content == "" && !n.args.has("allow-empty") {
		n.fail("empty body. Pipe content via stdin (e.g. a heredoc), use --content-file <path>, or pass --content \"...\"; use --allow-empty to write an empty note on purpose.")
	}
	return content
}

func idTitleLines(items []map[string]any, empty string) string {
	var lines []string
	for _, item := range items {
		lines = append(lines, fmt.Sprintf("%s  %s", str(item["id"]), firstNonEmpty(str(item["title"]), str(item["name"]))))
	}
	if len(lines) == 0 {
		return empty
	}
	return strings.Join(lines, "\n")
}

func (n *noteCLI) expectedRevision(existing map[string]any, body map[string]any) map[string]any {
	if rev := existing["revision"]; rev != nil && rev != false && rev != "" && rev != float64(0) {
		body["expectedRevision"] = rev
	}
	return body
}

func runCascadeNote(h *helper) {
	cmd := h.args.positional(0)
	if cmd == "" && !h.args.flag("help") && h.args.flag("json") {
		h.fail("missing command. Run with --help.")
	}
	if cmd == "" || h.args.flag("help") {
		fmt.Fprintln(h.stdout, noteUsage)
		if cmd == "" {
			h.exit(1)
		}
		h.exit(0)
	}
	h.config = readHelperContext()
	base := h.baseURL(false)
	n := &noteCLI{helper: h, api: &helperAPI{h: h, base: base, token: h.token(base), arrow: "→"}}
	vault := func() string { return h.resolveVault(n.api, "— pass --vault <id> (or set CASCADE_NOTE_VAULT)") }

	switch cmd {
	case "vault":
		if h.args.positional(1) == "list" {
			vaults := objects(n.api.get("/api/vaults")["vaults"])
			h.print(idTitleLines(vaults, "(no vaults)"), vaults)
			return
		}
		id := h.args.positional(2)
		name, nameOK := h.args.value("confirm-name")
		source, sourceOK := h.args.value("authority-message")
		runID := strings.TrimSpace(os.Getenv("CASCADE_RUN_ID"))
		if h.args.positional(1) != "delete" || id == "" || !nameOK || !sourceOK || runID == "" {
			h.fail("use vault delete <full-id> --confirm-name <exact-name> --authority-message <owner-message-id> from an active mission run")
		}
		if id == firstNonEmpty(h.configString("vaultId"), os.Getenv("CASCADE_NOTE_VAULT")) {
			h.fail("cannot delete the current vault")
		}
		visible := false
		for _, v := range objects(n.api.get("/api/vaults")["vaults"]) {
			visible = visible || (str(v["id"]) == id && str(v["name"]) == name)
		}
		if !visible {
			h.fail("target ID and exact name do not match a visible vault")
		}
		result := n.api.call("DELETE", "/api/vaults/"+encodeURIComponent(id), map[string]any{"expectedName": name, "authorityMessageId": source},
			map[string]string{"x-cascade-run-id": runID})
		for _, v := range objects(n.api.get("/api/vaults")["vaults"]) {
			if str(v["id"]) == id {
				h.fail("deletion returned success but target is still present")
			}
		}
		result["id"], result["name"], result["verifiedAbsent"] = id, name, true
		h.print(fmt.Sprintf("Deleted vault %s (%s); verified absent.", name, id), result)
	case "wiki":
		v := vault()
		action := firstNonEmpty(h.args.positional(1), "status")
		endpoint := "/api/vaults/" + v + "/wiki-maintenance"
		var data map[string]any
		switch action {
		case "status":
			data = n.api.get(endpoint)
		case "disable":
			data = n.api.call("PUT", endpoint, map[string]any{"enabled": false}, nil)
		case "enable":
			channel := firstNonEmpty(h.args.str("channel"), h.configString("chatChannelId"), os.Getenv("CASCADE_CHAT_CHANNEL"))
			registration := firstNonEmpty(h.args.str("registration"), h.configString("chatRegistrationId"))
			if channel == "" || registration == "" {
				h.fail("wiki enable needs --channel ID --registration ID")
			}
			data = n.api.call("PUT", endpoint, map[string]any{"enabled": true, "channelId": channel, "registrationId": registration}, nil)
		default:
			h.fail("wiki needs status|enable|disable")
		}
		h.print(jsonString(data), data)
	case "list":
		if v := strings.TrimSpace(firstNonEmpty(h.args.str("vault"), h.configString("vaultId"), os.Getenv("CASCADE_NOTE_VAULT"))); v != "" {
			notes := objects(n.api.get("/api/vaults/" + v + "/notes")["notes"])
			h.print(idTitleLines(notes, "(no notes)"), notes)
		} else {
			vaults := objects(n.api.get("/api/vaults")["vaults"])
			h.print(idTitleLines(vaults, "(no vaults)"), vaults)
		}
	case "search":
		q := h.args.rest(1)
		if q == "" {
			h.fail("search needs a query.")
		}
		v := vault()
		scope := firstNonEmpty(strings.TrimSpace(h.args.str("scope")), "notes")
		results := objects(n.api.get(fmt.Sprintf("/api/vaults/%s/search?q=%s&scope=%s", v, encodeURIComponent(q), encodeURIComponent(scope)))["results"])
		var lines []string
		for _, r := range results {
			kind := ""
			if t := str(r["type"]); t != "" {
				kind = "[" + t + "] "
			}
			lines = append(lines, fmt.Sprintf("%s%s  %s\n    %s", kind, str(r["id"]), str(r["title"]), str(r["snippet"])))
		}
		h.print(firstNonEmpty(strings.Join(lines, "\n"), "(no matches)"), results)
	case "backlinks":
		ref := h.args.positional(1)
		if ref == "" {
			h.fail("backlinks needs a note id or title.")
		}
		id := n.resolveNote(vault(), ref)
		data := n.api.get("/api/notes/" + id + "/backlinks")
		noteLinks, chatLinks := objects(data["backlinks"]), objects(data["chatBacklinks"])
		lines := []string{fmt.Sprintf("Note backlinks (%d):", len(noteLinks))}
		for _, b := range noteLinks {
			context := ""
			if c := str(b["context"]); c != "" {
				context = " — " + c
			}
			lines = append(lines, fmt.Sprintf("  %s  %s%s", str(b["id"]), str(b["title"]), context))
		}
		lines = append(lines, fmt.Sprintf("Chat backlinks (%d):", len(chatLinks)))
		for _, b := range chatLinks {
			lines = append(lines, fmt.Sprintf("  %s  #%s  %s\n    %s", str(b["messageId"]), str(b["channelId"]), str(b["author"]), str(b["snippet"])))
		}
		h.print(strings.Join(lines, "\n"), data)
	case "memory":
		runNoteMemory(n, vault())
	case "get", "read", "show", "view", "cat":
		ref := h.args.positional(1)
		if ref == "" {
			h.failf("%s needs a note id or title.", cmd)
		}
		note := asObject(n.api.get("/api/notes/" + n.resolveNote(vault(), ref))["note"])
		h.print(str(note["content"]), note)
	case "create":
		if h.args.has("title") {
			if _, ok := h.args.value("title"); !ok {
				h.fail("--title needs a value.")
			}
		}
		title := strings.TrimSpace(h.args.str("title"))
		if title == "" {
			h.fail("create needs --title.")
		}
		v := vault()
		content := helperEscapedBackticks.ReplaceAllString(n.bodyContent(), "`")
		if h.args.flag("memory") {
			data := n.api.call("PUT", "/api/vaults/"+v+"/agent-memory", map[string]any{"remember": content, "title": title}, nil)
			note := asObject(data["note"])
			out := any(note)
			if note == nil {
				out = data
			}
			h.print(fmt.Sprintf("created memory %s  %s", str(note["id"]), str(note["title"])), out)
			return
		}
		// Agent default: unlisted. Sidebar listing is human-directed (--listed).
		payload := map[string]any{"title": title, "content": content, "is_listed": h.args.flag("listed")}
		if h.args.str("folder") != "" && h.args.str("folder") != "false" {
			payload["folder_id"] = n.resolveFolder(v, h.args.str("folder"))["id"]
		}
		note := asObject(n.api.call("POST", "/api/vaults/"+v+"/notes", payload, nil)["note"])
		where := "unlisted"
		if note["is_listed"] == true {
			where = "listed"
		}
		h.print(fmt.Sprintf("created %s  %s  (%s)", str(note["id"]), str(note["title"]), where), note)
	case "folder":
		runNoteFolder(n, vault())
	case "move":
		ref := h.args.positional(1)
		if ref == "" {
			h.fail("move needs a note id or title.")
		}
		folderRef, ok := h.args.value("folder")
		if !ok || strings.TrimSpace(folderRef) == "" {
			h.fail("move needs --folder <folder id or unique name>.")
		}
		v := vault()
		id := n.resolveNote(v, ref)
		folder := n.resolveFolder(v, folderRef)
		note := asObject(n.api.call("POST", "/api/notes/"+id+"/move", map[string]any{"folder_id": folder["id"]}, nil)["note"])
		h.print(fmt.Sprintf("moved %s  %s  → %s", str(note["id"]), str(note["title"]), str(folder["name"])), note)
	case "edit", "append":
		ref := h.args.positional(1)
		if ref == "" {
			h.failf("%s needs a note id or title.", cmd)
		}
		id := n.resolveNote(vault(), ref)
		existing := asObject(n.api.get("/api/notes/" + id)["note"])
		content := n.bodyContent()
		if cmd == "append" {
			previous := str(existing["content"])
			sep := "\n"
			if strings.HasSuffix(previous, "\n") {
				sep = ""
			}
			content = previous + sep + content
		}
		body := n.expectedRevision(existing, map[string]any{"content": helperEscapedBackticks.ReplaceAllString(content, "`")})
		note := asObject(n.api.call("PUT", "/api/notes/"+id, body, nil)["note"])
		verb := "updated"
		if cmd == "append" {
			verb = "appended to"
		}
		h.print(fmt.Sprintf("%s %s  %s", verb, str(note["id"]), str(note["title"])), note)
	case "rename":
		ref := h.args.positional(1)
		if ref == "" {
			h.fail("rename needs a note id or title.")
		}
		if h.args.has("title") {
			if _, ok := h.args.value("title"); !ok {
				h.fail("--title needs a value.")
			}
		}
		title := strings.TrimSpace(h.args.str("title"))
		if title == "" {
			h.fail("rename needs --title <new title>.")
		}
		id := n.resolveNote(vault(), ref)
		note := asObject(n.api.call("POST", "/api/notes/"+id+"/rename", map[string]any{"title": title}, nil)["note"])
		h.print(fmt.Sprintf("renamed %s  %s", str(note["id"]), str(note["title"])), note)
	case "delete":
		ref := h.args.positional(1)
		if ref == "" {
			h.fail("delete needs a note id or title.")
		}
		id := n.resolveNote(vault(), ref)
		note := asObject(n.api.get("/api/notes/" + id)["note"])
		data := n.api.call("DELETE", "/api/notes/"+id, nil, nil)
		data["note"] = note
		h.print(fmt.Sprintf("deleted %s  %s", str(note["id"]), str(note["title"])), data)
	default:
		h.failf(`unknown command "%s". Run with --help.`, cmd)
	}
}

func runNoteMemory(n *noteCLI, vault string) {
	h := n.helper
	sub := firstNonEmpty(h.args.positional(1), "show")
	endpoint := "/api/vaults/" + vault + "/agent-memory"
	switch sub {
	case "show":
		query := queryString("topic", strings.TrimSpace(h.args.str("topic")), "agent", strings.TrimSpace(firstNonEmpty(h.args.str("agent"), h.configString("agentMemoryKey"))))
		if query != "" {
			query = "?" + query
		}
		data := n.api.get(endpoint + query)
		injection := asObject(data["injection"])
		noteIDs, _ := injection["noteIds"].([]any)
		truncated := ""
		if injection["truncated"] == true {
			truncated = " (truncated)"
		}
		h.print(strings.Join([]string{"enabled: " + fmt.Sprint(firstNonNil(data["enabled"], "undefined")),
			fmt.Sprintf("notes: %d%s", len(noteIDs), truncated), firstNonEmpty(str(injection["text"]), "(empty injection)")}, "\n"), data)
	case "enable", "disable":
		data := n.api.call("PUT", endpoint, map[string]any{"enabled": sub == "enable"}, nil)
		h.print("agent memory "+sub+"d", data)
	case "list":
		notes := n.memoryNotes(vault)
		h.print(idTitleLines(notes, "(empty scratchpad)"), notes)
	case "read":
		ref := h.args.positional(2)
		if ref == "" {
			h.fail("memory read needs an id or title.")
		}
		selected := n.resolveMemoryNote(vault, ref)
		note := asObject(n.api.get("/api/notes/" + str(selected["id"]))["note"])
		h.print(str(note["content"]), note)
	case "remember", "write":
		body := n.bodyContent()
		title, ok := h.args.value("title")
		if !ok || title == "" {
			h.fail("memory write needs --title.")
		}
		data := n.api.call("PUT", endpoint, map[string]any{"remember": body, "title": title, "agent": n.memoryAgentKey(), "listed": true}, nil)
		note := asObject(data["note"])
		h.print(fmt.Sprintf("remembered %s  %s", str(note["id"]), str(note["title"])), data)
	case "update":
		ref := h.args.positional(2)
		if ref == "" {
			h.fail("memory update needs an id or title.")
		}
		selected := n.resolveMemoryNote(vault, ref)
		content := n.bodyContent()
		existing := asObject(n.api.get("/api/notes/" + str(selected["id"]))["note"])
		note := asObject(n.api.call("PUT", "/api/notes/"+str(selected["id"]), n.expectedRevision(existing, map[string]any{"content": content}), nil)["note"])
		h.print(fmt.Sprintf("updated %s  %s", str(note["id"]), str(note["title"])), note)
	case "delete":
		ref := h.args.positional(2)
		if ref == "" {
			h.fail("memory delete needs an id or title.")
		}
		selected := n.resolveMemoryNote(vault, ref)
		if strings.ToLower(str(selected["title"])) == "index" {
			h.fail("INDEX cannot be deleted; update it instead.")
		}
		data := n.api.call("DELETE", "/api/notes/"+str(selected["id"]), nil, nil)
		h.print(fmt.Sprintf("deleted %s  %s", str(selected["id"]), str(selected["title"])), data)
	default:
		h.failf(`unknown memory subcommand "%s". Use show|list|read|write|update|delete|enable|disable.`, sub)
	}
}

func runNoteFolder(n *noteCLI, vault string) {
	h := n.helper
	parent := func() map[string]any {
		if ref := h.args.str("parent"); ref != "" && ref != "false" {
			return n.resolveFolder(vault, ref)
		}
		return nil
	}
	switch sub := firstNonEmpty(h.args.positional(1), "list"); sub {
	case "list":
		folders := n.folders(vault)
		var lines []string
		for _, folder := range folders {
			line := fmt.Sprintf("%s  %s", str(folder["id"]), str(folder["name"]))
			if p := str(folder["parent_id"]); p != "" {
				line += "  parent: " + p
			}
			lines = append(lines, line)
		}
		h.print(firstNonEmpty(strings.Join(lines, "\n"), "(no folders)"), folders)
	case "create":
		name := strings.TrimSpace(h.args.rest(2))
		if name == "" {
			h.fail("folder create needs a folder name.")
		}
		payload := map[string]any{"name": name}
		if p := parent(); p != nil {
			payload["parent_id"] = p["id"]
		}
		folder := asObject(n.api.call("POST", "/api/vaults/"+vault+"/folders", payload, nil)["folder"])
		h.print(fmt.Sprintf("created folder %s  %s", str(folder["id"]), str(folder["name"])), folder)
	case "reorder":
		ref := strings.TrimSpace(h.args.rest(2))
		if ref == "" {
			h.fail("folder reorder needs a folder id or unique name.")
		}
		position := h.args.str("position")
		if !h.args.has("position") || !nonNegativeInts.MatchString(position) {
			h.fail("folder reorder needs --position <non-negative integer>.")
		}
		folder := n.resolveFolder(vault, ref)
		var pos float64
		fmt.Sscanf(position, "%g", &pos)
		payload := map[string]any{"position": pos}
		if p := parent(); p != nil {
			payload["parent_id"] = p["id"]
		}
		updated := asObject(n.api.call("PATCH", "/api/folders/"+str(folder["id"]), payload, nil)["folder"])
		h.print(fmt.Sprintf("reordered %s  %s  → position %s", str(updated["id"]), str(updated["name"]), str(updated["position"])), updated)
	default:
		h.failf(`unknown folder subcommand "%s". Use list|create|reorder.`, sub)
	}
}
