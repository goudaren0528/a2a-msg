import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// A process that lost the O_EXCL election but still probes the just-created,
// not yet initialized coordination inode. It reports "holding" through a marker
// file (IPC cannot be read while the initializing process is blocked) and keeps
// the SHARED read transaction open for the requested time.
const [, , dir, marker, holdMs] = process.argv;
const path = join(dir, 'coordination.sqlite');
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const wait = ms => Atomics.wait(sleeper, 0, 0, ms);
const deadline = Date.now() + 5000;
while (!existsSync(path)) {
  if (Date.now() > deadline) process.exit(2);
  wait(1);
}
const db = new DatabaseSync(path, { readOnly: true });
db.exec('BEGIN');
db.exec('SELECT * FROM sqlite_master');
writeFileSync(marker, 'holding');
wait(Number(holdMs));
db.exec('COMMIT');
db.close();
process.send?.('released');
