import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("test_changes", Path(__file__).resolve().parents[1] / "test-changes.py")
selector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(selector)


class TestChanges(unittest.TestCase):
    def test_diff_includes_staged_unstaged_and_untracked(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def git(*args):
                return subprocess.run(["git", *args], cwd=root, check=True, capture_output=True)
            git("init")
            (root / "tracked").write_text("original\n")
            git("add", ".")
            git("-c", "user.name=Test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false", "commit", "-m", "initial")
            (root / "tracked").write_text("changed\n")
            (root / "staged").write_text("staged\n")
            git("add", "staged")
            (root / "new file").write_text("untracked\n")
            with patch.object(selector, "ROOT", root):
                state = selector.changed_state("HEAD")
            self.assertEqual(set(state["changed_paths"]), {"tracked", "staged"})
            self.assertEqual(state["untracked_paths"], ["new file"])

    def test_model_cannot_add_commands_and_threshold_is_inclusive(self):
        cases = {"case_0": {"file": "x", "name": "one"}, "case_1": {"file": "x", "name": "two"}}
        response = {"answers": {name: {"type": "noul", "noul": 0.1} for name in cases}}
        response["answers"]["case_0"]["noul"] = 0.5
        response["answers"]["untrusted command"] = {"type": "noul", "noul": 1}
        _, selected = selector.selection(response, 0.5, cases)
        self.assertEqual(selected, ["case_0"])
        for bad in (None, True, "0.9", -1, 2, float("nan")):
            response["answers"]["case_0"]["noul"] = bad
            with self.assertRaises(ValueError):
                selector.selection(response, 0.5, cases)
        with self.assertRaises(ValueError):
            selector.selection({"answers": {}}, 0.5, cases)

    def test_dry_run_never_starts_tests(self):
        cases = {"case_0": {"runner": "python", "file": "x.py", "name": "Tests.test_one"}}
        response = {"answers": {"case_0": {"type": "noul", "noul": 1}}}
        with patch.object(sys, "argv", ["test-changes.py", "--dry-run"]), patch.dict(selector.os.environ, {"TYPESAFE_API_KEY": "test"}), patch.object(selector, "changed_state", return_value={"diff_stat": "changed", "changed_paths": ["a"], "untracked_paths": []}), patch.object(selector, "discover_cases", return_value=cases), patch.object(selector, "ask_jev", return_value=response), patch.object(selector, "run_case") as runner, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(selector.main(), 0)
            runner.assert_not_called()

    def test_discovery_and_node_filter_exclude_siblings_and_expand_loops(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "cases.cjs").write_text('''
const test = require('node:test');
// test('not a real test', () => {});
for (const n of [1, 2]) test(`number ${n}`, () => {});
test('parent', async t => {
  await t.test('one [a]+$', () => { console.log('SELECTED_BODY'); });
  await t.test('two', () => { throw Error('unselected sibling ran'); });
});
test('unrelated', () => { throw Error('unselected test ran'); });
''')
            cases = selector.node_cases(root, ["cases.cjs"])
            self.assertEqual([c["name"] for c in cases], ["number 1", "number 2", "parent one [a]+$", "parent two", "unrelated"])
            case = dict(cases[2], runner="node")
            with patch.object(selector, "ROOT", root):
                command, cwd = selector.case_command(case)
            result = subprocess.run(command, cwd=cwd, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn('SELECTED_BODY', result.stdout)
            self.assertNotIn('unselected sibling ran', result.stdout)

    def test_parameterized_names_from_object_spread_and_map(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "cases.ts").write_text('''
const values = {a: () => {}, ...Object.fromEntries([['b', 2]].map(([k, v]) => [k, () => v]))};
for (const [name, fn] of Object.entries(values)) test(`${name}: works`, fn);
''')
            self.assertEqual([c['name'] for c in selector.node_cases(root, ['cases.ts'])], ['a: works', 'b: works'])

    def test_unknown_dynamic_name_fails_discovery(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "cases.ts").write_text("test(computeName(), () => {});")
            with self.assertRaises(ValueError):
                selector.node_cases(root, ['cases.ts'])

    def test_vitest_runs_one_case_and_skips_neighboring_cases(self):
        case = {"runner": "vitest", "file": "client/src/layout/tree.test.ts",
                "name": "layout tree > adds a tab to a pane and makes it active"}
        command, cwd = selector.case_command(case)
        result = subprocess.run(command, cwd=cwd, text=True, capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("1 passed | 11 skipped", result.stdout)

    def test_exit_status_and_timeout(self):
        case = {"file": "fixture", "name": "test"}
        with patch.object(selector, "case_command", return_value=([sys.executable, "-c", "raise SystemExit(7)"], selector.ROOT)), contextlib.redirect_stdout(io.StringIO()):
            code, _ = selector.run_case(case, 5)
            self.assertEqual(code, 7)
        with patch.object(selector, "case_command", return_value=([sys.executable, "-c", "import time; time.sleep(30)"], selector.ROOT)), contextlib.redirect_stdout(io.StringIO()):
            code, elapsed = selector.run_case(case, 0.1)
            self.assertEqual(code, 124)
            self.assertLess(elapsed, 5)


if __name__ == "__main__":
    unittest.main()
