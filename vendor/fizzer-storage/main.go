package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
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
	fmt.Fprintf(os.Stderr, "  tui\n")
	os.Exit(1)
}

func readInput(arg string) ([]byte, error) {
	if arg != "" && arg != "-" {
		return []byte(arg), nil
	}
	return io.ReadAll(os.Stdin)
}

func main() {
	if len(os.Args) < 2 {
		usage()
	}

	cmd := os.Args[1]
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

	case "tui":
		os.Exit(RunTuiDev())

	default:
		usage()
	}
}
