//go:build unix

package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func openNoFollow(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
}

func ownedByCurrentUser(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && int(stat.Uid) == os.Getuid()
}

func executableByCurrentUser(path string) bool {
	return syscall.Access(path, 0x1) == nil
}

func setProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// terminateProcess sends SIGTERM (to the whole group when grouped) and
// escalates to SIGKILL if the process is still running five seconds later.
func terminateProcess(cmd *exec.Cmd, group bool) {
	if cmd.Process == nil {
		return
	}
	pid := cmd.Process.Pid
	signal := func(sig syscall.Signal) {
		if group && syscall.Kill(-pid, sig) == nil {
			return
		}
		_ = cmd.Process.Signal(sig)
	}
	signal(syscall.SIGTERM)
	go func() {
		time.Sleep(5 * time.Second)
		if cmd.ProcessState == nil {
			signal(syscall.SIGKILL)
		}
	}()
}

func processSignaled(state *os.ProcessState) (bool, bool) {
	status, ok := state.Sys().(syscall.WaitStatus)
	if !ok {
		return false, false
	}
	return status.Signaled(), status.Signaled()
}

// ── Linux process leases ──────────────────────────────────────
// A grouped launcher survives a hard runner exit and is adopted by PID 1. A
// lease names its group and an ownership token carried in the environment, so
// a later runner can reap it without targeting an unrelated reused PID.

type agentProcessLease struct {
	Version         int    `json:"version"`
	RunID           int    `json:"runId"`
	OwnerPID        int    `json:"ownerPid"`
	OwnerStartTicks string `json:"ownerStartTicks"`
	ProcessGroupID  int    `json:"processGroupId"`
	Token           string `json:"token"`
	Label           string `json:"label"`
}

func agentProcessLeaseDir() string {
	if dir := os.Getenv("CASCADE_AGENT_PROCESS_DIR"); dir != "" {
		return dir
	}
	return filepath.Join(fizzerDir(), "agent-processes")
}

func leasePath(runID int) string {
	return filepath.Join(agentProcessLeaseDir(), fmt.Sprintf("%d.json", runID))
}

// procStatFields returns the fields after the command name in /proc/<pid>/stat;
// the name can contain spaces and parentheses.
func procStatFields(pid int) []string {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return nil
	}
	stat := string(data)
	end := strings.LastIndexByte(stat, ')')
	if end < 0 || end+2 > len(stat) {
		return nil
	}
	return strings.Fields(stat[end+2:])
}

func processStartTicks(pid int) string {
	if runtime.GOOS != "linux" || pid <= 0 {
		return ""
	}
	if fields := procStatFields(pid); len(fields) > 19 {
		return fields[19]
	}
	return ""
}

func processGroupIDOf(pid int) int {
	if runtime.GOOS != "linux" || pid <= 0 {
		return 0
	}
	fields := procStatFields(pid)
	if len(fields) < 4 {
		return 0
	}
	pgid, err := strconv.Atoi(fields[3])
	if err != nil || pgid <= 1 {
		return 0
	}
	return pgid
}

func writeAgentProcessLease(runID, pgid int, token, label string) {
	if runtime.GOOS != "linux" {
		return
	}
	lease := agentProcessLease{Version: 1, RunID: runID, OwnerPID: os.Getpid(),
		OwnerStartTicks: processStartTicks(os.Getpid()), ProcessGroupID: pgid, Token: token, Label: label}
	if err := os.MkdirAll(agentProcessLeaseDir(), 0o700); err != nil {
		return
	}
	data, _ := json.Marshal(lease)
	target := leasePath(runID)
	temporary := fmt.Sprintf("%s.%d.tmp", target, os.Getpid())
	if os.WriteFile(temporary, data, 0o600) == nil {
		_ = os.Rename(temporary, target)
	}
}

func clearAgentProcessLease(runID int) { _ = os.Remove(leasePath(runID)) }

func readAgentProcessLease(file string) (agentProcessLease, bool) {
	var lease agentProcessLease
	data, err := os.ReadFile(file)
	if err != nil || json.Unmarshal(data, &lease) != nil {
		return lease, false
	}
	valid := lease.Version == 1 && lease.RunID > 0 && lease.OwnerPID > 1 && lease.ProcessGroupID > 1 &&
		lease.OwnerStartTicks != "" && len(lease.Token) >= 16
	return lease, valid
}

func processHasLeaseToken(pid, runID int, token string) bool {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/environ", pid))
	if err != nil {
		return false
	}
	entries := strings.Split(string(data), "\x00")
	hasRun, hasToken := false, false
	for _, entry := range entries {
		hasRun = hasRun || entry == fmt.Sprintf("CASCADE_RUN_ID=%d", runID)
		hasToken = hasToken || entry == "CASCADE_AGENT_PROCESS_TOKEN="+token
	}
	return hasRun && hasToken
}

var numericName = regexp.MustCompile(`^\d+$`)

// findLeaseTokenProcess prefers members of the recorded group: the leader can
// die while token-bearing descendants remain.
func findLeaseTokenProcess(runID int, token string, pgid int) int {
	if pgid > 1 && processHasLeaseToken(pgid, runID, token) {
		return pgid
	}
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return 0
	}
	var pids []int
	for _, entry := range entries {
		if numericName.MatchString(entry.Name()) {
			if pid, _ := strconv.Atoi(entry.Name()); pid > 1 {
				pids = append(pids, pid)
			}
		}
	}
	for _, pid := range pids {
		if pgid > 1 && processGroupIDOf(pid) != pgid {
			continue
		}
		if processHasLeaseToken(pid, runID, token) {
			return pid
		}
	}
	if pgid > 1 {
		for _, pid := range pids {
			if processHasLeaseToken(pid, runID, token) {
				return pid
			}
		}
	}
	return 0
}

func killGroup(pgid int, wait time.Duration) {
	if pgid <= 1 {
		return
	}
	_ = syscall.Kill(-pgid, syscall.SIGTERM)
	kill := func() {
		if syscall.Kill(-pgid, 0) == nil {
			_ = syscall.Kill(-pgid, syscall.SIGKILL)
		}
	}
	if wait > 0 {
		time.Sleep(wait)
		kill()
		return
	}
	go func() { time.Sleep(5 * time.Second); kill() }()
}

// cancelCliRunFromLease stops a run using only its durable lease, when this
// process no longer holds the child.
func cancelCliRunFromLease(runID int) bool {
	if runtime.GOOS != "linux" {
		return false
	}
	lease, ok := readAgentProcessLease(leasePath(runID))
	if !ok || lease.RunID != runID {
		return false
	}
	defer clearAgentProcessLease(runID)
	pid := findLeaseTokenProcess(lease.RunID, lease.Token, lease.ProcessGroupID)
	if pid == 0 {
		return false
	}
	pgid := processGroupIDOf(pid)
	if pgid == 0 {
		pgid = lease.ProcessGroupID
	}
	killGroup(pgid, 0)
	return true
}

// reapOrphanedCliAgentProcesses kills grouped launchers whose owning runner died.
func reapOrphanedCliAgentProcesses() []int {
	if runtime.GOOS != "linux" {
		return nil
	}
	entries, err := os.ReadDir(agentProcessLeaseDir())
	if err != nil {
		return nil
	}
	var reaped []int
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		file := filepath.Join(agentProcessLeaseDir(), entry.Name())
		lease, ok := readAgentProcessLease(file)
		if !ok {
			_ = os.Remove(file)
			continue
		}
		if start := processStartTicks(lease.OwnerPID); start != "" && start == lease.OwnerStartTicks {
			continue
		}
		pid := findLeaseTokenProcess(lease.RunID, lease.Token, lease.ProcessGroupID)
		if pid == 0 {
			_ = os.Remove(file)
			continue
		}
		pgid := processGroupIDOf(pid)
		if pgid == 0 {
			pgid = lease.ProcessGroupID
		}
		killGroup(pgid, 250*time.Millisecond)
		_ = os.Remove(file)
		reaped = append(reaped, lease.RunID)
	}
	return reaped
}
