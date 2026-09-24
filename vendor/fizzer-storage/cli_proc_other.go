//go:build !unix

package main

import (
	"os"
	"os/exec"
)

func openNoFollow(path string) (*os.File, error) { return os.Open(path) }

// Profile command routing requires POSIX ownership checks.
func ownedByCurrentUser(info os.FileInfo) bool { return false }

func executableByCurrentUser(path string) bool { return false }

func setProcessGroup(cmd *exec.Cmd) {}

func terminateProcess(cmd *exec.Cmd, group bool) {
	if cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
}

func processSignaled(state *os.ProcessState) (bool, bool) { return false, false }

func writeAgentProcessLease(runID, pgid int, token, label string) {}

func clearAgentProcessLease(runID int) {}

func cancelCliRunFromLease(runID int) bool { return false }

func reapOrphanedCliAgentProcesses() []int { return nil }
