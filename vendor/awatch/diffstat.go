package main

import (
	"fmt"
	"strings"
)

// Reuse the same histogram diff as the expanded view, so unchanged context
// never counts as a change and toggling views never launches a second diff.
func renderDiffStat(ev *EditEvent) string {
	var counts smartCounts
	switch {
	case len(ev.OldLines) == 0:
		counts.adds = len(ev.NewLines)
	case len(ev.NewLines) == 0:
		counts.dels = len(ev.OldLines)
	default:
		ensureGitDiff(ev)
		if ev.diffErr != "" {
			return colorYellow + "diff unavailable: " + ev.diffErr + colorReset
		}
		counts = classifySmartDiff(ev.diffLines)
	}
	ev.stats = counts
	total := counts.adds + counts.moves + counts.mods + counts.dels
	if total == 0 {
		return "0 (no changes)"
	}
	sizes := []int{counts.adds, counts.moves, counts.mods, counts.dels}
	var bar strings.Builder
	colors := []string{colorGreen, colorCyan, colorYellow, colorRed}
	symbols := []string{"+", "*", "~", "-"}
	for i, size := range sizes {
		if size > 0 {
			bar.WriteString(colors[i] + strings.Repeat(symbols[i], size) + colorReset)
		}
	}
	return fmt.Sprintf("%d %s %s", total, bar.String(), counts.colored(true))
}

func (s smartCounts) colored(colorNumbers bool) string {
	beforeNumber := colorReset
	if colorNumbers {
		beforeNumber = ""
	}
	return fmt.Sprintf("(%s+%s%d%s %s*%s%d%s %s~%s%d%s %s-%s%d%s)",
		colorGreen, beforeNumber, s.adds, colorReset, colorCyan, beforeNumber, s.moves, colorReset,
		colorYellow, beforeNumber, s.mods, colorReset, colorRed, beforeNumber, s.dels, colorReset)
}
