# Fizzer product language

Canonical language for Fizzer’s help, feedback, and public issue-reporting surfaces.

## Language

**Fizzer Guide**:
The in-app product-help surface that answers questions from the maintained Fizzer manual and can draft a public **Fizzer tracker** issue from the active **Guide conversation**.
_Avoid_: Phaser guide, help bot

**Guide conversation**:
A locally saved thread with the **Fizzer Guide**. It belongs to one application or browser profile, is separate from vault chat channels, and is the only conversation context used for an issue draft started within it.
_Avoid_: guide chat, guide session

**Fizzer tracker**:
The public GitHub Issues tracker for the Fizzer product at `grm4871/fizzer`. It is the only issue destination owned by the **Fizzer Guide**.
_Avoid_: current project tracker, workspace repository, arbitrary repository

**Product feedback**:
A message sent privately to the Fizzer server owner about a product bug or usability suggestion. It is distinct from a public **Fizzer tracker** issue.
_Avoid_: GitHub issue, report

**Trust-and-safety report**:
A report about a vault, note, message, or member that may violate community rules. It is distinct from **Product feedback** and a **Fizzer tracker** issue.
_Avoid_: product feedback, bug report

## Flagged ambiguities

- “Phaser guide” in planning conversation means **Fizzer Guide**; Phaser is not a product surface in this repository.
- “Create an issue” from the **Fizzer Guide** means propose a public issue for the **Fizzer tracker**, never for the active workspace repository.

## Guide conversation behavior

- **New** starts a separate, empty **Guide conversation**.
- **History** lists locally saved Guide conversations by automatic title and message count. Selecting one reopens its saved turns without merging another conversation into it.
- The trash action deletes a conversation from local history. Deleting the last saved conversation creates a fresh, empty one.

## Fizzer tracker issue workflow

1. In the active **Guide conversation**, the user asks in natural language to create, open, file, or draft an issue.
2. The **Fizzer Guide** drafts from only that active conversation. Other Guide conversations, vault notes, chats, files, traces, attachments, workspaces, and repository contents are outside the drafting context.
3. Fizzer presents an editable public preview of the issue title, body, and `bug` or `enhancement` label. Nothing has been published yet.
4. The user reviews or edits the preview, then chooses **Create issue** once to publish it.

The destination is fixed: `grm4871/fizzer`. The active vault, workspace, and project repository never change it. Creation is available only in the desktop app and runs through the locally installed, authenticated `gh` CLI. The server does not create the issue, and the Guide does not collect a GitHub token.

In the web app, **Create issue** is disabled and the preview directs the user to Fizzer Desktop and a signed-in `gh` CLI. **Discard** closes the preview without publishing. A successful desktop creation adds the new public issue link to the active Guide conversation.

## Reporting boundaries

| Path | Audience and destination | Use |
| --- | --- | --- |
| **Fizzer tracker** issue | Public GitHub issue at `grm4871/fizzer` | Publish a Fizzer bug or enhancement after reviewing its editable preview. |
| **Product feedback** | Private message to the Fizzer server owner | Send a product bug or usability suggestion privately; it does not create a GitHub issue. |
| **Trust-and-safety report** | Moderation report for the relevant Fizzer community surface | Report a vault, note, message, or member that may violate community rules; it is neither Product feedback nor a tracker issue. |

## Example dialogue

> **User:** The Fizzer Guide gave me the wrong setup instructions. Can I report that publicly?
>
> **Guide:** Yes. Draft a Fizzer tracker issue, review exactly what will be public, and approve its creation. Use Product feedback instead if you only want the server owner to receive the message.
