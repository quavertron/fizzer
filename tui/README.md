# Fizzer TUI

Initialize the pinned Ratatui submodule, then start the TUI with Rust/Cargo:

```sh
git submodule update --init --recursive tui/vendor/ratatui
npm run tui
```

The submodule uses upstream `https://github.com/ratatui/ratatui.git`, pinned to
`a0189ae4af65f85affef2a4b52bc53551cf50a1d`. It replaces the previous sibling-checkout
dependency. Cloning with `git clone --recurse-submodules` initializes it too.

The default API is `http://localhost:3000`. Set `CASCADE_URL` and
`CASCADE_NOTE_TOKEN` (or use `~/.cascade/token`) for another authenticated
instance. `CASCADE_NOTE_VAULT` selects a vault explicitly. If initial vault
discovery fails, the TUI shows demo data; focus a side panel and press `r` to
retry discovery.

Enter sends; Shift+Enter, Alt+Enter or Ctrl+J inserts a newline. Multiline
pastes stay in the draft until sent. Long draft lines scroll horizontally.
Tab changes panes, F1/F2 toggle side panels, and Esc or Ctrl+C quits.

Run focused checks with:

```sh
cargo test --manifest-path tui/Cargo.toml
cargo build --locked --manifest-path tui/Cargo.toml
```

The live backend smoke test is opt-in and requires a local authenticated server:

```sh
cargo test --manifest-path tui/Cargo.toml test_live_elixir_backend_connection -- --ignored
```
