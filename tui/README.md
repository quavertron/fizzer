# Fizzer

Install the public npm command. Supported systems receive a prebuilt binary:

```sh
npm install -g fizzer
fizzer
```

For a project-local install, use `npx fizzer` after `npm install fizzer`. Rust/Cargo
is only required when running from source or on a platform without a prebuilt binary.

Initialize the pinned Ratatui submodule, then start the TUI with Rust/Cargo:

```sh
git submodule update --init --recursive tui/vendor/ratatui
npm run tui
```

This launches the native `fizzer` executable. After building, you can also run
`./tui/target/debug/fizzer` directly.

The submodule uses upstream `https://github.com/ratatui/ratatui.git`, pinned to
`a0189ae4af65f85affef2a4b52bc53551cf50a1d`. It replaces the previous sibling-checkout
dependency. Cloning with `git clone --recurse-submodules` initializes it too.

The default API is `http://localhost:3000`. Set `CASCADE_URL` and
`CASCADE_NOTE_TOKEN` (or use `~/.fizzer/token`) for another authenticated
instance. `CASCADE_NOTE_VAULT` selects a vault explicitly. The selected instance
and vault are remembered in `~/.fizzer/tui.json`. If discovery fails, use the
panel refresh action to retry it.

History starts with the latest 8 messages. Page Up or scrolling to the top
loads older messages in batches of 20 without blocking input.

Enter sends; Shift+Enter, Alt+Enter or Ctrl+J inserts a newline. Multiline
pastes stay in the draft until sent, and long drafts wrap across rows.
Use `C-x b` to choose a buffer, `C-x o` to switch windows, `C-x 2` / `C-x 3`
to split below/right, `C-x 0` to close a window, and `C-x 1` to keep only
the current window. `M-x` opens named commands; `C-x C-c` quits.

## Awatch buffer

Choose `Awatch` with `C-x b`, or run `M-x fizzer-awatch`. Fizzer embeds
the existing awatch terminal interface and keeps its process and history alive
when you switch buffers or close its window. Duplicate Awatch windows share
one terminal viewport, sized to the focused Awatch window when possible.

Provide an awatch executable using `FIZZER_AWATCH_BIN=/absolute/path/to/awatch`.
Fizzer also checks beside its own executable, then `.native-tools/awatch`
in a source build, then `/usr/local/libexec/fizzer/awatch`, then `awatch` on
PATH. Run `npm run build:agent-tools` to build the bundled helpers; see
[`vendor/README.md`](../vendor/README.md) for source-build prerequisites.

Emacs window commands remain available inside the buffer. `C-n` / `C-p`
scroll lines, `C-v` / `M-v` scroll pages, and `M-<` / `M->` jump to the
top/bottom. Awatch's `C-o` toggles diffs; mouse selection and `y` / `C-y`
copy remain available. `q` stops awatch; Enter restarts it. `C-c C-k` or
`M-x term-char-mode` enables character mode, where `C-c` passes to awatch.
Quitting Fizzer stops the child process.

## Inline SVG

Raw `<svg>...</svg>` documents and `svg` fenced blocks in chat are sent to the
bundled native purrvect encoder, built from `tui/vendor/purrvect` at the repository
root. `mermaid` fenced blocks are rendered to SVG in-process, then use the same
purrvect path. Inline backtick examples, invalid Mermaid diagrams, and other code
fences stay text. The TUI handles placement and resize; purrvect owns the SVG transport.
This requires a terminal with the purrvect SVG adapter, such as patched Ghostty;
ordinary Kitty-protocol support alone does not implement this extension.
`FIZZER_PURRVECT_BIN` can select another native helper. SVGs render only when their
reserved rows fit fully inside the visible chat viewport.

With the shared-collector version of awatch, this panel and standalone viewers
receive the same events concurrently. The collector owns `/tmp/awatch.sock`
and retains bounded replay; each viewer keeps its own scrolling and selection.
Quit any older single-instance awatch once when upgrading. The panel shows
startup errors and offers Enter to retry.

Run focused checks with:

```sh
cargo test --manifest-path tui/Cargo.toml
cargo build --locked --manifest-path tui/Cargo.toml
```

The live backend smoke test is opt-in and requires a local authenticated server:

```sh
cargo test --manifest-path tui/Cargo.toml test_live_elixir_backend_connection -- --ignored
```
