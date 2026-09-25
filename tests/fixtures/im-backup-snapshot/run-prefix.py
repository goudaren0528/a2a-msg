"""PRE-FIX targeted evidence only. No installs, runtime data or source writes."""
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile

source = Path('/mnt/d/team-mailbox')
base = Path('/root/team-mailbox-unix-ab-6d98adn4')
run = Path(tempfile.mkdtemp(prefix='old-snapshot-PREFIX-', dir=base))
candidate = run / 'candidate'
candidate.mkdir(mode=0o700)
hashes = {}
paths = [p for folder in ['src', 'tests'] for p in (source / folder).rglob('*') if p.is_file()]
paths += [source / 'package.json', source / 'package-lock.json']
for path in paths:
    relative = path.relative_to(source)
    data = path.read_bytes()
    target = candidate / relative
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    target.write_bytes(data)
    hashes[str(relative)] = hashlib.sha256(data).hexdigest()
os.symlink(base / 'snapshot/node_modules', candidate / 'node_modules')
node = base / 'node-v24.19.0-linux-x64/bin/node'
command = [str(node), '--test', 'tests/im-backup-snapshot.test.js']
metadata = {'label': 'PRE-FIX EXPECTED-RED; NOT FINAL ACCEPTANCE', 'sourceHashes': hashes,
            'command': command, 'node': subprocess.check_output([str(node), '--version'], text=True).strip(),
            'filesystem': subprocess.check_output(['findmnt', '-T', str(run), '-n', '-o', 'FSTYPE'], text=True).strip()}
(run / 'metadata.json').write_text(json.dumps(metadata, indent=2))
print(str(run), flush=True)
with (run / 'prefix-targeted.log').open('w') as log:
    child = subprocess.Popen(command, cwd=candidate, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    timed_out = False
    try:
        code = child.wait(timeout=90)
    except subprocess.TimeoutExpired:
        timed_out = True
        os.killpg(child.pid, signal.SIGTERM)
        try:
            code = child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            code = child.wait(timeout=3)
(run / 'native-exit.json').write_text(json.dumps({'exitCode': code, 'timeout': timed_out}))
print((run / 'prefix-targeted.log').read_text(), flush=True)
raise SystemExit(code if code >= 0 else 1)
