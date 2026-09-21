#!/usr/bin/env python3
"""Native tool input -> daemon-owned staging copy -> validated commit."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ALOCK = os.environ.get("ALOCK_BIN", str(Path(__file__).resolve().parents[1] / "alock"))
STATE = Path(os.environ.get("ALOCK_HOOK_STATE", "/tmp/alock/hooks"))
EDIT_TOOLS = {"Edit", "Write", "edit", "write", "edit_file", "write_file",
              "replace_file_content", "multi_replace_file_content", "write_to_file",
              "apply_patch", "ApplyPatch", "search_replace", "MultiEdit"}


def call(command, file, agent, *args):
    attribution = ["--author", agent.encode("utf-8")[:32].decode("utf-8", errors="ignore")] if command in {"commit", "write"} else []
    result = subprocess.run([ALOCK, command, "--file", str(file), "--agent", agent, *args, *attribution],
                            capture_output=True, text=True, timeout=15)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or "alock command failed")
    return json.loads(result.stdout)


def identity(data, host):
    session = data.get("session_id") or data.get("sessionId") or data.get("conversationId")
    tool_id = data.get("tool_use_id", data.get("toolUseId", data.get("stepIdx")))
    if not session or tool_id is None:
        raise ValueError("missing session or tool-call identity; refusing an untracked edit")
    key = hashlib.sha256(f"{host}:{session}:{tool_id}".encode()).hexdigest()
    return f"{host}:{key[:40]}", STATE / (key + ".json")


def target(path, data):
    if not isinstance(path, str) or not path:
        raise ValueError("missing edit target")
    cwd = data.get("cwd") or (data.get("workspacePaths") or [os.getcwd()])[0]
    return Path(os.path.realpath(os.path.join(cwd, os.path.expanduser(path))))


def rewrite(data, host):
    tool = data.get("tool_name") or data.get("toolName") or data.get("toolCall", {}).get("name", "")
    if tool not in EDIT_TOOLS:
        return {}
    agent, state = identity(data, host)
    if data.get("toolInputTruncated"):
        raise ValueError("cannot redirect truncated tool input")
    args = dict(data.get("tool_input") or data.get("toolInput") or data.get("toolCall", {}).get("args", {}))
    entries = []

    def stage(path, start=1, end=2147483647, options=()):
        file = target(path, data)
        response = call("stage", file, agent, "--lines", f"{start}-{end}", *options)
        entries.append({"file": str(file), "stage": response["stage"], "agent": agent})
        return response["stage"]

    def allow():
        # New files are written straight to their real path: no stage copy and no
        # lock, so there is nothing that can orphan and no temp path for a host to
        # reject. args is returned unchanged.
        if host == "agy":
            return {"decision": "allow", "overwrite": args}
        return {"hookSpecificOutput": {"hookEventName": "PreToolUse",
                "permissionDecision": "allow", "updatedInput": args}}

    try:
        if state.exists():
            raise ValueError("this tool call already has a pending stage")
        if tool in {"apply_patch", "ApplyPatch"}:
            key = next((k for k in ("command", "patch", "input") if k in args), None)
            patch = args.get(key, "")
            if not isinstance(patch, str) or not patch.startswith("*** Begin Patch\n"):
                raise ValueError("unrecognized patch input")
            seen = set()

            def claim(path):
                file = target(path, data)
                if file in seen:
                    raise ValueError("patch uses a source or destination more than once")
                seen.add(file)
                return file

            def replace(match):
                kind, path, destination = match.groups()
                file = claim(path)
                if kind == "Add":
                    if destination:
                        raise ValueError("Move to requires Update File")
                    if file.exists():
                        raise ValueError("Add File target already exists")
                    return match.group(0)
                options = ()
                if kind == "Delete":
                    if destination:
                        raise ValueError("Move to requires Update File")
                    options = ("--delete",)
                elif destination:
                    dest = claim(destination)
                    options = ("--to", str(dest))
                # A rename edits the source copy; the daemon owns the real move.
                return f"*** {kind} File: {stage(path, options=options)}"

            rewritten, count = re.subn(
                r"^\*\*\* (Update|Add|Delete) File: (.+)(?:\n\*\*\* Move to: (.+))?$",
                replace, patch, flags=re.M)
            if not count or re.search(r"^\*\*\* Move to:", rewritten, re.M):
                raise ValueError("patch has unsupported file targets or misplaced Move to")
            args[key] = rewritten
        else:
            key = next((k for k in ("file_path", "path", "TargetFile", "filePath", "file_name") if k in args), None)
            if not key:
                raise ValueError("unrecognized edit target field")
            file = target(args[key], data)
            try:
                empty = file.stat().st_size == 0
            except FileNotFoundError:
                empty = None
            if empty is None:
                # Absent file: atomically claim the path. The winner writes its real
                # path directly -- no stage copy, no lock, nothing to orphan, and no
                # temp path for a host to reject. A loser here means the file appeared
                # between the stat and the open, i.e. a concurrent creator won, so we
                # bounce this call; on retry the file exists and routes through normal
                # staging instead of clobbering the winner's content.
                try:
                    os.close(os.open(file, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644))
                except FileExistsError:
                    raise ValueError("file is being created by another agent; retry")
                return allow()
            if empty:
                # Nothing to protect in an empty file; write the real path directly.
                return allow()
            start, end = 1, 2147483647
            old = args.get("old_string", args.get("TargetContent"))
            if isinstance(old, str) and old:
                content = file.read_bytes()
                needle = old.encode()
                first, last = content.find(needle), content.rfind(needle)
                if first < 0:
                    raise ValueError("edit text not found")
                start = content[:first].count(b"\n") + 1
                end = content[:last + len(needle) - 1].count(b"\n") + 1
            elif "StartLine" in args and "EndLine" in args:
                start, end = int(args["StartLine"]), int(args["EndLine"])
            args[key] = stage(args[key], start, end)
        STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
        with state.open("x") as output:
            json.dump(entries, output)
        return allow()
    except Exception:
        for entry in entries:
            try:
                call("abort", entry["file"], agent, "--stage", entry["stage"])
            except Exception:
                pass
        raise


def finish(data, host, failed=False):
    _, state = identity(data, host)
    if not state.exists():
        return {}
    entries = json.loads(state.read_text())
    errors = []
    failed = failed or bool(data.get("error")) or data.get("hook_event_name") == "PostToolUseFailure"
    response = data.get("tool_response", data.get("toolResult"))
    if isinstance(response, dict):
        failed = failed or bool(response.get("isError") or response.get("error"))
    for entry in entries:
        try:
            call("abort" if failed else "commit", entry["file"], entry["agent"], "--stage", entry["stage"])
        except Exception as error:
            errors.append(str(error))
    state.unlink()
    if errors:
        raise RuntimeError("; ".join(errors))
    if host == "agy":
        return {}
    return {"hookSpecificOutput": {"hookEventName": "PostToolUse",
            "additionalContext": "alock: staging discarded." if failed else "alock: staged edits committed to original files."}}


def main():
    host, phase = sys.argv[1:3]
    try:
        data = json.load(sys.stdin)
        session = data.get("session_id") or data.get("sessionId") or data.get("conversationId", "")
        feedback = STATE / (hashlib.sha256(f"{host}:{session}".encode()).hexdigest() + ".error")
        if phase == "feedback":
            result = {}
            if feedback.exists():
                reason = feedback.read_text()
                feedback.unlink()
                result = {"injectSteps": [{"ephemeralMessage": reason}]} if host == "agy" else {
                    "decision": "block", "reason": reason}
            print(json.dumps(result))
            return 0
        result = rewrite(data, host) if phase == "pre" else finish(data, host, phase == "abort")
        print(json.dumps(result))
    except Exception as error:
        reason = f"alock: {error}"
        if phase == "pre":
            result = {"decision": "deny", "reason": reason} if host == "agy" else {
                "hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                       "permissionDecisionReason": reason}}
        else:
            result = {"decision": "block", "reason": f"alock commit failed: {error}; verify original files before continuing."}
            if "feedback" in locals():
                STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
                feedback.write_text(result["reason"])
            if host == "agy":
                result = {}
        print(json.dumps(result))
        print(reason, file=sys.stderr)
        return 0 if phase == "pre" else 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
