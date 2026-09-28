// New process: no approval resolution and no time sampling for exact committed
// recognition/resync even after TTL. Current recovery and converter admin remain.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { limits, fileHash, snapshot } from './oracle.js';
const [root, runId, requestJSON, suppliedWall] = process.argv.slice(2), request = JSON.parse(requestJSON);
let clockReads = 0, approvalCalls = 0;
Date.now = () => { clockReads++; return Number(suppliedWall); };
const [{ openWorkspace, context }, { createRecoveryConversionTarget }, { createCandidateSchemaV5Converter: create }, { observeNative }] = await Promise.all([
  import('../im-v2-recovery-conversion-target/helpers.js'), import('../../../src/im/v2/recovery.js'),
  import('../../../src/im/v2/candidate-schema-v5-converter.js'), import('./native-observer.js'),
]);
const recovery = openWorkspace(root).open(), target = createRecoveryConversionTarget(recovery, { runId }, context);
let adminAllowed = true;
const authority = { authorizeAdmin: ctx => ctx === context && adminAllowed }, approvalAuthority = {
  resolveApproval() { approvalCalls++; throw Error('mutation approval revoked'); },
  authorizeApproval() { approvalCalls++; return false; },
};
const converter = create({ target, authority, approvalAuthority, executorId: 'executor', limits: { ...limits } });
const path = join(root, 'runs', runId, 'candidate.sqlite'), dir = join(root, 'runs', runId), hash = fileHash(path), rows = snapshot(path);
const observer = observeNative(), beforeClock = clockReads;
let result;
try { result = converter.convertCandidate(request, context); } finally { observer.restore(); }
const clockReadsDuringConvert = clockReads - beforeClock;
assert.equal(result.replayed, true); assert.equal(approvalCalls, 0); assert.equal(clockReadsDuringConvert, 0);
assert.equal(fileHash(path), hash); assert.deepEqual(snapshot(path), rows);
assert.deepEqual(observer.events.filter(e => e.op === 'mutation' || e.op === 'exec' && /^\s*(CREATE|DROP|ALTER|UPDATE|INSERT|DELETE|REPLACE)\b/i.test(e.sql)), []);
for (const name of ['candidate.sqlite', 'conversion-complete.json']) {
  // Missing completion may be published through a synced pending inode.
  const linkedPending = observer.events.find(e => e.op === 'linkSync' && e.paths[1] === join(dir, name))?.paths[0];
  const event = observer.events.find(e => e.op === 'fsync' && e.fdType === 'file' &&
    (e.path === join(dir, name) || e.path === linkedPending));
  assert.ok(event, `durability for ${name}`);
  assert.ok(observer.events.some(e => e.op === 'fsync' && e.fdType === 'directory' && e.path === dir && e.seq > event.seq));
}
for (const patch of [{ approvalRef: 'different' }, { transitionId: '00000000-0000-0000-0000-000000000000' }, { planHash: 'a'.repeat(64) }]) {
  let error; try { converter.convertCandidate({ ...request, ...patch }, context); } catch (e) { error = e; }
  assert.equal(error?.code, 'MAINTENANCE_CONVERSION_CONFLICT'); assert.equal(error.message, error.code);
}
assert.equal(approvalCalls, 0);
const wrongExecutor = create({ target, authority, approvalAuthority, executorId: 'different-executor', limits: { ...limits } });
assert.throws(() => wrongExecutor.convertCandidate(request, context), { code: 'MAINTENANCE_CONVERSION_CONFLICT' });
adminAllowed = false;
assert.throws(() => converter.convertCandidate(request, context), { code: 'MAINTENANCE_AUTH_DENIED' });
assert.equal(approvalCalls, 0); assert.equal(fileHash(path), hash); assert.deepEqual(snapshot(path), rows);
process.stdout.write(JSON.stringify({ result, approvalCalls, clockReadsDuringConvert, events: observer.events }));
