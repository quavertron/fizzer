# Select individual tests with Jev

From the repository root:

```sh
uv run test-changes.py
uv run test-changes.py --dry-run
uv run test-changes.py --list
uv run test-changes.py --base main --timeout 300
```

The implementation is Python. `uv` installs the Python AST-parser dependencies
declared in the script. Alternatively, install `tree-sitter>=0.25,<0.26` and
`tree-sitter-typescript>=0.23,<0.24` in your Python environment and run
`python3 test-changes.py`. Authentication uses `TYPESAFE_API_KEY` or `~/jev`.
The repo's Node, Elixir and Rust tools must also be installed.

The script sends `git diff --stat HEAD`, changed filenames, and untracked
filenames and each individual test's name to Jev. Comparing against HEAD includes staged and unstaged changes;
`--base` changes the comparison commit. File contents and patches are not sent.
Ignored files are omitted. An empty change set makes no API request.

The script discovers individual cases, including supported literal-generated
names. Python parses Node test source without importing it. Vitest, ExUnit and
Rust provide collection metadata without running test bodies; collection may
load modules or compile code. Python unittest methods are read from their AST.
Unknown dynamic Node names or duplicate case identities stop discovery.

Jev scores every case in batches of 32, with up to four API calls at once.
Cases at or above `--threshold` (default 0.5) run sequentially. There is no
suite-level selection or whole-file fallback. API errors or incomplete answers
stop selection before tests start. `--dry-run` calls Jev and prints selected
cases and commands; `--list` only discovers cases.

Each selected case has its own process and elapsed time, including startup.
Vitest uses an anchored full-name regex; Node uses anchored names and sibling
exclusions; ExUnit uses its exact `test` tag; Rust uses `--exact`; Python unittest
receives `Class.test_method`. Required parent setup and hooks still run. Normal
skip/ignore annotations remain honored. The default timeout is 120 seconds per
case, after which the process group is stopped. Failures do not prevent later
selected cases from running; any failed or timed-out command makes the script
exit nonzero.

Model output cannot add commands. Discovery includes normal automated tests and deployment/load-harness unit tests,
but excludes live browser, deployment, capacity and vendored dependency checks.
Use those separately when needed, following [the release matrix](release-matrix.md).
Selection from filenames is a heuristic and does not replace required release
checks or establish that skipped tests cannot fail.
