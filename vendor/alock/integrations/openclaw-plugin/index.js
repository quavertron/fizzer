import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const ALOCK = "/Users/diego/mystuff/Coding/alock/alock";
const SOCK_DIR = "/tmp/alock";

function djb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++)
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

function socketPath(filePath) {
  const resolved = resolve(filePath);
  const hash = djb2(resolved).toString(16).padStart(8, "0");
  return `${SOCK_DIR}/${hash}.sock`;
}

function hasDaemon(filePath) {
  return existsSync(socketPath(filePath));
}

function alockExec(args, input) {
  const opts = { stdio: ["pipe", "pipe", "pipe"] };
  if (input != null) opts.input = input;
  return execFileSync(ALOCK, args, opts);
}

export default definePluginEntry({
  id: "alock",
  name: "alock",
  description: "Cooperative file locking for concurrent AI agents",
  register(api) {
    api.registerTool({
      name: "alock_edit",
      description:
        "Edit a file through the alock daemon. Use instead of Edit when working under an alock lock. " +
        "Performs a find-and-replace of old_string with new_string, routed through the alock daemon " +
        "which is the sole writer to locked files.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Absolute path to the file" },
          old_string: { type: "string", description: "The text to find and replace" },
          new_string: { type: "string", description: "The replacement text" },
        },
        required: ["file_path", "old_string", "new_string"],
      },
      async execute(_id, params, ctx) {
        const filePath = params.file_path;
        const agentId = ctx.sessionKey ?? ctx.agentId ?? "unknown";

        if (!hasDaemon(filePath)) {
          return { content: [{ type: "text", text: `alock: no daemon active for ${filePath} — use native Edit instead` }] };
        }

        try {
          alockExec(["check", "--file", filePath, "--agent", agentId]);
        } catch {
          return { content: [{ type: "text", text: `alock: agent ${agentId} has no lock on ${filePath}` }] };
        }

        const fileContent = readFileSync(resolve(filePath), "utf-8");
        const idx = fileContent.indexOf(params.old_string);
        if (idx === -1) {
          return { content: [{ type: "text", text: `alock_edit: old_string not found in ${filePath}` }] };
        }

        const beforeMatch = fileContent.slice(0, idx);
        const lineStart = beforeMatch.split("\n").length;
        const matchLineCount = params.old_string.split("\n").length;
        const lineEnd = lineStart + matchLineCount - 1;

        const lines = fileContent.split("\n");
        const section = lines.slice(lineStart - 1, lineEnd).join("\n");
        const newSection = section.replace(params.old_string, params.new_string);

        try {
          alockExec(
            ["write", "--file", filePath, "--lines", `${lineStart}-${lineEnd}`, "--agent", agentId],
            newSection,
          );
          return { content: [{ type: "text", text: `alock_edit: applied to ${filePath} lines ${lineStart}-${lineEnd} via daemon` }] };
        } catch (err) {
          const stderr = err.stderr ? err.stderr.toString().trim() : err.message;
          return { content: [{ type: "text", text: `alock_edit: write rejected — ${stderr}` }] };
        }
      },
    });

    api.registerTool({
      name: "alock_write",
      description:
        "Write content to a file through the alock daemon. Use instead of Write when working under " +
        "an alock lock. The daemon is the sole writer to locked files.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Absolute path to the file" },
          content: { type: "string", description: "The content to write" },
        },
        required: ["file_path", "content"],
      },
      async execute(_id, params, ctx) {
        const filePath = params.file_path;
        const agentId = ctx.sessionKey ?? ctx.agentId ?? "unknown";

        if (!hasDaemon(filePath)) {
          return { content: [{ type: "text", text: `alock: no daemon active for ${filePath} — use native Write instead` }] };
        }

        try {
          alockExec(["check", "--file", filePath, "--agent", agentId]);
        } catch {
          return { content: [{ type: "text", text: `alock: agent ${agentId} has no lock on ${filePath}` }] };
        }

        const lineCount = params.content.split("\n").length;

        try {
          alockExec(
            ["write", "--file", filePath, "--lines", `1-${lineCount}`, "--agent", agentId],
            params.content,
          );
          return { content: [{ type: "text", text: `alock_write: wrote ${filePath} (${lineCount} lines) via daemon` }] };
        } catch (err) {
          const stderr = err.stderr ? err.stderr.toString().trim() : err.message;
          return { content: [{ type: "text", text: `alock_write: write rejected — ${stderr}` }] };
        }
      },
    });
  },
});
