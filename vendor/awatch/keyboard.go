package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
)

func enableKeyboardProtocol() tea.Msg {
	// Init runs after Bubble Tea enters the alternate screen. Kitty flags are
	// screen-local, so this leaves the shell's keyboard behavior alone.
	fmt.Fprint(os.Stdout, "\x1b[=1u")
	return nil
}

func decodeTerminalKey(msg tea.Msg) (tea.KeyMsg, bool) {
	s, ok := msg.(fmt.Stringer)
	if !ok {
		return tea.KeyMsg{}, false
	}
	text := s.String()
	// Bubble Tea v1 represents unsupported CSI sequences as decimal bytes.
	if !strings.HasPrefix(text, "?CSI[") || !strings.HasSuffix(text, "]?") {
		return tea.KeyMsg{}, false
	}
	var raw strings.Builder
	for _, part := range strings.Fields(text[5 : len(text)-2]) {
		n, err := strconv.Atoi(part)
		if err != nil || n < 0 || n > 127 {
			return tea.KeyMsg{}, false
		}
		raw.WriteByte(byte(n))
	}
	sequence := raw.String()
	if !strings.HasSuffix(sequence, "u") {
		return tea.KeyMsg{}, false
	}
	parts := strings.Split(strings.TrimSuffix(sequence, "u"), ";")
	code, err := strconv.Atoi(parts[0])
	if err != nil {
		return tea.KeyMsg{}, false
	}
	mods := 1
	if len(parts) > 1 {
		mods, err = strconv.Atoi(parts[1])
		if err != nil {
			return tea.KeyMsg{}, false
		}
	}
	mods--
	if mods&8 != 0 && (code == 'c' || code == 'C') {
		return tea.KeyMsg{Type: tea.KeyCtrlY}, true
	}
	if mods&4 != 0 && code >= 'a' && code <= 'z' {
		return tea.KeyMsg{Type: tea.KeyType(code - 'a' + 1)}, true
	}
	if code == 27 || code == 13 || code == 9 || code == 127 {
		return tea.KeyMsg{Type: tea.KeyType(code), Alt: mods&2 != 0}, true
	}
	return tea.KeyMsg{}, false
}
