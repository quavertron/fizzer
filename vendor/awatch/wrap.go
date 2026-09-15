package main

import (
	"sort"
	"strings"

	"github.com/charmbracelet/x/ansi"
)

type visualRow struct{ line, start, end int }
type lineLayout struct {
	width, count int
	rows         []visualRow
	first        []int
}

// Extend the index only for appended log lines. Resizing or switching diff
// modes rebuilds it; ordinary redraws and scrolling reuse it.
func (m *model) wrappedLayout() *lineLayout {
	w := max(1, m.width)
	if m.layout == nil || m.layout.width != w || m.layout.count > len(m.lines) {
		m.layout = &lineLayout{width: w}
		m.clipCache = make(map[string]string)
	}
	l := m.layout
	for i := l.count; i < len(m.lines); i++ {
		l.first = append(l.first, len(l.rows))
		start := 0
		for _, part := range strings.Split(ansi.Hardwrap(m.lines[i], w, true), "\n") {
			end := start + ansi.StringWidth(part)
			l.rows = append(l.rows, visualRow{i, start, end})
			start = end
		}
	}
	l.count = len(m.lines)
	return l
}

func (m *model) visualAnchor() textPoint {
	l := m.wrappedLayout()
	if len(l.rows) == 0 {
		return textPoint{}
	}
	r := l.rows[min(m.yOffset, len(l.rows)-1)]
	return textPoint{r.line, r.start}
}

func (m *model) restoreVisualAnchor(p textPoint) {
	l := m.wrappedLayout()
	if p.row >= len(l.first) {
		m.clampOffset()
		return
	}
	start := l.first[p.row]
	end := len(l.rows)
	if p.row+1 < len(l.first) {
		end = l.first[p.row+1]
	}
	n := sort.Search(end-start, func(i int) bool { return l.rows[start+i].end > p.col })
	m.yOffset = start + min(n, end-start-1)
	m.clampOffset()
}
