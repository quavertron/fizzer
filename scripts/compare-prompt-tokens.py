#!/usr/bin/env python3
"""Measure saved before/after prompt sections, without calling a model."""
import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path


def expand(value, root):
    if isinstance(value, dict):
        if set(value) == {'contextRef'}:
            target = root
            for key in value['contextRef']:
                target = target[key]
            if not isinstance(target, str):
                raise ValueError('contextRef must point directly to retained text')
            return target
        return {key: expand(item, root) for key, item in value.items()}
    if isinstance(value, list):
        return [expand(item, root) for item in value]
    return value


def compare(manifest, encode):
    def count(text):
        return len(encode(text))

    def counts(before, after):
        return {'before': before, 'after': after, 'saved': before - after,
                'reductionPercent': round(100 * (before - after) / before, 4) if before else None}

    results = []
    for sample in manifest['samples']:
        sections = sample['sections']
        before = ''.join(section['before'] for section in sections)
        after = ''.join(section['after'] for section in sections)
        total = counts(count(before), count(after))
        rows, checks = [], []
        for section in sections:
            old, new = section['before'], section['after']
            if section.get('check') == 'identical':
                if old != new:
                    raise ValueError(f"{sample['name']}: {section['name']} changed")
                checks.append(section['name'] + ': identical')
            elif section.get('check') == 'contextRefs':
                source, projected = json.loads(old), json.loads(new)
                if expand(projected, projected) != source:
                    raise ValueError(f"{sample['name']}: context reconstruction differs")
                checks.append(section['name'] + ': exact JSON reconstruction')
            for text in section.get('required', []):
                if text not in old or text not in new:
                    raise ValueError(f"{sample['name']}: required text missing: {text}")
            row = {'name': section['name'], **counts(count(old), count(new))}
            for side in ('before', 'after'):
                row[side + 'SharePercent'] = round(100 * row[side] / total[side], 4) if total[side] else None
            rows.append(row)
        results.append({'name': sample['name'], 'scope': sample.get('scope', ''),
                        'total': total, 'sections': rows, 'checks': checks,
                        'boundaryDifference': {side: total[side] - sum(row[side] for row in rows)
                                               for side in ('before', 'after')},
                        'sha256': {side: hashlib.sha256(text.encode()).hexdigest()
                                   for side, text in [('before', before), ('after', after)]}})
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path, help='JSON with samples containing ordered before/after sections')
    parser.add_argument('--encoding', default='o200k_base')
    args = parser.parse_args()
    import tiktoken
    data = args.input.read_bytes()
    encoding = tiktoken.get_encoding(args.encoding)
    result = {'tokenizer': 'tiktoken', 'version': importlib.metadata.version('tiktoken'),
              'encoding': args.encoding, 'inputSha256': hashlib.sha256(data).hexdigest(),
              'caveat': 'Offline text tokens only; excludes API framing, hidden context, caching, output and retries. Not billed/provider usage or full-task efficiency. Section sums can differ at tokenizer boundaries.',
              'samples': compare(json.loads(data), lambda text: encoding.encode(text, disallowed_special=()))}
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
