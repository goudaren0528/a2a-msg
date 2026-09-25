"""Isolated ext4 evidence runner; invoked from WSL, never reads runtime data."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import signal

source = Path('/mnt/d/team-mailbox')
base = Path('/root/team-mailbox-unix-ab-6d98adn4')
run = Path(tempfile.mkdtemp(prefix='p5-a-', dir=base))
candidate = run / 'candidate'
candidate.mkdir(mode=0o700)
hashes = {}
for directory in ['src', 'tests']:
    for path in (source / directory).rglob('*'):
        if path.is_file():
            relative = path.relative_to(source)
            data = path.read_bytes()
            target = candidate / relative
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            target.write_bytes(data)
            hashes[str(relative)] = hashlib.sha256(data).hexdigest()
for name in ['package.json', 'package-lock.json', 'docs/im-v2-recovery-storage-contract.md']:
    data = (source / name).read_bytes()
    (candidate / name).parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    (candidate / name).write_bytes(data)
    hashes[name] = hashlib.sha256(data).hexdigest()
os.symlink(base / 'snapshot/node_modules', candidate / 'node_modules')
node = base / 'node-v24.19.0-linux-x64/bin/node'
command = [str(node), '--test', 'tests/im-v2-backup.test.js',
           'tests/im-v2-backup-registry.test.js', 'tests/im-backup-registry.test.js']
metadata = {'sourceHashes': hashes, 'command': command,
            'node': subprocess.check_output([str(node), '--version'], text=True).strip(),
            'filesystem': subprocess.check_output(['stat', '-f', '-c', '%T', str(run)], text=True).strip()}
(run / 'metadata.json').write_text(json.dumps(metadata, indent=2))
with (run / 'targeted.log').open('w') as log:
    child = subprocess.Popen(command, cwd=candidate, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    timed_out = False
    try:
        code = child.wait(timeout=60)
    except subprocess.TimeoutExpired:
        timed_out = True
        os.killpg(child.pid, signal.SIGTERM)
        try:
            code = child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            code = child.wait(timeout=3)
(run / 'native-exit.json').write_text(json.dumps({'exitCode': code, 'timeout': timed_out}))
print(str(run), flush=True)
print((run / 'targeted.log').read_text(), flush=True)
raise SystemExit(code if code >= 0 else 1)
