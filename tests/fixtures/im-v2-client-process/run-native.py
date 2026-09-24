"""TEST ONLY immutable allowlisted snapshot; reused lock-matching deps, no install.
Every attempt retains unique native/outer/Windows logs and before/after manifests.
"""
import base64
import hashlib
import json
import pathlib
import subprocess
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[3]
HEAD = '7f0d0f68c382ef391356d1d2c9b87e0cd3f3ba85'
BASE = '/root/team-mailbox-unix-ab-6d98adn4'
PINS = {
    'src/im/v2/client.js': '5bc027f2f39a2b7e8d65e4be80aece0dafc81c099c2b78503fc7606fe13aa9ee',
    'src/im/v2/journal.js': '160ca3d8931c2b2e61f45b63f885fe8bfdb7e3dc637c39b60d6391f9566a1af0',
}
TESTS = ['tests/im-v2-client-process.test.js', 'tests/im-v2-client-faults.test.js']
assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT).decode().strip() == HEAD
names = subprocess.check_output(['git', 'ls-tree', '-r', '--name-only', HEAD], cwd=ROOT).decode().splitlines()
committed = [n for n in names if n in ['package.json', 'package-lock.json'] or n.startswith('src/im/') or
             n.startswith('tests/fixtures/im-v2-') or n.startswith('tests/fixtures/im-tls/')]
owned = TESTS + ['tests/fixtures/im-v2-client/harness.js']
owned += [p.relative_to(ROOT).as_posix() for p in (ROOT / 'tests/fixtures/im-v2-client-process').rglob('*')
          if p.is_file() and '__pycache__' not in p.parts]
files, manifest = {}, {}
for name in sorted(set(committed + owned + list(PINS))):
    data = (ROOT / name).read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if name in PINS:
        assert digest == PINS[name], f'pinned source mismatch: {name}'
        origin = 'explicit-pinned-source-overlay'
    elif name in committed:
        assert data == subprocess.check_output(['git', 'show', f'{HEAD}:{name}'], cwd=ROOT), f'changed base prerequisite: {name}'
        origin = HEAD
    else:
        origin = 'readonly-existing-client-harness' if name == 'tests/fixtures/im-v2-client/harness.js' else 'new-bounded-test-lane'
    files[name] = base64.b64encode(data).decode()
    manifest[name] = {'sha256': digest, 'origin': origin}
for name, entry in manifest.items():
    assert hashlib.sha256((ROOT / name).read_bytes()).hexdigest() == entry['sha256'], f'changed during capture: {name}'
run_id = 'p4-process-' + uuid.uuid4().hex
evidence = pathlib.Path('C:/Users/ttx/AppData/Local/Temp/opencode') / run_id
evidence.mkdir()
payload = {'files': files, 'manifest': manifest, 'run_id': run_id, 'base': BASE,
           'base_commit': HEAD, 'pins': PINS, 'tests': TESTS}
script = '''import base64, hashlib, json, os, pathlib, signal, subprocess
p = json.loads(base64.b64decode(PAYLOAD))
root = pathlib.Path('/root') / p['run_id']; root.mkdir(mode=0o700)
snapshot = root / 'snapshot'; snapshot.mkdir(mode=0o700)
for name, encoded in p['files'].items():
    path = snapshot / name; path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    data = base64.b64decode(encoded)
    assert hashlib.sha256(data).hexdigest() == p['manifest'][name]['sha256']
    path.write_bytes(data); path.chmod(0o400)
base = pathlib.Path(p['base'])
assert hashlib.sha256((base / 'snapshot/package-lock.json').read_bytes()).hexdigest() == p['manifest']['package-lock.json']['sha256']
(snapshot / 'node_modules').symlink_to(base / 'snapshot/node_modules', target_is_directory=True)
node = str(base / 'node-v24.19.0-linux-x64/bin/node')
command = [node, '--test', '--test-reporter=tap', '--test-concurrency=1'] + p['tests']
metadata = {'base_commit': p['base_commit'], 'pins': p['pins'], 'manifest': p['manifest'],
    'node_sha256': hashlib.sha256(pathlib.Path(node).read_bytes()).hexdigest(),
    'node_version': subprocess.check_output([node, '--version']).decode().strip(),
    'filesystem': subprocess.check_output(['stat','-f','-c','%T',str(root)]).decode().strip(),
    'reused_deps': str(base / 'snapshot/node_modules'), 'command': command}
(root / 'manifest.json').write_text(json.dumps(metadata, indent=2))
with (root / 'native.stdout.log').open('wb') as out, (root / 'native.stderr.log').open('wb') as err:
    child = subprocess.Popen(command, cwd=snapshot, stdout=out, stderr=err, start_new_session=True)
    (root / 'owned-test-pid.txt').write_text(str(child.pid)); timed_out = False
    try: code = child.wait(timeout=600)
    except subprocess.TimeoutExpired:
        timed_out = True; os.killpg(child.pid, signal.SIGTERM)
        try: code = child.wait(timeout=7)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL); code = child.wait(timeout=7)
(root / 'native.exit.json').write_text(json.dumps({'exit':code, 'timed_out':timed_out}))
after = {name: {'before': entry['sha256'], 'after': hashlib.sha256((snapshot/name).read_bytes()).hexdigest()}
    for name, entry in p['manifest'].items()}
(root / 'after-manifest.json').write_text(json.dumps(after, indent=2))
assert all(x['before'] == x['after'] for x in after.values())
print(json.dumps({'root':str(root),'exit':code,'timed_out':timed_out}))
print((root / 'native.stdout.log').read_text()); print((root / 'native.stderr.log').read_text())
raise SystemExit(code if not timed_out and code >= 0 else 1)
'''.replace('PAYLOAD', repr(base64.b64encode(json.dumps(payload).encode()).decode()))
(evidence / 'native-wrapper.py').write_text(script, encoding='utf-8', newline='\n')
(evidence / 'source-manifest.json').write_text(json.dumps(manifest, indent=2))
(evidence / 'snapshot-context.json').write_text(json.dumps({'base_commit': HEAD, 'pins': PINS, 'tests': TESTS}, indent=2))

def run(command, timeout, data=None):
    child = subprocess.Popen(command, cwd=ROOT, stdin=subprocess.PIPE if data else subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        out, err = child.communicate(input=data, timeout=timeout)
        return {'exit': child.returncode, 'timed_out': False}, out, err
    except subprocess.TimeoutExpired:
        child.terminate()
        try: out, err = child.communicate(timeout=8)
        except subprocess.TimeoutExpired:
            child.kill(); out, err = child.communicate(timeout=8)
        return {'exit': 124, 'timed_out': True}, out, err

native, out, err = run(['wsl', '-d', 'Ubuntu-24.04', '--', 'python3', '-'], 640, script.encode())
for name, data in [('outer.stdout.log', out), ('outer.stderr.log', err)]: (evidence / name).write_bytes(data)
(evidence / 'outer.exit.json').write_text(json.dumps(native))
windows, wout, werr = run(['node', '--test', '--test-reporter=tap'] + TESTS, 90)
(evidence / 'windows.stdout.log').write_bytes(wout); (evidence / 'windows.stderr.log').write_bytes(werr)
(evidence / 'windows.exit.json').write_text(json.dumps(windows))
(evidence / 'post-run-hashes.json').write_text(json.dumps({name: {
    'before': entry['sha256'], 'after': hashlib.sha256((ROOT / name).read_bytes()).hexdigest(),
} for name, entry in manifest.items()}, indent=2))
print(f'EVIDENCE {evidence}'); print(out.decode(errors='replace')); print(err.decode(errors='replace'))
print(f'OUTER_EXIT {native["exit"]} WINDOWS_EXIT {windows["exit"]}')
raise SystemExit(native['exit'] or windows['exit'])
