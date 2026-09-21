"""Account three-way merge regressions against a real isolated daemon."""
import unittest
import hashlib
import http.client
import json
import select
import subprocess
from test_bridge import BridgeTests


class MergeTests(BridgeTests):
    def test_merge_over_http_dtob(self):
        self.file.write_bytes(b'alpha\nbeta\ngamma\ndelta\nepsilon\n')
        header = self.root / 'http-auth'
        header.write_text('Authorization: Bearer ' + 'x' * 48 + '\n')
        server = subprocess.Popen([str(self.binary), 'account', 'http-serve',
            '--root', str(self.root), '--listen', '127.0.0.1:0', '--header-file', str(header),
            '--control-stdin'], env=self.env, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        connection = None
        try:
            self.assertTrue(select.select([server.stdout], [], [], 10)[0])
            host, port = json.loads(server.stdout.readline())['address'].rsplit(':', 1)
            connection = http.client.HTTPConnection(host, int(port), timeout=10)
            def request(operation, **fields):
                args = [str(self.harness), '--encode-account', '--operation', operation,
                        '--session', 'merge-http', '--author', 'agent']
                for key, value in fields.items(): args += ['--' + key, str(value)]
                encoded = subprocess.run(args, capture_output=True, check=True).stdout
                connection.request('POST', '/' + operation, encoded,
                    {'Content-Type': 'application/vnd.dtob', 'Authorization': 'Bearer ' + 'x' * 48})
                response = connection.getresponse()
                data = self.root / 'response.dtob'
                data.write_bytes(response.read())
                decoded = subprocess.run([str(self.harness), '--decode-account', str(data)],
                                         capture_output=True, check=True).stdout
                meta, _, content = decoded.partition(b'\n')
                return response.status, json.loads(meta), content
            fields = dict(file='note', line_start=1, line_end=2147483647,
                          sha256=hashlib.sha256(self.file.read_bytes()).hexdigest())
            status, first, _ = request('lock', **fields)
            self.assertEqual(status, 200)
            status, second, _ = request('lock', **fields)
            self.assertEqual(status, 200)
            proposal = self.root / 'http-proposal'
            proposal.write_bytes(b'alpha\nbeta\ngamma\ndelta\nEPSILON\n')
            self.assertEqual(request('commit', ticket=second['ticket'], replacement=proposal)[0], 200)
            proposal.write_bytes(b'ALPHA\nbeta\ngamma\ndelta\nepsilon\n')
            status, _, merged = request('commit', ticket=first['ticket'], replacement=proposal)
            self.assertEqual(status, 200)
            self.assertEqual(merged, b'ALPHA\nbeta\ngamma\ndelta\nEPSILON\n')
            self.assertEqual(self.file.read_bytes(), merged)
        finally:
            if connection: connection.close()
            server.stdin.close()
            server.stdin = None
            try: server.wait(timeout=10)
            except subprocess.TimeoutExpired: server.terminate()
            _, errors = server.communicate(timeout=10)
            self.assertEqual(server.returncode, 0, errors)

    def test_merge_identical_and_unchanged_proposals_preserve_current(self):
        self.file.write_bytes(b'alpha\nbeta\ngamma')
        stale = self.account_lock()
        identical = self.account_lock()
        other = self.account_lock()
        self.account_commit(other, b'ALPHA\nbeta\ngamma')
        self.assertEqual(self.account_commit(stale, b'alpha\nbeta\ngamma')['status'], 200)
        self.assertEqual(self.account_commit(identical, b'ALPHA\nbeta\ngamma')['status'], 200)
        self.assertEqual(self.file.read_bytes(), b'ALPHA\nbeta\ngamma')

    def test_merge_follows_insertions_and_deletions_above_live_range(self):
        for prefix, changed_prefix in [(b'head\n', b'head\ninserted\n'),
                                       (b'head\nremoved\n', b'head\n')]:
            with self.subTest(prefix=prefix):
                self.account('conclude', 'upper')
                self.account('conclude')
                body = b'alpha\nbeta\ngamma\ndelta\nepsilon\n'
                self.file.write_bytes(prefix + body + b'tail\n')
                first = prefix.count(b'\n') + 1
                upper = self.account_lock('upper', lines=(1, first - 1))
                stale = self.account_lock(lines=(first, first + 4))
                other = self.account_lock(lines=(first, first + 4))
                self.assertEqual(self.account_commit(upper, changed_prefix, 'upper')['status'], 200)
                theirs = b'alpha\nbeta\ngamma\ndelta\nEPSILON\nextra\n'
                self.assertEqual(self.account_commit(other, theirs)['status'], 200)
                ours = b'ALPHA\nbeta\ngamma\ndelta\nepsilon\n'
                merged = self.account_commit(stale, ours)
                self.assertEqual(merged['status'], 200, merged)
                expected = b'ALPHA\nbeta\ngamma\ndelta\nEPSILON\nextra\n'
                self.assertEqual(self.file.read_bytes(), changed_prefix + expected + b'tail\n')
                self.assertEqual(merged['start'], len(changed_prefix))
                self.assertEqual(merged['length'], len(expected))
                shifted = changed_prefix.count(b'\n') + 1
                conflict = self.account_lock('outsider', lines=(shifted, shifted))
                self.assertEqual(conflict['status'], 409)
                self.assertEqual(self.account_commit(stale, expected.replace(b'beta', b'BETA'))['status'], 200)
                self.assertEqual(self.file.read_bytes(), changed_prefix + expected.replace(b'beta', b'BETA') + b'tail\n')

    def test_merge_conflict_preserves_master_and_proposal_and_lock(self):
        self.file.write_bytes(b'alpha\nbeta\ngamma\n')
        stale = self.account_lock()
        other = self.account_lock()
        self.assertEqual(self.account_commit(other, b'THEIRS\nbeta\ngamma\n')['status'], 200)
        for remote in (0, 1):
            conflict = self.account_commit(stale, b'OURS\nbeta\ngamma\n', remote=remote)
            self.assertEqual(conflict['status'], 409)
            self.assertIn('Three-way merge conflict', conflict['error'])
            self.assertEqual(self.file.read_bytes(), b'THEIRS\nbeta\ngamma\n')
            self.assertEqual((self.root / 'account-proposal').read_bytes(), b'OURS\nbeta\ngamma\n')
            if remote:
                from pathlib import Path
                self.assertEqual(Path(conflict['pending']).read_bytes(), b'OURS\nbeta\ngamma\n')
        self.assertEqual(self.account_lock('outsider')['status'], 409)

    def test_merge_remote_clean_and_syntax_rejection(self):
        self.file.write_bytes(b'alpha\nbeta\ngamma\ndelta\nepsilon\n')
        stale = self.account_lock()
        other = self.account_lock()
        self.account_commit(other, b'alpha\nbeta\ngamma\ndelta\nEPSILON\n')
        syntax = self.config / 'alock'
        syntax.mkdir(parents=True, exist_ok=True)
        (syntax / 'syntax.tsv').write_text('note\t! grep -q INVALID "$1"\n')
        rejected = self.account_commit(stale, b'INVALID\nbeta\ngamma\ndelta\nepsilon\n')
        self.assertEqual(rejected['status'], 422)
        self.assertTrue(self.file.read_bytes().startswith(b'alpha\n'))
        accepted = self.account_commit(stale, b'ALPHA\nbeta\ngamma\ndelta\nepsilon\n', remote=1)
        self.assertEqual(accepted['status'], 200, accepted)
        self.assertEqual(self.file.read_bytes(), b'ALPHA\nbeta\ngamma\ndelta\nEPSILON\n')

    def test_merge_does_not_renew_expired_lock_over_changed_head(self):
        stale = self.account_lock()
        self.account('conclude')
        self.file.write_bytes(b'changed\n')
        result = self.account_commit(stale, b'proposal\n')
        self.assertEqual(result['status'], 409)
        self.assertEqual(self.file.read_bytes(), b'changed\n')

    def test_merge_rejects_binary_conflict(self):
        self.file.write_bytes(b'a\x00\nb\x00\nc\x00\n')
        stale = self.account_lock()
        other = self.account_lock()
        self.account_commit(other, b'a\x00\nb\x00\nC\x00\n')
        result = self.account_commit(stale, b'A\x00\nb\x00\nc\x00\n')
        self.assertEqual(result['status'], 409)
        self.assertIn('binary', result['error'])


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(MergeTests(name) for name in
                              loader.getTestCaseNames(MergeTests) if name.startswith('test_merge_'))


if __name__ == '__main__':
    unittest.main()
