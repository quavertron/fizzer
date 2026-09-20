# Bundled agent tools

These source snapshots are part of Fizzer itself. They include unpublished local
fixes where recorded in DEPENDENCIES.json; their upstream repositories need not
be available to build this checkout. Git pins the actual snapshot contents.

Dependency tests and benchmarks are omitted from these build-source snapshots;
they remain in the original projects. Fizzer keeps its own integration tests.
Upstream READMEs may describe test commands available only in the full projects.

- alock: cross-user bridge, locking, history recovery and turn batching
- nab: embedded history engine and standalone CLI
- libdtob: one shared codec source and build for alock, nab and awatch
- awatch: edit monitor
- purrvect: TUI-only SVG rendering and terminal transport, sourced from
  [`tui/vendor/purrvect`](../tui/vendor/purrvect)

`npm run build:agent-tools` builds in a temporary directory and writes the four
executables plus purrvect's runtime libraries to `.native-tools/`. It preserves
upstream relative paths with temporary symlinks, not additional vendored codecs.
No source checkout or user library installation is modified by the build.

Prerequisites: Node, Go, Rust/Cargo, make, C/C++ compilers, CMake, pkg-config, ThorVG >= 1.0.7.
Go module versions/checksums remain in awatch/go.mod and go.sum. System C runtimes
are provided by the target OS. Build packages on the target OS/architecture.
Electron and npm/TUI packaging use this same helper bundle; installers place it
under `/usr/local/libexec/fizzer` after administrator authentication.

Purrvect's authoritative source snapshot lives in `tui/vendor/purrvect` because
it is a TUI dependency. The shared packaging build reads it from there when
assembling the native helper bundle; it is ordinary Fizzer source, not a submodule.

The TUI calls native `purrvect encode` over stdin, with explicit image IDs and
placement dimensions. Its Rust module handles placement and chat text only;
SVG encoding/rendering stays in C++. This experimental SVG transport still
requires a patched terminal. `FIZZER_PURRVECT_BIN` overrides the helper path.
