package main

import (
	"sort"
	"strings"
)

// Classification follows Coding/git-smart-stat/diff.c: exact moves between
// groups (20 alphanumeric characters minimum), then greedy pairing at 50%
// byte-based Levenshtein similarity within each group.
type smartCounts struct{ adds, moves, mods, dels int }
type smartLine struct {
	text       string
	group      int
	add, moved bool
}

func classifySmartDiff(patch []string) smartCounts {
	var lines []smartLine
	group := 0
	for _, line := range patch {
		if strings.HasPrefix(line, "@@") || line == "" || line[0] == ' ' {
			group++
		} else if line[0] == '+' || line[0] == '-' {
			lines = append(lines, smartLine{text: strings.TrimRight(line[1:], "\r\n"), group: group, add: line[0] == '+'})
		}
	}
	deleted := make(map[string][]int)
	for i, line := range lines {
		if !line.add {
			deleted[line.text] = append(deleted[line.text], i)
		}
	}
	claimed := make([]bool, len(lines))
	matches := make([]int, len(lines))
	for i, line := range lines {
		if !line.add {
			continue
		}
		candidates := deleted[line.text]
		for j := len(candidates) - 1; j >= 0; j-- {
			d := candidates[j]
			if !claimed[d] && lines[d].group != line.group {
				matches[i], claimed[d] = d+1, true
				break
			}
		}
	}
	start, chars := 0, 0
	for i := 0; i <= len(lines); i++ {
		if i < len(lines) && matches[i] != 0 {
			for _, c := range []byte(lines[i].text) {
				if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' {
					chars++
				}
			}
			continue
		}
		if chars >= 20 {
			for j := start; j < i; j++ {
				lines[j].moved, lines[matches[j]-1].moved = true, true
			}
		}
		start, chars = i+1, 0
	}
	var counts smartCounts
	for i := 0; i < len(lines); {
		var add, del []string
		g := lines[i].group
		for i < len(lines) && lines[i].group == g {
			line := lines[i]
			if line.moved {
				if line.add {
					counts.moves++
				}
			} else if line.add {
				add = append(add, line.text)
			} else {
				del = append(del, line.text)
			}
			i++
		}
		mods := pairSmartLines(del, add)
		counts.mods += mods
		counts.adds += len(add) - mods
		counts.dels += len(del) - mods
	}
	return counts
}

func pairSmartLines(del, add []string) int {
	if len(del) == 0 || len(add) == 0 {
		return 0
	}
	mods := 0
	// Match smart-stat's overflow-safe million-comparison cap and positional
	// fallback rather than allocating a quadratic candidate list for huge edits.
	if len(del) > 1000000/len(add) {
		for i := 0; i < min(len(del), len(add)); i++ {
			if smartSimilarity(del[i], add[i]) >= .5 {
				mods++
			}
		}
		return mods
	}
	type pair struct {
		d, a int
		sim  float64
	}
	var pairs []pair
	for d, before := range del {
		for a, after := range add {
			if sim := smartSimilarity(before, after); sim >= .5 {
				pairs = append(pairs, pair{d, a, sim})
			}
		}
	}
	sort.Slice(pairs, func(i, j int) bool {
		a, b := pairs[i], pairs[j]
		if a.sim != b.sim {
			return a.sim > b.sim
		}
		if a.d != b.d {
			return a.d < b.d
		}
		return a.a < b.a
	})
	dUsed, aUsed := make([]bool, len(del)), make([]bool, len(add))
	for _, p := range pairs {
		if !dUsed[p.d] && !aUsed[p.a] {
			dUsed[p.d], aUsed[p.a] = true, true
			mods++
		}
	}
	return mods
}

func smartSimilarity(a, b string) float64 {
	if a == b {
		return 1
	}
	n := max(len(a), len(b))
	if min(len(a), len(b))*2 < n {
		return 0
	}
	// Identical edges do not affect edit distance. Trimming them saves work on
	// long source lines that differ in just a small expression.
	for len(a) > 0 && len(b) > 0 && a[0] == b[0] {
		a, b = a[1:], b[1:]
	}
	for len(a) > 0 && len(b) > 0 && a[len(a)-1] == b[len(b)-1] {
		a, b = a[:len(a)-1], b[:len(b)-1]
	}
	if len(b) > len(a) {
		a, b = b, a
	}
	row := make([]int, len(b)+1)
	for j := range row {
		row[j] = j
	}
	for i := 0; i < len(a); i++ {
		prev := row[0]
		row[0] = i + 1
		for j := 0; j < len(b); j++ {
			cost := 0
			if a[i] != b[j] {
				cost = 1
			}
			old := row[j+1]
			row[j+1] = min(row[j+1]+1, row[j]+1, prev+cost)
			prev = old
		}
	}
	return 1 - float64(row[len(b)])/float64(n)
}
