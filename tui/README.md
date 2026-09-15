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
pastes stay in the draft until sent, and long drafts wrap across rows. Tab changes
panes; F1 toggles Chats, F2 Agents/Users, F3 Notes, and F4 opens Vaults. Esc or
Ctrl+C quits.

Run focused checks with:

```sh
cargo test --manifest-path tui/Cargo.toml
cargo build --locked --manifest-path tui/Cargo.toml
```

The live backend smoke test is opt-in and requires a local authenticated server:

```sh
cargo test --manifest-path tui/Cargo.toml test_live_elixir_backend_connection -- --ignored
```
