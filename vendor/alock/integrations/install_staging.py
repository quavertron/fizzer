#!/usr/bin/env python3
"""Preview by default; --apply installs the same shared hook into local hosts."""
import json
from pathlib import Path
import shlex
import shutil
import sys
import tempfile

home = Path.home()
script = Path(__file__).with_name("staging_hook.py").resolve()
matcher = "Edit|Write|MultiEdit|apply_patch|ApplyPatch|search_replace|replace_file_content|multi_replace_file_content|write_to_file"


def group(host, phase):
    return {"matcher": matcher, "hooks": [{"type": "command", "timeout": 60,
            "command": f"python3 {shlex.quote(str(script))} {host} {phase}"}]}


def hooks(host):
    result = {"PreToolUse": [group(host, "pre")], "PostToolUse": [group(host, "post")]}
    if host != "agy":
        if host != "codex":
            result["PostToolUseFailure"] = [group(host, "abort")]
        result["Stop"] = [{"hooks": group(host, "feedback")["hooks"]}]
    else:
        result["PreInvocation"] = group(host, "feedback")["hooks"]
    return result


def read(path):
    return json.loads(path.read_text()) if path.exists() else {}


writes = {}
claude = home / ".claude/settings.json"
settings = read(claude)
for event, groups in settings.get("hooks", {}).items():
    for item in groups:
        item["hooks"] = [h for h in item.get("hooks", []) if "alock" not in h.get("command", "")]
    settings["hooks"][event] = [item for item in groups if item.get("hooks")]
for event, groups in hooks("claude").items():
    settings.setdefault("hooks", {}).setdefault(event, []).extend(groups)
writes[claude] = settings
agy = home / ".gemini/config/hooks.json"
settings = read(agy)
settings.pop("alock-editor-guard", None)
settings["alock-staging"] = hooks("agy")
writes[agy] = settings
writes[home / ".grok/hooks/alock-staging.json"] = {"hooks": hooks("grok")}
plugin = home / "plugins/alock-enforcer"
codex_hooks = hooks("codex")
codex_hooks["SessionStart"] = [{"hooks": [{"type": "command", "timeout": 10,
    "command": f"python3 {shlex.quote(str(plugin / 'scripts/session_start.py'))}"}]}]
writes[plugin / "hooks/hooks.json"] = {"hooks": codex_hooks}
# Codex discovers hooks/hooks.json in plugin roots.
manifest = read(plugin / ".codex-plugin/plugin.json")
if manifest:
    manifest.pop("hooks", None)
    manifest["description"] = "Stage native edits and commit through alock."
    manifest["interface"]["shortDescription"] = "Native edits staged and validated by alock."
    manifest["interface"]["longDescription"] = "Redirect native edit tools to temporary copies; alock commits only changes covered by their locks."
    writes[plugin / ".codex-plugin/plugin.json"] = manifest
wrappers = {plugin / "scripts/pre_write_alock_check.sh": "pre",
            plugin / "scripts/post_tool_log.sh": "post"}
obsolete = [home / ".claude/hooks/alock-hook.sh", home / ".claude/hooks/alock-release-agent.sh",
            home / ".gemini/config/scripts/alock_hook.py",
            ]

if "--apply" in sys.argv:
    backup = Path(tempfile.mkdtemp(prefix="alock-hook-backup-"))
    for path in list(writes) + obsolete + list(wrappers):
        if path.exists():
            dest = backup / path.relative_to(home)
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, dest)
    for path, data in writes.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, indent=2) + "\n")
    # Existing Codex threads still reference these absolute command paths.
    for path, phase in wrappers.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"#!/bin/sh\nexec python3 {shlex.quote(str(script))} codex {phase}\n")
        path.chmod(0o755)
    for path in obsolete:
        path.unlink(missing_ok=True)
    print(f"Installed staging hooks. Previous files saved in {backup}")
else:
    for path, data in writes.items():
        print(f"WRITE {path}\n{json.dumps(data, indent=2)}")
    for path in obsolete:
        print(f"REMOVE obsolete hook: {path}")
