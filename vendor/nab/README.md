# nab

`nab` is a small, binary-safe file versioning CLI. It stores successive
versions of one file in a single `.nab` archive, using copy/add deltas between
versions and periodic full snapshots so old versions can be reconstructed
without replaying the entire history.

The archive is encoded with the [DTOB](https://gitlab.com/diegocabello/dtob)
binary format. Each version
also records a SHA-256 content hash, timestamp, byte location, checkpoint
location, and a content SimHash used by `nab log` to show how much a version
changed from the previous one.

When upgrading archives that predate author metadata, nab preserves the complete
DTOB types header, including with encoders that omit an empty document root.

## Build

Requirements:

- A C11 compiler (`gcc` or `clang`)
- `make`

`nab` has **zero external dependencies**:
- SHA-256 uses Apple `CommonCrypto` (`CC_SHA256`) on macOS, and a portable, self-contained pure C11 SHA-256 implementation on non-Apple/Linux.
- DTOB is bundled directly in `libdtob/` and compiled automatically.

To build `nab`:

```sh
make
```

To build both `nab` and the C microbenchmark harness:

```sh
make bench
```

The resulting executable is `./nab`. Remove built artifacts with `make clean`.

## Usage

```text
nab [--debug] <command> [args]
```

Commands:
- `patch <file> [nab_file]`  — create or update `.nab` archive
- `rebuild <file.nab> [v]`   — reconstruct content to stdout (default: latest)
- `diff <file.nab> [a] [b]`  — compare versions or the current file using `git diff` or `diff`
- `log <file.nab>`           — show version history with timestamps and SimHash distance

Options:
- `--author <author>`       — record a patch author, at most 32 bytes
- `--debug`, `-d`            — print microsecond step-by-step phase timings to stderr

### Save a version

```sh
./nab patch notes.txt
```

With no archive path, `nab` creates a hidden archive beside the input file. For
example, patching `notes.txt` writes `.notes.txt.nab`, and patching
`docs/notes.txt` writes `docs/.notes.txt.nab`.

Run the same command after editing the source file to append another version:

```sh
./nab patch notes.txt
```

If the file content is identical to the latest recorded revision, `nab` automatically detects this via SHA-256 and no-ops in under 1 ms without appending a redundant patch.

You can choose an explicit archive path instead:

```sh
./nab patch notes.txt history/notes.nab
```

The input may contain arbitrary binary data; it is not limited to text files.

Pass `--author` to record an author for that revision:

```sh
./nab patch notes.txt --author diego
```

NAB enforces a 32-byte limit (UTF-8 bytes, not characters), using `DTOB_RAW`
storage. Without the flag, the author is empty and omitted from `nab log`;
it is never inferred or inherited. Older archives migrate on the next changed
revision, with empty authors for existing entries. Identical content still
does not create a revision, even when an author is supplied.

### View history

```sh
./nab log .notes.txt.nab
```

Example output:

```text
0 2026-Sep-05 18:21:03-0400 simhash-dist=0
1 2026-Sep-05 18:24:11-0400 simhash-dist=7
```

The first column is the archive's zero-based patch index. `simhash-dist` is the
Hamming distance from the preceding version's content SimHash: a smaller value
usually means a smaller structural change.

### Rebuild a version

Rebuilt bytes are written to standard output. With no version argument, `nab`
reconstructs the latest version:

```sh
./nab rebuild .notes.txt.nab > restored.txt
```

The optional rebuild version is one-based, so version `1` rebuilds
the first entry displayed as index `0` by `nab log`:

```sh
./nab rebuild .notes.txt.nab 1 > first-version.txt
```

For binary files, redirect stdout in the same way:

```sh
./nab rebuild image.nab > restored.png
```

`nab` verifies reconstructed content against the stored SHA-256 hash and emits
a warning on stderr if it does not match.

### Recipe rebuilding

Rebuilds compose byte-range recipes on one thread, then materialize the final
bytes once. Inspect each phase with `--debug`, or select the old byte replay
algorithm for a benchmark comparison:

```sh
./nab --debug rebuild image.nab
NAB_REBUILD_MODE=serial ./nab --debug rebuild image.nab
```

`NAB_REBUILD_MODE=auto` (the default) and `compose` both use recipes. This also
applies when `patch` reconstructs the preceding version and when `diff`
rebuilds versions. Archive format and SHA-256 verification are unchanged.

Run `make test` for binary round-trip and malformed-patch checks. Run
`make all bench` followed by
`python3 test/parallel_rebuild.py --size 4194304 --debug-bench`
to compare algorithms on a reproducible 50-patch chain. The benchmark and
CLI share the production replay implementation.

### Compare two versions

```sh
./nab diff .notes.txt.nab
./nab diff .notes.txt.nab 3
./nab diff .notes.txt.nab 3 7
```

With no version, `nab diff` compares the latest archived version with the
current file. With one version, it compares that archived version with the
current file. With two versions, it compares those two archived versions.
Versions are one-based.

The current filename is derived from the archive name beside it:
`.notes.txt.nab` and `notes.txt.nab` both resolve to `notes.txt`.

`nab diff` reconstructs the requested archive version or versions, then runs
`git --paginate diff --no-index` so Git's normal color and pager configuration
apply. If Git is unavailable, it falls back to `diff -u`. If neither command is
available, `nab` reports the problem on stderr. The temporary reconstructed
files are removed after the diff command exits.

### Diagnostics & Timing (`--debug` / `-d`)

Pass `--debug` (or `-d`) anywhere in the command to inspect microsecond timings for each phase:

```sh
./nab --debug patch notes.txt
```

Example diagnostic output:

```text
[debug] read_file                   45.0 µs (150001 bytes)
[debug] hash_sha256                 55.0 µs
[debug] read_types_header           18.0 µs (1024 bytes)
[debug] read_metadata_trailer       62.0 µs (50 entries, 7146 bytes)
[debug] reconstruct_prev           240.0 µs (25 patches -> 149200 bytes)
[debug] diff_build                  69.0 µs (14 ops)
[debug] compute_simhash            230.0 µs
[debug] encode_patch                10.0 µs (420 bytes)
[debug] encode_metadata             25.0 µs (51 entries -> 7280 bytes)
[debug] disk_write_fsync           133.0 µs (7700 bytes)
[debug] ----------------------------------------
[debug] total elapsed               1.68 ms
```

All debug output is emitted exclusively to `stderr`, keeping `stdout` completely clean for stream redirection and piping. When `--debug` is used with `rebuild`, the stdout payload write is suppressed so timings can be inspected without flooding your terminal.

## Performance

Across 100 sequential revisions of a 2,000-line codebase (~15 MB raw uncompressed total, with 100% cryptographic SHA-256 verification):

| Metric | `nab` | `xdelta3` | `rdiff` | `git` |
| :--- | :---: | :---: | :---: | :---: |
| **Commit / Delta Creation Speed** | **2.65 ms** (🥇 **#1 Overall**) | 4.13 ms (raw) / 8.74 ms | 5.70 ms | 33.98 ms |
| **Rebuild Latency (49-patch chain)** | **2.18 ms** (CLI) / **405 µs** (Engine) | 131.25 ms | 131.19 ms | 8.52 ms (`git show`) |
| **Throughput** | **376.8 revs/sec** | 242.4 revs/sec | 175.3 revs/sec | 29.4 revs/sec |
| **Storage Architecture** | **Single file** (`.nab`) | Loose `.xd3` files | Loose `.delta` files | `.git` repository |

See [`benchmark/RESULTS.md`](benchmark/RESULTS.md) for the full benchmark report and comparative analysis.

## Archive design

A `.nab` file contains:

1. a DTOB custom-types header;
2. an array of patch payloads;
3. an array of metadata records.

The first version is stored in full. Later versions are represented as a
sequence of operations:

- `copy(start, end)` copies an inclusive byte range from the preceding state;
- `add(bytes)` inserts literal bytes.

### Core Algorithmic Details:
- **Polynomial Rolling Hash**: 16-byte blocks of the preceding version are indexed using a polynomial rolling hash into a flat direct-mapped 64K entry hash table.
- **64-bit Chunk Matching**: Candidate match blocks are validated and extended 8 bytes at a time using 64-bit word comparisons.
- **Bidirectional Match Extension**: Matches are extended both forward and backward to maximize copy range lengths and minimize literal payload overhead.
- **Bit-Sliced SimHash (CSA-127)**: Fast 64-bit content SimHash is computed via a 7-bit Carry-Save Adder tree across CPU registers, accelerating fuzzy similarity tracking to 240 µs per revision.
- **Periodic Checkpoints**: Every 50th patch is stored as a full snapshot, strictly bounding patch replay depth regardless of repository history length.
- **Recipe composition**: Replay resolves patches into ranges of decoded literals on a single thread, then materializes the output once. Literal storage is retained until composition finishes; fragmented or literal-heavy histories can use more memory. The old streaming replay remains available for benchmark comparisons.
- **Cryptographic Ground Truth**: Every version stores a SHA-256 content checksum, verified automatically upon reconstruction.

## Source layout

```text
src/nab.c       entry point, CLI argument parsing, debug timer, SimHash CSA-127
src/nab.h       DTOB custom type schema codes for patches and metadata
src/cmd.c       command handlers (patch, rebuild, log) and schema migration
src/rebuild.c   single-thread recipe composition and serial replay baseline
src/xbdiff.c    polynomial rolling hash, 64K block index, 64-bit chunk matcher
src/util.c      Apple CC_SHA256 / portable C11 SHA-256, DTOB trailer scan, file helpers
libdtob/        bundled DTOB serialization library
benchmark/      benchmark suite (run_benchmark.py, bench_rebuild.c, RESULTS.md)
```
