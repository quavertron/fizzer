//go:build !unix

package main

import (
	"os"
	"os/exec"
)

func detachProcess(cmd *exec.Cmd) {}

func signalGroup(cmd *exec.Cmd, sig os.Signal) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	_ = cmd.Process.Signal(sig)
}
