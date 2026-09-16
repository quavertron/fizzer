package main

import (
	"fmt"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/x/ansi"
)

// Points use absolute log rows and terminal cells, independent of the viewport.
type textPoint struct{ row, col int }
type selection struct {
	start, end       textPoint
	active, dragging bool
}
type selectionTick uint64
type clipboardMsg struct{ err error }

const selectionBackground = "\x1b[48;2;50;50;50m"

var selectionSGR = regexp.MustCompile("\x1b\\[[0-9;:]*m")

func (m model) selectedText() string {
	if !m.selection.active || len(m.lines) == 0 {
		return ""
	}
	a, b := m.selection.bounds()
	var out strings.Builder
	for row := a.row; row <= b.row && row < len(m.lines); row++ {
		line := ansi.Strip(m.lines[row])
		start, end := 0, ansi.StringWidth(line)
		if row == a.row {
			start = a.col
		}
		if row == b.row {
			end = min(end, b.col+1)
		}
		if row > a.row {
			out.WriteByte('\n')
		}
		out.WriteString(ansi.Cut(line, start, end))
	}
	return out.String()
}

func copySelection(text string) tea.Cmd {
	return func() tea.Msg {
		var cmd *exec.Cmd
		switch runtime.GOOS {
		case "darwin":
			cmd = exec.Command("pbcopy")
		case "windows":
			cmd = exec.Command("clip")
		default:
			if path, err := exec.LookPath("wl-copy"); err == nil {
				cmd = exec.Command(path)
			} else if path, err := exec.LookPath("xclip"); err == nil {
				cmd = exec.Command(path, "-selection", "clipboard")
			} else {
				return clipboardMsg{fmt.Errorf("install wl-copy or xclip")}
			}
		}
		cmd.Stdin = strings.NewReader(text)
		return clipboardMsg{cmd.Run()}
	}
}

func (m model) mousePoint(x, y int) textPoint {
	l := m.wrappedLayout()
	if len(l.rows) == 0 {
		return textPoint{}
	}
	index := min(len(l.rows)-1, m.yOffset+min(max(0, y), m.viewHeight()-1))
	row := l.rows[index]
	col := min(max(0, x), max(0, m.width-1))
	return textPoint{row.line, min(row.start+col, row.end)}
}

func (m model) nextSelectionTick() tea.Cmd {
	id := m.dragTick
	return tea.Tick(16*time.Millisecond, func(time.Time) tea.Msg { return selectionTick(id) })
}

func (m model) dragScrollDelta() int {
	h := m.viewHeight()
	const step = 1
	if m.dragY < 0 {
		return -min(4, 1-m.dragY)
	}
	if m.dragY >= h {
		return min(4, 1+m.dragY-h)
	}
	if m.dragY == 0 {
		return -step
	}
	if m.dragY == h-1 {
		return step
	}
	return 0
}

func (m *model) syncDragTimer(wasScrolling bool) tea.Cmd {
	if m.dragScrollDelta() == 0 {
		if wasScrolling {
			m.dragTick++
		}
		return nil
	}
	if wasScrolling {
		return nil
	}
	m.dragTick++
	return m.nextSelectionTick()
}

func (m model) updateMouse(msg tea.MouseMsg) (tea.Model, tea.Cmd) {
	wasScrolling := m.selection.dragging && m.dragScrollDelta() != 0
	if msg.Button == tea.MouseButtonWheelUp || msg.Button == tea.MouseButtonWheelDown {
		if m.selection.dragging {
			m.dragX, m.dragY = msg.X, msg.Y
		}
		delta := 3
		if msg.Button == tea.MouseButtonWheelUp {
			delta = -delta
		}
		m.scrollBy(delta)
		if m.selection.dragging {
			cmd := m.syncDragTimer(wasScrolling)
			return m, cmd
		}
		return m, nil
	}
	if msg.Action == tea.MouseActionRelease {
		if m.selection.dragging {
			m.selection.end = m.mousePoint(msg.X, msg.Y)
		}
		m.selection.dragging = false
		m.dragTick++
		return m, nil
	}
	if msg.Button != tea.MouseButtonLeft {
		return m, nil
	}
	if msg.Action == tea.MouseActionPress {
		if msg.Y < 0 || msg.Y >= m.viewHeight() || len(m.lines) == 0 {
			return m, nil
		}
		m.copyStatus = ""
		point := m.mousePoint(msg.X, msg.Y)
		m.selection = selection{start: point, end: point, active: true, dragging: true}
		m.follow = false
		m.dragTick++
		wasScrolling = false
	} else if !m.selection.dragging {
		return m, nil
	}
	m.dragX, m.dragY = msg.X, msg.Y
	m.selection.end = m.mousePoint(msg.X, msg.Y)
	// Keep the timer alive during edge motion instead of postponing every tick.
	cmd := m.syncDragTimer(wasScrolling)
	return m, cmd
}

func (s selection) bounds() (textPoint, textPoint) {
	a, b := s.start, s.end
	if a.row > b.row || (a.row == b.row && a.col > b.col) {
		a, b = b, a
	}
	return a, b
}

func (m model) highlightLine(row int, line string) string {
	return m.highlightWrappedLine(visualRow{row, 0, ansi.StringWidth(line)}, line)
}

func (m model) highlightWrappedLine(row visualRow, line string) string {
	if !m.selection.active {
		return line
	}
	a, b := m.selection.bounds()
	if row.line < a.row || row.line > b.row {
		return line
	}
	width := ansi.StringWidth(line)
	start, end := 0, width
	if row.line == a.row {
		start = min(max(0, a.col-row.start), width)
	}
	if row.line == b.row {
		end = min(max(0, b.col+1-row.start), width)
	}
	if start >= end {
		return line
	}
	// Match Fizzer: retain foreground/styles and override only the background.
	// Reapply it after embedded SGR resets or background changes.
	selected := selectionSGR.ReplaceAllString(ansi.Cut(line, start, end), "${0}"+selectionBackground)
	return ansi.Cut(line, 0, start) + selectionBackground + selected + colorReset + ansi.Cut(line, end, width)
}
