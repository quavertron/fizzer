"""Real separate-UID local -> DTOB/HTTP -> remote smoke test, with disposable files.

Usage: python3 tests/account_http_smoke.py /absolute/path/to/alock [agent-user]
Requires an existing account and passwordless permission to launch as that user.
"""
import json
import os
from pathlib import Path
import secrets
import select
import subprocess
import sys
import tempfile


def run(binary, user):
    children = []
    proposals = []
    with tempfile.TemporaryDirectory(prefix='alock-http-uid-', dir='/tmp') as temporary:
        root = Path(temporary).resolve()
        root.chmod(0o755)
        mirror, remote = root / 'mirror', root / 'remote'
        mirror.mkdir(0o755)
        remote.mkdir(0o755)
        baseline = b'baseline\n'
        (mirror / 'note').write_bytes(baseline)
        (remote / 'note').write_bytes(baseline)
        header = root / 'authorization'
        header.write_text('Authorization: Bearer ' + secrets.token_hex(32) + '\n')
        header.chmod(0o600)

        def start(args):
            child = subprocess.Popen([binary, 'account', *args], stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            children.append(child)
            readable, _, _ = select.select([child.stdout], [], [], 15)
            if not readable:
                raise RuntimeError('Daemon startup timed out')
            line = child.stdout.readline()
            if not line:
                raise RuntimeError(child.stderr.read().decode())
            return child, json.loads(line)

        def agent(*args, success=True):
            result = subprocess.run(['sudo', '-n', '-H', '-u', user, '--', binary, 'account', *args],
                                    capture_output=True, text=True, timeout=30)
            if success:
                assert result.returncode == 0, result.stderr
                return json.loads(result.stdout)
            assert result.returncode != 0, result.stdout
            return result

        try:
            server, ready = start(['http-serve', '--root', str(remote), '--listen', '127.0.0.1:0', '--header-file', str(header)])
            socket = str(root / 'agent.sock')
            bridge, _ = start(['serve', '--root', str(mirror), '--user', user, '--socket', socket,
                               '--remote-url', 'http://' + ready['address'], '--header-file', str(header)])
            staged = agent('stage', '--socket', socket, '--path', 'note', '--base', str(mirror / 'note'), '--author', 'smoke-agent')
            proposal = staged['file']
            proposals.extend([proposal, proposal + '.alock'])
            for content in ['first remote edit\n', 'second remote edit\n']:
                subprocess.run(['sudo', '-n', '-H', '-u', user, '--', sys.executable, '-c',
                    'from pathlib import Path; import sys; Path(sys.argv[1]).write_text(sys.argv[2])', proposal, content], check=True)
                agent('commit', '--socket', socket, '--ticket', staged['ticket'], '--file', proposal, '--author', 'smoke-agent')
                assert (remote / 'note').read_text() == content
                assert (mirror / 'note').read_bytes() == baseline, 'Mirror changed despite syncing being deferred'
                assert server.poll() is None and bridge.poll() is None
            stale = agent('stage', '--socket', socket, '--path', 'note', '--base', str(mirror / 'note'), '--author', 'smoke-agent', success=False)
            assert stale.returncode == 3, stale.stderr
            bridge.stdin.write(b'conclude\n')
            bridge.stdin.flush()
            readable, _, _ = select.select([bridge.stdout], [], [], 15)
            assert readable and json.loads(bridge.stdout.readline())['concluded']
            assert (remote / '.note.nab').is_file()
            print(json.dumps({'ok': True, 'remotePid': server.pid, 'localPid': bridge.pid,
                              'agentUser': user, 'mirrorUnchanged': True, 'turnConcluded': True}))
        finally:
            for child in reversed(children):
                child.terminate()
                try:
                    _, stderr = child.communicate(timeout=15)
                except subprocess.TimeoutExpired:
                    child.kill()
                    _, stderr = child.communicate()
                if child.returncode != 0:
                    print(stderr.decode(), file=sys.stderr)
            if proposals:
                subprocess.run(['sudo', '-n', '-H', '-u', user, '--', '/bin/rm', '-f', *proposals], check=True)


if __name__ == '__main__':
    run(str(Path(sys.argv[1]).resolve()), sys.argv[2] if len(sys.argv) > 2 else 'fizzer')
