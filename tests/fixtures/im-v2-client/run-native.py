"""Source-only isolated native run. Reuses lock-matching isolated dependencies;
not a fresh install. Keeps hashes, stdout/stderr, native/outer/Windows exits.
"""
import base64
import hashlib
import json
import pathlib
import subprocess
import uuid
import argparse

parser = argparse.ArgumentParser(description='Hash-bound isolated P4 client test snapshot; never reads live source after capture.')
parser.add_argument('--label', required=True, choices=['preintegration', 'terminal-integration'])
parser.add_argument('--test-name-pattern')
args = parser.parse_args()

ROOT = pathlib.Path(__file__).resolve().parents[3]
HEAD = '7f0d0f68c382ef391356d1d2c9b87e0cd3f3ba85'
BASE = '/root/team-mailbox-unix-ab-6d98adn4'
APPROVED_OVERLAYS = {
    'src/im/v2/journal.js': '160ca3d8931c2b2e61f45b63f885fe8bfdb7e3dc637c39b60d6391f9566a1af0',
}
assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT).decode().strip() == HEAD
names = subprocess.check_output(['git', 'ls-tree', '-r', '--name-only', HEAD], cwd=ROOT).decode().splitlines()
committed = [n for n in names if n in ['package.json', 'package-lock.json'] or n.startswith('src/im/') or
             n.startswith('tests/fixtures/im-v2-') or n.startswith('tests/fixtures/im-tls/')]
owned = ['src/im/v2/client.js', 'tests/im-v2-client.test.js', 'tests/im-v2-client-recovery.test.js']
owned += [p.relative_to(ROOT).as_posix() for p in (ROOT / 'tests/fixtures/im-v2-client').rglob('*') if p.is_file()]
files, manifest = {}, {}
for name in committed + owned:
    data = (ROOT / name).read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if name in APPROVED_OVERLAYS:
        assert digest == APPROVED_OVERLAYS[name], f'unapproved source overlay: {name}'
        origin = 'approved-pinned-overlay'
    elif name in committed:
        assert data == subprocess.check_output(['git', 'show', f'{HEAD}:{name}'], cwd=ROOT), f'changed prerequisite: {name}'
        origin = HEAD
    else:
        origin = 'candidate-client' if name == 'src/im/v2/client.js' else 'owned-test-overlay'
    files[name] = base64.b64encode(data).decode()
    manifest[name] = {'sha256': digest, 'origin': origin}
# Detect writes during capture. Later edits cannot affect this byte snapshot.
for name, entry in manifest.items():
    assert hashlib.sha256((ROOT / name).read_bytes()).hexdigest() == entry['sha256'], f'changed during snapshot: {name}'
run_id = 'p4-client-' + uuid.uuid4().hex
evidence = pathlib.Path('C:/Users/ttx/AppData/Local/Temp/opencode') / run_id
evidence.mkdir()
payload = {'files': files, 'manifest': manifest, 'run_id': run_id, 'base': BASE,
           'label': args.label, 'test_name_pattern': args.test_name_pattern, 'base_commit': HEAD,
           'approved_overlays': APPROVED_OVERLAYS}
script = '''import base64, hashlib, json, os, pathlib, signal, subprocess
p = json.loads(base64.b64decode(PAYLOAD))
root = pathlib.Path('/root') / p['run_id']; root.mkdir(mode=0o700)
snapshot = root / 'snapshot'; snapshot.mkdir(mode=0o700)
for name, encoded in p['files'].items():
    path = snapshot / name; path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    data = base64.b64decode(encoded)
    assert hashlib.sha256(data).hexdigest() == p['manifest'][name]['sha256']
    path.write_bytes(data)
base = pathlib.Path(p['base'])
assert hashlib.sha256((base / 'snapshot/package-lock.json').read_bytes()).hexdigest() == p['manifest']['package-lock.json']['sha256']
(snapshot / 'node_modules').symlink_to(base / 'snapshot/node_modules', target_is_directory=True)
node = str(base / 'node-v24.19.0-linux-x64/bin/node')
command = [node, '--test', '--test-reporter=tap']
if p['test_name_pattern']: command.append('--test-name-pattern=' + p['test_name_pattern'])
command += ['tests/im-v2-client.test.js', 'tests/im-v2-client-recovery.test.js']
metadata = {'label': p['label'], 'base_commit': p['base_commit'], 'approved_overlays': p['approved_overlays'],
    'manifest': p['manifest'], 'node_sha256': hashlib.sha256(pathlib.Path(node).read_bytes()).hexdigest(),
    'node_version': subprocess.check_output([node, '--version']).decode().strip(),
    'filesystem': subprocess.check_output(['stat','-f','-c','%T',str(root)]).decode().strip(),
    'command': command}
(root / 'manifest.json').write_text(json.dumps(metadata, indent=2))
with (root / 'native.stdout.log').open('wb') as out, (root / 'native.stderr.log').open('wb') as err:
    child = subprocess.Popen(metadata['command'], cwd=snapshot, stdout=out, stderr=err, start_new_session=True)
    (root / 'owned-test-pid.txt').write_text(str(child.pid)); timed_out = False
    try: code = child.wait(timeout=180)
    except subprocess.TimeoutExpired:
        timed_out = True; os.killpg(child.pid, signal.SIGTERM)
        try: code = child.wait(timeout=7)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL); code = child.wait(timeout=7)
(root / 'native.exit.json').write_text(json.dumps({'exit':code, 'timed_out':timed_out}))
print(json.dumps({'root':str(root),'exit':code,'timed_out':timed_out}))
print((root / 'native.stdout.log').read_text()); print((root / 'native.stderr.log').read_text())
raise SystemExit(code if not timed_out and code >= 0 else 1)
'''.replace('PAYLOAD', repr(base64.b64encode(json.dumps(payload).encode()).decode()))
(evidence / 'native-wrapper.py').write_text(script, encoding='utf-8', newline='\n')
(evidence / 'source-manifest.json').write_text(json.dumps(manifest, indent=2))
(evidence / 'snapshot-context.json').write_text(json.dumps({
    'label': args.label, 'base_commit': HEAD, 'approved_overlays': APPROVED_OVERLAYS,
    'test_name_pattern': args.test_name_pattern}, indent=2))
def run(command, timeout, data=None):
    child = subprocess.Popen(command, cwd=ROOT, stdin=subprocess.PIPE if data else subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        out, err = child.communicate(input=data, timeout=timeout)
        return {'exit':child.returncode,'timed_out':False}, out, err
    except subprocess.TimeoutExpired:
        child.terminate()
        try: out, err = child.communicate(timeout=8)
        except subprocess.TimeoutExpired:
            child.kill(); out, err = child.communicate(timeout=8)
        return {'exit':124,'timed_out':True}, out, err
native, out, err = run(['wsl','-d','Ubuntu-24.04','--','python3','-'], 210, script.encode())
for name, data in [('outer.stdout.log',out),('outer.stderr.log',err)]: (evidence / name).write_bytes(data)
(evidence / 'outer.exit.json').write_text(json.dumps(native))
windows_command = ['node','--test','--test-reporter=tap']
if args.test_name_pattern: windows_command.append('--test-name-pattern=' + args.test_name_pattern)
windows_command += ['tests/im-v2-client.test.js','tests/im-v2-client-recovery.test.js']
windows, wout, werr = run(windows_command, 60)
(evidence / 'windows.stdout.log').write_bytes(wout); (evidence / 'windows.stderr.log').write_bytes(werr)
(evidence / 'windows.exit.json').write_text(json.dumps(windows))
(evidence / 'post-run-hashes.json').write_text(json.dumps({name: {
    'before': entry['sha256'], 'after': hashlib.sha256((ROOT / name).read_bytes()).hexdigest(),
} for name, entry in manifest.items()}, indent=2))
print(f'EVIDENCE {evidence}'); print(out.decode(errors='replace')); print(err.decode(errors='replace'))
print(f'OUTER_EXIT {native["exit"]} WINDOWS_EXIT {windows["exit"]}')
raise SystemExit(native['exit'] or windows['exit'])
