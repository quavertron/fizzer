package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

func usage() {
	fmt.Fprintf(os.Stderr, "Usage: fizzer-storage <command> <subcommand> [args...]\n")
	fmt.Fprintf(os.Stderr, "Commands:\n")
	fmt.Fprintf(os.Stderr, "  remote-vaults read <directory>\n")
	fmt.Fprintf(os.Stderr, "  remote-vaults save <directory> [record-json]\n")
	fmt.Fprintf(os.Stderr, "  server-sessions read <directory>\n")
	fmt.Fprintf(os.Stderr, "  server-sessions remember <directory> <origin> <token>\n")
	fmt.Fprintf(os.Stderr, "  list-connections <directory> [vaults-json]\n")
	fmt.Fprintf(os.Stderr, "  antigravity-ls ensure\n")
	fmt.Fprintf(os.Stderr, "  agent-account <enabled|should-offer|state|decline|setup-command|resolve-workspace|launch-argv|run|cancel|save-write-access|write-access-roots|is-remote-vault|prepare-workspace>\n")
	fmt.Fprintf(os.Stderr, "  codex-sessions <list|read|assert-idle> [json]\n")
	fmt.Fprintf(os.Stderr, "  worktree <prepare|status|create|list|diff|file-diff|remove|prune|pr-create|pr-status|normalize-slug|root|resolve-repo> [json]\n")
	fmt.Fprintf(os.Stderr, "  agent-run <start|cancel|reap> [json]\n")
	fmt.Fprintf(os.Stderr, "  runner [json]\n")
	fmt.Fprintf(os.Stderr, "  tui\n")
	fmt.Fprintf(os.Stderr, "  cascade-note|cascade-chat|cascade-scratchpad [args...]  (also by link name)\n")
	os.Exit(1)
}

func readInput(arg string) ([]byte, error) {
	if arg != "" && arg != "-" {
		return []byte(arg), nil
	}
	return io.ReadAll(os.Stdin)
}

func main() {
	// Agents invoke the helpers by name through links to this binary.
	if name := filepath.Base(os.Args[0]); helperCommands[name] != nil {
		os.Exit(runHelper(name, os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
	}
	if len(os.Args) < 2 {
		usage()
	}

	cmd := os.Args[1]
	if helperCommands[cmd] != nil {
		os.Exit(runHelper(cmd, os.Args[2:], os.Stdin, os.Stdout, os.Stderr))
	}
	switch cmd {
	case "remote-vaults", "vaults":
		if len(os.Args) < 4 {
			usage()
		}
		subcmd := os.Args[2]
		dir := os.Args[3]
		switch subcmd {
		case "read":
			records, err := ReadRemoteVaults(dir)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				os.Exit(1)
			}
			out, err := json.Marshal(records)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				os.Exit(1)
			}
			os.Stdout.Write(out)
		case "save":
			var input string
			if len(os.Args) > 4 {
				input = os.Args[4]
			}
			data, err := readInput(input)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error reading input: %v\n", err)
				os.Exit(1)
			}
			var record RemoteVaultRecord
			if err := json.Unmarshal(data, &record); err != nil {
				fmt.Fprintf(os.Stderr, "Invalid vault record JSON: %v\n", err)
				os.Exit(1)
			}
			if err := SaveRemoteVault(dir, record); err != nil {
				fmt.Fprintf(os.Stderr, "Error saving vault: %v\n", err)
				os.Exit(1)
			}
		default:
			usage()
		}

	case "server-sessions", "sessions":
		if len(os.Args) < 4 {
			usage()
		}
		subcmd := os.Args[2]
		dir := os.Args[3]
		switch subcmd {
		case "read":
			sessions, err := ReadSessions(dir)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				os.Exit(1)
			}
			out, err := json.Marshal(sessions)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				os.Exit(1)
			}
			os.Stdout.Write(out)
		case "remember":
			if len(os.Args) < 6 {
				usage()
			}
			origin := os.Args[4]
			token := os.Args[5]
			if err := RememberSession(dir, origin, token); err != nil {
				fmt.Fprintf(os.Stderr, "Error remembering session: %v\n", err)
				os.Exit(1)
			}
		default:
			usage()
		}

	case "list-connections":
		if len(os.Args) < 3 {
			usage()
		}
		dir := os.Args[2]
		var input string
		if len(os.Args) > 3 {
			input = os.Args[3]
		}
		data, err := readInput(input)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error reading input: %v\n", err)
			os.Exit(1)
		}
		var vaults []RemoteVaultRecord
		if len(data) > 0 {
			if err := json.Unmarshal(data, &vaults); err != nil {
				fmt.Fprintf(os.Stderr, "Invalid vaults JSON: %v\n", err)
				os.Exit(1)
			}
		}
		connections, err := ListConnections(dir, vaults)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		out, err := json.Marshal(connections)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		os.Stdout.Write(out)

	case "antigravity-ls":
		if len(os.Args) < 3 || os.Args[2] != "ensure" {
			usage()
		}
		endpoint, err := EnsureAntigravityLS()
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		out, err := json.Marshal(endpoint)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		os.Stdout.Write(out)

	case "agent-account":
		os.Exit(AgentAccountCLI(os.Args[2:]))

	case "codex-sessions":
		os.Exit(CodexSessionsCLI(os.Args[2:]))

	case "worktree":
		os.Exit(WorktreeCLI(os.Args[2:]))

	case "agent-run":
		os.Exit(AgentRunCLI(os.Args[2:]))

	case "runner":
		os.Exit(RunnerCLI(os.Args[2:]))

	case "tui":
		os.Exit(RunTuiDev())

	default:
		usage()
	}
}
