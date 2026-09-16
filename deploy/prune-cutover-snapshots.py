#!/usr/bin/env python3
"""Keep two verified cutover recovery points. Default is a read-only plan."""
import argparse
from contextlib import closing
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat

KEEP = 2
NAME = re.compile(r"cutover-[0-9a-f]{40}-(\d{8}T\d{6}Z)$")


def inventory(directory):
    """Never traverse links, special files, or another mounted filesystem."""
    device = directory.lstat().st_dev
    files = {}
    for base, directories, names in os.walk(directory, followlinks=False):
        for name in directories + names:
            path = Path(base) / name
            info = path.lstat()
            if info.st_dev != device or not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
                raise ValueError(f"unsafe snapshot entry: {path}")
            if stat.S_ISREG(info.st_mode):
                files[str(path.relative_to(directory))] = path
    return files


def digest(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def verify(directory):
    files = inventory(directory)
    for name in ('docs.db', 'docs.db.sha256', 'revision.txt'):
        if name not in files:
            raise ValueError(f"missing {name}")
    if not re.fullmatch(r'[0-9a-f]{40}', files['revision.txt'].read_text().strip()):
        raise ValueError('invalid recovery revision')
    for name in ('vaults', 'qmd'):
        if not (directory / 'corpus' / name).is_dir():
            raise ValueError(f"missing corpus/{name}")
    if 'docs.db-wal' in files and files['docs.db-wal'].stat().st_size:
        raise ValueError('snapshot contains uncheckpointed WAL')
    expected = files['docs.db.sha256'].read_text().split()
    if len(expected) != 2 or expected[1] != 'docs.db' or digest(files['docs.db']) != expected[0]:
        raise ValueError('database checksum mismatch')
    # Immutable URI avoids creating WAL/SHM in the retained recovery point.
    with closing(sqlite3.connect(files['docs.db'].as_uri() + '?mode=ro&immutable=1', uri=True)) as db:
        if db.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
            raise ValueError('database quick_check failed')
        if db.execute('PRAGMA foreign_key_check').fetchall():
            raise ValueError('database foreign_key_check failed')
    # Legacy snapshots predate corpus checksums. Read all corpus bytes; new
    # snapshots additionally have a creation-time manifest to detect drift.
    corpus = {name: digest(path) for name, path in sorted(files.items()) if name.startswith('corpus/')}
    manifest = directory / 'corpus.sha256.json'
    if manifest.exists() and json.loads(manifest.read_text()) != corpus:
        raise ValueError('corpus checksum mismatch')
    return corpus


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--protect', action='append', default=[])
    parser.add_argument('--seal', action='store_true', help='validate one newly created snapshot and seal its corpus')
    args = parser.parse_args()
    # Share the existing deployment lock, including standalone operator use.
    lock = os.open(Path(__file__).resolve().parent.parent, os.O_RDONLY)
    if os.environ.get('CASCADE_DEPLOY_LOCK_HELD') != '1':
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    root = args.root.absolute()
    if root.is_symlink() or not root.is_dir():
        raise ValueError('snapshot root must be a real directory')
    if args.seal:
        corpus = verify(root)
        temporary = root / '.corpus.sha256.json.incomplete'
        with temporary.open('x') as output:
            json.dump(corpus, output, sort_keys=True)
            output.flush()
            os.fsync(output.fileno())
        temporary.replace(root / 'corpus.sha256.json')
        print(json.dumps({'sealed': str(root), 'corpus_files': len(corpus)}))
        return

    candidates = sorted((p for p in root.iterdir() if NAME.fullmatch(p.name)
                         and not p.is_symlink() and p.is_dir()),
                        key=lambda p: (NAME.fullmatch(p.name)[1], p.name), reverse=True)
    retained, warnings = [], []
    for candidate in candidates:
        try:
            verify(candidate)
            retained.append(candidate)
        except (ValueError, OSError, sqlite3.Error) as error:
            warnings.append(f'{candidate.name}: {error}')
        if len(retained) == KEEP:
            break
    if len(retained) < KEEP:
        print(json.dumps({'apply': args.apply, 'keep': KEEP, 'retained': [p.name for p in retained],
                          'removed': [], 'warnings': ['fewer than two verified recovery points; nothing pruned'] + warnings}))
        return
    protected = {Path(p).name for p in args.protect if p}
    # Only dates older than both good points can expire. Incomplete/corrupt new
    # attempts stay available for investigation, as do unknown directory names.
    cutoff = NAME.fullmatch(retained[-1].name)[1]
    removed = [p for p in candidates if NAME.fullmatch(p.name)[1] < cutoff and p.name not in protected]
    allocated = 0
    for candidate in removed:
        files = inventory(candidate)  # validate the entire removal plan first
        allocated += sum(p.lstat().st_blocks * 512 for p in files.values())
    free_before = shutil.disk_usage(root).free
    if args.apply:
        for candidate in removed:
            shutil.rmtree(candidate)
    print(json.dumps({'apply': args.apply, 'keep': KEEP, 'retained': [p.name for p in retained],
                      'protected': sorted(protected), 'removed': [p.name for p in removed],
                      'removed_allocated_bytes': allocated if args.apply else 0,
                      'planned_allocated_bytes': allocated, 'warnings': warnings,
                      'filesystem_free_delta_bytes': shutil.disk_usage(root).free - free_before}))


if __name__ == '__main__':
    main()
