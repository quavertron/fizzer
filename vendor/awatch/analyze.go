package main

import (
	"bufio"
	"encoding/json"
	"io"
)

// Headless adapter for GUI clients. The TUI and this adapter deliberately call
// the same histogram diff and smart-stat implementation.
func analyzeStream(input io.Reader, output io.Writer) error {
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 4096), 8*1024*1024)
	encoder := json.NewEncoder(output)
	for scanner.Scan() {
		var request struct {
			ID int `json:"id"`
			EditEvent
		}
		if err := json.Unmarshal(scanner.Bytes(), &request); err != nil {
			return err
		}
		event := &request.EditEvent
		if event.Kind != "lock" {
			ensureGitDiff(event)
			event.stats = changeCounts(event)
		}
		response := map[string]any{
			"id": request.ID, "lines": event.diffLines,
			"detail": lockDescription(event),
			"counts": map[string]int{"adds": event.stats.adds, "moves": event.stats.moves, "mods": event.stats.mods, "dels": event.stats.dels},
		}
		if event.diffErr != "" {
			response["error"] = event.diffErr
		}
		if err := encoder.Encode(response); err != nil {
			return err
		}
	}
	return scanner.Err()
}
