# TUI windows and buffers

Run `npm run tui` from the repository. The interface uses Emacs-style window commands and a command minibuffer. Status, errors, and prefix hints appear in the header; the bottom row remains available for buffer content.

A window is a rectangle on screen; a buffer is its content. Channels, Notes, and Users are directory buffers. Each channel has Chat and Composer buffers; the Agents buffer follows the active chat channel. Any window can display any buffer, including a buffer already visible elsewhere.

`C-x` means press Control+x, release it, then press the following key. `M-x` means Alt+x (Meta+x). Commands target the window with the cyan border.

| Keys | Action |
| --- | --- |
| `C-x b` | Choose a buffer in this window |
| `C-x C-b` | Open the buffer list |
| `C-x 4 b` | Choose a buffer in another window; split if necessary |
| `C-x 2` / `C-x 3` | Split below / right, showing the same buffer |
| `C-x o` | Focus the next window |
| `C-x 0` | Delete this window, retaining its buffer |
| `C-x 1` | Delete the other windows, retaining their buffers |
| `C-x +` | Balance windows |
| `C-x ^` | Enlarge this window vertically |
| `C-x -` | Shrink this window vertically |
| `C-x {` / `C-x }` | Shrink / enlarge this window horizontally |
| `C-x 4 0` | Swap buffers with a vertical neighbor |
| `C-x r w KEY` / `C-x r j KEY` | Save / restore a window configuration in a register |
| `M-x` | Run a named command |
| `C-g` | Cancel the command or picker |
| `C-x C-c` | Quit the TUI |

In the minibuffer, type to filter, use `C-n` / `C-p` or arrows to select, Tab to complete, and Enter to confirm. Paste goes into the prompt, never into the chat draft beneath it.

Use `M-x fizzer-vaults` for the vault chooser, `M-x fizzer-import-codex-session` to import a Codex session, and `M-x revert-buffer` to refresh. Window commands also have names such as `split-window-right`, `other-window`, `delete-other-windows`, and `shrink-window`.

For example: `C-x 3`, `C-x o`, `C-x b`, then select another channel's Chat buffer. Both chats stay visible and continue receiving responses. Typing `Agents` in the buffer picker selects an agents buffer.

Function keys are unbound. Tab no longer cycles windows. The old panel toggles, Alt+e maximize shortcut, Ctrl/Alt+arrow resizing, and custom `C-x r` layout reset are removed. Use the buffer picker, window commands, and `M-x` instead.

A split keeps focus in the original window. Duplicate windows share content but keep separate cursors, selections, and scroll positions. There is no fixed window-count limit; a window must have enough room to split. Deleting a window leaves its channel's draft, attachments, history, and running responses intact. Send completions and background updates remain attached to their originating channel.

Mouse clicks focus the exact window under the pointer. Wheel scrolling targets that window without changing keyboard focus. Pagination preserves selections in duplicate windows at their respective wrapping widths. Typing into a Chat window focuses or opens the Composer for the same channel.

The default layout is Channels on the left, Chat above Composer in the center, and Agents above Users on the right. The default composer grows with its draft; after rearrangement, split ratios control sizes. On small terminals, the focused window temporarily fills the workspace; enlarging the terminal restores the arrangement.

The layout, window registers, and named configuration favorites are saved in `~/.fizzer/tui.json` with the selected vault. Use `M-x save-window-configuration NAME` and `M-x load-window-configuration NAME` for favorites. Unsent drafts remain runtime state. Changing vaults resets the workspace. Note editing still uses the configured external editor. This implements Emacs-style navigation inside Fizzer, not an embedded Emacs or Emacs Lisp runtime.

Window command names and bindings follow the [GNU Emacs window manual](https://www.gnu.org/software/emacs/manual/html_node/emacs/Change-Window.html).
