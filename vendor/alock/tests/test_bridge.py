import fcntl
import json
import os
from pathlib import Path
import pwd
import select
import signal
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
import unittest
import hashlib
import http.client

ROOT = Path(__file__).resolve().parents[1]
LIMIT = 4 * 1024 * 1024


class BridgeTests(unittest.TestCase):
    def account(self, operation, session='account-a', **fields):
        args = [str(self.harness), '--account', '--operation', operation, '--session', self.root.name + ':' + session, '--author', 'agent']
        for key, value in fields.items(): args += ['--' + key, str(value)]
        result = subprocess.run(args, env=self.env, capture_output=True, check=True)
        header, _, content = result.stdout.partition(b'\n')
        return json.loads(header), content

    def account_lock(self, session='account-a', lines=(1, 2147483647), **fields):
        return self.account('lock', session, file=self.file, line_start=lines[0], line_end=lines[1], **fields)[0]

    def account_commit(self, staged, content, session='account-a', **fields):
        proposal = self.root / 'account-proposal'
        proposal.write_bytes(content)
        return self.account('commit', session, ticket=staged['ticket'], replacement=proposal, **fields)[0]

    def test_account_turn_retains_lock_and_batches_until_conclude(self):
        self.config.mkdir(parents=True, exist_ok=True)
        (self.config / 'alock.toml').write_text('nab = true\n')
        first = self.account_lock()
        self.assertEqual(first['sha256'], hashlib.sha256(b'baseline\n').hexdigest())
        self.assertEqual(self.account_commit(first, b'first\n')['status'], 200)
        self.assertEqual(self.account_commit(first, b'second\n')['status'], 200)
        self.assertEqual(self.account_lock('account-b')['status'], 409)
        self.assertEqual(self.history_versions(), 0)
        self.assertEqual(self.account('conclude')[0]['status'], 200)
        self.assertEqual(self.history_versions(), 2)
        self.assertEqual(self.account_lock('account-b')['status'], 200)

    def test_account_disjoint_ranges_shift_and_concurrent_commits_record(self):
        self.config.mkdir(parents=True, exist_ok=True)
        (self.config / 'alock.toml').write_text('nab = true\n')
        self.file.write_bytes(b'first\nsecond\nthird\n')
        first = self.account_lock(lines=(1, 1))
        second = self.account_lock('account-b', lines=(3, 3))
        self.assertEqual(self.account_commit(first, b'one\nextra\n')['status'], 200)
        self.assertEqual(self.account_commit(second, b'last\n', 'account-b')['status'], 200)
        self.assertEqual(self.file.read_bytes(), b'one\nextra\nsecond\nlast\n')
        self.assertEqual(self.history_versions(), 3)

    def test_account_conflict_names_holder_and_shifted_range(self):
        self.file.write_bytes(b'first\nsecond\nthird\n')
        first = self.account_lock(lines=(1, 1))
        self.account_lock('account-b', lines=(3, 3))
        self.account_commit(first, b'one\nextra\n')
        conflict = self.account_lock('account-c', lines=(4, 4))
        self.assertEqual(conflict['status'], 409)
        self.assertEqual(conflict['error'], 'agent holds a lock on range 4–4')

    def test_account_persistent_lock_survives_conclude_then_expires(self):
        staged = self.account_lock(persistent_seconds=1)
        self.assertEqual(staged['status'], 200)
        self.account('conclude')
        self.assertEqual(self.account_lock('account-b')['status'], 409)
        time.sleep(1.1)
        self.assertEqual(self.account_lock('account-b')['status'], 200)
        self.assertEqual(self.account_lock('account-c', persistent_seconds=601)['status'], 400)

    def test_account_unclaimed_commit_renews_only_unchanged_head(self):
        staged = self.account_lock()
        self.account('conclude')
        self.assertEqual(self.account_commit(staged, b'accepted\n')['status'], 200)
        self.account('conclude')
        self.file.write_bytes(b'human change\n')
        self.assertEqual(self.account_commit(staged, b'stale\n')['status'], 409)
        self.assertEqual(self.file.read_bytes(), b'human change\n')

    def test_account_syntax_rejection_preserves_temp_and_master(self):
        syntax = self.config / 'alock'
        syntax.mkdir(parents=True, exist_ok=True)
        (syntax / 'syntax.tsv').write_text('note\t! grep -q INVALID "$1"\n')
        staged = self.account_lock()
        self.assertEqual(self.account_commit(staged, b'INVALID\n')['status'], 422)
        self.assertEqual((self.root / 'account-proposal').read_bytes(), b'INVALID\n')
        self.assertEqual(self.file.read_bytes(), b'baseline\n')
        self.assertFalse(list(self.root.glob('*.pending-*')))
        self.assertEqual(self.account_commit(staged, b'valid\n')['status'], 200)

    def test_account_invalid_conclude_does_not_record(self):
        syntax = self.config / 'alock'
        syntax.mkdir(parents=True, exist_ok=True)
        (self.config / 'alock.toml').write_text('nab = true\n')
        (syntax / 'syntax.tsv').write_text('note\t! grep -q INVALID "$1"\n')
        staged = self.account_lock()
        self.assertEqual(self.account_commit(staged, b'valid\n')['status'], 200)
        self.file.write_bytes(b'INVALID human edit\n')
        self.assertEqual(self.account('conclude')[0]['status'], 200)
        self.assertEqual(self.history_versions(), 0)
        self.assertEqual(self.file.read_bytes(), b'INVALID human edit\n')

    def test_account_remote_stale_hash_rejected_and_failed_commit_saved_pending(self):
        self.assertEqual(self.account_lock(sha256=hashlib.sha256(b'stale').hexdigest(), remote=1)['status'], 409)
        staged = self.account_lock(sha256=hashlib.sha256(self.file.read_bytes()).hexdigest(), remote=1)
        self.file.write_bytes(b'authoritative human change\n')
        result = self.account_commit(staged, b'proposed\n', remote=1)
        self.assertEqual(result['status'], 409)
        self.assertEqual(Path(result['pending']).read_bytes(), b'proposed\n')
        self.assertEqual(self.file.read_bytes(), b'authoritative human change\n')

    def test_account_http_daemon_dtob_roundtrip_and_authorization(self):
        header = self.root / 'http-auth'
        header.write_text('Authorization: Bearer ' + 'x'*48 + '\n')
        server = subprocess.Popen([str(self.binary), 'account', 'http-serve', '--root', str(self.root),
            '--listen', '127.0.0.1:0', '--header-file', str(header), '--control-stdin', '--events-stdout'], env=self.env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            ready, _, _ = select.select([server.stdout], [], [], 10)
            self.assertTrue(ready, 'HTTP daemon did not become ready')
            address = json.loads(server.stdout.readline())['address']
            host, port = address.rsplit(':', 1)
            connection = http.client.HTTPConnection(host, int(port), timeout=10)
            encoded = subprocess.run([str(self.harness), '--encode-account', '--operation', 'lock',
                '--session', 'http-session', '--author', 'agent', '--file', 'note', '--line_start', '1',
                '--line_end', '2147483647', '--sha256', hashlib.sha256(self.file.read_bytes()).hexdigest()],
                capture_output=True, check=True).stdout
            connection.request('POST', '/lock', encoded, {'Content-Type': 'application/vnd.dtob'})
            denied = connection.getresponse(); self.assertEqual(denied.status, 401); denied.read()
            connection.request('POST', '/lock', encoded, {'Content-Type': 'application/vnd.dtob', 'Authorization': 'Bearer '+'x'*48})
            response = connection.getresponse(); self.assertEqual(response.status, 200)
            encoded_reply = self.root / 'response.dtob'; encoded_reply.write_bytes(response.read())
            result = subprocess.run([str(self.harness), '--decode-account', str(encoded_reply)], capture_output=True, check=True)
            meta, _, content = result.stdout.partition(b'\n')
            self.assertEqual(json.loads(meta)['status'], 200)
            self.assertEqual(content, b'baseline\n')
            ready, _, _ = select.select([server.stdout], [], [], 5)
            self.assertTrue(ready, 'Remote lock did not reach the shared activity feed')
            event = json.loads(server.stdout.readline())['activity']
            self.assertEqual(event['kind'], 'lock')
            self.assertEqual(event['file'], 'note')
            self.assertEqual(event['result'], 'granted')
            connection.close()
            server.stdin.close()
            server.stdin = None
            self.assertEqual(server.wait(timeout=10), 0, 'HTTP daemon did not stop when its owning host closed the control pipe')
        finally:
            server.terminate()
            _, errors = server.communicate(timeout=10)
            self.assertEqual(server.returncode, 0, errors)

    @classmethod
    def setUpClass(cls):
        cls.build = tempfile.TemporaryDirectory(prefix='alock-native-tests-', dir='/tmp')
        cls.binary = Path(cls.build.name) / 'alock'
        cls.harness = Path(cls.build.name) / 'bridge-test'
        cls.nab_fixture = Path(cls.build.name) / 'nab-fixture'
        subprocess.run(['cargo', 'build', '--locked', '--release', '--manifest-path', 'control/Cargo.toml',
                        '--target-dir', str(Path(cls.build.name) / 'rust')], cwd=ROOT, check=True)
        control = str(Path(cls.build.name) / 'rust/release/libalock_control.a')
        flags = ['cc', '-std=c11', '-Wall', '-Wextra', '-Werror', '-g',
                 '-Isrc', '-Ilibdtob/lib',
                 '-DTURN_LEASE_SECONDS=3', '-DBRIDGE_HEARTBEAT_SECONDS=1',
                 '-DAWATCH_SOCK="' + str(Path(cls.build.name).resolve() / 'awatch.sock') + '"',
                 '-DALOCK_SOCK_DIR="' + str(Path(cls.build.name).resolve() / 'runtime') + '"']
        # Optional sanitizer pass exercises the actual production source too.
        if os.environ.get('ALOCK_TEST_SANITIZERS'):
            flags += ['-fsanitize=address,undefined', '-fno-omit-frame-pointer']
        sources = ['src/events.c', 'src/lock.c', 'src/daemon.c', 'src/ipc.c', 'src/bridge.c', 'src/history.c', 'src/turns.c', 'src/nab_embed.c', 'src/account_io.c', 'src/syntax.c', control]
        subprocess.run(flags + ['tests/nab_history_fixture.c', 'libdtob/libdtob.a', '-o', str(cls.nab_fixture)], cwd=ROOT, check=True)
        subprocess.run(flags + ['src/main.c', *sources, 'libdtob/libdtob.a', '-o', str(cls.binary)], cwd=ROOT, check=True)
        main = str(Path(cls.build.name) / 'main.o')
        subprocess.run(flags + ['-Dmain=alock_cli_main', '-c', 'src/main.c', '-o', main], cwd=ROOT, check=True)
        subprocess.run(flags + ['-DBRIDGE_LEASE_SECONDS=2', 'tests/bridge_harness.c', main,
                                *sources, 'libdtob/libdtob.a', '-o', str(cls.harness)], cwd=ROOT, check=True)

    @classmethod
    def tearDownClass(cls):
        cls.build.cleanup()

    def setUp(self):
        # Keep Unix socket paths below the macOS sockaddr_un limit.
        self.tmp = tempfile.TemporaryDirectory(prefix='alb-', dir='/tmp')
        self.root = Path(self.tmp.name).resolve()
        self.config = Path(self.build.name) / 'config'
        self.state = Path(self.build.name) / 'state'
        shutil.rmtree(self.config, ignore_errors=True)
        shutil.rmtree(self.state, ignore_errors=True)
        self.env = dict(os.environ, XDG_CONFIG_HOME=str(self.config), XDG_STATE_HOME=str(self.state))
        self.file = self.root / 'note'
        self.file.write_bytes(b'baseline\n')
        self.endpoint = str(self.root / 'socket')
        self.proposals = []
        self.server = None
        self.start()

    def start(self, uid=None, turn=False):
        self.server = subprocess.Popen([str(self.harness), str(self.root), self.endpoint,
                                        str(os.getuid() if uid is None else uid)] + (['--turn'] if turn else []),
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=self.env)
        ready, _, _ = select.select([self.server.stdout], [], [], 5)
        self.assertTrue(ready, 'Server startup timed out')
        line = self.server.stdout.readline()
        if 'Bridge ready' not in line:
            _, error = self.server.communicate(timeout=5)
            self.fail('Server failed: ' + error)

    def stop(self):
        if self.server is not None:
            self.server.terminate()
            _, error = self.server.communicate(timeout=15)
            self.assertEqual(self.server.returncode, 0, error)
            self.server = None

    def tearDown(self):
        self.stop()
        for path in self.proposals:
            path.unlink(missing_ok=True)
        self.tmp.cleanup()

    def cli(self, *args, check=True):
        if args[0] in ('commit', 'mkdir') and '--author' not in args:
            args = (*args, '--author', 'bridge-test')
        result = subprocess.run([str(self.binary), 'bridge', *args, '--socket', self.endpoint],
                                capture_output=True, text=True, timeout=15, env=self.env)
        if check:
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        return result.stderr

    def stage(self, path='note'):
        response = self.cli('stage', '--path', path)
        self.proposals.append(Path(response['file']))
        return response

    def commit(self, staged, data=b'proposal\n', check=True):
        Path(staged['file']).write_bytes(data)
        return self.cli('commit', '--ticket', staged['ticket'], '--file', staged['file'], check=check)

    def watch(self, cursor=None):
        ready = subprocess.run([str(self.binary), 'events', '--ensure'], env=self.env, capture_output=True, check=True)
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.settimeout(3)
        client.connect(json.loads(ready.stdout)['socket'])
        payload = json.dumps({'cmd': 'watch', 'cursor': cursor or {}}).encode()
        client.sendall(struct.pack('<I', len(payload)) + payload)
        self.addCleanup(client.close)
        stream = client.makefile('rb')
        self.addCleanup(stream.close)
        self.assertIn('Status', json.loads(stream.readline()))
        return client, stream

    def test_awatch_receives_agent_and_author_without_ticket_identity(self):
        _, stream = self.watch()
        staged = self.cli('stage', '--path', 'note', '--author', 'astra')
        self.proposals.append(Path(staged['file']))
        Path(staged['file']).write_bytes(b'new content\n')
        self.cli('commit', '--ticket', staged['ticket'], '--file', staged['file'], '--author', 'diego')
        events = []
        while not events or events[-1]['kind'] != 'edit':
            event = json.loads(stream.readline())['Event']
            if event['file'] == str(self.file): events.append(event)
        self.assertGreaterEqual(len(events), 2)
        for event in events: self.assertEqual(event['agent'], 'astra')
        self.assertEqual(events[-1]['author'], 'diego')
        self.assertEqual(self.file.read_bytes(), b'new content\n')

    def test_account_release_events_for_conclude_expiry_and_explicit_release(self):
        _, stream = self.watch()
        for mode in ('release', 'conclude', 'expiry'):
            staged = self.account_lock(persistent_seconds=1 if mode == 'expiry' else 0)
            if mode == 'release': self.account('release', ticket=staged['ticket'])
            elif mode == 'conclude': self.account('conclude')
            else:
                time.sleep(1.1)
                self.account('heartbeat')
            while True:
                packet = json.loads(stream.readline())
                event = packet.get('Event', {})
                if event.get('result') == 'released': break
            self.assertEqual(event['kind'], 'lock')
            self.assertEqual(event['author'], 'agent')
            self.assertEqual(event['file'], str(self.file))
            self.assertEqual(event['line_start'], 1)

    def test_activity_fanout_replay_and_tool_submission_use_command_socket(self):
        _, first = self.watch()
        _, second = self.watch()
        def submit(identifier):
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.connect(str(Path(self.build.name).resolve() / 'runtime' / 'daemon.sock'))
                payload = json.dumps({'cmd':'activity','event':{'kind':'tool','id':identifier,'tool':'Write'}}).encode()
                client.sendall(struct.pack('<I',len(payload)) + payload)
        def until(stream, identifier):
            while True:
                packet = json.loads(stream.readline())
                if packet.get('Event',{}).get('id') == identifier: return packet
        identifier = self.root.name + ':first'
        submit(identifier)
        packet = until(first,identifier)
        self.assertEqual(until(second,identifier)['Cursor'],packet['Cursor'])
        _, replay = self.watch(packet['Cursor'])
        submit(identifier + ':next')
        self.assertEqual(until(replay,identifier + ':next')['Cursor']['Seq'],packet['Cursor']['Seq']+1)
        self.assertEqual(until(second,identifier + ':next')['Event']['tool'],'Write')

    def test_daemon_bounds_incomplete_and_oversized_requests(self):
        subprocess.run([str(self.harness), '--daemon-pid'], env=self.env, capture_output=True, check=True)
        runtime = str(Path(self.build.name).resolve() / 'runtime' / 'daemon.sock')
        for header in [struct.pack('<I', 16), struct.pack('<I', 0xffffffff)]:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.connect(runtime)
                client.sendall(header)
                result = subprocess.run([str(self.binary), 'status'], env=self.env, capture_output=True, timeout=4)
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_out_of_range_direct_write_preserves_file(self):
        for operation in ['acquire', 'write']:
            result = subprocess.run([str(self.binary), operation, '--file', str(self.file),
                '--lines', '999-999', '--agent', 'bad-range', '--author', 'test'],
                input=b'wrong\n', env=self.env, capture_output=True, timeout=4)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(self.file.read_bytes(), b'baseline\n')

    def test_busy_capability_probe_does_not_kill_bridge(self):
        self.stop()
        self.start(turn=True)
        pid = int(subprocess.check_output([str(self.harness), '--daemon-pid'], env=self.env))
        os.kill(pid, signal.SIGSTOP)
        try:
            time.sleep(4.5)  # Past the three-second capability timeout.
            self.assertIsNone(self.server.poll())
        finally:
            os.kill(pid, signal.SIGCONT)
        time.sleep(1.5)
        self.assertIsNone(self.server.poll())
        self.commit(self.stage(), b'alive\n')

    def test_sequence_migrates_timestamp_journal_and_survives_restart(self):
        self.stop()
        self.enable_history()
        self.start(turn=True)
        self.commit(self.stage(), b'first\n')
        pending = next(self.state.rglob('pending-*'))
        journal = pending.parent
        # Legacy entry is far in the future; system time must not reorder it.
        pending.rename(journal / 'pending-00000000004000000000-999999999-legacy')
        (journal / 'sequence').unlink()
        self.commit(self.stage(), b'latest\n')
        self.assertGreater(int((journal / 'sequence').read_text()), 4000000000)
        self.stop()
        result = subprocess.run([str(self.nab_fixture), 'rebuild', str(self.root / '.note.nab'), '1'], capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, b'latest\n')
        self.start(turn=True)
        self.commit(self.stage(), b'next\n')
        self.stop()
        self.assertGreater(int((journal / 'sequence').read_text()), 4000000001)

    def test_staged_delete_and_history(self):
        self.enable_history()
        staged = self.cli('stage', '--path', 'note', '--delete', '--author', 'astra')
        self.proposals.append(Path(staged['file']))
        self.assertTrue(self.file.exists())
        self.cli('commit', '--ticket', staged['ticket'], '--delete', '--author', 'astra')
        self.assertFalse(self.file.exists())
        self.assertTrue((self.root / '.note.nab').exists())

    def test_delete_rejects_changed_file_and_operation_switch(self):
        staged = self.cli('stage', '--path', 'note', '--delete')
        self.proposals.append(Path(staged['file']))
        self.file.write_bytes(b'human edit\n')
        self.cli('commit', '--ticket', staged['ticket'], '--delete', check=False)
        self.assertEqual(self.file.read_bytes(), b'human edit\n')
        staged = self.stage()
        self.cli('commit', '--ticket', staged['ticket'], '--delete', check=False)
        self.assertTrue(self.file.exists())

    def test_symlink_retarget_replace_and_delete_preserve_referents(self):
        self.enable_history()
        link = self.root / 'link'
        link.symlink_to('note')
        staged = self.cli('stage', '--path', 'link', '--symlink')
        self.proposals.append(Path(staged['file']))
        self.assertEqual(Path(staged['file']).read_bytes(), b'note')
        self.commit(staged, b'missing-target')
        self.assertEqual(os.readlink(link), 'missing-target')
        self.assertEqual(self.file.read_bytes(), b'baseline\n')
        staged = self.cli('stage', '--path', 'link', '--replace-symlink')
        self.proposals.append(Path(staged['file']))
        self.commit(staged, b'regular content\n')
        self.assertFalse(link.is_symlink())
        self.assertEqual(link.read_bytes(), b'regular content\n')
        link.unlink()
        link.symlink_to('note')
        staged = self.cli('stage', '--path', 'link', '--delete')
        self.proposals.append(Path(staged['file']))
        self.cli('commit', '--ticket', staged['ticket'], '--delete')
        self.assertFalse(link.is_symlink())
        self.assertEqual(self.file.read_bytes(), b'baseline\n')
        self.assertTrue((self.root / '.link.nab').exists())

    def test_symlink_operation_rejects_changed_link_and_symlink_parent(self):
        link = self.root / 'link'
        link.symlink_to('note')
        staged = self.cli('stage', '--path', 'link', '--replace-symlink')
        self.proposals.append(Path(staged['file']))
        link.unlink()
        link.symlink_to('elsewhere')
        self.commit(staged, check=False)
        self.assertEqual(os.readlink(link), 'elsewhere')
        (self.root / 'directory-link').symlink_to(self.root, target_is_directory=True)
        self.cli('stage', '--path', 'directory-link/link', '--symlink', check=False)
        self.cli('stage', '--path', 'note', '--symlink', check=False)

    def test_change_subscribers_receive_only_committed_changes(self):
        directory = Path(f"/tmp/alock-events-{os.getuid()}")
        directory.mkdir(mode=0o700, exist_ok=True)
        sockets = []
        paths = []
        for index in range(2):
            path = directory / f"bridge-test-{os.getpid()}-{index}.sock"
            listener = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
            listener.bind(str(path))
            listener.settimeout(0.1)
            sockets.append(listener)
            paths.append(path)
        try:
            staged = self.stage()
            for listener in sockets:
                with self.assertRaises(socket.timeout):
                    listener.recv(65536)
            self.commit(staged, b"changed\n")
            for listener in sockets:
                event = json.loads(listener.recv(65536))
                self.assertEqual(event["kind"], "change")
                self.assertEqual(event["file"], str(self.file))
                self.assertEqual(event["author"], "bridge-test")
            staged = self.stage()
            self.file.write_bytes(b"human edit\n")
            self.commit(staged, check=False)
            for listener in sockets:
                with self.assertRaises(socket.timeout):
                    listener.recv(65536)
        finally:
            for listener in sockets:
                listener.close()
            for path in paths:
                path.unlink(missing_ok=True)

    def test_invalid_symlink_target_and_abort_preserve_link(self):
        link = self.root / 'link'
        link.symlink_to('note')
        for invalid in (b'', b'bad\x00target', b'target\n'):
            staged = self.cli('stage', '--path', 'link', '--symlink')
            self.proposals.append(Path(staged['file']))
            self.commit(staged, invalid, check=False)
            self.assertEqual(os.readlink(link), 'note')
        staged = self.cli('stage', '--path', 'link', '--delete')
        self.proposals.append(Path(staged['file']))
        self.cli('abort', '--ticket', staged['ticket'])
        self.assertEqual(os.readlink(link), 'note')
        self.cli('stage', '--path', '.', '--delete', check=False)

    def test_real_commit_and_ticket_replay(self):
        staged = self.stage()
        self.assertEqual(Path(staged['file']).read_bytes(), b'baseline\n')
        self.assertEqual(Path(staged['file']).stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.file.read_bytes(), b'baseline\n')
        self.commit(staged)
        self.assertEqual(self.file.read_bytes(), b'proposal\n')
        self.assertIn('ticket', self.commit(staged, check=False))

    def enable_history(self):
        self.config.mkdir()
        (self.config / 'alock.toml').write_text('nab = true # enable recording\n')

    def history_versions(self):
        archive = self.root / '.note.nab'
        if not archive.exists(): return 0
        result = subprocess.run([str(self.nab_fixture), 'log', str(archive)], capture_output=True, text=True, check=True)
        return len(result.stdout.splitlines())

    def test_solo_turn_defers_versions_but_saves_each_snapshot(self):
        self.enable_history()
        self.stop()
        self.start(turn=True)
        self.commit(self.stage(), b'first\n')
        self.commit(self.stage(), b'second\n')
        self.assertEqual(self.history_versions(), 0)
        self.assertEqual(len(list(self.state.rglob('pending-*'))), 2)
        self.stop()
        self.assertEqual(self.history_versions(), 2) # baseline plus one turn
        self.assertFalse(list(self.state.rglob('pending-*')))
        rebuilt = subprocess.check_output([str(self.nab_fixture), 'rebuild', str(self.root / '.note.nab')])
        self.assertEqual(rebuilt, b'second\n')

    def test_join_flushes_then_each_concurrent_edit_records_even_with_same_author(self):
        self.enable_history()
        self.stop()
        self.start(turn=True)
        self.commit(self.stage(), b'A1\n')
        self.commit(self.stage(), b'A2\n')
        primary = self.endpoint
        other_socket = str(self.root / 'other-socket')
        other = subprocess.Popen([str(self.harness), str(self.root), other_socket, str(os.getuid()), '--turn'],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=self.env)
        try:
            self.assertTrue(select.select([other.stdout], [], [], 5)[0])
            self.assertIn('Bridge ready', other.stdout.readline())
            self.endpoint = other_socket
            staged = self.stage()
            self.assertEqual(self.history_versions(), 2) # A flushed before B gets its stage
            self.cli('abort', '--ticket', staged['ticket'])
            self.endpoint = primary
            self.commit(self.stage(), b'A3\n')
            self.assertEqual(self.history_versions(), 3)
            self.endpoint = other_socket
            self.commit(self.stage(), b'B1\n')
            self.assertEqual(self.history_versions(), 4)
            other.terminate()
            _, error = other.communicate(timeout=15)
            self.assertEqual(other.returncode, 0, error)
            self.endpoint = primary
            self.commit(self.stage(), b'A4\n')
            self.assertEqual(self.history_versions(), 4)
            self.stop()
            self.assertEqual(self.history_versions(), 5)
        finally:
            self.endpoint = primary
            if other.poll() is None: other.terminate()
            other.communicate(timeout=15)

    def test_failed_flush_blocks_incoming_turn(self):
        self.enable_history()
        self.stop()
        self.start(turn=True)
        self.commit(self.stage(), b'A1\n')
        archive = self.root / '.note.nab'
        archive.write_bytes(b'corrupt')
        other_socket = str(self.root / 'other-socket')
        other = subprocess.Popen([str(self.harness), str(self.root), other_socket, str(os.getuid()), '--turn'],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=self.env)
        primary = self.endpoint
        try:
            self.assertTrue(select.select([other.stdout], [], [], 5)[0])
            self.assertIn('Bridge ready', other.stdout.readline())
            self.endpoint = other_socket
            self.cli('stage', '--path', 'note', check=False)
            self.assertEqual(self.file.read_bytes(), b'A1\n')
            self.assertTrue(list(self.state.rglob('pending-*')))
        finally:
            self.endpoint = primary
            archive.unlink()
            other.terminate()
            other.communicate(timeout=15)

    def test_heartbeat_keeps_solo_batch_and_crash_flushes_after_lease(self):
        self.enable_history()
        self.stop()
        self.start(turn=True)
        self.commit(self.stage(), b'pending\n')
        time.sleep(4) # longer than the test turn lease; heartbeats keep it alive
        self.assertEqual(self.history_versions(), 0)
        self.server.kill()
        self.server.communicate(timeout=5)
        self.server = None
        deadline = time.monotonic() + 7
        while time.monotonic() < deadline and not (self.root / '.note.nab').exists():
            time.sleep(0.1)
        self.assertEqual(self.history_versions(), 2)
        self.assertFalse(list(self.state.rglob('pending-*')))

    def test_daemon_restart_recovers_durable_turn_snapshots(self):
        self.enable_history()
        self.stop()
        self.start(turn=True)
        self.commit(self.stage(), b'recovery\n')
        pid = int(subprocess.check_output([str(self.harness), '--daemon-pid'], env=self.env))
        self.assertGreater(pid, 1)
        self.server.kill()
        self.server.communicate(timeout=5)
        self.server = None
        os.kill(pid, signal.SIGKILL)
        # Start a separate endpoint; a killed bridge leaves its old socket behind.
        self.endpoint = str(self.root / 'restarted-socket')
        self.start(turn=True)
        self.assertEqual(self.history_versions(), 2)
        self.assertFalse(list(self.state.rglob('pending-*')))
        self.commit(self.stage(), b'next turn\n')
        self.stop()
        self.assertEqual(self.history_versions(), 3)

    def test_required_author_and_recorded_history(self):
        self.enable_history()
        staged = self.stage()
        result = subprocess.run([str(self.binary), 'bridge', 'commit', '--socket', self.endpoint,
                                 '--ticket', staged['ticket'], '--file', staged['file']],
                                capture_output=True, text=True, env=self.env)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('--author', result.stderr)
        self.assertEqual(self.file.read_bytes(), b'baseline\n')
        self.commit(staged, b'first\n')
        self.commit(self.stage(), b'second\n')
        archive = self.root / '.note.nab'
        result = subprocess.run([str(ROOT.parent / 'nab/nab'), 'rebuild', str(archive)], capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, b'second\n')
        log = subprocess.run([str(self.binary), 'history', '--file', str(self.file)], env=self.env, capture_output=True, text=True)
        self.assertEqual(log.returncode, 0, log.stderr)
        self.assertEqual(log.stdout.count('bridge-test'), 2)

    def test_history_failure_preserves_archive_and_retryable_snapshot(self):
        self.enable_history()
        self.commit(self.stage(), b'first\n')
        archive = self.root / '.note.nab'
        original = archive.read_bytes()
        archive.write_bytes(b'corrupt')
        error = self.commit(self.stage(), b'second\n', check=False)
        self.assertIn('File changed but nab history failed', error)
        self.assertEqual(self.file.read_bytes(), b'second\n')
        self.assertEqual(archive.read_bytes(), b'corrupt')
        self.assertTrue(list(self.state.rglob('pending-*')))
        archive.write_bytes(original)
        result = subprocess.run([str(self.binary), 'history', '--file', str(self.file), '--retry'],
                                env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(list(self.state.rglob('pending-*')))

    def test_pre_author_archive_migration_remains_readable(self):
        self.enable_history()
        archive = self.root / '.note.nab'
        subprocess.run([str(self.nab_fixture), '--legacy', str(self.file), str(archive)], check=True)
        self.commit(self.stage(), b'first\n')
        self.commit(self.stage(), b'second\n')
        for version, expected in [('0', b'baseline\n'), ('1', b'first\n'), ('2', b'second\n')]:
            result = subprocess.run([str(self.nab_fixture), 'rebuild', str(archive), version], capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, expected)

    def test_sidecar_symlink_is_rejected_without_touching_target(self):
        self.enable_history()
        target = self.root / 'unrelated'
        target.write_bytes(b'preserve me')
        (self.root / '.note.nab').symlink_to(target)
        self.commit(self.stage(), check=False)
        self.assertEqual(target.read_bytes(), b'preserve me')

    def test_disabled_history_and_invalid_boolean(self):
        self.commit(self.stage())
        self.assertFalse(self.state.exists())
        self.enable_history()
        staged = self.stage()
        (self.config / 'alock.toml').write_text('nab = "true"\n')
        before = self.file.read_bytes()
        self.assertIn('TOML boolean', self.commit(staged, check=False))
        self.assertEqual(self.file.read_bytes(), before)

    def test_wrong_kernel_uid_denied(self):
        self.stop()
        self.start(os.getuid() + 1)
        self.cli('stage', '--path', 'note', check=False)
        self.assertEqual(self.file.read_bytes(), b'baseline\n')

    def test_production_cli_refuses_same_uid_and_root(self):
        for user in (pwd.getpwuid(os.getuid()).pw_name, 'root'):
            error = self.cli('serve', '--root', str(self.root), '--user', user, check=False)
            self.assertIn('different non-root account', error)

    def test_stale_human_append_rejected(self):
        staged = self.stage()
        self.file.write_bytes(b'baseline\nhuman append\n')
        self.assertIn('changed since staging', self.commit(staged, check=False))
        self.assertEqual(self.file.read_bytes(), b'baseline\nhuman append\n')

    def test_conflicting_agents_and_abort(self):
        staged = self.stage()
        self.cli('stage', '--path', 'note', check=False)
        self.cli('abort', '--ticket', staged['ticket'])
        self.commit(self.stage())

    def test_coordinates_with_existing_alock_clients(self):
        staged = self.stage()
        result = subprocess.run([str(self.binary), 'stage', '--file', str(self.file),
                                 '--lines', '1-2147483647', '--agent', 'native-bridge-test'],
                                capture_output=True, text=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.cli('abort', '--ticket', staged['ticket'])

    def test_path_escape_links_and_missing_file(self):
        (self.root / 'link').symlink_to(self.file)
        for path in ('../note', '/etc/passwd', './note', 'a/../note', 'link', 'missing/child'):
            with self.subTest(path=path):
                self.cli('stage', '--path', path, check=False)
        os.link(self.file, self.root / 'hardlink')
        self.cli('stage', '--path', 'note', check=False)

    def test_directory_permissions_rechecked(self):
        staged = self.stage()
        self.root.chmod(0o777)
        try:
            self.assertIn('permissions', self.commit(staged, check=False))
        finally:
            self.root.chmod(0o700)
        self.assertEqual(self.file.read_bytes(), b'baseline\n')

    def test_create_file_and_directory(self):
        self.cli('mkdir', '--path', 'package')
        staged = self.stage('package/main.go')
        self.assertFalse((self.root / 'package/main.go').exists())
        self.assertEqual(Path(staged['file']).read_bytes(), b'')
        self.commit(staged, b'package main\n')
        self.assertEqual((self.root / 'package/main.go').read_bytes(), b'package main\n')
        self.assertEqual((self.root / 'package/main.go').stat().st_mode & 0o777, 0o644)
        self.cli('mkdir', '--path', 'package', check=False)
        self.cli('mkdir', '--path', '../escape', check=False)

    def test_create_abort_and_concurrent_creator(self):
        staged = self.stage('new')
        self.cli('abort', '--ticket', staged['ticket'])
        self.assertFalse((self.root / 'new').exists())
        staged = self.stage('new')
        (self.root / 'new').write_bytes(b'human edit')
        self.commit(staged, check=False)
        self.assertEqual((self.root / 'new').read_bytes(), b'human edit')

    def test_create_rejects_replaced_parent(self):
        self.cli('mkdir', '--path', 'package')
        staged = self.stage('package/new')
        (self.root / 'package').rename(self.root / 'old')
        (self.root / 'package').symlink_to(self.root / 'old')
        self.commit(staged, check=False)
        self.assertFalse((self.root / 'old/new').exists())

    @unittest.skipUnless(sys.platform == 'darwin', 'macOS ACL syntax')
    def test_extended_acl_rejected(self):
        subprocess.run(['/bin/chmod', '+a', 'everyone allow read', str(self.file)], check=True)
        self.cli('stage', '--path', 'note', check=False)

    @unittest.skipUnless(sys.platform == 'darwin', 'macOS ACL syntax')
    def test_home_style_deny_acl_allows_bridge_but_allow_acl_rejected(self):
        self.stop()
        subprocess.run(['/bin/chmod', '+a', 'everyone deny delete', str(self.root)], check=True)
        try:
            self.start()
            self.commit(self.stage())
            subprocess.run(['/bin/chmod', '+a', 'everyone allow write', str(self.root)], check=True)
            self.cli('stage', '--path', 'note', check=False)
        finally:
            subprocess.run(['/bin/chmod', '-N', str(self.root)], check=True)

    def test_target_replaced_with_symlink(self):
        staged = self.stage()
        other = self.root / 'other'
        other.write_bytes(b'untouched')
        self.file.unlink()
        self.file.symlink_to(other)
        self.commit(staged, check=False)
        self.assertEqual(other.read_bytes(), b'untouched')

    def test_expiry_and_shutdown_release_locks(self):
        staged = self.stage()
        time.sleep(3.1)  # Harness shortens the production 60-second lease.
        self.assertIn('ticket', self.commit(staged, check=False))
        self.stage()
        self.stop()
        self.assertFalse(Path(self.endpoint).exists())
        self.start()
        self.commit(self.stage())

    def test_oversize_proposal_and_file_rejected(self):
        staged = self.stage()
        self.assertIn('limit', self.commit(staged, b'x' * (LIMIT + 1), check=False))
        self.cli('abort', '--ticket', staged['ticket'])
        self.file.write_bytes(b'x' * (LIMIT + 1))
        self.cli('stage', '--path', 'note', check=False)

    def test_empty_and_binary_content(self):
        self.commit(self.stage(), b'')
        self.assertEqual(self.file.read_bytes(), b'')
        self.commit(self.stage(), b'a\0b\xff\n')
        self.assertEqual(self.file.read_bytes(), b'a\0b\xff\n')

    def test_existing_socket_is_not_unlinked(self):
        result = subprocess.run([str(self.harness), str(self.root), self.endpoint, str(os.getuid())],
                                capture_output=True, text=True, timeout=5)
        self.assertNotEqual(result.returncode, 0)
        self.commit(self.stage())

    def test_malformed_and_fragmented_frames(self):
        # Hostile boundary: a 4-byte little-endian length then a DTOB payload.
        # Nothing here is valid DTOB, so the decoder must reject every case
        # without the server dying. Bytes go out one at a time so a frame split
        # across many reads is still bounded by the transfer deadline.
        packets = [struct.pack('<I', 0),                       # empty envelope
                   struct.pack('<I', 1 << 30),                 # length past FRAME_LIMIT
                   struct.pack('<I', 8) + b'notdtob!',         # payload is not DTOB
                   struct.pack('<I', 3) + b'\xff\xff\xff',     # truncated garbage
                   struct.pack('<I', 6) + b'ALB1\x00\x01']     # the retired framing
        for packet in packets:
            with socket.socket(socket.AF_UNIX) as client:
                client.settimeout(5)
                client.connect(self.endpoint)
                try:
                    for byte in packet:
                        client.sendall(bytes([byte]))
                except BrokenPipeError:
                    pass  # server may reject on the length prefix alone
                try:
                    reply = client.recv(4)
                except (ConnectionResetError, socket.timeout):
                    reply = b''
                # Either a framed error reply, or the connection is dropped.
                if reply:
                    self.assertEqual(len(reply), 4)
                    self.assertTrue(0 < struct.unpack('<I', reply)[0] <= (1 << 30))
        # The server survived all of it and still serves a real request.
        self.commit(self.stage())

    @unittest.skip('Standalone in-place history synchronization is deferred; bundled history still uses copy/rename')
    def test_archive_inode_preserved_and_flock_blocks(self):
        self.enable_history()
        self.commit(self.stage(), b'first\n')
        archive = self.root / '.note.nab'
        self.assertTrue(archive.exists())
        self.assertEqual(archive.stat().st_mode & 0o777, 0o600)
        ino_before = archive.stat().st_ino

        with archive.open('rb') as holder:
            fcntl.flock(holder, fcntl.LOCK_EX)
            staged = self.stage()
            Path(staged['file']).write_bytes(b'second\n')

            import threading
            commit_done = threading.Event()
            commit_error = []

            def do_commit():
                try:
                    self.cli('commit', '--ticket', staged['ticket'], '--file', staged['file'])
                except Exception as e:
                    commit_error.append(e)
                finally:
                    commit_done.set()

            t = threading.Thread(target=do_commit)
            t.start()

            self.assertFalse(commit_done.wait(timeout=0.3), "commit should be blocked by archive flock")

            fcntl.flock(holder, fcntl.LOCK_UN)
            self.assertTrue(commit_done.wait(timeout=5), "commit timed out after flock release")
            t.join()
            self.assertEqual(commit_error, [])

        self.assertEqual(archive.stat().st_ino, ino_before)
        self.assertEqual(archive.stat().st_mode & 0o777, 0o600)

        for version, expected in [('0', b'baseline\n'), ('1', b'first\n'), ('2', b'second\n')]:
            result = subprocess.run([str(self.nab_fixture), 'rebuild', str(archive), version], capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, expected)


if __name__ == '__main__':
    unittest.main()
