package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type workspaceEntry struct {
	Path       string `json:"path"`
	RepoRoot   string `json:"repoRoot"`
	SourceRoot string `json:"sourceRoot,omitempty"`
	Repo       string `json:"repo"`
	Branch     string `json:"branch"`
	BaseBranch string `json:"baseBranch"`
	BaseCommit string `json:"baseCommit"`
	ChannelID  any    `json:"channelId"`
	WorkItemID any    `json:"workItemId"`
	CreatedAt  string `json:"createdAt"`
}

type gitResult struct {
	OK     bool   `json:"ok"`
	Code   int    `json:"code"`
	Stdout string `json:"stdout"`
	Stderr string `json:"stderr"`
}

func workspacesRoot() string {
	if dir := os.Getenv("CASCADE_WORKTREE_ROOT"); dir != "" {
		return dir
	}
	return filepath.Join(fizzerDir(), "worktrees")
}

func runCommand(file string, args []string, cwd string, timeout time.Duration) gitResult {
	cmd := exec.Command(file, args...)
	cmd.Dir = cwd
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	code := 0
	ok := err == nil
	if err != nil {
		code = 1
		if ee, ok := err.(*exec.ExitError); ok {
			code = ee.ExitCode()
		}
	}
	out := strings.TrimRight(stdout.String(), "\n")
	errOut := strings.TrimSpace(stderr.String())
	if errOut == "" && err != nil {
		errOut = err.Error()
	}
	return gitResult{OK: ok, Code: code, Stdout: out, Stderr: errOut}
}

func gitRun(args []string, cwd string) gitResult {
	return runCommand("git", args, cwd, 20*time.Second)
}

func normalizeSlug(input string) string {
	s := strings.ToLower(strings.TrimSpace(input))
	var b strings.Builder
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		} else {
			b.WriteRune('-')
		}
	}
	slug := b.String()
	slug = strings.Trim(slug, "-")
	if len(slug) > 48 {
		slug = slug[:48]
		slug = strings.TrimRight(slug, "-")
	}
	if slug == "" {
		return ""
	}
	if slug[0] < 'a' || slug[0] > 'z' {
		return ""
	}
	return slug
}

func readWorkspaceRegistry() []workspaceEntry {
	data, err := os.ReadFile(filepath.Join(workspacesRoot(), "workspaces.json"))
	if err != nil {
		return nil
	}
	var entries []workspaceEntry
	if err := json.Unmarshal(data, &entries); err != nil {
		return nil
	}
	return entries
}

func writeWorkspaceRegistry(entries []workspaceEntry) error {
	root := workspacesRoot()
	if err := os.MkdirAll(root, 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(entries, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(root, "workspaces.json"), append(data, '\n'), 0o644)
}

func rememberWorkspace(entry workspaceEntry) error {
	entries := readWorkspaceRegistry()
	out := make([]workspaceEntry, 0, len(entries)+1)
	for _, e := range entries {
		if !samePath(e.Path, entry.Path) {
			out = append(out, e)
		}
	}
	out = append(out, entry)
	return writeWorkspaceRegistry(out)
}

func forgetWorkspace(target string) error {
	entries := readWorkspaceRegistry()
	out := make([]workspaceEntry, 0, len(entries))
	for _, e := range entries {
		if !samePath(e.Path, target) {
			out = append(out, e)
		}
	}
	return writeWorkspaceRegistry(out)
}

func expandHomePath(dir string) string {
	value := strings.TrimSpace(dir)
	if value == "" {
		return ""
	}
	if value == "~" {
		home, _ := os.UserHomeDir()
		return home
	}
	if strings.HasPrefix(value, "~/") {
		home, _ := os.UserHomeDir()
		return filepath.Join(home, value[2:])
	}
	abs, err := filepath.Abs(value)
	if err != nil {
		return value
	}
	return abs
}

type resolvedRepo struct {
	IsRepo      bool   `json:"isRepo"`
	Error       string `json:"error,omitempty"`
	Root        string `json:"root"`
	Name        string `json:"name"`
	Branch      string `json:"branch"`
	Head        string `json:"head"`
	PrimaryRoot string `json:"primaryRoot"`
	IsPrimary   bool   `json:"isPrimary"`
}

func resolveRepo(dir string) resolvedRepo {
	expanded := expandHomePath(dir)
	if expanded == "" {
		return resolvedRepo{Error: "Directory does not exist"}
	}
	if _, err := os.Stat(expanded); err != nil {
		return resolvedRepo{Error: "Directory does not exist"}
	}
	top := gitRun([]string{"rev-parse", "--show-toplevel"}, expanded)
	if !top.OK {
		return resolvedRepo{Error: "Not a git repository"}
	}
	root := top.Stdout
	branch := gitRun([]string{"rev-parse", "--abbrev-ref", "HEAD"}, root)
	head := gitRun([]string{"rev-parse", "HEAD"}, root)
	common := gitRun([]string{"rev-parse", "--path-format=absolute", "--git-common-dir"}, root)
	primaryRoot := root
	if common.OK && common.Stdout != "" {
		primaryRoot = filepath.Dir(common.Stdout)
	}
	return resolvedRepo{
		IsRepo:      true,
		Root:        root,
		Name:        filepath.Base(primaryRoot),
		Branch:      branch.Stdout,
		Head:        head.Stdout,
		PrimaryRoot: primaryRoot,
		IsPrimary:   samePath(primaryRoot, root),
	}
}

func realPath(p string) string {
	abs, err := filepath.Abs(p)
	if err != nil {
		return p
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return abs
	}
	return resolved
}

func pathExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func samePath(a, b string) bool {
	return realPath(a) == realPath(b)
}

func defaultBaseBranch(root string) string {
	remote := gitRun([]string{"symbolic-ref", "--short", "refs/remotes/origin/HEAD"}, root)
	if remote.OK && remote.Stdout != "" {
		return strings.TrimPrefix(remote.Stdout, "origin/")
	}
	for _, candidate := range []string{"main", "master"} {
		if gitRun([]string{"rev-parse", "--verify", "--quiet", candidate}, root).OK {
			return candidate
		}
	}
	current := gitRun([]string{"rev-parse", "--abbrev-ref", "HEAD"}, root)
	if current.OK && current.Stdout != "" {
		return current.Stdout
	}
	return "HEAD"
}

type workspaceStatus struct {
	OK           bool                `json:"ok"`
	Error        string              `json:"error,omitempty"`
	Path         string              `json:"path"`
	Repo         string              `json:"repo"`
	Branch       string              `json:"branch"`
	Head         string              `json:"head"`
	IsPrimary    bool                `json:"isPrimary"`
	BaseBranch   string              `json:"baseBranch"`
	BaseCommit   string              `json:"baseCommit"`
	Dirty        bool                `json:"dirty"`
	ChangedFiles []map[string]string `json:"changedFiles"`
	Commits      []map[string]string `json:"commits"`
	Unpushed     int                 `json:"unpushed"`
	BehindBase   int                 `json:"behindBase"`
	HasUpstream  bool                `json:"hasUpstream"`
}

func workspaceStatusFor(dir string) workspaceStatus {
	repo := resolveRepo(dir)
	if !repo.IsRepo {
		return workspaceStatus{OK: false, Error: firstNonEmpty(repo.Error, "Not a git repository")}
	}
	registry := readWorkspaceRegistry()
	var entry *workspaceEntry
	for i := range registry {
		if samePath(registry[i].Path, repo.Root) {
			entry = &registry[i]
			break
		}
	}
	baseRef := ""
	baseCommit := ""
	if entry != nil {
		baseRef = entry.BaseBranch
		baseCommit = entry.BaseCommit
	}
	if baseRef == "" {
		baseRef = defaultBaseBranch(repo.Root)
	}

	rangeArg := baseCommit
	if rangeArg == "" {
		rangeArg = baseRef
	}
	statusOut := gitRun([]string{"status", "--porcelain"}, repo.Root)
	upstream := gitRun([]string{"rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"}, repo.Root)
	logOut := gitRun([]string{"log", "--oneline", "--no-decorate", "-n", "25", rangeArg + "...HEAD"}, repo.Root)
	baseDiff := gitRun([]string{"diff", "--name-status", rangeArg + "...HEAD"}, repo.Root)

	workingFiles := []map[string]string{}
	if statusOut.OK && statusOut.Stdout != "" {
		for _, line := range strings.Split(statusOut.Stdout, "\n") {
			if strings.TrimSpace(line) == "" {
				continue
			}
			if len(line) < 4 {
				continue
			}
			workingFiles = append(workingFiles, map[string]string{
				"status": strings.TrimSpace(line[:2]),
				"path":   line[3:],
			})
		}
	}
	baseFiles := []map[string]string{}
	if baseDiff.OK && baseDiff.Stdout != "" {
		for _, line := range strings.Split(baseDiff.Stdout, "\n") {
			if strings.TrimSpace(line) == "" {
				continue
			}
			parts := strings.Split(line, "\t")
			if len(parts) < 2 {
				continue
			}
			baseFiles = append(baseFiles, map[string]string{
				"status": parts[0],
				"path":   parts[len(parts)-1],
			})
		}
	}
	changedOrder := []string{}
	changedMap := map[string]map[string]string{}
	for _, f := range append(append([]map[string]string{}, workingFiles...), baseFiles...) {
		p := f["path"]
		if p == "" {
			continue
		}
		if _, seen := changedMap[p]; !seen {
			changedOrder = append(changedOrder, p)
		}
		changedMap[p] = f
	}
	changed := make([]map[string]string, 0, len(changedOrder))
	for _, p := range changedOrder {
		changed = append(changed, changedMap[p])
	}

	commits := []map[string]string{}
	if logOut.OK && logOut.Stdout != "" {
		for _, line := range strings.Split(logOut.Stdout, "\n") {
			if strings.TrimSpace(line) == "" {
				continue
			}
			fields := strings.Fields(line)
			if len(fields) == 0 {
				continue
			}
			subject := ""
			if len(fields) > 1 {
				subject = strings.Join(fields[1:], " ")
			}
			commits = append(commits, map[string]string{"sha": fields[0], "subject": subject})
		}
	}

	unpushed := len(commits)
	hasUpstream := upstream.OK && upstream.Stdout != ""
	if hasUpstream {
		counts := gitRun([]string{"rev-list", "--left-right", "--count", upstream.Stdout + "...HEAD"}, repo.Root)
		if counts.OK {
			fields := strings.Fields(counts.Stdout)
			if len(fields) >= 2 {
				unpushed, _ = strconv.Atoi(fields[1])
			}
		}
	}
	behindBase := 0
	if baseRef != "" {
		counts := gitRun([]string{"rev-list", "--left-right", "--count", baseRef + "...HEAD"}, repo.Root)
		if counts.OK {
			fields := strings.Fields(counts.Stdout)
			if len(fields) >= 1 {
				behindBase, _ = strconv.Atoi(fields[0])
			}
		}
	}

	return workspaceStatus{
		OK:           true,
		Path:         repo.Root,
		Repo:         repo.Name,
		Branch:       repo.Branch,
		Head:         repo.Head,
		IsPrimary:    repo.IsPrimary,
		BaseBranch:   baseRef,
		BaseCommit:   baseCommit,
		Dirty:        len(workingFiles) > 0,
		ChangedFiles: changed,
		Commits:      commits,
		Unpushed:     unpushed,
		BehindBase:   behindBase,
		HasUpstream:  hasUpstream,
	}
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

type prepareResult struct {
	OK         bool   `json:"ok"`
	Error      string `json:"error,omitempty"`
	Resumed    bool   `json:"resumed,omitempty"`
	Rebased    bool   `json:"rebased"`
	Path       string `json:"path,omitempty"`
	Repository string `json:"repository,omitempty"`
	Repo       string `json:"repo,omitempty"`
	Branch     string `json:"branch,omitempty"`
	BaseBranch string `json:"baseBranch,omitempty"`
	BaseCommit string `json:"baseCommit,omitempty"`
}

func createWorkspace(opts map[string]any) prepareResult {
	dir, _ := opts["dir"].(string)
	repo := resolveRepo(dir)
	if !repo.IsRepo {
		return prepareResult{OK: false, Error: firstNonEmpty(repo.Error, "Not a git repository")}
	}
	name := normalizeSlug(str(opts["slug"]))
	if name == "" {
		return prepareResult{OK: false, Error: "Workspace name must contain letters or numbers"}
	}
	branch := str(opts["branch"])
	if branch == "" {
		branch = "cascade/" + name
	}
	if !strings.HasPrefix(branch, "cascade/") {
		return prepareResult{OK: false, Error: "Managed branches must start with cascade/"}
	}
	if !gitRun([]string{"check-ref-format", "--branch", branch}, repo.PrimaryRoot).OK {
		return prepareResult{OK: false, Error: "Invalid managed branch"}
	}
	target := realPath(filepath.Join(workspacesRoot(), repo.Name, name))
	if gitRun([]string{"rev-parse", "--verify", "--quiet", "refs/heads/" + branch}, repo.PrimaryRoot).OK {
		return prepareResult{OK: false, Error: "Branch " + branch + " already exists"}
	}
	if pathExists(target) {
		return prepareResult{OK: false, Error: "Workspace directory already exists: " + target}
	}
	base := str(opts["baseBranch"])
	if base == "" {
		base = defaultBaseBranch(repo.PrimaryRoot)
	}
	start := gitRun([]string{"rev-parse", "HEAD"}, repo.Root)
	if !start.OK || start.Stdout == "" {
		return prepareResult{OK: false, Error: "Could not resolve current HEAD"}
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return prepareResult{OK: false, Error: err.Error()}
	}
	created := gitRun([]string{"worktree", "add", "-b", branch, target, start.Stdout}, repo.PrimaryRoot)
	if !created.OK {
		return prepareResult{OK: false, Error: firstNonEmpty(created.Stderr, "git worktree add failed")}
	}
	_ = rememberWorkspace(workspaceEntry{
		Path:       target,
		RepoRoot:   repo.PrimaryRoot,
		SourceRoot: repo.Root,
		Repo:       repo.Name,
		Branch:     branch,
		BaseBranch: base,
		BaseCommit: start.Stdout,
		ChannelID:  opts["channelId"],
		WorkItemID: opts["workItemId"],
		CreatedAt:  time.Now().UTC().Format(time.RFC3339),
	})
	return prepareResult{
		OK:         true,
		Path:       target,
		Repository: repo.PrimaryRoot,
		Repo:       repo.Name,
		Branch:     branch,
		BaseBranch: base,
		BaseCommit: start.Stdout,
	}
}

func rebaseUnusedWorkspace(entry workspaceEntry, status workspaceStatus) prepareResult {
	unused := !status.Dirty && len(status.Commits) == 0 &&
		(status.Head == "" || status.Head == entry.BaseCommit)
	if !unused {
		return prepareResult{OK: true, Rebased: false, BaseCommit: entry.BaseCommit}
	}
	source := entry.SourceRoot
	if source == "" {
		source = entry.RepoRoot
	}
	repo := resolveRepo(source)
	if !repo.IsRepo {
		return prepareResult{OK: false, Error: firstNonEmpty(repo.Error, "Source workspace is not a git repository")}
	}
	if !samePath(repo.PrimaryRoot, entry.RepoRoot) {
		return prepareResult{OK: false, Error: "Source workspace belongs to another repository"}
	}
	start := gitRun([]string{"rev-parse", "HEAD"}, repo.Root)
	if !start.OK || start.Stdout == "" {
		return prepareResult{OK: false, Error: "Could not resolve current HEAD"}
	}
	if start.Stdout == entry.BaseCommit {
		return prepareResult{OK: true, Rebased: false, BaseCommit: entry.BaseCommit}
	}
	reset := gitRun([]string{"reset", "--hard", start.Stdout}, entry.Path)
	if !reset.OK {
		return prepareResult{OK: false, Error: firstNonEmpty(reset.Stderr, "Could not move unused workspace onto current HEAD")}
	}
	entry.BaseCommit = start.Stdout
	_ = rememberWorkspace(entry)
	return prepareResult{OK: true, Rebased: true, BaseCommit: start.Stdout}
}

func PrepareWorkspace(opts map[string]any) prepareResult {
	itemID := strings.TrimSpace(str(opts["workItemId"]))
	expectedBranch := strings.TrimSpace(str(opts["branch"]))
	if itemID == "" {
		return prepareResult{OK: false, Error: "Work item id is required"}
	}
	if !strings.HasPrefix(expectedBranch, "cascade/") {
		return prepareResult{OK: false, Error: "Managed task branches must start with cascade/"}
	}

	var owned []workspaceEntry
	for _, entry := range readWorkspaceRegistry() {
		if str(entry.WorkItemID) == itemID {
			owned = append(owned, entry)
		}
	}
	if len(owned) > 1 {
		return prepareResult{OK: false, Error: "Work item owns multiple local workspaces"}
	}
	if len(owned) == 1 {
		entry := owned[0]
		if !pathExists(entry.Path) {
			return prepareResult{OK: false, Error: "Owned workspace is missing: " + entry.Path}
		}
		status := workspaceStatusFor(entry.Path)
		if !status.OK {
			return prepareResult{OK: false, Error: status.Error}
		}
		if status.Branch != expectedBranch || entry.Branch != expectedBranch {
			return prepareResult{OK: false, Error: "Owned workspace branch does not match the work item"}
		}
		ownedRepo := resolveRepo(entry.Path)
		if !samePath(ownedRepo.PrimaryRoot, entry.RepoRoot) || !samePath(status.Path, entry.Path) {
			return prepareResult{OK: false, Error: "Owned workspace belongs to another repository or path"}
		}
		moved := rebaseUnusedWorkspace(entry, status)
		if !moved.OK {
			return moved
		}
		return prepareResult{
			OK:         true,
			Resumed:    true,
			Rebased:    moved.Rebased,
			Path:       status.Path,
			Repository: entry.RepoRoot,
			Repo:       entry.Repo,
			Branch:     status.Branch,
			BaseBranch: entry.BaseBranch,
			BaseCommit: moved.BaseCommit,
		}
	}

	branchCheckDir := expandHomePath(str(opts["dir"]))
	branchCheck := gitResult{}
	if branchCheckDir != "" {
		if _, err := os.Stat(branchCheckDir); err == nil {
			branchCheck = gitRun([]string{"check-ref-format", "--branch", expectedBranch}, branchCheckDir)
		}
	}
	if !branchCheck.OK {
		return prepareResult{OK: false, Error: "Invalid managed task branch"}
	}

	repo := resolveRepo(str(opts["dir"]))
	if !repo.IsRepo {
		return prepareResult{OK: false, Error: firstNonEmpty(repo.Error, "Not a git repository")}
	}
	for _, entry := range readWorkspaceRegistry() {
		if samePath(entry.RepoRoot, repo.PrimaryRoot) && entry.Branch == expectedBranch {
			return prepareResult{OK: false, Error: "Task branch is already owned by another workspace"}
		}
	}
	name := normalizeSlug(strings.TrimPrefix(expectedBranch, "cascade/"))
	if name == "" {
		return prepareResult{OK: false, Error: "Managed task branch has no usable workspace name"}
	}
	return createWorkspace(map[string]any{
		"dir":        repo.Root,
		"slug":       name,
		"branch":     expectedBranch,
		"baseBranch": opts["baseBranch"],
		"channelId":  opts["channelId"],
		"workItemId": itemID,
	})
}

func str(v any) string {
	if v == nil {
		return ""
	}
	switch t := v.(type) {
	case string:
		return t
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case json.Number:
		return t.String()
	default:
		return fmt.Sprint(t)
	}
}

type workspaceListItem struct {
	Path       string `json:"path"`
	Branch     string `json:"branch"`
	IsPrimary  bool   `json:"isPrimary"`
	Managed    bool   `json:"managed"`
	ChannelID  any    `json:"channelId"`
	WorkItemID any    `json:"workItemId"`
	BaseBranch any    `json:"baseBranch"`
	CreatedAt  any    `json:"createdAt"`
	Exists     bool   `json:"exists"`
}

type listWorkspacesResult struct {
	OK          bool                `json:"ok"`
	Error       string              `json:"error,omitempty"`
	Repo        string              `json:"repo,omitempty"`
	PrimaryRoot string              `json:"primaryRoot,omitempty"`
	Workspaces  []workspaceListItem `json:"workspaces,omitempty"`
}

func anyOrNil(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func listWorkspaces(dir string) listWorkspacesResult {
	repo := resolveRepo(dir)
	if !repo.IsRepo {
		return listWorkspacesResult{OK: false, Error: firstNonEmpty(repo.Error, "Not a git repository")}
	}
	listed := gitRun([]string{"worktree", "list", "--porcelain"}, repo.PrimaryRoot)
	if !listed.OK {
		return listWorkspacesResult{OK: false, Error: firstNonEmpty(listed.Stderr, "git worktree list failed")}
	}
	registryByPath := map[string]workspaceEntry{}
	for _, entry := range readWorkspaceRegistry() {
		key := realPath(entry.Path)
		if _, ok := registryByPath[key]; !ok {
			registryByPath[key] = entry
		}
	}
	primaryRoot := realPath(repo.PrimaryRoot)
	var workspaces []workspaceListItem
	for _, block := range strings.Split(listed.Stdout, "\n\n") {
		var wtPath, branchLine string
		for _, line := range strings.Split(block, "\n") {
			if strings.HasPrefix(line, "worktree ") {
				wtPath = strings.TrimSpace(strings.TrimPrefix(line, "worktree "))
			}
			if strings.HasPrefix(line, "branch ") {
				branchLine = line
			}
		}
		if wtPath == "" {
			continue
		}
		resolvedPath := realPath(wtPath)
		entry, managed := registryByPath[resolvedPath]
		branch := "(detached)"
		if branchLine != "" {
			branch = strings.TrimSpace(strings.TrimPrefix(branchLine, "branch refs/heads/"))
		}
		workspaces = append(workspaces, workspaceListItem{
			Path:       wtPath,
			Branch:     branch,
			IsPrimary:  resolvedPath == primaryRoot,
			Managed:    managed,
			ChannelID:  entry.ChannelID,
			WorkItemID: entry.WorkItemID,
			BaseBranch: anyOrNil(entry.BaseBranch),
			CreatedAt:  anyOrNil(entry.CreatedAt),
			Exists:     pathExists(wtPath),
		})
	}
	if workspaces == nil {
		workspaces = []workspaceListItem{}
	}
	return listWorkspacesResult{
		OK:          true,
		Repo:        repo.Name,
		PrimaryRoot: repo.PrimaryRoot,
		Workspaces:  workspaces,
	}
}

type workspaceDiffResult struct {
	OK         bool                `json:"ok"`
	Error      string              `json:"error,omitempty"`
	Path       string              `json:"path,omitempty"`
	Repo       string              `json:"repo,omitempty"`
	Branch     string              `json:"branch,omitempty"`
	Head       string              `json:"head,omitempty"`
	BaseBranch string              `json:"baseBranch,omitempty"`
	BaseCommit string              `json:"baseCommit,omitempty"`
	Dirty      bool                `json:"dirty,omitempty"`
	Files      []map[string]string `json:"files,omitempty"`
	Summary    string              `json:"summary,omitempty"`
}

func workspaceDiff(dir string) workspaceDiffResult {
	status := workspaceStatusFor(dir)
	if !status.OK {
		return workspaceDiffResult{OK: false, Error: status.Error}
	}
	if status.BaseCommit == "" {
		return workspaceDiffResult{OK: false, Error: "Workspace has no recorded base commit"}
	}
	shortStat := gitRun([]string{"diff", "--shortstat", "--no-ext-diff", status.BaseCommit, "--"}, status.Path)
	untracked := 0
	for _, file := range status.ChangedFiles {
		if file["status"] == "??" {
			untracked++
		}
	}
	parts := []string{}
	if shortStat.OK && shortStat.Stdout != "" {
		parts = append(parts, shortStat.Stdout)
	}
	if untracked > 0 {
		label := "untracked files"
		if untracked == 1 {
			label = "untracked file"
		}
		parts = append(parts, strconv.Itoa(untracked)+" "+label)
	}
	return workspaceDiffResult{
		OK:         true,
		Path:       status.Path,
		Repo:       status.Repo,
		Branch:     status.Branch,
		Head:       status.Head,
		BaseBranch: status.BaseBranch,
		BaseCommit: status.BaseCommit,
		Dirty:      status.Dirty,
		Files:      status.ChangedFiles,
		Summary:    strings.Join(parts, " · "),
	}
}

type fileDiffResult struct {
	OK        bool   `json:"ok"`
	Error     string `json:"error,omitempty"`
	Path      string `json:"path,omitempty"`
	Status    string `json:"status,omitempty"`
	Kind      string `json:"kind,omitempty"`
	Text      string `json:"text,omitempty"`
	Truncated bool   `json:"truncated,omitempty"`
}

func clipReviewText(value string) (string, bool) {
	data := []byte(value)
	if len(data) <= maxReviewTextBytes {
		return string(data), false
	}
	return string(data[:maxReviewTextBytes]) + "\n\n[Diff truncated by Cascade]", true
}

func workspaceFileDiff(opts map[string]any) fileDiffResult {
	dir := str(opts["dir"])
	relative := strings.TrimSpace(str(opts["file"]))
	if relative == "" || filepath.IsAbs(relative) || strings.Contains(relative, "\x00") {
		return fileDiffResult{OK: false, Error: "A repository-relative changed file is required"}
	}
	normalized := filepath.Clean(relative)
	if normalized == ".." || strings.HasPrefix(normalized, ".."+string(filepath.Separator)) {
		return fileDiffResult{OK: false, Error: "File must stay inside the workspace"}
	}
	evidence := workspaceDiff(dir)
	if !evidence.OK {
		return fileDiffResult{OK: false, Error: evidence.Error}
	}
	var changedStatus string
	found := false
	for _, item := range evidence.Files {
		if item["path"] == relative {
			changedStatus = item["status"]
			found = true
			break
		}
	}
	if !found {
		return fileDiffResult{OK: false, Error: "File is not changed relative to this workspace base"}
	}
	if changedStatus == "??" {
		absolute := filepath.Join(evidence.Path, normalized)
		rootPrefix := evidence.Path + string(filepath.Separator)
		if !strings.HasPrefix(absolute, rootPrefix) {
			return fileDiffResult{OK: false, Error: "File must stay inside the workspace"}
		}
		info, err := os.Lstat(absolute)
		if err != nil {
			return fileDiffResult{OK: false, Error: "Changed file no longer exists"}
		}
		if !info.Mode().IsRegular() {
			return fileDiffResult{OK: true, Path: relative, Status: changedStatus, Kind: "binary"}
		}
		toRead := info.Size()
		if toRead > int64(maxReviewTextBytes)+1 {
			toRead = int64(maxReviewTextBytes) + 1
		}
		content := make([]byte, toRead)
		fd, err := os.Open(absolute)
		if err != nil {
			return fileDiffResult{OK: false, Error: "Changed file no longer exists"}
		}
		_, err = fd.Read(content)
		fd.Close()
		if err != nil && err != io.EOF {
			return fileDiffResult{OK: false, Error: "Changed file no longer exists"}
		}
		checkLen := len(content)
		if checkLen > 8000 {
			checkLen = 8000
		}
		if bytes.IndexByte(content[:checkLen], 0) >= 0 {
			return fileDiffResult{OK: true, Path: relative, Status: changedStatus, Kind: "binary"}
		}
		clipped, truncated := clipReviewText(string(content))
		return fileDiffResult{OK: true, Path: relative, Status: changedStatus, Kind: "text", Text: clipped, Truncated: truncated}
	}
	diff := gitRun([]string{
		"diff", "--no-color", "--no-ext-diff", "--find-renames", "--unified=4",
		evidence.BaseCommit, "--", relative,
	}, evidence.Path)
	if !diff.OK {
		return fileDiffResult{OK: false, Error: firstNonEmpty(diff.Stderr, "Could not read file diff")}
	}
	clipped, truncated := clipReviewText(diff.Stdout)
	return fileDiffResult{OK: true, Path: relative, Status: changedStatus, Kind: "patch", Text: clipped, Truncated: truncated}
}

type removeResult struct {
	OK         bool   `json:"ok"`
	Error      string `json:"error,omitempty"`
	NeedsForce bool   `json:"needsForce,omitempty"`
	Path       string `json:"path,omitempty"`
	Branch     string `json:"branch,omitempty"`
}

func removeWorkspace(opts map[string]any) removeResult {
	dir := str(opts["dir"])
	force := truthy(opts["force"])
	status := workspaceStatusFor(dir)
	if !status.OK {
		return removeResult{OK: false, Error: status.Error}
	}
	if status.IsPrimary {
		return removeResult{OK: false, Error: "Refusing to remove the repository’s primary checkout"}
	}
	if !force && status.Dirty {
		return removeResult{
			OK:         false,
			Error:      strconv.Itoa(len(status.ChangedFiles)) + " uncommitted change(s) — commit them or remove with force",
			NeedsForce: true,
		}
	}
	if !force && status.Unpushed > 0 {
		return removeResult{
			OK:         false,
			Error:      strconv.Itoa(status.Unpushed) + " commit(s) exist only here — push them or remove with force",
			NeedsForce: true,
		}
	}
	repo := resolveRepo(dir)
	args := []string{"worktree", "remove", status.Path}
	if force {
		args = append(args, "--force")
	}
	removed := gitRun(args, repo.PrimaryRoot)
	if !removed.OK {
		return removeResult{OK: false, Error: firstNonEmpty(removed.Stderr, "git worktree remove failed")}
	}
	_ = forgetWorkspace(status.Path)
	return removeResult{OK: true, Path: status.Path, Branch: status.Branch}
}

type pruneKept struct {
	Path   string `json:"path"`
	Reason string `json:"reason"`
}

type pruneRemoved struct {
	Path   string `json:"path"`
	Branch string `json:"branch"`
}

type pruneResult struct {
	OK        bool           `json:"ok"`
	Removed   []pruneRemoved `json:"removed"`
	Kept      []pruneKept    `json:"kept"`
	Forgotten []string       `json:"forgotten"`
}

func pruneWorkspaces(opts map[string]any) pruneResult {
	maxAgeMs := numberOf(opts["maxAgeMs"])
	if opts["maxAgeMs"] == nil {
		maxAgeMs = float64(workspaceMaxIdleMs)
	}
	var keepPaths []string
	if raw, ok := opts["keepPaths"].([]any); ok {
		for _, item := range raw {
			keepPaths = append(keepPaths, str(item))
		}
	}
	dryRun := truthy(opts["dryRun"])
	force := truthy(opts["force"])
	keep := map[string]bool{}
	for _, entry := range keepPaths {
		expanded := realPath(expandHomePath(entry))
		if expanded != "" {
			keep[expanded] = true
		}
	}
	cutoff := float64(time.Now().UnixMilli()) - maxAgeMs
	result := pruneResult{OK: true, Removed: []pruneRemoved{}, Kept: []pruneKept{}, Forgotten: []string{}}

	for _, entry := range readWorkspaceRegistry() {
		target := entry.Path
		if target == "" {
			continue
		}
		if !pathExists(target) {
			if !dryRun {
				_ = forgetWorkspace(target)
			}
			result.Forgotten = append(result.Forgotten, target)
			continue
		}
		if keep[realPath(target)] {
			result.Kept = append(result.Kept, pruneKept{Path: target, Reason: "in use"})
			continue
		}
		touchedAt := float64(0)
		if info, err := os.Stat(target); err == nil {
			touchedAt = float64(info.ModTime().UnixMilli())
		}
		createdAt := float64(0)
		if parsed, err := time.Parse(time.RFC3339, entry.CreatedAt); err == nil {
			createdAt = float64(parsed.UnixMilli())
		}
		lastActivity := touchedAt
		if createdAt > lastActivity {
			lastActivity = createdAt
		}
		if lastActivity > cutoff {
			result.Kept = append(result.Kept, pruneKept{Path: target, Reason: "recently active"})
			continue
		}
		if dryRun {
			status := workspaceStatusFor(target)
			blocked := ""
			if !status.OK {
				blocked = status.Error
			} else if !force {
				if status.Dirty {
					blocked = strconv.Itoa(len(status.ChangedFiles)) + " uncommitted change(s)"
				} else if status.Unpushed > 0 {
					blocked = strconv.Itoa(status.Unpushed) + " unpushed commit(s)"
				}
			}
			if blocked != "" {
				result.Kept = append(result.Kept, pruneKept{Path: target, Reason: blocked})
			} else {
				result.Removed = append(result.Removed, pruneRemoved{Path: target, Branch: status.Branch})
			}
			continue
		}
		removed := removeWorkspace(map[string]any{"dir": target, "force": force})
		if removed.OK {
			result.Removed = append(result.Removed, pruneRemoved{Path: removed.Path, Branch: removed.Branch})
		} else {
			result.Kept = append(result.Kept, pruneKept{Path: target, Reason: firstNonEmpty(removed.Error, "refused")})
		}
	}
	return result
}

type pullRequestResult struct {
	OK     bool   `json:"ok"`
	Error  string `json:"error,omitempty"`
	URL    string `json:"url,omitempty"`
	Branch string `json:"branch,omitempty"`
	Base   string `json:"base,omitempty"`
	Draft  bool   `json:"draft,omitempty"`
	PR     any    `json:"pr,omitempty"`
}

func ghRun(args []string, cwd string) gitResult {
	return runCommand("gh", args, cwd, 60*time.Second)
}

func createPullRequest(opts map[string]any) pullRequestResult {
	dir := str(opts["dir"])
	status := workspaceStatusFor(dir)
	if !status.OK {
		return pullRequestResult{OK: false, Error: status.Error}
	}
	if len(status.Commits) == 0 {
		return pullRequestResult{OK: false, Error: "Nothing to review yet — commit something in this workspace first"}
	}
	if status.Dirty {
		return pullRequestResult{OK: false, Error: strconv.Itoa(len(status.ChangedFiles)) + " uncommitted change(s) — commit them before opening a PR"}
	}
	version := ghRun([]string{"--version"}, status.Path)
	if !version.OK {
		return pullRequestResult{OK: false, Error: "GitHub CLI (gh) is not available on this machine"}
	}
	pushed := runCommand("git", []string{"push", "-u", "origin", status.Branch}, status.Path, 60*time.Second)
	if !pushed.OK {
		return pullRequestResult{OK: false, Error: firstNonEmpty(pushed.Stderr, "git push failed")}
	}
	base := str(opts["baseBranch"])
	if base == "" {
		base = status.BaseBranch
	}
	title := str(opts["title"])
	if title == "" && len(status.Commits) > 0 {
		title = status.Commits[0]["subject"]
	}
	args := []string{
		"pr", "create", "--base", base, "--head", status.Branch,
		"--title", title,
		"--body", str(opts["body"]),
	}
	draft := true
	if v, ok := opts["draft"].(bool); ok {
		draft = v
	}
	if draft {
		args = append(args, "--draft")
	}
	created := ghRun(args, status.Path)
	if !created.OK {
		return pullRequestResult{OK: false, Error: firstNonEmpty(created.Stderr, "gh pr create failed")}
	}
	url := created.Stdout
	if idx := strings.Index(url, "https://"); idx >= 0 {
		if end := strings.IndexAny(url[idx:], " \t\r\n"); end >= 0 {
			url = url[idx : idx+end]
		} else {
			url = url[idx:]
		}
	}
	return pullRequestResult{OK: true, URL: url, Branch: status.Branch, Base: base, Draft: draft}
}

func pullRequestStatus(dir string) pullRequestResult {
	repo := resolveRepo(dir)
	if !repo.IsRepo {
		return pullRequestResult{OK: false, Error: firstNonEmpty(repo.Error, "Not a git repository")}
	}
	viewed := ghRun([]string{
		"pr", "view", "--json", "number,url,title,state,isDraft,mergeable,reviewDecision,statusCheckRollup",
	}, repo.Root)
	if !viewed.OK {
		return pullRequestResult{OK: true, PR: nil}
	}
	var pr struct {
		Number            int    `json:"number"`
		URL               string `json:"url"`
		Title             string `json:"title"`
		State             string `json:"state"`
		IsDraft           bool   `json:"isDraft"`
		Mergeable         string `json:"mergeable"`
		ReviewDecision    string `json:"reviewDecision"`
		StatusCheckRollup []struct {
			Conclusion string `json:"conclusion"`
		} `json:"statusCheckRollup"`
	}
	if err := json.Unmarshal([]byte(viewed.Stdout), &pr); err != nil {
		return pullRequestResult{OK: true, PR: nil}
	}
	checks := pr.StatusCheckRollup
	failing := 0
	pending := 0
	for _, check := range checks {
		switch check.Conclusion {
		case "FAILURE", "ERROR", "TIMED_OUT":
			failing++
		case "":
			pending++
		}
	}
	reviewDecision := any(nil)
	if pr.ReviewDecision != "" {
		reviewDecision = pr.ReviewDecision
	}
	return pullRequestResult{
		OK: true,
		PR: map[string]any{
			"number":         pr.Number,
			"url":            pr.URL,
			"title":          pr.Title,
			"state":          pr.State,
			"isDraft":        pr.IsDraft,
			"mergeable":      pr.Mergeable,
			"reviewDecision": reviewDecision,
			"checks": map[string]any{
				"total":   len(checks),
				"failing": failing,
				"pending": pending,
			},
		},
	}
}

const maxReviewTextBytes = 512 * 1024
const workspaceMaxIdleMs = 3 * 24 * 60 * 60 * 1000

func readWorktreeJSON(args []string) (map[string]any, error) {
	arg := ""
	if len(args) > 0 {
		arg = args[0]
	}
	data, err := readInput(arg)
	if err != nil {
		return nil, err
	}
	var opts map[string]any
	if err := json.Unmarshal(data, &opts); err != nil {
		return nil, err
	}
	return opts, nil
}

func writeWorktreeJSON(value any, _failed bool) int {
	out, _ := json.Marshal(value)
	os.Stdout.Write(out)
	return 0
}

func WorktreeCLI(args []string) int {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "Usage: fizzer-storage worktree <prepare|status|create|list|diff|file-diff|remove|prune|pr-create|pr-status|normalize-slug|root|resolve-repo> [json]")
		return 1
	}
	sub := args[0]
	rest := args[1:]
	switch sub {
	case "prepare":
		opts, err := readWorktreeJSON(rest)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			return 1
		}
		r := PrepareWorkspace(opts)
		return writeWorktreeJSON(r, !r.OK)
	case "status":
		opts, err := readWorktreeJSON(rest)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			return 1
		}
		dir := str(opts["dir"])
		if dir == "" && len(rest) > 0 && !strings.HasPrefix(rest[0], "{") {
			dir = rest[0]
		}
		return writeWorktreeJSON(workspaceStatusFor(dir), false)
	case "create":
		opts, err := readWorktreeJSON(rest)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			return 1
		}
		r := createWorkspace(opts)
		return writeWorktreeJSON(r, !r.OK)
	case "list":
		opts, err := readWorktreeJSON(rest)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			return 1
		}
		dir := str(opts["dir"])
		if dir == "" && len(rest) > 0 && !strings.HasPrefix(rest[0], "{") {
			dir = rest[0]
		}
		r := listWorkspaces(dir)
		return writeWorktreeJSON(r, !r.OK)
	case "diff":
		opts, err := readWorktreeJSON(rest)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			return 1
		}
		dir := str(opts["dir"])
		if dir == "" && len(rest) > 0 && !strings.HasPrefix(rest[0], "{") {
			dir = rest[0]
		}
		r := workspaceDiff(dir)
		return writeWorktreeJSON(r, !r.OK)
	case "file-diff":
		opts, err := readWorktreeJSON(rest)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			return 1
		}
		r := workspaceFileDiff(opts)
		return writeWorktreeJSON(r, !r.OK)
	case "remove":
		opts, err := readWorktreeJSON(rest)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			return 1
		}
		r := removeWorkspace(opts)
		return writeWorktreeJSON(r, !r.OK)
	case "prune":
		opts, err := readWorktreeJSON(rest)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			return 1
		}
		if opts == nil {
			opts = map[string]any{}
		}
		return writeWorktreeJSON(pruneWorkspaces(opts), false)
	case "pr-create":
		opts, err := readWorktreeJSON(rest)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			return 1
		}
		r := createPullRequest(opts)
		return writeWorktreeJSON(r, !r.OK)
	case "pr-status":
		dir := ""
		if len(rest) > 0 {
			if strings.HasPrefix(rest[0], "{") {
				opts, err := readWorktreeJSON(rest)
				if err != nil {
					fmt.Fprintf(os.Stderr, "Error: %v\n", err)
					return 1
				}
				dir = str(opts["dir"])
			} else {
				dir = rest[0]
			}
		}
		r := pullRequestStatus(dir)
		return writeWorktreeJSON(r, !r.OK)
	case "normalize-slug":
		raw := ""
		if len(rest) > 0 {
			raw = rest[0]
		}
		if strings.HasPrefix(raw, "{") {
			opts, err := readWorktreeJSON(rest)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				return 1
			}
			raw = str(opts["input"])
		}
		slug := normalizeSlug(raw)
		if slug == "" {
			os.Stdout.Write([]byte("null"))
			return 0
		}
		out, _ := json.Marshal(slug)
		os.Stdout.Write(out)
		return 0
	case "root":
		os.Stdout.Write([]byte(workspacesRoot()))
		return 0
	case "resolve-repo":
		dir := ""
		if len(rest) > 0 {
			if strings.HasPrefix(rest[0], "{") {
				opts, err := readWorktreeJSON(rest)
				if err != nil {
					fmt.Fprintf(os.Stderr, "Error: %v\n", err)
					return 1
				}
				dir = str(opts["dir"])
			} else {
				dir = rest[0]
			}
		}
		return writeWorktreeJSON(resolveRepo(dir), false)
	default:
		fmt.Fprintln(os.Stderr, "unknown worktree subcommand:", sub)
		return 1
	}
}

var jwtPattern = regexp.MustCompile(`^[^.\s]+\.[^.\s]+\.[^.\s]+$`)

func isExpiredJWT(token string) bool {
	if token == "" {
		return true
	}
	if !jwtPattern.MatchString(token) {
		return false
	}
	return float64(time.Now().Unix()) > float64(decodeTokenExp(token))-10
}
