package main

import "fmt"

// The holder range is distinct from the range requested by the blocked agent.
// Both frontends use this formatter; alock supplies the authoritative metadata.
func lockDescription(event *EditEvent) string {
	if event.Result == "released" {
		owner := event.Author
		if owner == "" { owner = event.Agent }
		return fmt.Sprintf("Lock released: %s, range %d–%d", owner, event.LineStart, event.LineEnd)
	}
	if event.Result != "conflict" { return event.Detail }
	if event.ConflictAgent != "" && event.ConflictLineStart > 0 && event.ConflictLineEnd >= event.ConflictLineStart {
		return fmt.Sprintf("%s holds a lock on range %d–%d", event.ConflictAgent, event.ConflictLineStart, event.ConflictLineEnd)
	}
	if event.Detail != "" { return event.Detail }
	if event.ConflictAgent != "" { return event.ConflictAgent + " holds a lock (range unavailable)" }
	return "Lock conflict (holder and range unavailable)"
}
