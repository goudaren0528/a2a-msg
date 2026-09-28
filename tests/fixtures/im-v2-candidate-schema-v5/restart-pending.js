import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { files, fileHash, snapshot } from './oracle.js';
Date.now = () => 1800000400000;
const [{ openWorkspace, context }, { createRecoveryConversionTarget }, { observeNative }] = await Promise.all([
  import('../im-v2-recovery-conversion-target/helpers.js'), import('../../../src/im/v2/recovery.js'), import('./native-observer.js'),
]);
const [root, runId] = process.argv.slice(2), dir = join(root, 'runs', runId), path = join(dir, 'candidate.sqlite');
const before = files(dir), rows = snapshot(path), hash = fileHash(path);
const pending = fs.readdirSync(dir).filter(n => n.endsWith('.pending')); assert.equal(pending.length, 1);
const stat = fs.statSync(join(dir, pending[0]), { bigint: true });
const identity = { ino: String(stat.ino), dev: String(stat.dev), nlink: String(stat.nlink), size: String(stat.size), mtime: String(stat.mtimeNs) };
const recovery = openWorkspace(root).open();
const observer = observeNative(); let error;
try { createRecoveryConversionTarget(recovery, { runId }, context); } catch (e) { error = e; } finally { observer.restore(); }
assert.equal(error?.code, 'RECOVERY_INDETERMINATE'); assert.equal(error.message, error.code);
assert.ok(observer.events.length > 0, 'mint actually observed');
assert.deepEqual(observer.events.filter(e => ['mutation', 'fsync', 'write', 'linkSync', 'unlinkSync', 'renameSync'].includes(e.op) || e.op === 'exec' && /^\s*(CREATE|DROP|ALTER|UPDATE|INSERT|DELETE|REPLACE)\b/i.test(e.sql)), []);
assert.deepEqual(files(dir), before); assert.deepEqual(snapshot(path), rows); assert.equal(fileHash(path), hash);
const after = fs.statSync(join(dir, pending[0]), { bigint: true });
assert.deepEqual({ ino: String(after.ino), dev: String(after.dev), nlink: String(after.nlink), size: String(after.size), mtime: String(after.mtimeNs) }, identity);
assert.equal(fs.existsSync(join(dir, 'conversion-complete.json')), false);
process.stdout.write(JSON.stringify({ code: error.code, identity, before, events: observer.events }));
