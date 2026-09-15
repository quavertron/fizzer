package main

import (
	"fmt"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/x/ansi"
)

func listeningLines() []string {
	return []string{colorDim + "awatch listening" + colorReset, ""}
}

type model struct {
	lines            []string
	evs              []EditEvent
	lastFile         string
	ready            bool
	expand           bool
	follow           bool
	width            int
	height           int
	yOffset          int
	events           chan EditEvent
	selection        selection
	dragX, dragY     int
	dragTick         uint64
	clipCache        map[string]string
	copyStatus       string
	listenerUpdates  chan string
	listenerStatus   string
	layout           *lineLayout
	sessionStats     smartCounts
	launchTime       time.Time
	keyboardProtocol bool
}

func (m *model) viewHeight() int {
	h := m.height - 1
	if h < 1 {
		return 1
	}
	return h
}

func (m *model) maxOffset() int {
	return max(0, len(m.wrappedLayout().rows)-m.viewHeight())
}

func (m *model) clampOffset() {
	if m.yOffset < 0 {
		m.yOffset = 0
	}
	maxOff := m.maxOffset()
	if m.yOffset > maxOff {
		m.yOffset = maxOff
	}
	m.follow = m.yOffset >= maxOff && !m.selection.active
}

func (m *model) gotoTop() {
	m.yOffset = 0
	m.follow = m.maxOffset() == 0
}

func (m *model) gotoBottom() {
	m.yOffset = m.maxOffset()
	m.follow = true
}

func (m *model) scrollBy(n int) {
	m.yOffset += n
	m.clampOffset()
	if m.selection.dragging {
		m.selection.end = m.mousePoint(m.dragX, m.dragY)
	}
}

func cacheEvent(ev *EditEvent, lastFile *string) {
	prev := *lastFile
	ev.collapsed = renderEvent(ev, &prev, false)
	next := *lastFile
	ev.expanded = renderEvent(ev, &next, true)
	*lastFile = next
	ev.OldLines = nil
	ev.NewLines = nil
	ev.diffLines = nil
}

func (m *model) addEvent(ev EditEvent) {
	// Inspect the old layout before appending changes the bottom offset.
	if !m.selection.active && m.yOffset >= m.maxOffset() {
		m.follow = true
	}
	m.evs = append(m.evs, ev)
	if ev.expanded == nil {
		cacheEvent(&m.evs[len(m.evs)-1], &m.lastFile)
	}
	stats := m.evs[len(m.evs)-1].stats
	m.sessionStats.adds += stats.adds
	m.sessionStats.moves += stats.moves
	m.sessionStats.mods += stats.mods
	m.sessionStats.dels += stats.dels
	index := len(m.evs) - 1
	if m.joinLockEdit(index) && len(m.lines) > 0 && m.lines[len(m.lines)-1] == "" {
		// The former separator becomes the edit's first line. Reindex only
		// that tail so cached wrapping does not leave a stale blank row.
		if m.layout != nil && m.layout.count == len(m.lines) {
			last := len(m.lines) - 1
			m.layout.rows = m.layout.rows[:m.layout.first[last]]
			m.layout.first = m.layout.first[:last]
			m.layout.count = last
		}
		clear(m.clipCache)
	}
	m.lines = m.appendEventLines(m.lines, index)
	if m.follow {
		m.gotoBottom()
	}
}

func (m *model) joinLockEdit(index int) bool {
	if m.expand || index == 0 {
		return false
	}
	prev, ev := m.evs[index-1], m.evs[index]
	return prev.Kind == "lock" && ev.Kind != "lock" && prev.File == ev.File && prev.Agent == ev.Agent
}

func (m *model) appendEventLines(lines []string, index int) []string {
	if m.expand {
		return append(lines, m.evs[index].expanded...)
	}
	if m.joinLockEdit(index) && len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	ev := &m.evs[index]
	if m.width > 0 && ev.compact != "" && len(ev.collapsed) > 0 && ansi.StringWidth(ev.collapsed[0]) > m.width {
		lines = append(lines, ev.compact)
		return append(lines, ev.collapsed[1:]...)
	}
	return append(lines, ev.collapsed...)
}

// rebuild swaps the visible log between cached expanded/collapsed lines.
func (m *model) rebuild() {
	lines := listeningLines()
	for i := range m.evs {
		lines = m.appendEventLines(lines, i)
	}
	m.lines = lines
	m.layout = nil
	if m.follow {
		m.gotoBottom()
	} else {
		m.clampOffset()
	}
}

func (m model) Init() tea.Cmd {
	if m.keyboardProtocol {
		return tea.Batch(waitForEvents(m.events, m.lastFile), waitForListener(m.listenerUpdates), enableKeyboardProtocol)
	}
	if m.listenerUpdates == nil {
		return waitForEvents(m.events, m.lastFile)
	}
	return tea.Batch(waitForEvents(m.events, m.lastFile), waitForListener(m.listenerUpdates))
}

type listenerMsg string

func waitForListener(ch chan string) tea.Cmd {
	return func() tea.Msg { return listenerMsg(<-ch) }
}

// Cache expensive diffs outside Update, and bound each batch so input remains
// responsive even when producers never stop sending events.
type eventsMsg struct {
	events   []EditEvent
	lastFile string
	closed   bool
}

func waitForEvents(ch chan EditEvent, lastFile string) tea.Cmd {
	if ch == nil {
		return nil
	}
	return func() tea.Msg {
		batch := eventsMsg{lastFile: lastFile}
		ev, ok := <-ch
		if !ok {
			batch.closed = true
			return batch
		}
		deadline := time.Now().Add(8 * time.Millisecond)
		for {
			cacheEvent(&ev, &batch.lastFile)
			batch.events = append(batch.events, ev)
			if len(batch.events) >= 128 || time.Now().After(deadline) {
				return batch
			}
			select {
			case ev, ok = <-ch:
				if !ok {
					batch.closed = true
					return batch
				}
			default:
				return batch
			}
		}
	}
}

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	if key, ok := decodeTerminalKey(msg); ok {
		msg = key
	}
	m.wrappedLayout()
	if m.clipCache == nil {
		m.clipCache = make(map[string]string)
	}
	switch msg := msg.(type) {
	case listenerMsg:
		m.listenerStatus = string(msg)
		return m, waitForListener(m.listenerUpdates)
	case clipboardMsg:
		m.copyStatus = "copied"
		if msg.err != nil {
			m.copyStatus = "copy failed: " + msg.err.Error()
		}
		return m, nil
	case tea.MouseMsg:
		return m.updateMouse(msg)
	case selectionTick:
		if uint64(msg) != m.dragTick || !m.selection.dragging {
			return m, nil
		}
		if delta := m.dragScrollDelta(); delta != 0 {
			m.scrollBy(delta)
		} else {
			return m, nil
		}
		return m, m.nextSelectionTick()
	case tea.KeyMsg:
		switch msg.String() {
		case "y", "ctrl+y":
			if m.selection.active {
				return m, copySelection(m.selectedText())
			}
			return m, nil
		case "esc":
			m.copyStatus = ""
			m.selection = selection{}
			m.dragTick++
			m.clampOffset()
			return m, nil
		case "q", "ctrl+c":
			return m, tea.Quit
		case "G":
			m.gotoBottom()
			return m, nil
		case "g":
			m.gotoTop()
			return m, nil
		case "ctrl+o":
			m.selection = selection{}
			m.dragTick++
			m.expand = !m.expand
			m.rebuild()
			return m, nil
		case "up", "k":
			m.scrollBy(-1)
			return m, nil
		case "down", "j":
			m.scrollBy(1)
			return m, nil
		case "pgup", "b":
			m.scrollBy(-m.viewHeight())
			return m, nil
		case "pgdown", "f", " ":
			m.scrollBy(m.viewHeight())
			return m, nil
		case "u", "ctrl+u":
			m.scrollBy(-max(1, m.viewHeight()/2))
			return m, nil
		case "d", "ctrl+d":
			m.scrollBy(max(1, m.viewHeight()/2))
			return m, nil
		}
		return m, nil

	case tea.WindowSizeMsg:
		anchor := m.visualAnchor()
		m.clipCache = make(map[string]string)
		m.width = msg.Width
		m.height = msg.Height
		m.ready = true
		if len(m.evs) > 0 {
			m.rebuild()
		}
		if m.follow {
			m.gotoBottom()
		} else {
			m.restoreVisualAnchor(anchor)
		}
		return m, nil

	case eventMsg:
		m.addEvent(EditEvent(msg))
		return m, waitForEvents(m.events, m.lastFile)
	case eventsMsg:
		for _, ev := range msg.events {
			m.addEvent(ev)
		}
		m.lastFile = msg.lastFile
		if msg.closed {
			return m, nil
		}
		return m, waitForEvents(m.events, m.lastFile)
	}

	return m, nil
}

func (m model) View() string {
	if !m.ready {
		return "awatch listening..."
	}
	mode := "expanded"
	if !m.expand {
		mode = "collapsed"
	}
	status := fmt.Sprintf("%s %d events | ctrl+o: %s | drag: select | cmd+c: copy | esc: clear | q: quit%s", colorDim, len(m.evs), mode, colorReset)
	if m.copyStatus != "" {
		status = colorDim + m.copyStatus + colorReset
	}
	if m.listenerStatus != "" {
		status = colorYellow + m.listenerStatus + colorReset
	}
	status = m.launchTime.Format("15:04:05") + " session " + m.sessionStats.colored(false) + " | " + status
	status = ansi.Truncate(status, max(0, m.width), "")

	h := m.viewHeight()
	layout := m.wrappedLayout()
	start := m.yOffset
	if start > len(layout.rows) {
		start = 0
	}
	out := make([]string, h)
	for i := 0; i < h; i++ {
		idx := start + i
		if idx >= len(layout.rows) {
			break
		}
		row := layout.rows[idx]
		line := m.lines[row.line]
		key := fmt.Sprintf("%d:%d:%d", row.line, row.start, row.end)
		if clipped, ok := m.clipCache[key]; ok {
			line = clipped
		} else {
			clipped := ansi.Cut(line, row.start, row.end) + colorReset
			if m.clipCache != nil {
				if len(m.clipCache) >= max(1, 2*h) {
					clear(m.clipCache)
				}
				m.clipCache[key] = clipped
			}
			line = clipped
		}
		out[i] = m.highlightWrappedLine(row, line)
	}
	return strings.Join(out, "\n") + "\n" + status
}
