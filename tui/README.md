# Fizzer TUI

Initialize the pinned Ratatui submodule, then start the TUI with Rust/Cargo:

```sh
git submodule update --init --recursive tui/vendor/ratatui
npm run tui
```

The submodule uses upstream `https://github.com/ratatui/ratatui.git`, pinned to
`a0189ae4af65f85affef2a4b52bc53551cf50a1d`. It replaces the previous sibling-checkout
dependency. Cloning with `git clone --recurse-submodules` initializes it too.

The default API is `http://localhost:3000`. Authentication is token-only: the
TUI reads `CASCADE_NOTE_TOKEN`, then `CASCADE_TOKEN`, then
`~/.cascade/token` (plain text or JSON). It has no interactive login. Set
`CASCADE_URL` for another instance and `CASCADE_NOTE_VAULT` to select a vault.
If initial vault discovery fails, the TUI enters offline mode and clears live
data; fix the connection or token and restart it.

## Controls

- `Enter` sends; `Shift+Enter`, `Alt+Enter`, or `Ctrl+J` inserts a newline.
- Multiline pastes remain in the draft until sent; long lines scroll horizontally.
- `Tab` and `Shift+Tab` move between visible panes.
- `F1`/`Ctrl+B`, `F2`/`Ctrl+G`, and `F3`/`Ctrl+N` toggle channels, agents, and notes.
- `Alt+E` expands the composer; `Ctrl/Alt+Up` and `Ctrl/Alt+Down` resize it.
- `F5` or `Ctrl+R` refreshes while the chat transcript has focus. In the channel pane, `r` refreshes, `n` creates a channel, and `Shift+R` renames one.
- In side panes, arrow keys or `j`/`k` move the selection. In Agents, `n` creates an agent, `s` opens settings, and `Enter` inserts its mention.
- In Notes, `Enter` opens the selected note in `GIT_EDITOR`, `VISUAL`, or `EDITOR` (falling back to `vi`) and saves it after a successful editor exit.
- `Ctrl+V` attaches a clipboard image. `Ctrl+Shift+C` or `Cmd+C` copies selected chat text.
- `Esc` or `Ctrl+C` quits.

Run focused checks with:

```sh
cargo test --manifest-path tui/Cargo.toml
cargo build --locked --manifest-path tui/Cargo.toml
```

The live backend smoke test is opt-in and requires a local authenticated server:

```sh
cargo test --manifest-path tui/Cargo.toml test_live_elixir_backend_connection -- --ignored
```
