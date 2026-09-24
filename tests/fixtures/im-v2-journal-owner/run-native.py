"""Bounded source-only Windows -> authorized local WSL owner-test evidence run.

No dependency installation. The existing isolated lock-matching deps are reused.
Every snapshot is unique and retained, including failures and native/outer exits.
"""
import base64
import hashlib
import json
import pathlib
import subprocess
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[3]
HEAD = '24b45e77e59e735cb37d93e8b951d95498c79a22'
BASE = '/root/team-mailbox-unix-ab-6d98adn4'
committed = ['package.json', 'package-lock.json', 'src/im/v2/contracts.js',
             'src/im/v2/journal.js', 'src/im/v2/journal-schema.js', 'src/im/transaction.js']
owned = ['src/im/v2/journal-owner.js', 'tests/im-v2-journal-owner.test.js',
         'tests/fixtures/im-v2-journal-owner/child.js',
         'tests/fixtures/im-v2-journal-owner/run-native.py']
assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, timeout=15).decode().strip() == HEAD
files = {}
manifest = {}
for name in committed + owned:
    data = subprocess.check_output(['git', 'show', f'{HEAD}:{name}'], cwd=ROOT, timeout=15) if name in committed else (ROOT / name).read_bytes()
    if name in committed:
        assert data == (ROOT / name).read_bytes(), f'working source differs: {name}'
    files[name] = base64.b64encode(data).decode()
    manifest[name] = {'sha256': hashlib.sha256(data).hexdigest(), 'origin': HEAD if name in committed else 'owned-untracked'}
run_id = 'p4-owner-recovery-' + uuid.uuid4().hex
evidence = pathlib.Path('C:/Users/ttx/AppData/Local/Temp/opencode') / run_id
evidence.mkdir()
payload = {'files': files, 'manifest': manifest, 'run_id': run_id, 'base': BASE}
script = '''import base64, hashlib, json, os, pathlib, signal, subprocess
p = json.loads(base64.b64decode(PAYLOAD))
root = pathlib.Path('/root') / p['run_id']
root.mkdir(mode=0o700)
snapshot = root / 'snapshot'
snapshot.mkdir(mode=0o700)
for name, encoded in p['files'].items():
    path = snapshot / name
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    data = base64.b64decode(encoded)
    assert hashlib.sha256(data).hexdigest() == p['manifest'][name]['sha256']
    path.write_bytes(data)
base = pathlib.Path(p['base'])
assert hashlib.sha256((base / 'snapshot/package-lock.json').read_bytes()).hexdigest() == p['manifest']['package-lock.json']['sha256']
(snapshot / 'node_modules').symlink_to(base / 'snapshot/node_modules', target_is_directory=True)
node = str(base / 'node-v24.19.0-linux-x64/bin/node')
metadata = {'manifest': p['manifest'], 'node_sha256': hashlib.sha256(pathlib.Path(node).read_bytes()).hexdigest(),
             'node_version': subprocess.check_output([node, '--version'], timeout=10).decode().strip(),
             'filesystem': subprocess.check_output(['stat', '-f', '-c', '%T', str(root)], timeout=10).decode().strip(),
            'command': [node, '--test', '--test-reporter=tap', 'tests/im-v2-journal-owner.test.js']}
(root / 'manifest.json').write_text(json.dumps(metadata, indent=2))
with (root / 'native.stdout.log').open('wb') as out, (root / 'native.stderr.log').open('wb') as err:
    child = subprocess.Popen(metadata['command'], cwd=snapshot, stdout=out, stderr=err, start_new_session=True)
    (root / 'owned-test-pid.txt').write_text(str(child.pid))
    timed_out = False
    try:
        code = child.wait(timeout=90)
    except subprocess.TimeoutExpired:
        timed_out = True
        os.killpg(child.pid, signal.SIGTERM)
        try: code = child.wait(timeout=7)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            try: code = child.wait(timeout=7)
            except subprocess.TimeoutExpired: code = -999
(root / 'native.exit.json').write_text(json.dumps({'exit': code, 'timed_out': timed_out}))
print(json.dumps({'root': str(root), 'exit': code, 'timed_out': timed_out}))
print((root / 'native.stdout.log').read_text())
print((root / 'native.stderr.log').read_text())
raise SystemExit(code if not timed_out and code >= 0 else 1)
'''.replace('PAYLOAD', repr(base64.b64encode(json.dumps(payload).encode()).decode()))
(evidence / 'native-wrapper.py').write_text(script, encoding='utf-8', newline='\n')
(evidence / 'source-manifest.json').write_text(json.dumps(manifest, indent=2))
def bounded(command, timeout, *, input=None, cwd=None):
    proc = subprocess.Popen(command, cwd=cwd, stdin=subprocess.PIPE if input is not None else subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        out, err = proc.communicate(input=input, timeout=timeout)
        return {'exit': proc.returncode, 'timed_out': False}, out, err
    except subprocess.TimeoutExpired:
        proc.terminate()
        try: out, err = proc.communicate(timeout=8)
        except subprocess.TimeoutExpired:
            proc.kill()
            try: out, err = proc.communicate(timeout=8)
            except subprocess.TimeoutExpired: out, err = b'', b'owned process failed to exit after kill'
        return {'exit': 124, 'timed_out': True, 'owned_pid': proc.pid}, out, err

native, native_out, native_err = bounded(['wsl', '-d', 'Ubuntu-24.04', '--', 'python3', '-'], 125, input=script.encode())
(evidence / 'outer.stdout.log').write_bytes(native_out)
(evidence / 'outer.stderr.log').write_bytes(native_err)
(evidence / 'outer.exit.json').write_text(json.dumps(native))
windows, windows_out, windows_err = bounded(['node', '--test', '--test-reporter=tap', 'tests/im-v2-journal-owner.test.js'], 100, cwd=ROOT)
(evidence / 'windows.stdout.log').write_bytes(windows_out)
(evidence / 'windows.stderr.log').write_bytes(windows_err)
(evidence / 'windows.exit.json').write_text(json.dumps(windows))
print(f'EVIDENCE {evidence}')
print(native_out.decode(errors='replace'))
print(native_err.decode(errors='replace'))
print(f'OUTER_EXIT {native["exit"]} WINDOWS_EXIT {windows["exit"]}')
raise SystemExit(native['exit'] or windows['exit'])
