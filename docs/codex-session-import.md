# Import a local Codex session

Open the destination vault first, whether local or remote.

- Electron: open **Sessions**, choose **Import local Codex session**, then select a session. Search and Previous/Next browse sessions on your computer.
- TUI: press **F6**, select a session with the arrow keys, then press **Enter**. Use **n/p** for the next/previous page and **Esc** to close the picker.

Fizzer copies a snapshot of the session's user and assistant text into a chat channel. Browsing does not upload history; selecting a session shares those messages with the destination vault's members. History is read in bounded pages, without subscribing to future messages from the original terminal.

Send a message in the imported channel to resume the original Codex session through your local runner. The original session retains its full context; imported chat history omits tool records, images, and system/developer instructions. If that session is still working elsewhere, finish its current turn first. Fizzer will not interrupt it or silently replace it with a fresh session.

Importing the same session again into the same vault/account reuses its channel and skips messages already copied. After a Fizzer run takes over, reimporting opens that channel without duplicating its output.

The destination server needs the session-import endpoint from this change. Local discovery requires Codex's local `state_5.sqlite` history index; the TUI also needs Node 24+, as does its existing local runner. Resuming requires the session and its working directory on the runner's computer.
