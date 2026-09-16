#!/usr/bin/env python3
"""Scoped release retention: current + two distinct deployed predecessors + recovery pins.
Default is read-only. No image age ordering, force removal, prune, or data writes.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess

ROOT = Path('/var/www/fizzer')
REV = re.compile(r'[0-9a-f]{40}')
TAG = re.compile(r'cascade:(?:certified|rollback)-[0-9a-f]{40}')
IMAGE = re.compile(r'sha256:[0-9a-f]{64}')
LABEL = 'org.opencontainers.image.revision'


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def inspect(*args):
    return json.loads(run('docker', *args))


def inventory():
    ids = sorted(set(run('docker', 'image', 'ls', '-aq', '--no-trunc').split()))
    return inspect('image', 'inspect', *ids) if ids else []


def recovery_refs():
    refs = {}
    for root in (Path('/var/backups/cascade'), Path('/var/lib/cascade-release')):
        if not root.is_dir() or root.is_symlink():
            raise ValueError(f'unsafe/missing recovery root: {root}')
        for base, dirs, files in os.walk(root, followlinks=False):
            dirs[:] = [d for d in dirs if d not in ('corpus', 'vaults', 'qmd')]
            for d in dirs:
                if (Path(base) / d).is_symlink():
                    raise ValueError('symlink in recovery metadata')
            for name in files:
                if name == 'corpus.sha256.json' or (name not in ('revision.txt', 'rollback-image.txt') and not name.endswith('.json')):
                    continue
                p = Path(base) / name
                if p.is_symlink() or not p.is_file() or p.stat().st_size > 1_000_000:
                    raise ValueError(f'unsafe recovery metadata: {p}')
                text = p.read_text()
                values = set(re.findall(r'(?<![0-9a-f])sha256:[0-9a-f]{64}(?![0-9a-f])|cascade:(?:certified|rollback)-[0-9a-f]{40}(?![0-9a-f])|(?<![0-9a-f])[0-9a-f]{40}(?![0-9a-f])', text))
                if values:
                    refs[str(p)] = sorted(values)
    return refs


def plan(images, live, containers, refs):
    by_id = {i['Id']: i for i in images}
    tags = {t: i['Id'] for i in images for t in (i.get('RepoTags') or [])}
    revision = lambda image: by_id[image].get('Config', {}).get('Labels', {}).get(LABEL, '')
    current = live['Image']
    rev = revision(current)
    if not REV.fullmatch(rev) or tags.get('cascade:certified-' + rev) != current or tags.get('cascade:latest') != current:
        raise ValueError('current/certified/latest identity mismatch')
    # rollback-NEW_REV is the image serving immediately BEFORE NEW_REV, not NEW_REV.
    lineage, seen = [current], {rev}
    cursor = current
    for _ in range(len(images) + 1):
        if len(lineage) == 3:
            break
        prior = tags.get('cascade:rollback-' + revision(cursor))
        if prior is None or prior == cursor or prior in lineage:
            raise ValueError('cannot prove two distinct deployed rollback versions')
        previous_revision = revision(prior)
        if not REV.fullmatch(previous_revision):
            raise ValueError('invalid rollback revision')
        if previous_revision not in seen:
            lineage.append(prior)
            seen.add(previous_revision)
        cursor = prior
    if len(lineage) != 3:
        raise ValueError('insufficient rollback lineage')
    protected = set(lineage) | {c['Image'] for c in containers}
    reasons = {}
    missing = []
    for path, values in refs.items():
        for value in values:
            targets = {value} if value in by_id else set()
            if value in tags:
                targets.add(tags[value])
            if REV.fullmatch(value):
                # Legacy snapshots may name only a revision; preserve both sides.
                targets.update(tags[t] for t in ('cascade:certified-' + value, 'cascade:rollback-' + value) if t in tags)
            for image in targets:
                protected.add(image)
                reasons.setdefault(image, []).append(path)
            if IMAGE.fullmatch(value) and not targets:
                missing.append({'path': path, 'image': value})
    for image in images:
        if image['Created'] > by_id[current]['Created']:
            protected.add(image['Id'])
            reasons.setdefault(image['Id'], []).append('newer staged candidate; not an old release')
        image_tags = image.get('RepoTags') or []
        if any(t != 'cascade:latest' and not TAG.fullmatch(t) for t in image_tags):
            protected.add(image['Id'])
            reasons.setdefault(image['Id'], []).append('non-release pointer/repository tag')
    removed = []
    for image in images:
        ts = image.get('RepoTags') or []
        if image['Id'] not in protected and ts and all(TAG.fullmatch(t) for t in ts):
            removed.append({'id': image['Id'], 'revision': revision(image['Id']), 'tags': sorted(ts)})
    return {'lineage': [{'id': i, 'revision': revision(i), 'tags': by_id[i]['RepoTags']} for i in lineage],
            'recovery_pins': reasons, 'missing_referenced_images': missing, 'remove': removed,
            'retained': [{'id': i['Id'], 'revision': revision(i['Id']), 'tags': i.get('RepoTags')} for i in images if i['Id'] not in {r['id'] for r in removed}]}


def snapshot():
    containers = inspect('container', 'inspect', *run('docker', 'ps', '-aq').split())
    live = next(c for c in containers if c['Name'] == '/cascade')
    if not live['State']['Running'] or Path('/run/cascade-maintenance').exists():
        raise ValueError('production is not stable/running')
    if any(c['Name'].startswith('/cascade-') for c in containers):
        raise ValueError('transitional Fizzer container present')
    identity = {k: live[k] for k in ('Id', 'Image', 'RestartCount')}
    identity['StartedAt'] = live['State']['StartedAt']
    return inventory(), live, containers, recovery_refs(), identity


def health():
    result = {}
    for url in ('http://127.0.0.1:3000/api/health', 'https://cscd.online/api/health'):
        body = run('curl', '--fail', '--silent', '--show-error', '--connect-timeout', '5', '--max-time', '15', url)
        if json.loads(body) != {'status': 'ok'}:
            raise ValueError('unhealthy endpoint')
        result[url] = body
    return result


def disk():
    v = os.statvfs('/')
    return {'total_bytes': v.f_blocks * v.f_frsize, 'used_bytes': (v.f_blocks - v.f_bfree) * v.f_frsize,
            'available_bytes': v.f_bavail * v.f_frsize, 'free_inodes': v.f_ffree}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--lock-fd', type=int)
    args = parser.parse_args()
    lock = args.lock_fd if args.lock_fd is not None else os.open(ROOT, os.O_RDONLY)
    if (os.fstat(lock).st_dev, os.fstat(lock).st_ino) != (ROOT.stat().st_dev, ROOT.stat().st_ino):
        raise ValueError('wrong deploy lock inode')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    images, live, containers, refs, identity = snapshot()
    revision = next(i for i in images if i['Id'] == live['Image'])['Config']['Labels'][LABEL]
    if run('git', '-C', str(ROOT), 'rev-parse', 'HEAD') != revision or run('git', '-C', str(ROOT), 'status', '--porcelain'):
        raise ValueError('checkout is not clean/current; possible interrupted deploy')
    before_health = health()
    result = plan(images, live, containers, refs)
    result.update({'apply': args.apply, 'before_images': len(images), 'before_tags': sum(len(i.get('RepoTags') or []) for i in images),
                   'before_disk': disk(), 'identity': identity, 'references': refs, 'health_before': before_health})
    print(json.dumps({'event': 'plan', **result}), flush=True)
    if args.apply:
        fresh = snapshot()
        if fresh[4] != identity or fresh[3] != refs or fresh[0] != images:
            raise ValueError('inventory changed during preflight')
        for entry in result['remove']:
            for tag in entry['tags']:
                if inspect('image', 'inspect', tag)[0]['Id'] != entry['id']:
                    raise ValueError('tag changed')
                output = run('docker', 'image', 'rm', tag)
                print(json.dumps({'event': 'removed_tag', 'tag': tag, 'id': entry['id'], 'output': output}), flush=True)
        os.sync()
    after = snapshot()
    if after[4] != identity or after[3] != refs:
        raise ValueError('runtime or references changed')
    remaining_ids = {i['Id'] for i in after[0]}
    if not {i['id'] for i in result['retained']} <= remaining_ids:
        raise ValueError('retained image missing')
    if args.apply and {i['id'] for i in result['remove']} & remaining_ids:
        raise ValueError('obsolete image still present')
    print(json.dumps({'event': 'verified', 'apply': args.apply, 'identity': after[4], 'after_images': len(after[0]),
                      'after_tags': sum(len(i.get('RepoTags') or []) for i in after[0]), 'after_disk': disk(),
                      'health_after': health(), 'retained': result['retained'], 'deleted_images': len(result['remove']) if args.apply else 0}), flush=True)


if __name__ == '__main__':
    main()
