import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import socket
from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("hook", ROOT / "integrations/staging_hook.py")
hook = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(hook)


class StagingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.file = self.root / "file.txt"
        self.file.write_bytes(b"one\ntwo\nthree\n")
        self.stages = []
        hook.STATE = self.root / "state"

    def tearDown(self):
        for path, agent, file in self.stages:
            self.cli("abort", "--file", str(file), "--agent", agent, "--stage", str(path), check=False)
        self.tmp.cleanup()

    def cli(self, *args, check=True, input=None):
        if args[0] in {"commit", "write"} and "--author" not in args:
            args = (*args, "--author", "staging-test")
        result = subprocess.run([os.environ.get("ALOCK_BIN", str(ROOT / "alock")), *args], input=input, capture_output=True, text=True, timeout=10)
        if check:
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)
        return result

    def stage(self, lines="1-3", agent="test-a", file=None):
        file = file or self.file
        path = Path(self.cli("stage", "--file", str(file), "--lines", lines, "--agent", agent)["stage"])
        self.stages.append((path, agent, file))
        return path

    def commit(self, path, agent="test-a", file=None, check=True):
        return self.cli("commit", "--file", str(file or self.file), "--agent", agent, "--stage", str(path), check=check)

    def test_missing_author_rejected_before_mutation(self):
        binary = os.environ.get("ALOCK_BIN", str(ROOT / "alock"))
        staged = self.stage()
        before = self.file.read_bytes()
        result = subprocess.run([binary, 'commit', '--file', str(self.file), '--agent', 'test-a', '--stage', str(staged)], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('--author', result.stderr)
        self.assertEqual(self.file.read_bytes(), before)
        self.cli('abort', '--file', str(self.file), '--agent', 'test-a', '--stage', str(staged))

    def operation(self, *options, lines="1-2147483647", check=True):
        result = self.cli("stage", "--file", str(self.file), "--lines", lines,
                          "--agent", "test-a", *options, check=check)
        if not check:
            return result
        path = Path(result["stage"])
        self.stages.append((path, "test-a", self.file))
        return path

    def test_delete_commit_and_missing_proposal(self):
        path = self.operation("--delete")
        self.assertNotEqual(self.commit(path, check=False).returncode, 0)
        self.assertTrue(self.file.exists())
        path = self.operation("--delete")
        path.unlink()
        self.assertTrue(self.file.exists())
        self.commit(path)
        self.assertFalse(self.file.exists())

    def test_rename_with_edits_and_permissions(self):
        self.file.chmod(0o755)
        dest = self.root / "renamed.txt"
        path = self.operation("--to", str(dest))
        path.write_bytes(b"changed")
        self.assertFalse(dest.exists())
        self.commit(path)
        self.assertFalse(self.file.exists())
        self.assertEqual(dest.read_bytes(), b"changed")
        self.assertEqual(dest.stat().st_mode & 0o777, 0o755)

    def test_operations_require_exclusive_whole_file(self):
        self.assertNotEqual(self.operation("--delete", lines="1-1", check=False).returncode, 0)
        self.stage("3-3", "test-b")
        self.assertNotEqual(self.operation("--delete", check=False).returncode, 0)
        self.assertNotEqual(self.operation("--to", str(self.root / "dest"), check=False).returncode, 0)

    def test_rename_destination_reservation_and_abort(self):
        dest = self.root / "dest"
        path = self.operation("--to", str(dest))
        result = self.cli("stage", "--file", str(dest), "--lines", "1-1", "--agent", "test-b", check=False)
        self.assertNotEqual(result.returncode, 0)
        self.cli("abort", "--file", str(self.file), "--stage", str(path), "--agent", "test-a")
        self.assertFalse(dest.exists())
        self.stage("1-1", "test-b", dest)

    def test_rename_does_not_overwrite_destination(self):
        dest = self.root / "dest"
        path = self.operation("--to", str(dest))
        dest.write_bytes(b"concurrent creator")
        self.assertNotEqual(self.commit(path, check=False).returncode, 0)
        self.assertEqual(dest.read_bytes(), b"concurrent creator")
        self.assertTrue(self.file.exists())
        self.assertNotEqual(self.operation("--to", str(dest), check=False).returncode, 0)
        self.assertNotEqual(self.operation("--to", str(self.file), check=False).returncode, 0)

    def test_delete_and_rename_reject_stale_baseline(self):
        for options in (("--delete",), ("--to", str(self.root / "dest"))):
            with self.subTest(options=options):
                self.file.write_bytes(b"baseline")
                path = self.operation(*options)
                if options[0] == "--delete":
                    path.unlink()
                self.file.write_bytes(b"baseline appended")
                self.assertNotEqual(self.commit(path, check=False).returncode, 0)
                self.assertEqual(self.file.read_bytes(), b"baseline appended")

    def test_empty_file_delete_and_rename(self):
        self.file.write_bytes(b"")
        dest = self.root / "dest"
        path = self.operation("--to", str(dest))
        self.commit(path)
        self.assertEqual(dest.read_bytes(), b"")
        self.file.write_bytes(b"")
        path = self.operation("--delete")
        path.unlink()
        self.commit(path)
        self.assertFalse(self.file.exists())

    def test_patch_delete_and_rename(self):
        for deleting in (True, False):
            for failed in (True, False):
                with self.subTest(deleting=deleting, failed=failed):
                    self.file.write_bytes(b"one\ntwo\nthree\n")
                    dest = self.root / "dest"
                    body = f"*** Delete File: {self.file}\n" if deleting else (
                        f"*** Update File: {self.file}\n*** Move to: {dest}\n@@\n-two\n+TWO\n")
                    data = {"session_id": "test", "tool_use_id": "operation", "tool_name": "apply_patch",
                            "tool_input": {"command": "*** Begin Patch\n" + body + "*** End Patch\n"}}
                    output = hook.rewrite(data, "codex")
                    command = output["hookSpecificOutput"]["updatedInput"]["command"]
                    self.assertNotIn(str(self.file), command)
                    self.assertNotIn("*** Move to:", command)
                    stage = Path(command.splitlines()[1].split(": ", 1)[1])
                    if deleting:
                        stage.unlink()
                    else:
                        stage.write_bytes(b"one\nTWO\nthree\n")
                    hook.finish(data, "codex", failed=failed)
                    self.assertEqual(self.file.exists(), failed)
                    self.assertEqual(dest.exists(), not deleting and not failed)
                    if dest.exists():
                        self.assertEqual(dest.read_bytes(), b"one\nTWO\nthree\n")
                        dest.unlink()

    def test_native_edit_is_invisible_until_commit(self):
        path = self.stage("2-2")
        path.write_bytes(b"one\nTWO\nthree\n")
        self.assertEqual(self.file.read_bytes(), b"one\ntwo\nthree\n")
        self.commit(path)
        self.assertEqual(self.file.read_bytes(), b"one\nTWO\nthree\n")
        self.assertFalse(path.exists())

    def test_direct_write_uses_atomic_splice_and_shifts_staged_lock(self):
        staged = self.stage("3-3", "test-b")
        self.file.chmod(0o755)
        self.cli("acquire", "--file", str(self.file), "--lines", "1-1", "--agent", "test-writer")
        try:
            with self.file.open("rb") as old_inode:
                self.cli("write", "--file", str(self.file), "--lines", "1-1", "--agent", "test-writer",
                         input="ONE\nextra\n")
                self.assertEqual(old_inode.read(), b"one\ntwo\nthree\n")
            self.assertEqual(self.file.stat().st_mode & 0o777, 0o755)
            staged.write_bytes(b"one\ntwo\nTHREE\n")
            self.commit(staged, "test-b")
            self.assertEqual(self.file.read_bytes(), b"ONE\nextra\ntwo\nTHREE\n")
        finally:
            self.cli("release-agent", "--agent", "test-writer", check=False)

    def test_direct_write_rejects_unlocked_range(self):
        self.cli("acquire", "--file", str(self.file), "--lines", "2-2", "--agent", "test-writer")
        try:
            result = self.cli("write", "--file", str(self.file), "--lines", "1-1", "--agent", "test-writer",
                              input="BAD\n", check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(self.file.read_bytes(), b"one\ntwo\nthree\n")
        finally:
            self.cli("release-agent", "--agent", "test-writer", check=False)

    def test_pipe_command_is_removed(self):
        result = self.cli("pipe", "--file", str(self.file), "--lines", "1-1", "--agent", "test-writer",
                          "--cmd", "touch " + str(self.root / "should-not-exist"), check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / "should-not-exist").exists())

    def test_outside_lock_rejected_without_partial_write(self):
        path = self.stage("2-2")
        path.write_bytes(b"BAD\nTWO\nthree\n")
        self.assertNotEqual(self.commit(path, check=False).returncode, 0)
        self.assertEqual(self.file.read_bytes(), b"one\ntwo\nthree\n")

    def test_disjoint_edit_survives_shift(self):
        a = self.stage("1-1")
        b = self.stage("3-3", "test-b")
        a.write_bytes(b"ONE\nextra\ntwo\nthree\n")
        b.write_bytes(b"one\ntwo\nTHREE\n")
        self.commit(a)
        self.commit(b, "test-b")
        self.assertEqual(self.file.read_bytes(), b"ONE\nextra\ntwo\nTHREE\n")

    def test_empty_and_missing_file_locks(self):
        for missing in (False, True):
            if missing:
                self.file.unlink()
            else:
                self.file.write_bytes(b"")
            path = self.stage("1-1")
            blocked = self.cli("stage", "--file", str(self.file), "--lines", "1-1", "--agent", "test-b", check=False)
            self.assertNotEqual(blocked.returncode, 0)
            path.write_bytes(b"new\n")
            self.commit(path)
            self.assertEqual(self.file.read_bytes(), b"new\n")

    def test_wrong_agent_and_stale_content(self):
        path = self.stage("2-2")
        self.assertNotEqual(self.commit(path, "wrong", check=False).returncode, 0)
        self.file.write_bytes(b"one\nexternal\nthree\n")
        path.write_bytes(b"one\nTWO\nthree\n")
        self.assertNotEqual(self.commit(path, check=False).returncode, 0)
        self.assertIn(b"external", self.file.read_bytes())

    def test_four_host_payloads(self):
        for host in ("codex", "claude", "grok", "agy"):
            with self.subTest(host=host):
                self.file.write_bytes(b"one\ntwo\nthree\n")
                data = {"session_id": "test", "tool_use_id": host, "tool_name": "Edit",
                        "tool_input": {"file_path": str(self.file), "old_string": "two", "new_string": "TWO"}}
                if host == "agy":
                    data = {"conversationId": "test", "stepIdx": 1, "toolCall": {
                        "name": "replace_file_content", "args": {"TargetFile": str(self.file),
                        "TargetContent": "two", "ReplacementContent": "TWO"}}}
                elif host == "grok":
                    data = {"sessionId": "test", "toolUseId": host, "toolName": "search_replace",
                            "toolInput": {"file_path": str(self.file), "old_string": "two", "new_string": "TWO"}}
                output = hook.rewrite(data, host)
                args = output.get("overwrite") or output["hookSpecificOutput"]["updatedInput"]
                path = Path(args.get("file_path") or args["TargetFile"])
                self.assertNotEqual(path, self.file)
                path.write_bytes(b"one\nTWO\nthree\n")
                hook.finish(data, host)
                self.assertEqual(self.file.read_bytes(), b"one\nTWO\nthree\n")

    def test_patch_redirect_and_failed_tool(self):
        data = {"session_id": "test", "tool_use_id": "patch", "tool_name": "apply_patch",
                "tool_input": {"command": f"*** Begin Patch\n*** Update File: {self.file}\n@@\n-two\n+TWO\n*** End Patch\n"}}
        result = hook.rewrite(data, "codex")
        command = result["hookSpecificOutput"]["updatedInput"]["command"]
        self.assertNotIn(str(self.file), command)
        hook.finish(data, "codex", failed=True)
        self.assertEqual(self.file.read_bytes(), b"one\ntwo\nthree\n")

    def test_mode_and_no_final_newline(self):
        self.file.write_bytes(b"one\ntwo")
        self.file.chmod(0o755)
        path = self.stage("2-2")
        path.write_bytes(b"one\nchanged")
        self.commit(path)
        self.assertEqual(self.file.read_bytes(), b"one\nchanged")
        self.assertEqual(self.file.stat().st_mode & 0o777, 0o755)

    def test_simultaneous_overlapping_acquires_have_one_winner(self):
        def acquire(index):
            agent = f"race-{index}"
            result = self.cli("stage", "--file", str(self.file), "--lines", "1-3", "--agent", agent, check=False)
            if not result.returncode:
                self.stages.append((Path(json.loads(result.stdout)["stage"]), agent, self.file))
            return result.returncode
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(acquire, range(8)))
        self.assertEqual(results.count(0), 1)

    def test_released_lock_cannot_commit(self):
        path = self.stage()
        self.cli("release-agent", "--agent", "test-a")
        self.assertNotEqual(self.commit(path, check=False).returncode, 0)
        self.assertEqual(self.file.read_bytes(), b"one\ntwo\nthree\n")

    def test_change_event_only_after_approved_commit_to_original(self):
        directory = Path(os.environ.get("ALOCK_EVENT_DIR", f"/tmp/alock-events-{os.getuid()}"))
        directory.mkdir(mode=0o700, exist_ok=True)
        endpoint = directory / f"test-{os.getpid()}.sock"
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as listener:
            listener.bind(str(endpoint))
            listener.settimeout(0.1)
            try:
                staged = self.stage("2-2")
                staged.write_bytes(b"one\nTWO\nthree\n")
                with self.assertRaises(socket.timeout):
                    listener.recv(65536)
                self.commit(staged)
                event = json.loads(listener.recv(65536))
                self.assertEqual(event["kind"], "change")
                self.assertEqual(Path(event["file"]), self.file.resolve())
                self.assertEqual(event["line_start"], 2)
                self.assertEqual(event["author"], "staging-test")
                staged = self.stage("2-2")
                staged.write_bytes(b"OUTSIDE\nTWO\nthree\n")
                self.assertNotEqual(self.commit(staged, check=False).returncode, 0)
                with self.assertRaises(socket.timeout):
                    listener.recv(65536)
                staged = self.stage("2-2")
                self.cli("abort", "--file", str(self.file), "--agent", "test-a", "--stage", str(staged))
                with self.assertRaises(socket.timeout):
                    listener.recv(65536)
            finally:
                endpoint.unlink(missing_ok=True)

    def test_hardlink_shares_lock_by_inode(self):
        hardlink = self.root / "link_note"
        os.link(self.file, hardlink)
        self.assertEqual(hardlink.stat().st_ino, self.file.stat().st_ino)

        # Agent A stages self.file lines 2-2
        staged_a = self.stage("2-2")

        # Agent B attempts to lock the same range via the hardlink path
        res = self.cli("acquire", "--file", str(hardlink), "--lines", "2-2", "--agent", "test-b", check=False)
        self.assertNotEqual(res.returncode, 0, "Hardlink lock should conflict with original file lock on same inode")

        # Agent A commits
        staged_a.write_bytes(b"one\nTWO\nthree\n")
        self.commit(staged_a)

        # Now Agent B can acquire the lock on the hardlink
        res = self.cli("acquire", "--file", str(hardlink), "--lines", "2-2", "--agent", "test-b", check=False)
        self.assertEqual(res.returncode, 0, res.stderr)
        self.cli("release", "--file", str(hardlink), "--agent", "test-b")

    def test_non_trailing_newline_staging_and_bounds(self):
        no_nl_file = self.root / "no_newline.txt"
        no_nl_file.write_bytes(b"alpha\nbeta")
        # Line 1-2 covers the file
        staged = self.stage("1-2", agent="test-a", file=no_nl_file)
        self.assertEqual(staged.read_bytes(), b"alpha\nbeta")
        self.cli("abort", "--file", str(no_nl_file), "--agent", "test-a", "--stage", str(staged))

        # Line 3 is insertion at EOF
        staged_eof = self.stage("3-3", agent="test-a", file=no_nl_file)
        self.assertEqual(staged_eof.read_bytes(), b"alpha\nbeta")
        self.cli("abort", "--file", str(no_nl_file), "--agent", "test-a", "--stage", str(staged_eof))

        # Line 4 is beyond EOF
        res = self.cli("stage", "--file", str(no_nl_file), "--lines", "4-4", "--agent", "test-a", check=False)
        self.assertNotEqual(res.returncode, 0)


if __name__ == "__main__":
    unittest.main()
