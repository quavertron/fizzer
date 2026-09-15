package main

/*
#cgo CFLAGS: -I${SRCDIR}/libdtob/lib
#cgo LDFLAGS: ${SRCDIR}/libdtob/libdtob.a
#include <dtob.h>
#include <stdlib.h>

static DtobValue *c_dtob_decode(const void *buf, size_t len) {
    return dtob_decode((const uint8_t *)buf, len);
}

static void c_dtob_free(DtobValue *v) {
    if (v) dtob_free(v);
}

static const uint8_t *c_kvset_raw(const DtobValue *kvs, const char *key, size_t *out_len) {
    return dtob_kvset_raw(kvs, key, out_len);
}

static size_t c_arr_len(const DtobValue *arr) {
    if (!arr || arr->code != DTOB_OPEN_ARR) return 0;
    return arr->num_elements;
}

static const uint8_t *c_arr_elem_data(const DtobValue *arr, size_t idx, size_t *out_len) {
    if (!arr || idx >= arr->num_elements) return NULL;
    DtobValue *v = arr->elements[idx].data.val;
    if (!v) return NULL;
    *out_len = v->data_len;
    return v->data;
}
*/
import "C"
import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
	"unsafe"

	tea "github.com/charmbracelet/bubbletea"
)

const sockPath = "/tmp/awatch.sock"
const wholeFileLineEnd = 2147483647

type EditEvent struct {
	Kind          string   `json:"kind"`
	Agent         string   `json:"agent"`
	Author        string   `json:"author"`
	ConflictAgent string   `json:"conflict_agent"`
	Result        string   `json:"result"`
	Tool          string   `json:"tool"`
	Detail        string   `json:"detail"`
	File          string   `json:"file"`
	LineStart     int      `json:"line_start"`
	LineEnd       int      `json:"line_end"`
	OldLines      []string `json:"old_lines"`
	NewLines      []string `json:"new_lines"`
	Timestamp     int64    `json:"timestamp"`
	diffLines     []string
	diffErr       string
	diffReady     bool
	collapsed     []string
	compact       string
	expanded      []string
	stats         smartCounts
}

func dtobGetString(kvs *C.DtobValue, key string) string {
	ckey := C.CString(key)
	defer C.free(unsafe.Pointer(ckey))
	var outLen C.size_t
	raw := C.c_kvset_raw(kvs, ckey, &outLen)
	if raw == nil || outLen == 0 {
		return ""
	}
	return string(C.GoBytes(unsafe.Pointer(raw), C.int(outLen)))
}

func dtobGetInt(kvs *C.DtobValue, key string) int64 {
	ckey := C.CString(key)
	defer C.free(unsafe.Pointer(ckey))
	return int64(C.dtob_kvset_int(kvs, ckey))
}

func dtobGetUint(kvs *C.DtobValue, key string) uint64 {
	ckey := C.CString(key)
	defer C.free(unsafe.Pointer(ckey))
	return uint64(C.dtob_kvset_uint(kvs, ckey))
}

func dtobGetStringArray(kvs *C.DtobValue, key string) []string {
	ckey := C.CString(key)
	defer C.free(unsafe.Pointer(ckey))
	arrVal := C.dtob_kvset_get(kvs, ckey)
	n := int(C.c_arr_len(arrVal))
	if n == 0 {
		return nil
	}
	res := make([]string, n)
	for i := 0; i < n; i++ {
		var elen C.size_t
		data := C.c_arr_elem_data(arrVal, C.size_t(i), &elen)
		if data != nil && elen > 0 {
			res[i] = string(C.GoBytes(unsafe.Pointer(data), C.int(elen)))
		} else {
			res[i] = ""
		}
	}
	return res
}

func parseDtobEvent(buf []byte) (*EditEvent, error) {
	if len(buf) == 0 {
		return nil, fmt.Errorf("empty buffer")
	}
	cbuf := C.CBytes(buf)
	defer C.free(cbuf)

	root := C.c_dtob_decode(cbuf, C.size_t(len(buf)))
	if root == nil {
		return nil, fmt.Errorf("failed to decode dtob")
	}
	defer C.c_dtob_free(root)

	ev := &EditEvent{
		Kind:          dtobGetString(root, "kind"),
		Agent:         dtobGetString(root, "agent"),
		Author:        dtobGetString(root, "author"),
		ConflictAgent: dtobGetString(root, "conflict_agent"),
		Result:        dtobGetString(root, "result"),
		Tool:          dtobGetString(root, "tool"),
		Detail:        dtobGetString(root, "detail"),
		File:          dtobGetString(root, "file"),
		LineStart:     int(dtobGetUint(root, "line_start")),
		LineEnd:       int(dtobGetUint(root, "line_end")),
		OldLines:      dtobGetStringArray(root, "old_lines"),
		NewLines:      dtobGetStringArray(root, "new_lines"),
		Timestamp:     dtobGetInt(root, "timestamp"),
	}
	return ev, nil
}

const (
	colorReset   = "\033[0m"
	colorRed     = "\033[31m"
	colorGreen   = "\033[32m"
	colorYellow  = "\033[33m"
	colorCyan    = "\033[36m"
	colorMagenta = "\033[35m"
	colorDim     = "\033[2m"
)

type eventMsg EditEvent

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--collector" {
		if err := runCollector(context.Background(), sockPath); err != nil {
			fmt.Fprintln(os.Stderr, "awatch collector:", err)
			os.Exit(1)
		}
		return
	}
	launchTime := time.Now()

	events := make(chan EditEvent, 64)
	status := make(chan string, 1)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		watchCollector(ctx, sockPath, events, status)
	}()

	m := model{
		launchTime:       launchTime,
		events:           events,
		listenerUpdates:  status,
		keyboardProtocol: true,
		expand:           true,
		follow:           true,
		lines:            listeningLines(),
	}

	p := tea.NewProgram(m, tea.WithAltScreen(), tea.WithMouseCellMotion())
	_, err := p.Run()
	cancel()
	<-done
	if err != nil {
		fmt.Fprintf(os.Stderr, "awatch: %v\n", err)
		os.Exit(1)
	}

}

func handleConn(conn net.Conn, events chan<- EditEvent) {
	handleConnContext(context.Background(), conn, events)
}

func handleConnContext(ctx context.Context, conn net.Conn, events chan<- EditEvent) {
	defer conn.Close()

	reader := bufio.NewReader(conn)
	for {
		hdr, err := reader.Peek(1)
		if err != nil {
			break
		}
		if hdr[0] == '{' {
			line, err := reader.ReadBytes('\n')
			if len(line) > 0 {
				var ev EditEvent
				if err := json.Unmarshal(line, &ev); err == nil {
					select {
					case events <- ev:
					case <-ctx.Done():
						return
					}
				}
			}
			if err != nil {
				break
			}
			continue
		}

		var lenBuf [4]byte
		if _, err := io.ReadFull(reader, lenBuf[:]); err != nil {
			break
		}
		length := binary.LittleEndian.Uint32(lenBuf[:])
		if length == 0 || length > 64*1024*1024 {
			break
		}
		buf := make([]byte, length)
		if _, err := io.ReadFull(reader, buf); err != nil {
			break
		}
		ev, err := parseDtobEvent(buf)
		if err == nil {
			select {
			case events <- *ev:
			case <-ctx.Done():
				return
			}
		}
	}
}

// Keep event identities absolute; abbreviate only the displayed path.
func displayPath(path string) string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" || home == string(filepath.Separator) {
		return path
	}
	home = filepath.Clean(home)
	clean := filepath.Clean(path)
	if clean == home {
		return "~"
	}
	if strings.HasPrefix(clean, home+string(filepath.Separator)) {
		return "~" + strings.TrimPrefix(clean, home)
	}
	return path
}

func renderEvent(ev *EditEvent, lastFile *string, expand bool) []string {
	var out []string
	ts := time.Unix(ev.Timestamp, 0).Format("15:04:05")
	agent := ev.Agent
	if agent == "" {
		agent = "?"
	}
	if ev.Author != "" {
		agent = ev.Author
	}
	who := fmt.Sprintf("%s %s%s%s", eventTimestamp(ts), colorMagenta, agent, colorReset)
	if ev.Kind == "tool" {
		return []string{fmt.Sprintf("%s %stool%s %s %s %s", who, colorCyan, colorReset, ev.Tool, ev.Result, displayPath(ev.Detail)), ""}
	}

	if ev.Kind == "lock" {
		return renderLockEvent(ev, lastFile, ts, agent)
	}
	who = fmt.Sprintf("%s by %s", eventTimestamp(ts), agent)
	if !expand {
		pathPrefix := ""
		if ev.File != *lastFile {
			pathPrefix = fmt.Sprintf("%s%s%s | ", colorCyan, displayPath(ev.File), colorReset)
		}
		*lastFile = ev.File
		stat := renderDiffStat(ev)
		row := func(stat string) string {
			return fmt.Sprintf("%s %s%s %sby %s%s", eventTimestamp(ts), pathPrefix, stat, colorReset, agent, editRangeSuffix(ev))
		}
		if ev.diffErr == "" && ev.stats.adds+ev.stats.moves+ev.stats.mods+ev.stats.dels > 0 {
			ev.compact = row(ev.stats.colored(true))
		}
		return []string{
			row(stat),
			"",
		}
	}

	if ev.File != *lastFile {
		out = append(out, fmt.Sprintf("%s%s%s", colorCyan, displayPath(ev.File), colorReset))
		*lastFile = ev.File
	}

	oldCount := len(ev.OldLines)
	newCount := len(ev.NewLines)

	if oldCount == 0 && newCount > 0 {
		out = append(out, fmt.Sprintf("%s added lines %d-%d", who, ev.LineStart, ev.LineStart+newCount-1))
		if expand {
			out = appendDiffLines(out, ev.LineStart, ev.NewLines, '+', colorGreen)
		}
		out = append(out, "")
		return out
	}

	if oldCount > 0 && newCount == 0 {
		out = append(out, fmt.Sprintf("%s deleted lines %d-%d", who, ev.LineStart, ev.LineEnd))
		if expand {
			out = appendDiffLines(out, ev.LineStart, ev.OldLines, '-', colorRed)
		}
		out = append(out, "")
		return out
	}

	out = append(out, who+editRangeSuffix(ev))
	out = appendGitDiff(out, ev)
	out = append(out, "")
	return out
}
func appendDiffLines(out []string, start int, lines []string, sign byte, color string) []string {
	for i, line := range lines {
		out = append(out, fmt.Sprintf("  %s%3d%s %s%c %s%s", colorDim, start+i, colorReset, color, sign, line, colorReset))
	}
	return out
}

func wholeFileRange(ev *EditEvent) bool {
	return ev.LineStart <= 1 && ev.LineEnd >= wholeFileLineEnd
}

func editRangeSuffix(ev *EditEvent) string {
	if wholeFileRange(ev) {
		return ""
	}
	return " " + lineRangeLabel(ev)
}

func lineRangeLabel(ev *EditEvent) string {
	if wholeFileRange(ev) {
		return "file"
	}
	if ev.LineEnd >= wholeFileLineEnd {
		return fmt.Sprintf("lines %d-end", ev.LineStart)
	}
	return fmt.Sprintf("lines %d-%d", ev.LineStart, ev.LineEnd)
}

func lockTarget(ev *EditEvent) string {
	if wholeFileRange(ev) {
		return displayPath(ev.File)
	}
	if ev.LineEnd >= wholeFileLineEnd {
		return fmt.Sprintf("%s:%d-end", displayPath(ev.File), ev.LineStart)
	}
	return fmt.Sprintf("%s:%d-%d", displayPath(ev.File), ev.LineStart, ev.LineEnd)
}

func ensureGitDiff(ev *EditEvent) {
	if !ev.diffReady {
		lines, err := gitDiffLines(ev.OldLines, ev.NewLines)
		ev.diffLines = lines
		if err != nil {
			ev.diffErr = err.Error()
		}
		ev.diffReady = true
	}
}

func appendGitDiff(out []string, ev *EditEvent) []string {
	ensureGitDiff(ev)
	if ev.diffErr != "" {
		return append(out, fmt.Sprintf("  %sdiff unavailable: %s%s", colorYellow, ev.diffErr, colorReset))
	}
	for _, line := range ev.diffLines {
		color := colorReset
		switch {
		case strings.HasPrefix(line, "@@"):
			color = colorCyan
		case strings.HasPrefix(line, "-"):
			color = colorRed
		case strings.HasPrefix(line, "+"):
			color = colorGreen
		}
		out = append(out, fmt.Sprintf("  %s%s%s", color, line, colorReset))
	}
	return out
}

// gitDiffLines delegates alignment and hunk generation to Git. Headers naming
// temporary files are omitted; the hunk and changed lines are returned intact.
func gitDiffLines(oldLines, newLines []string) ([]string, error) {
	oldFile, err := os.CreateTemp("", "awatch-old-*")
	if err != nil {
		return nil, err
	}
	oldPath := oldFile.Name()
	defer os.Remove(oldPath)

	newFile, err := os.CreateTemp("", "awatch-new-*")
	if err != nil {
		oldFile.Close()
		return nil, err
	}
	newPath := newFile.Name()
	defer os.Remove(newPath)

	write := func(file *os.File, lines []string) error {
		if _, err := file.WriteString(strings.Join(lines, "\n") + "\n"); err != nil {
			file.Close()
			return err
		}
		return file.Close()
	}
	if err := write(oldFile, oldLines); err != nil {
		newFile.Close()
		return nil, err
	}
	if err := write(newFile, newLines); err != nil {
		return nil, err
	}

	output, err := exec.Command("git", "diff", "--no-index", "--no-color", "--no-ext-diff",
		"--diff-algorithm=histogram", "--unified=0", "--", oldPath, newPath).CombinedOutput()
	if err != nil {
		var exitErr *exec.ExitError
		if !errors.As(err, &exitErr) || exitErr.ExitCode() != 1 {
			return nil, fmt.Errorf("git diff: %s", strings.TrimSpace(string(output)))
		}
	}

	patch := strings.Split(strings.TrimSuffix(string(output), "\n"), "\n")
	for i, line := range patch {
		if strings.HasPrefix(line, "@@") {
			body := patch[i:]
			for j, bodyLine := range body {
				if !strings.HasPrefix(bodyLine, "@@") {
					continue
				}
				if end := strings.Index(bodyLine[2:], "@@"); end >= 0 {
					body[j] = bodyLine[:end+4]
				}
			}
			return body, nil
		}
	}
	return nil, nil
}

func eventTimestamp(ts string) string {
	return colorDim + ts + colorReset
}

func renderLockBanner(color, title, verb, relLabel, relAgent string, ev *EditEvent, ts, agent string) []string {
	if relAgent == "" {
		relAgent = "?"
	}
	bar := strings.Repeat("━", 60)
	return []string{
		fmt.Sprintf("%s%s%s", color, bar, colorReset),
		fmt.Sprintf("%s %s%s%s %s %s%s",
			eventTimestamp(ts), color, title, colorReset, agent, verb, editRangeSuffix(ev)),
		fmt.Sprintf("%s  %s %s%s", color, relLabel, relAgent, colorReset),
		fmt.Sprintf("%s%s%s", color, bar, colorReset),
		"",
	}
}

func renderLockEvent(ev *EditEvent, lastFile *string, ts, agent string) []string {
	var out []string
	if ev.File != *lastFile {
		out = append(out, fmt.Sprintf("%s%s%s", colorCyan, displayPath(ev.File), colorReset))
		*lastFile = ev.File
	}

	if ev.Result == "conflict" {
		return append(out, renderLockBanner(colorRed, "LOCK CONFLICT", "wants", "blocked by", ev.ConflictAgent, ev, ts, agent)...)
	}

	if ev.Result == "shared" {
		return append(out, renderLockBanner(colorYellow, "SHARED FILE", "locked", "also held by", ev.ConflictAgent, ev, ts, agent)...)
	}

	out = append(out, fmt.Sprintf("%s %slock granted%s to %s",
		eventTimestamp(ts), colorMagenta, colorReset, agent))
	if !wholeFileRange(ev) {
		out[len(out)-1] += " at " + lineRangeLabel(ev)
	}
	out = append(out, "")
	return out
}
