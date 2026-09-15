# awatch

`awatch` is a small terminal monitor for file edits and alock activity. It
listens on a Unix domain socket and renders incoming events in a Bubble Tea
interface. Edit diffs are shown inline, and lock grants, shared locks, and
lock conflicts get dedicated banners.

awatch displays events supplied by agents and lock tools; it does not scan
directories for changes. Run it before starting event producers to see their
activity. Each viewer holds its own display history in memory; a shared
collector retains bounded replay for viewers that connect later.

## Code layout

- `main.go` defines events, decodes JSON/DTOB, and renders edits and locks.
- `listener.go` owns the socket and handles reconnects and shutdown.
- `collector.go` broadcasts events to independent viewers and retains replay.
- `tui.go` manages the Bubble Tea model, event batches, and viewport.
- `wrap.go` and `selection.go` handle wrapped rows, selection, and copying.
- `diffstat.go` and `smartstat.go` compute and display compact change counts.
- `keyboard.go` handles extended terminal keyboard input.
- `tool_hook.py` adapts Codex/Claude hook events to the socket protocol.
- `test/` contains regression tests; `benchmark-results/` records benchmarks.

## Requirements

- Go 1.26.1 or newer
- CGO and a C compiler
- The `libdtob` submodule, for the binary DTOB event format
- Git, used to align old and new file contents into a compact diff

Initialize the DTOB dependency and build:

```sh
git submodule update --init --recursive
make -C libdtob
go build -o awatch .
```

Run the tests with:

```sh
python3 test/run.py
```

Tests live in `test/`. The runner uses a temporary Go overlay to test the
application's unexported functions without moving or copying source files.
Pass Go test flags through it, for example `python3 test/run.py -race`.

The cgo directives in `main.go` link against `libdtob/libdtob.a`. If that
archive is not already present, build it first:

```sh
make -C libdtob
```

## Running

Start the monitor with:

```sh
./awatch
```

Any number of awatch viewers can run together, including the Fizzer panel.
The first viewer starts a detached collector automatically. Producers still
send to `/tmp/awatch.sock`; viewers subscribe on `/tmp/awatch.sock.viewers`.
Every viewer receives the same events with independent scrolling, selection,
and expanded/collapsed state. Closing a viewer leaves the collector and other
viewers running. The collector remains running after the last viewer closes.

New viewers replay up to 1,024 recent events, capped at 16 MiB of serialized
event data. Reconnecting viewers resume after their last received event.
A collector restart or expired replay produces a visible history-gap notice.
Slow viewers reconnect rather than blocking producers or other viewers.
Their existing display history remains intact; collector replay is not persisted
across a collector restart. Events sent while the producer socket is unavailable
cannot be replayed.

When upgrading from the old single-instance awatch, quit the old process once,
then launch the rebuilt executable. Already-open new viewers retry automatically.
An older process's history cannot be imported. Stale sockets left by a crash
are recovered automatically, and the collector checks socket health every second.

`awatch --collector` runs the collector in the foreground for supervision.
Ordinary use requires only `awatch`; there is no configuration file.

## Input protocol

awatch accepts two event formats on the socket.

### JSON

Send one JSON object per line. The supported fields are:

| Field | Type | Meaning |
| --- | --- | --- |
| `kind` | string | Event kind; `lock` renders a lock event. |
| `agent` | string | Agent responsible for the event. |
| `author` | string | Edit author supplied to alock; preferred over the agent as the displayed name. |
| `conflict_agent` | string | Agent that owns the conflicting/shared lock. |
| `result` | string | Lock result, such as `conflict` or `shared`. |
| `tool` | string | Tool name for tool activity events. |
| `detail` | string | Short description or path for tool activity events. |
| `file` | string | Edited or locked file path. |
| `line_start` | integer | First affected line. |
| `line_end` | integer | Last affected line; `2147483647` means end-of-file. |
| `old_lines` | string array | Previous file lines. |
| `new_lines` | string array | Replacement file lines. |
| `timestamp` | integer | Unix timestamp in seconds. |

For example:

```json
{"kind":"edit","agent":"codex","file":"src/main.go","line_start":10,"line_end":12,"old_lines":["old"],"new_lines":["new"],"timestamp":1710000000}
```

### DTOB

Binary events are framed with a four-byte little-endian unsigned payload
length, followed by a DTOB-encoded key/value object containing the same fields
as the JSON format. DTOB decoding is provided by `libdtob`.

## Keyboard controls

- `Ctrl+O` — toggle expanded diffs and collapsed event summaries
- `g` — jump to the top
- `G` — jump to the bottom
- `Up`/`Down` or `k`/`j` — scroll one line
- `Page Up`/`Page Down` — scroll one page
- Mouse wheel — scroll three lines
- Left drag — highlight text with Fizzer's dark gray background, retaining text
  colors; hold at either edge for fast scrolling, faster still outside the viewport
- `Command+C` — copy awatch's selection in Ghostty (with its performable native
  copy binding); `y` or `Ctrl+Y` also copies, including offscreen lines (macOS: `pbcopy`;
  Linux: `wl-copy` or `xclip`; Windows: `clip`)
- `Esc` — clear the selection
- `q` or `Ctrl+C` — quit

The viewport follows new events when it was already at the bottom. Selecting
text pauses following; clearing the selection with `Esc` at the bottom resumes
following. Scrolling back to the bottom or pressing `G` also resumes it. Highlights persist through scrolling,
resizing, and incoming events. Toggling diffs clears the selection because it
changes the displayed log lines. Hold your terminal's selection override key
(usually Shift or Option) to use native terminal selection instead.

Incoming events are processed in bounded batches, with diff generation outside
the input loop. Long lines wrap to the terminal width, retaining their colors.
Scrolling and selection follow the wrapped rows; copying preserves the original
line breaks. Resizing reflows the log and keeps the current reading position.
Rendered visible rows are cached with a viewport-sized limit,
so repeated redraw work does not grow with the length of the event history.
Event history itself remains in memory for scrolling and selection.

The bottom status line always includes colored session totals `(+N *N ~N -N)`
across every received edit, file, and agent. These sum activity during this
awatch run, not a net diff against starting file contents. Lock and tool events
do not change the totals; switching views does not recount them.

`tool_hook.py codex` / `tool_hook.py claude` accept agent hook JSON on stdin and
send tool-start/completion/failure events to awatch. Read, get, list, search,
grep, glob, fetch, view, and inspection tools are excluded. Tool names, session
identity, status, and short path/description details are logged; complete tool
inputs and outputs are not. Hook delivery times out after 50 ms if awatch is
unavailable. Configure your agent's hooks to call this script; cloning awatch
does not install hooks automatically. Newly started agent sessions pick up
changed hook configuration.

## Event rendering

- The file path is printed when the file changes from the previous event.
- Normal edits show the affected range and a Git histogram diff. Added and
  deleted blocks show their line contents directly.
- Collapsed mode (Ctrl+O) shows one left-aligned smart-stat row per edit:
  `12:34:56 src/main.go | 5 +*~~- (+1 *1 ~2 -1) | bot lines 10-12`.
  Every event summary uses the same dim `HH:MM:SS` timestamp at the left edge,
  including expanded edits, lock grants, shared locks, and conflicts.
  Following `git-smart-stat`, green `+` means insertion, cyan `*` movement,
  yellow `~` modification, and red `-` deletion. Similar removed/added lines
  are paired at 50% byte-based Levenshtein similarity; identical moved blocks
  across change groups require at least 20 alphanumeric characters. A paired
  modification or movement counts once, not as an insertion plus deletion.
  Classification is per event; moves between separate events cannot be matched.
  Bars are capped at 30 characters with exact counts alongside them. Stats share
  the expanded view's cached Git diff and are cached before source is released.
  The view uses smart-stat's compact style; whole-file line totals are omitted
  because events may contain only a changed range.
- Lock events distinguish granted locks, shared locks, and conflicts. A line
  range ending at `2147483647` is displayed as `lines N-end`; a whole-file
  range (`1` through `2147483647`) is displayed as `file`.
