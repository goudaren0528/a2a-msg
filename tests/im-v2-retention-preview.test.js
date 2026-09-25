import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { fixture, content, audit, configuration, id, sha, F, H, messageOracle, auditOracle, messageDescriptor, auditDescriptor } from './fixtures/im-v2-retention-preview/helpers.js';
import { activeFixture } from './fixtures/im-v2-maintenance-read-target/legal-fixtures.js';
import { assertImSchemaV4 } from '../src/im/v2/schema.js';
import { encodeMaintenanceCursor, hashMaintenancePlan, decodeMaintenancePlan } from '../src/im/v2/maintenance-plan.js';

// Capture the actual native receiver before the target snapshots entrypoints.
const calls = [];
// Native statements still execute on the original connection. Record detached raw
// results before the target's fatal TEXT decoding mutates them; no ledger hooks.
const sqlEvents = [];
let observing = false, onStatement = null;
const nativePrepare = DatabaseSync.prototype.prepare, nativeExec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.prepare = function (sql) {
  if (observing) { calls.push(sql); onStatement?.(sql); }
  const statement = nativePrepare.call(this, sql);
  for (const method of ['all', 'get']) {
    const original = statement[method];
    statement[method] = function (...args) {
      const result = Reflect.apply(original, this, args);
      if (observing) sqlEvents.push({ sql, args: structuredClone(args), rows: structuredClone(method === 'all' ? result : result ? [result] : []) });
      return result;
    };
  }
  return statement;
};
DatabaseSync.prototype.exec = function (sql) {
  if (observing) { calls.push(sql); onStatement?.(sql); }
  return nativeExec.call(this, sql);
};
const { createImV2MaintenanceReadTarget } = await import('../src/im/v2/maintenance-read-target.js');
const { createImV2MaintenancePreview } = await import('../src/im/v2/retention.js');
const unix = { skip: process.platform === 'win32' ? 'native offline protection unavailable on Windows' : false };
const error = code => ({ code: `MAINTENANCE_${code}`, message: 'Maintenance preview rejected' });
function setup(f, options = {}) {
  const readTarget = createImV2MaintenanceReadTarget({ db: f.db, databasePath: f.databasePath });
  f.beforeClose.push(() => readTarget.invalidate());
  const config = options.config ?? configuration();
  const api = createImV2MaintenancePreview({ readTarget, authority: { authorize: options.authorize ?? (() => true) },
    policyProvider: { getConfig: options.getConfig ?? (() => config) }, clock: options.clock ?? (() => 20000000000) });
  return { api, readTarget, config };
}
function image(f) {
  const schema = f.db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name').all();
  const rows = Object.fromEntries(schema.filter(r => r.type === 'table').map(r => [r.name,
    f.db.prepare(`SELECT * FROM "${r.name}"`).all().map(row => JSON.stringify(row, (_, v) => v instanceof Uint8Array ? ['blob', v.length, sha(v)] : v)).sort()]));
  const files = fs.readdirSync(f.dir).sort().map(name => {
    const path = join(f.dir, name), stat = fs.lstatSync(path, { bigint: true });
    return [name, stat.ino.toString(), stat.mtimeNs.toString(), sha(fs.readFileSync(path))];
  });
  return { schema, rows, files };
}
function observed(f, fn) {
  const before = image(f), names = ['openSync', 'readFileSync', 'writeFileSync', 'appendFileSync', 'fsyncSync', 'fdatasyncSync', 'unlinkSync', 'renameSync', 'chmodSync', 'mkdirSync', 'rmSync', 'truncateSync'];
  const originals = Object.fromEntries(names.map(k => [k, fs[k]]));
  for (const k of names) fs[k] = () => assert.fail(`forbidden ${k}`);
  calls.length = 0; sqlEvents.length = 0; observing = true;
  try { return fn(); } finally {
    observing = false; onStatement = null;
    for (const k of names) fs[k] = originals[k];
    assert.deepEqual(image(f), before);
    assert.ok(calls.every(sql => /^(SELECT|PRAGMA main\.(schema_version|data_version|journal_mode)|BEGIN$|COMMIT$|ROLLBACK$)/.test(sql)));
    assert.ok(!calls.some(sql => /SELECT \*|COUNT\(|JOIN |UPDATE |query_only/i.test(sql)));
    assert.equal(f.db.isTransaction, false); assert.equal(f.db.isOpen, true);
  }
}
function checkPlan(answer) {
  assert.deepEqual(Object.keys(answer), ['plan', 'planHash', 'complete', 'nextCursor']);
  const p = answer.plan, s = p.scan;
  assert.equal(answer.planHash, hashMaintenancePlan(p));
  assert.equal(answer.planHash, sha(Buffer.concat([Buffer.from('a2a-msg.im.maintenance.plan.v2\0'), Buffer.from(JSON.stringify(p))])));
  assert.equal(answer.complete, s.complete); assert.equal(answer.nextCursor, s.nextCursor);
  assert.equal(p.timeEvidence.executable, false); assert.equal(p.timeEvidence.reason, 'SCHEMA_UPGRADE_REQUIRED');
  for (const key of ['anchorGeneration', 'anchorHash', 'sessionNonce', 'anchorWallAt', 'monotonicElapsedMs']) assert.equal(p.timeEvidence[key], null);
  assert.ok(Object.isFrozen(p) && Object.isFrozen(s) && Object.isFrozen(p.candidates));
  assert.ok(Buffer.byteLength(JSON.stringify(answer)) <= 65536);
  const identity = [2, p.instanceId, p.instanceCreatedAt, p.centerEpoch, p.kind, p.executionPolicyHash, 1, p.selection.cutoffAt,
    p.selection.eligibleThroughAt, 1, p.selection.after, p.selection.limit, p.selection.effect, p.selection.auditActions];
  const outcomes = [...p.candidates.map(c => [c.key, 'candidate', c.expectedFingerprint, c.expectedRows, c.expectedBytes]),
    ...s.held.map(h => [h.key, h.reason, h.expectedFingerprint, h.expectedRows, h.expectedBytes])]
    .sort((a, b) => a[0][0] - b[0][0] || (a[0][1] < b[0][1] ? -1 : 1));
  assert.equal(s.rangeDigest, H('a2a-msg.im.maintenance.range.v1', [identity, s.plannedRangeEnd, s.hasMore, outcomes]));
  assert.equal(p.candidateDigest, H('a2a-msg.im.maintenance.candidates.v2', [identity, s.plannedRangeEnd, s.rangeDigest,
    p.candidates.map(c => [c.key, c.messageId, c.auditId, c.contentPolicyHash, c.expectedState, c.expiresAt, c.expectedFingerprint, c.expectedBytes, c.expectedRows])]));
}
test('literal typed Unicode/raw bytes framing oracle', () => {
  assert.equal(F(null).toString('hex'), '6e3b'); assert.equal(F('').toString('hex'), '73303a');
  assert.equal(F('é').toString('hex'), '73323ac3a9'); assert.equal(F(-1).toString('hex'), '692d313b');
  assert.equal(F(new Uint8Array([0, 255])).toString('hex'), '78323a00ff');
  assert.equal(F([null, '', 0]).toString('hex'), '61333a6e3b73303a69303b');
});
test('factory and preauthorization have no target/provider/clock reflection hooks', t => {
  const f = fixture(t); let invoked = 0;
  const api = observed(f, () => createImV2MaintenancePreview({ readTarget: new Proxy({}, { get() { invoked++; throw Error(); } }),
    authority: { authorize: () => false }, policyProvider: { getConfig() { invoked++; } }, clock() { invoked++; } }));
  assert.deepEqual(Object.keys(api), ['previewMaintenance']); assert.ok(Object.isFrozen(api));
  observed(f, () => assert.throws(() => api.previewMaintenance({ kind: 'expire' }, {}), error('AUTH_DENIED')));
  assert.equal(invoked, 0); assert.deepEqual(calls, []);
});
test('strict input, Proxy/accessor zero-hook, known async zero-prefix', () => {
  let hooks = 0;
  const options = { readTarget: {}, authority: { authorize: () => true }, policyProvider: { getConfig: () => configuration() } };
  const api = createImV2MaintenancePreview(options);
  const hostile = new Proxy({}, { getPrototypeOf() { hooks++; }, ownKeys() { hooks++; }, get() { hooks++; } });
  for (const request of [undefined, null, {}, { kind: 'x' }, { kind: 'expire', after: null }, { kind: 'expire', after: undefined },
    { kind: 'expire', limit: -0 }, { kind: 'expire', limit: 101 }, { kind: 'expire', runId: id(1) }, hostile,
    { get kind() { hooks++; return 'expire'; } }]) assert.throws(() => api.previewMaintenance(request), error('INVALID'));
  for (const extra of [{ authority: { authorize: async () => { hooks++; } } }, { clock: async function* () { hooks++; } },
    { policyProvider: { getConfig: new Proxy(() => {}, {}) } }]) assert.throws(() => createImV2MaintenancePreview({ ...options, ...extra }), error('INVALID'));
  assert.equal(hooks, 0);
});
test('literal true, hostile exceptions, thenables observed and caught reentry fail closed', async () => {
  let provider = 0, hooks = 0, rejections = 0;
  const hostile = new Proxy({}, { get() { hooks++; throw Error(); } });
  for (const authorize of [() => 'true', () => 1, () => { throw hostile; }]) {
    const api = createImV2MaintenancePreview({ readTarget: {}, authority: { authorize }, policyProvider: { getConfig() { provider++; } } });
    assert.throws(() => api.previewMaintenance({ kind: 'audit' }), error('AUTH_DENIED'));
  }
  for (const value of [Promise.reject(hostile), { then(resolve, reject) { rejections++; reject(hostile); } }, { get then() { hooks++; } }, hostile]) {
    const api = createImV2MaintenancePreview({ readTarget: {}, authority: { authorize: () => value }, policyProvider: { getConfig() { provider++; } } });
    assert.throws(() => api.previewMaintenance({ kind: 'audit' }), error('INVALID'));
  }
  let api;
  api = createImV2MaintenancePreview({ readTarget: {}, authority: { authorize() { assert.throws(() => api.previewMaintenance({})); return true; } }, policyProvider: { getConfig() { provider++; } } });
  assert.throws(() => api.previewMaintenance({ kind: 'audit' }), error('AUTH_DENIED'));
  assert.equal(provider, 0); assert.equal(hooks, 0); assert.equal(rejections, 1);
  await new Promise(resolve => setImmediate(resolve));
});
test('Windows genuine native target gate is unsupported with zero statements/writes', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t), { api } = setup(f);
  observed(f, () => assert.throws(() => api.previewMaintenance({ kind: 'expire' }), error('READ_UNAVAILABLE')));
  assert.deepEqual(calls, []);
});
for (const mode of ['paused', 'enabled']) test(`active ${mode} expire and empty preview immutable canonical independent descriptor`, unix, t => {
  const f = fixture(t, mode), message = content(f); assertImSchemaV4(f.db);
  const expected = messageOracle(f.db, message), { api } = setup(f, { config: configuration({ writeMode: mode }) });
  const answer = observed(f, () => api.previewMaintenance({ kind: 'expire' })); checkPlan(answer);
  assert.equal(answer.plan.candidates.length, 1); assert.equal(answer.plan.candidates[0].expectedFingerprint, expected);
  assert.equal(answer.plan.candidates[0].expectedRows, 2); assert.equal(answer.plan.candidates[0].expectedBytes, 0);
  assert.equal(answer.plan.selection.effect, 'expire-only'); assert.equal(answer.plan.scan.stopReason, 'END');
  const empty = observed(f, () => api.previewMaintenance({ kind: 'scrub' })); checkPlan(empty);
  assert.equal(empty.plan.candidates.length, 0); assert.equal(empty.complete, true);
  assert.notEqual(empty.plan.runId, answer.plan.runId);
});
test('scrub original bytes/name metadata and no phantom key row', unix, t => {
  const f = fixture(t), message = content(f, 100, { expired: true }); assertImSchemaV4(f.db);
  const expected = messageOracle(f.db, message), { api } = setup(f);
  const answer = observed(f, () => api.previewMaintenance({ kind: 'scrub' })); checkPlan(answer);
  assert.equal(answer.plan.candidates[0].expectedRows, 3);
  assert.equal(answer.plan.candidates[0].expectedBytes, 4 + Buffer.byteLength('字é秘密é.bin'));
  assert.equal(answer.plan.candidates[0].expectedFingerprint, expected);
});
test('signed audit IDs, allowlist/held range and fixed cursor cutoff', unix, t => {
  const f = fixture(t);
  audit(f, -1); audit(f, 0, 'message.accepted'); audit(f, 1, 'new.governance'); audit(f, 2, 'message.read');
  const expected = [-1, 0, 1, 2].map(n => auditOracle(f.db, n));
  const { api } = setup(f);
  const a = observed(f, () => api.previewMaintenance({ kind: 'audit', limit: 3 })); checkPlan(a);
  assert.equal(a.complete, true); assert.ok(a.nextCursor); assert.equal(a.plan.scan.stopReason, 'LIMIT');
  assert.deepEqual([a.plan.candidates[0].expectedFingerprint, ...a.plan.scan.held.map(h => h.expectedFingerprint)], expected.slice(0, 3));
  assert.deepEqual(a.plan.scan.held.map(h => h.reason), ['AUDIT_PROTECTED', 'AUDIT_ACTION_UNKNOWN']);
  const b = observed(f, () => api.previewMaintenance({ kind: 'audit', after: a.nextCursor, limit: 1 })); checkPlan(b);
  assert.deepEqual(b.plan.candidates.map(c => c.auditId), [2]); assert.equal(b.nextCursor, null);
  assert.equal(b.plan.selection.cutoffAt, a.plan.selection.cutoffAt);
  assert.ok(calls.some(sql => sql.includes('(occurred_at,id)>(?,?)')));
  assert.ok(!JSON.stringify(a).includes('private-actor'));
});
test('exact cutoff equality and early audit subtraction', unix, t => {
  const f = fixture(t); content(f); audit(f, -1);
  for (const [wall, kind, count] of [[7776000099, 'expire', 0], [7776000100, 'expire', 1], [15551999999, 'audit', 0], [15552000100, 'audit', 1]]) {
    const { api } = setup(f, { clock: () => wall });
    const a = observed(f, () => api.previewMaintenance({ kind })); checkPlan(a); assert.equal(a.plan.candidates.length, count);
    if (kind === 'audit' && count === 0) assert.equal(a.plan.selection.eligibleThroughAt, null);
  }
});
test('request captured before authority mutation and provider/authorization final revocation', unix, t => {
  const f = fixture(t); content(f);
  const request = { kind: 'expire', limit: 1 };
  const { api } = setup(f, { authorize() { request.kind = 'scrub'; request.limit = 100; return true; } });
  const a = observed(f, () => api.previewMaintenance(request)); assert.equal(a.plan.kind, 'expire'); assert.equal(a.plan.selection.limit, 1);
  let calls = 0;
  const drift = setup(f, { getConfig() { const c = configuration(); if (++calls > 1) c.maintenance.maxRows = 99; return c; } });
  observed(f, () => assert.throws(() => drift.api.previewMaintenance({ kind: 'expire' }), error('POLICY_STALE')));
  let gates = 0;
  const revoked = setup(f, { authorize: () => ++gates === 1 });
  observed(f, () => assert.throws(() => revoked.api.previewMaintenance({ kind: 'expire' }), error('AUTH_DENIED')));
});
test('row grouping 33*3=99; remainder never packs a later group', unix, t => {
  const f = fixture(t); for (let n = 100; n < 134; n++) content(f, n, { expired: true });
  const { api } = setup(f);
  const a = observed(f, () => api.previewMaintenance({ kind: 'scrub', limit: 100 })); checkPlan(a);
  assert.equal(a.plan.budget.plannedRows, 99); assert.equal(a.plan.candidates.length, 33);
  assert.equal(a.plan.scan.stopReason, 'ROW_BUDGET'); assert.equal(a.complete, true);
  const b = observed(f, () => api.previewMaintenance({ kind: 'scrub', after: a.nextCursor })); assert.equal(b.plan.candidates.length, 1);
});
test('whole 10MiB plus filename held; held-only page advances to next small group', unix, t => {
  const f = fixture(t); content(f, 100, { expired: true, bytes: Buffer.alloc(10485760, 0xab), text: '' }); content(f, 101, { expired: true });
  const { api } = setup(f);
  const a = observed(f, () => api.previewMaintenance({ kind: 'scrub', limit: 1 })); checkPlan(a);
  assert.equal(a.plan.candidates.length, 0); assert.equal(a.plan.scan.held[0].reason, 'OVERSIZED_GROUP');
  assert.equal(a.plan.scan.held[0].expectedBytes, 10485760 + Buffer.byteLength('秘密é.bin')); assert.ok(a.nextCursor);
  const b = observed(f, () => api.previewMaintenance({ kind: 'scrub', after: a.nextCursor })); assert.equal(b.plan.candidates[0].messageId, id(101));
});
for (const delta of [0, -1]) test(`logical scrub exact B${delta ? '-1' : ''}`, unix, t => {
  const f = fixture(t); content(f, 100, { expired: true });
  const config = configuration(); config.maintenance.maxBytes = 4 + Buffer.byteLength('字é秘密é.bin') + delta;
  const { api } = setup(f, { config }); const a = observed(f, () => api.previewMaintenance({ kind: 'scrub' })); checkPlan(a);
  assert.equal(a.plan.candidates.length, delta ? 0 : 1); assert.equal(a.plan.scan.heldCount, delta ? 1 : 0);
});
for (const [name, sql] of [
  ['missing-map', 'DELETE FROM im_send_operation_keys'], ['missing-delivery', 'DELETE FROM im_deliveries'],
  ['missing-reservation', 'DELETE FROM im_attachment_reservations'], ['deadline', 'UPDATE im_content_state SET expires_at=expires_at+1'],
  ['same-size-payload', "UPDATE im_attachments SET data=x'01020304'"], ['routing', "UPDATE im_messages SET recipient_id='00000000-0000-0000-0000-000000000099'"],
  ['ACK', 'PRAGMA ignore_check_constraints=ON; UPDATE im_deliveries SET acked_at=NULL'],
  ['missing-epoch', 'PRAGMA foreign_keys=OFF; DELETE FROM im_center_epochs WHERE center_epoch NOT IN (SELECT center_epoch FROM im_center_state)'],
]) test(`corrupt selected group ${name} rejected without writes`, unix, t => {
  const f = fixture(t); content(f);
  if (name === 'missing-epoch') {
    f.db.exec("PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON; UPDATE im_send_operation_keys SET origin_epoch='00000000-0000-0000-0000-000000000099'");
  } else f.db.exec('PRAGMA foreign_keys=OFF; ' + sql);
  const { api } = setup(f);
  observed(f, () => assert.throws(() => api.previewMaintenance({ kind: 'expire' }), error('FACT_MISMATCH')));
});
for (const kind of ['v3_import', 'snapshot_recovery']) for (const mode of ['paused', 'enabled']) test(`actual P1/P5 ${kind}/${mode} historical v1 fingerprint`, unix, async t => {
  const f = await activeFixture(t, kind, mode);
  const expected = f.db.prepare('SELECT message_id FROM im_content_state ORDER BY expires_at,message_id').all().map(r => messageOracle(f.db, r.message_id));
  const config = configuration({ writeMode: mode, retention: { policy: f.policy, policyHash: sha(JSON.stringify(f.policy)) } });
  const wall = f.db.prepare('SELECT last_observed_at FROM im_clock').get().last_observed_at + 20000000000;
  const { api } = setup(f, { config, clock: () => wall });
  const a = observed(f, () => api.previewMaintenance({ kind: 'expire' })); checkPlan(a);
  assert.deepEqual(a.plan.candidates.map(c => c.expectedFingerprint), expected);
});
for (const corrupt of ['origin', 'missing']) test(`real P1 historical v1 epoch ${corrupt} rejects`, unix, async t => {
  const f = await activeFixture(t, 'snapshot_recovery', 'paused');
  const origin = f.db.prepare("SELECT origin_epoch FROM im_send_operation_keys WHERE source_protocol='a2a-msg.im.v1'").get().origin_epoch;
  // Add a distinct historical epoch so activation trust remains a valid baseline.
  const old = f.db.prepare('SELECT * FROM im_center_epochs WHERE center_epoch=?').get(origin);
  f.db.prepare('INSERT INTO im_center_epochs VALUES (?,?,?,?)').run(id(9999), old.created_at, 'v3_import', old.recovery_counter);
  f.db.exec('PRAGMA foreign_keys=OFF'); f.db.prepare('UPDATE im_send_operation_keys SET origin_epoch=?').run(id(9999));
  if (corrupt === 'origin') f.db.prepare("UPDATE im_center_epochs SET origin='fresh' WHERE center_epoch=?").run(id(9999));
  else f.db.prepare('DELETE FROM im_center_epochs WHERE center_epoch=?').run(id(9999));
  const wall = f.db.prepare('SELECT last_observed_at FROM im_clock').get().last_observed_at + 20000000000;
  const { api } = setup(f, { clock: () => wall, config: configuration({ retention: { policy: f.policy, policyHash: sha(JSON.stringify(f.policy)) } }) });
  observed(f, () => assert.throws(() => api.previewMaintenance({ kind: 'expire' }), error('FACT_MISMATCH')));
});
test('trust scan cap errors, selection row exhaustion gives incomplete prefix', unix, t => {
  const f = fixture(t); for (let n = 100; n < 180; n++) content(f, n);
  for (const limits of [{ maxScanRows: 1 }, { maxScanBytes: 1 }]) {
    const config = configuration(); Object.assign(config.maintenance, limits);
    const { api } = setup(f, { config }); observed(f, () => assert.throws(() => api.previewMaintenance({ kind: 'expire' }), error('READ_UNAVAILABLE')));
  }
  const config = configuration(); config.maintenance.maxScanRows = 1500;
  const { api } = setup(f, { config }); const a = observed(f, () => api.previewMaintenance({ kind: 'expire', limit: 100 })); checkPlan(a);
  assert.equal(a.complete, false); assert.equal(a.plan.scan.stopReason, 'SCAN_ROWS'); assert.equal(a.plan.scan.hasMore, null);
  assert.ok(a.plan.scan.rowsRead <= 1500); assert.ok(a.plan.candidates.length < 50);
});
test('wall malformed/rollback/overflow and final native elapsed overrun never complete', unix, t => {
  const f = fixture(t); content(f);
  for (const wall of [-0, NaN, -1, 99, Number.MAX_SAFE_INTEGER]) {
    const { api } = setup(f, { clock: () => wall }); observed(f, () => assert.throws(() => api.previewMaintenance({ kind: 'expire' }), error('CLOCK_UNSAFE')));
  }
  const original = performance.now;
  let offset = 0;
  Object.defineProperty(performance, 'now', { value: () => original.call(performance) + offset, configurable: true });
  try {
    const { api } = setup(f);
    observed(f, () => {
      onStatement = sql => { if (sql === 'COMMIT') offset = 1001; };
      assert.throws(() => api.previewMaintenance({ kind: 'expire' }), error('READ_UNAVAILABLE'));
    });
  } finally { delete performance.now; }
});
test('fake/invalidate/cookie and cursor target/policy/kind scope gates', unix, t => {
  const f = fixture(t); content(f, 100); content(f, 101);
  const { api, readTarget } = setup(f);
  const a = observed(f, () => api.previewMaintenance({ kind: 'expire', limit: 1 }));
  const tuple = JSON.parse(Buffer.from(a.nextCursor, 'base64url'));
  for (const [index, value, code] of [[2, id(99), 'TARGET_STALE'], [3, 2, 'TARGET_STALE'], [4, id(99), 'TARGET_STALE'], [6, 'f'.repeat(64), 'POLICY_STALE'], [5, 'scrub', 'INVALID'], [7, 20000000001, 'CLOCK_UNSAFE']]) {
    const changed = [...tuple]; changed[index] = value;
    observed(f, () => assert.throws(() => api.previewMaintenance({ kind: 'expire', after: encodeMaintenanceCursor(changed) }), error(code)));
  }
  f.db.exec('PRAGMA schema_version=999');
  observed(f, () => assert.throws(() => api.previewMaintenance({ kind: 'expire' }), error('TARGET_STALE')));
  readTarget.invalidate(); observed(f, () => assert.throws(() => api.previewMaintenance({ kind: 'expire' }), error('TARGET_STALE')));
  const fake = createImV2MaintenancePreview({ readTarget: {}, authority: { authorize: () => true }, policyProvider: { getConfig: () => configuration() } });
  assert.throws(() => fake.previewMaintenance({ kind: 'expire' }), error('READ_UNAVAILABLE'));
});
for (const kind of ['expire', 'scrub', 'audit']) test(`EXPLAIN ${kind} actual composite target query, index-backed ordered search`, unix, t => {
  const f = fixture(t); content(f, 100); content(f, 101); content(f, 102, { expired: true }); content(f, 103, { expired: true }); audit(f, -1); audit(f, 0);
  const { api } = setup(f);
    observed(f, () => api.previewMaintenance({ kind, limit: 2 }));
    const sql = calls.find(x => x.includes(kind === 'audit' ? '(occurred_at,id)>(?,?)' : '(expires_at,message_id)>(?,?)'));
    assert.ok(sql);
    const explain = nativePrepare.call(f.db, 'EXPLAIN QUERY PLAN ' + sql).all(20000000000, 0, kind === 'audit' ? -1 : id(0));
    assert.ok(explain.some(row => row.detail.includes('SEARCH') && row.detail.includes(kind === 'audit' ? 'im_audit_occurred' : kind === 'scrub' ? 'im_content_scrub' : 'im_content_expiry')));
    assert.ok(explain.every(row => !row.detail.includes('TEMP B-TREE')), JSON.stringify({ kind, sql, explain }));
});

test('enabled deletion flags remain diagnostic and policy effective time checked', unix, t => {
  const f = fixture(t); content(f);
  const config = configuration();
  Object.assign(config.retention.policy, { expiryEnabled: true, purgeEnabled: true });
  config.retention.policyHash = sha(JSON.stringify(config.retention.policy));
  const p = config.retention.policy;
  f.db.prepare('INSERT INTO im_retention_policies VALUES (?,?,?,?,?,?,?,?)').run(config.retention.policyHash, p.version, p.effectiveAt,
    p.messageRetentionMs, p.attachmentRetentionMs, p.safeRetryWindowMs, p.auditRetentionMs, JSON.stringify(p));
  const { api } = setup(f, { config });
  const a = observed(f, () => api.previewMaintenance({ kind: 'expire' })); checkPlan(a);
  assert.equal(a.plan.selection.effect, 'expire-only'); assert.equal(a.plan.budget.plannedBytes, 0);
  const future = structuredClone(config); future.retention.policy.effectiveAt = 20000000001;
  future.retention.policyHash = sha(JSON.stringify(future.retention.policy));
  const q = future.retention.policy;
  f.db.prepare('INSERT INTO im_retention_policies VALUES (?,?,?,?,?,?,?,?)').run(future.retention.policyHash, q.version, q.effectiveAt,
    q.messageRetentionMs, q.attachmentRetentionMs, q.safeRetryWindowMs, q.auditRetentionMs, JSON.stringify(q));
  const next = setup(f, { config: future });
  observed(f, () => assert.throws(() => next.api.previewMaintenance({ kind: 'expire' }), error('POLICY_INVALID')));
});

test('provider data Proxy/accessors and malformed full configuration refuse without hooks', () => {
  let hooks = 0;
  const proxy = new Proxy({}, { get() { hooks++; }, ownKeys() { hooks++; }, getPrototypeOf() { hooks++; } });
  const accessor = configuration(); Object.defineProperty(accessor, 'maintenance', { enumerable: true, get() { hooks++; } });
  for (const config of [proxy, accessor, { enabled: true }, { ...configuration(), maintenance: {} }]) {
    const api = createImV2MaintenancePreview({ readTarget: {}, authority: { authorize: () => true }, policyProvider: { getConfig: () => config } });
    assert.throws(() => api.previewMaintenance({ kind: 'expire' }), error(config === proxy ? 'INVALID' : 'POLICY_INVALID'));
  }
  assert.equal(hooks, 0);
});

test('late config change inside final authorize is detected; invalidation/reentry during final callbacks cannot succeed', unix, t => {
  const f = fixture(t); content(f);
  const config = configuration(); let gates = 0;
  const drift = setup(f, { config, authorize() { if (++gates === 2) config.maintenance.maxRows--; return true; } });
  observed(f, () => assert.throws(() => drift.api.previewMaintenance({ kind: 'expire' }), error('POLICY_STALE')));
  let view, n = 0;
  view = setup(f, { authorize() { if (++n === 2) { assert.throws(() => view.api.previewMaintenance({ kind: 'expire' })); } return true; } });
  observed(f, () => assert.throws(() => view.api.previewMaintenance({ kind: 'expire' }), error('AUTH_DENIED')));
  let revoked, count = 0;
  revoked = setup(f, { getConfig() { if (++count === 2) revoked.readTarget.invalidate(); return configuration(); } });
  observed(f, () => assert.throws(() => revoked.api.previewMaintenance({ kind: 'expire' }), error('TARGET_STALE')));
});

test('fixed approved page excludes later keys; inside-row original facts alter independent digest', unix, t => {
  const f = fixture(t); audit(f, -1); audit(f, 0); audit(f, 1);
  const first = setup(f).api.previewMaintenance({ kind: 'audit', limit: 1 });
  // Each owner mutation is outside observation and revokes the previous binding;
  // fresh preview compares the same bounded range, never implements apply.
  f.db.prepare("UPDATE im_audit SET safe_details_json='{}' WHERE id=1").run();
  const outside = observed(f, () => setup(f).api.previewMaintenance({ kind: 'audit', limit: 1 }));
  assert.equal(outside.plan.candidateDigest, first.plan.candidateDigest);
  f.db.prepare("UPDATE im_audit SET safe_details_json='{}' WHERE id=-1").run();
  const inside = observed(f, () => setup(f).api.previewMaintenance({ kind: 'audit', limit: 1 }));
  assert.notEqual(inside.plan.candidateDigest, first.plan.candidateDigest);
  const suffix = observed(f, () => setup(f).api.previewMaintenance({ kind: 'audit', after: first.nextCursor }));
  assert.deepEqual(suffix.plan.candidates.map(c => c.auditId), [0, 1]);
});

test('maximal 100-key held page envelope fits independent cap and never leaks raw audit JSON', unix, t => {
  const f = fixture(t);
  f.db.exec('BEGIN');
  for (let n = -100; n <= 0; n++) audit(f, n, 'unrecognized.security', 100, '{"private":"' + '字'.repeat(1000) + '"}');
  f.db.exec('COMMIT');
  const { api } = setup(f);
  const a = observed(f, () => api.previewMaintenance({ kind: 'audit', limit: 100 })); checkPlan(a);
  assert.equal(a.plan.scan.heldCount, 100); assert.equal(a.plan.candidates.length, 0); assert.equal(a.complete, true); assert.ok(a.nextCursor);
  assert.ok(Buffer.byteLength(JSON.stringify(a.plan)) < 65536); assert.ok(Buffer.byteLength(JSON.stringify(a)) <= 65536);
  assert.ok(!JSON.stringify(a).includes('private')); assert.ok(!JSON.stringify(a).includes('字'));
});

test('length-reserved scan bytes stop before heavy BLOB and keep trustworthy incomplete prefix', unix, t => {
  const f = fixture(t); content(f, 100, { bytes: Buffer.alloc(10485760) });
  const config = configuration(); config.maintenance.maxScanBytes = 1000000;
  const { api } = setup(f, { config });
  const a = observed(f, () => api.previewMaintenance({ kind: 'expire' })); checkPlan(a);
  assert.equal(a.complete, false); assert.equal(a.plan.scan.stopReason, 'SCAN_BYTES'); assert.equal(a.nextCursor, null);
  assert.ok(calls.some(sql => sql.includes('length(CAST(data AS BLOB))')));
  assert.ok(!calls.some(sql => sql.includes('sha256,data FROM main.im_attachments')));
});

test('duplicate logical entity is schema uniqueness corruption, not a normal second group', unix, t => {
  const f = fixture(t); content(f);
  // Distinct sender/client key still cannot create two keys for one message.
  assert.throws(() => f.db.prepare('INSERT INTO im_send_keys SELECT sender_id,?,payload_hash,message_id,created_at,retry_until,status FROM im_send_keys').run('duplicate'), /UNIQUE/);
  const a = observed(f, () => setup(f).api.previewMaintenance({ kind: 'expire' })); checkPlan(a); assert.equal(a.plan.candidates.length, 1);
});

// Costs come from native result-column arrays, including raw Uint8Array TEXT,
// absent point probes and all repeated trust/projection/material reads (§8.2).
const sqlCost = events => events.reduce((sum, e) => ({
  rows: sum.rows + Math.max(1, e.rows.length),
  bytes: sum.bytes + e.rows.reduce((n, row) => n + F(Object.values(row)).length, 0),
}), { rows: 0, bytes: 0 });
const baseProbe = e => /SELECT expires_at, CASE/.test(e.sql);
const material = (e, table, key) => e.sql.includes(`FROM main.${table} WHERE`) && !e.sql.includes('typeof(') && e.args[0] === key &&
  (table !== 'im_messages' || e.sql.includes('CAST(text AS BLOB) AS text'));
const projection = (e, table, key) => e.sql.includes(`FROM main.${table} WHERE`) && e.sql.includes('typeof(') && e.args[0] === key;
function rangeFrames(p) {
  const s = p.scan;
  const identity = [2, p.instanceId, p.instanceCreatedAt, p.centerEpoch, p.kind, p.executionPolicyHash,
    1, p.selection.cutoffAt, p.selection.eligibleThroughAt, 1, p.selection.after, p.selection.limit, p.selection.effect, p.selection.auditActions];
  const outcomes = [...p.candidates.map(c => [c.key, 'candidate', c.expectedFingerprint, c.expectedRows, c.expectedBytes]),
    ...s.held.map(h => [h.key, h.reason, h.expectedFingerprint, h.expectedRows, h.expectedBytes])]
    .sort((a, b) => a[0][0] - b[0][0] || (a[0][1] < b[0][1] ? -1 : a[0][1] > b[0][1] ? 1 : 0));
  return F([identity, s.plannedRangeEnd, s.hasMore, outcomes]).length + F([identity, s.plannedRangeEnd, s.rangeDigest,
    p.candidates.map(c => [c.key, c.messageId, c.auditId, c.contentPolicyHash, c.expectedState, c.expiresAt, c.expectedFingerprint, c.expectedBytes, c.expectedRows])]).length;
}
const jsonBytes = value => Buffer.byteLength(JSON.stringify(value));
// §8.2 requires a fixed scalar reservation, but does NOT uniquely specify its
// size. Pin the frozen implementation's 1KiB reservation semantics explicitly,
// not a residual fitted to reported bytes. Two copies of two provisional zero
// scalars (bytesRead, elapsedMs) can grow by at most 4*(16-1)=60 bytes. Hashes
// already occupy 64 characters; rowsRead is final before output settlement.
const OUTPUT_SCALAR_RESERVATION = 1024;
const MAX_SCALAR_GROWTH = 2 * 2 * (String(Number.MAX_SAFE_INTEGER).length - 1);
function outputAccounting(p, rows) {
  const provisional = structuredClone(p);
  Object.assign(provisional.scan, { rowsRead: rows, bytesRead: 0, elapsedMs: 0 });
  const plan = jsonBytes(provisional);
  const envelope = jsonBytes({ plan: provisional, planHash: '0'.repeat(64), complete: p.scan.complete, nextCursor: p.scan.nextCursor });
  // Frozen reservation representation retains the four bytes of its null plan
  // placeholder, uses false (one byte longer than true), and reserves cursor
  // content alongside null (two bytes longer than quoted cursor replacement).
  // These are explicit structural padding, NOT SQL/descriptor slack.
  const structuralPadding = jsonBytes(null) + Number(p.scan.complete) + (p.scan.nextCursor === null ? 0 : 2);
  const scalarGrowth = 2 * (String(p.scan.bytesRead).length - 1 + String(p.scan.elapsedMs).length - 1);
  assert.ok(scalarGrowth <= MAX_SCALAR_GROWTH && MAX_SCALAR_GROWTH <= OUTPUT_SCALAR_RESERVATION);
  return { plan, envelope, structuralPadding, scalarReservation: OUTPUT_SCALAR_RESERVATION, scalarGrowth,
    bytes: plan + envelope + structuralPadding + OUTPUT_SCALAR_RESERVATION };
}
function accountingTerms(answer, events, descriptors) {
  const p = answer.plan, sql = sqlCost(events), output = outputAccounting(p, sql.rows);
  const descriptorBytes = descriptors.reduce((n, d) => n + F(d).length, 0), digestBytes = rangeFrames(p);
  return { sql, descriptorBytes, digestBytes, output, total: sql.bytes + descriptorBytes + digestBytes + output.bytes };
}
function assertAccounting(answer, events, descriptors) {
  const terms = accountingTerms(answer, events, descriptors), p = answer.plan;
  assert.equal(p.scan.rowsRead, terms.sql.rows, 'native SQL source/probe units including final checks');
  assert.equal(p.scan.bytesRead, terms.total, `exact SQL + descriptors + digest frames + output: ${JSON.stringify(terms)}`);
  assert.ok(p.scan.bytesRead <= p.budget.maxScanBytes);
  return terms;
}

// The target's maximum per-material reservation, derived from the actual native
// length-only projection, not the (smaller) eventual result frame or a ticket.
function materialReservation(event) {
  assert.equal(event.rows.length, 1);
  const lengths = Object.entries(event.rows[0]).filter(([name]) => name.endsWith('_length')).map(([, n]) => n);
  assert.ok(lengths.length > 0 && lengths.every(Number.isSafeInteger));
  return { rows: 1, bytes: Buffer.byteLength(`a${lengths.length}:`) + 24 * lengths.length + lengths.reduce((n, x) => n + x, 0) };
}
function prefixOutputReservation(fullPlan, count, budgetField, cap) {
  // Output is reserved when a candidate is admitted, before that candidate's
  // end-key/planned-cost bookkeeping. Reconstruct that representation from the
  // public canonical shape and ordered candidates; no private ledger inspection.
  const p = structuredClone(fullPlan), prior = p.candidates.slice(0, count - 1);
  p.candidates = p.candidates.slice(0, count);
  p.budget[budgetField] = cap;
  p.budget.plannedRows = prior.reduce((n, c) => n + c.expectedRows, 0);
  p.budget.plannedBytes = prior.reduce((n, c) => n + c.expectedBytes, 0);
  Object.assign(p.scan, { rowsRead: 0, bytesRead: 0, elapsedMs: 0, plannedRangeEnd: prior.at(-1)?.key ?? null,
    lastScanned: prior.at(-1)?.key ?? null, nextCursor: null, hasMore: true, complete: true, stopReason: 'END',
    candidateCount: 0, heldCount: 0, skippedCount: 0 });
  // §2/§5: each cursor is at most 1024 ASCII bytes. The frozen conservative
  // envelope reserves two such cursor slots and the fixed scalar allowance in
  // EACH of its two metadata copies, plus the independently framed hash inputs.
  return 2 * (jsonBytes(p) + OUTPUT_SCALAR_RESERVATION + 2 * 1024) + rangeFrames(p);
}
function assertPrefix(answer, ids, reason) {
  checkPlan(answer);
  assert.equal(answer.complete, false); assert.equal(answer.plan.scan.stopReason, reason);
  assert.equal(answer.plan.scan.hasMore, null); assert.deepEqual(answer.plan.candidates.map(c => c.messageId), ids);
  assert.deepEqual(answer.plan.scan.held, []);
  const last = ids.length ? [7776000100, ids.at(-1)] : null;
  assert.deepEqual(answer.plan.scan.plannedRangeEnd, last); assert.deepEqual(answer.plan.scan.lastScanned, last);
  if (last) assert.deepEqual(JSON.parse(Buffer.from(answer.nextCursor, 'base64url')).at(-1), last);
  else assert.equal(answer.nextCursor, null);
}

for (const heavy of ['body', 'attachment']) for (const axis of ['rows', 'bytes']) {
  test(`whole-group ${heavy} SCAN_${axis.toUpperCase()} refuses collectively unaffordable material`, unix, t => {
    const f = fixture(t), first = content(f, 100);
    const blocked = content(f, 101, { text: '字'.repeat(21000), bytes: new Uint8Array(524288).fill(0xab) });
    assertImSchemaV4(f.db);
    const descriptors = [first, blocked].map(key => messageDescriptor(f.db, key));
    const ample = setup(f);
    const full = observed(f, () => ample.api.previewMaintenance({ kind: 'expire' }));
    checkPlan(full); assert.equal(full.complete, true);
    assert.deepEqual(full.plan.candidates.map(c => c.expectedFingerprint), descriptors.map(d => H('a2a-msg.im.maintenance.message.v1', d)));
    assertAccounting(full, sqlEvents, descriptors);
    const control = structuredClone(sqlEvents);
    const firstBase = control.findIndex(baseProbe);
    const secondBase = control.findIndex(e => baseProbe(e) && e.rows[0]?.message_id === blocked);
    const firstHeavy = control.findIndex(e => material(e, 'im_messages', blocked) || material(e, 'im_attachments', blocked));
    assert.ok(firstBase > 0 && secondBase > firstBase && firstHeavy > secondBase);
    const selected = control.find(e => material(e, heavy === 'body' ? 'im_messages' : 'im_attachments', blocked));
    assert.ok(selected); assert.equal(selected.rows.length, 1);
    const beforeHeavy = sqlCost(control.slice(0, firstHeavy));
    const initial = sqlCost(control.slice(0, firstBase));
    // Frozen read-target §accounting.holdFinal: reserve, do not consume, two
    // copies of initial trust plus bounded fixed PRAGMA overhead. This is the
    // frozen dependency's documented escrow, never a replacement ledger.
    const finalEscrow = { rows: 2 * initial.rows + 16, bytes: 2 * initial.bytes + 4096 };
    const selectedCost = sqlCost([selected]);
    const bodyReservation = materialReservation(control.find(e => projection(e, 'im_messages', blocked)));
    const attachmentReservation = materialReservation(control.find(e => projection(e, 'im_attachments', blocked)));
    const selectedReservation = heavy === 'body' ? bodyReservation : attachmentReservation;
    assert.ok(selectedCost.bytes < selectedReservation.bytes, 'actual charge is not maximum reservation');
    const config = configuration();
    const budgetField = axis === 'rows' ? 'maxScanRows' : 'maxScanBytes';
    const prefixFrame = axis === 'bytes' ? F(descriptors[0]).length : 0;
    const fixed = beforeHeavy[axis] + finalEscrow[axis] + prefixFrame + selectedReservation[axis];
    // The cap's own decimal width appears in reserved metadata. Enumerate the
    // finite legal widths and solve exactly, rather than padding with a margin.
    const caps = axis === 'rows' ? [fixed] : Array.from({ length: String(config.maintenance.maxScanBytes).length }, (_, i) => {
      const width = i + 1, probe = 10 ** (width - 1);
      const cap = fixed + prefixOutputReservation(full.plan, 1, budgetField, probe);
      return String(cap).length === width && cap <= config.maintenance.maxScanBytes ? cap : null;
    }).filter(n => n !== null);
    assert.equal(caps.length, 1, 'one exact decimal-width solution');
    const cap = caps[0]; config.maintenance[budgetField] = cap;
    const outputHeld = axis === 'bytes' ? prefixOutputReservation(full.plan, 1, budgetField, cap) : 0;
    const available = cap - beforeHeavy[axis] - finalEscrow[axis] - prefixFrame - outputHeld;
    // Only accepted_at and payload size in the unread heavy descriptor are
    // integers; reserve their safe-integer widths. All other descriptor facts
    // are already read, or have exact projected text/blob lengths and hash widths.
    const descriptorBound = structuredClone(descriptors[1]);
    descriptorBound[2][5] = Number.MAX_SAFE_INTEGER;
    descriptorBound[8][4] = Number.MAX_SAFE_INTEGER;
    const descriptorReservation = axis === 'bytes' ? F(descriptorBound).length : 0;
    const outputGrowth = axis === 'bytes' ? Math.max(0, prefixOutputReservation(full.plan, 2, budgetField, cap) - outputHeld) : 0;
    const remainingGroup = bodyReservation[axis] + attachmentReservation[axis] + descriptorReservation + outputGrowth;
    assert.equal(available, selectedReservation[axis], 'selected maximum reservation fits EXACT true remaining capacity');
    assert.ok(remainingGroup > available, 'entire mandatory group plus descriptor/output growth cannot fit');
    t.diagnostic(JSON.stringify({ heavy, axis, budgetField, cap, beforeHeavy, finalEscrow, prefixFrame, outputHeld,
      available, selectedCost, selectedReservation, bodyReservation, attachmentReservation, descriptorReservation, outputGrowth, remainingGroup }));
    ample.readTarget.invalidate();
    const { api } = setup(f, { config });
    const answer = observed(f, () => api.previewMaintenance({ kind: 'expire' }));
    assertPrefix(answer, [first], `SCAN_${axis.toUpperCase()}`);
    assert.ok(sqlEvents.some(e => projection(e, 'im_messages', blocked)));
    assert.ok(sqlEvents.some(e => projection(e, 'im_attachments', blocked)));
    assert.ok(!sqlEvents.some(e => material(e, 'im_messages', blocked)), 'no blocked body materialization');
    assert.ok(!sqlEvents.some(e => material(e, 'im_attachments', blocked)), 'no blocked BLOB materialization');
    const actual = sqlCost(sqlEvents);
    assert.equal(answer.plan.scan.rowsRead, actual.rows, 'all projection/dependency/final trust rows, no double-counted reservation');
    t.diagnostic(JSON.stringify(assertAccounting(answer, sqlEvents, descriptors.slice(0, 1))));
    assert.ok(answer.plan.scan[axis === 'rows' ? 'rowsRead' : 'bytesRead'] <= cap);
    assert.ok(calls.includes('COMMIT'), 'final trusted snapshot closure still available');
    assert.ok(sqlEvents.filter(e => e.sql.includes('FROM main.sqlite_schema ORDER BY')).length === 3,
      'initial and both final manifest checks actually executed');
  });
}

test('actual later small group is not packed past a blocked next large group', unix, t => {
  const f = fixture(t);
  const first = content(f, 100, { expired: true });
  const blocked = content(f, 101, { expired: true });
  const small = content(f, 102, { expired: true, attachment: false, text: 'x', correlation: null });
  assertImSchemaV4(f.db);
  const config = configuration(); config.maintenance.maxRows = 5;
  const { api } = setup(f, { config });
  const answer = observed(f, () => api.previewMaintenance({ kind: 'scrub', limit: 100 })); checkPlan(answer);
  assert.equal(answer.complete, true); assert.equal(answer.plan.scan.stopReason, 'ROW_BUDGET');
  assert.deepEqual(answer.plan.candidates.map(c => [c.messageId, c.expectedRows]), [[first, 3]]);
  assert.equal(answer.plan.budget.maxRows - answer.plan.budget.plannedRows, 2);
  assert.deepEqual(answer.plan.scan.lastScanned, [7776000100, first]);
  const next = observed(f, () => api.previewMaintenance({ kind: 'scrub', after: answer.nextCursor })); checkPlan(next);
  assert.deepEqual(next.plan.candidates.map(c => [c.messageId, c.expectedRows]), [[blocked, 3], [small, 2]]);
});

test('independent complete scan accounting includes Unicode/raw bytes, descriptors and range frames exactly once', unix, t => {
  const f = fixture(t), key = content(f, 100, { text: '字é𠮷', bytes: new Uint8Array([0, 255, 128, 195, 169]) });
  audit(f, -1, 'message.read', 100, '{"字":"é𠮷"}');
  assertImSchemaV4(f.db);
  const descriptor = messageDescriptor(f.db, key), row = auditDescriptor(f.db, -1);
  const { api } = setup(f);
  const full = observed(f, () => api.previewMaintenance({ kind: 'expire' })); checkPlan(full);
  const contentTerms = assertAccounting(full, sqlEvents, [descriptor]);
  t.diagnostic(JSON.stringify({ kind: 'expire', ...contentTerms }));
  const omitted = structuredClone(sqlEvents);
  const version = omitted.find(e => e.sql === 'PRAGMA main.data_version');
  assert.ok(version, 'mandatory data-version result observed');
  assert.equal(F(Object.values(version.rows[0])).length, 6, 'single-digit version frame is exactly six bytes, like F([4])');
  version.rows = []; // Missing-frame control retains the one row/probe unit.
  assert.equal(accountingTerms(full, omitted, [descriptor]).total, contentTerms.total - 6);
  assert.throws(() => assertAccounting(full, omitted, [descriptor]), { code: 'ERR_ASSERTION', operator: 'strictEqual', actual: full.plan.scan.bytesRead, expected: contentTerms.total - 6 });
  const raw = sqlEvents.find(e => material(e, 'im_messages', key)).rows[0].text;
  assert.ok(raw instanceof Uint8Array); assert.equal(raw.byteLength, Buffer.byteLength('字é𠮷'));
  assert.equal(F(raw).length, F('字é𠮷').length, 'raw TEXT bytes preserve exact UTF-8 frame length');
  const a = observed(f, () => api.previewMaintenance({ kind: 'audit' })); checkPlan(a);
  const auditTerms = assertAccounting(a, sqlEvents, [row]);
  t.diagnostic(JSON.stringify({ kind: 'audit', ...auditTerms }));
  assert.equal(contentTerms.output.scalarReservation, auditTerms.output.scalarReservation);
  assert.ok(F(row).length < OUTPUT_SCALAR_RESERVATION, 'small mandatory audit descriptor could hide in the former slack');
  assert.equal(accountingTerms(a, sqlEvents, []).total, auditTerms.total - F(row).length);
  assert.throws(() => assertAccounting(a, sqlEvents, []), { code: 'ERR_ASSERTION', operator: 'strictEqual', actual: a.plan.scan.bytesRead, expected: auditTerms.total - F(row).length });
});

// node:test executes this file in its own child process. Instrument the private
// monotonic source and actual completed envelope serialization, never the public
// wall-clock callback or product return value. Native DB execution is unchanged.
for (const scenario of [
  { name: 'below cap terminal 11 versus early 10 and veto 12', cap: 20, terminal: 11, tail: 12, ok: true },
  { name: 'terminal and tail equal exact cap', cap: 11, terminal: 11, tail: 11, ok: true },
  { name: 'terminal exceeds cap', cap: 11, terminal: 12, tail: 12, ok: false },
  { name: 'bounded scalar sealing tail exceeds cap', cap: 11, terminal: 11, tail: 12, ok: false },
]) test(`final elapsed boundary: ${scenario.name}`, unix, t => {
  const f = fixture(t); content(f); assertImSchemaV4(f.db);
  const config = configuration(); config.maintenance.maxScanMs = scenario.cap;
  let adapterCalls = 0;
  const { api } = setup(f, { config,
    authorize() { adapterCalls++; return true; },
    getConfig() { adapterCalls++; return config; },
    clock() { adapterCalls++; return 20000000000; },
  });
  const originalStringify = JSON.stringify, ownNow = Object.getOwnPropertyDescriptor(performance, 'now');
  let offset = 0, envelopes = 0, answer, caught;
  const samples = [], preparations = [];
  Object.defineProperty(performance, 'now', { configurable: true, value() {
    samples.push({ value: offset, envelopes, statements: calls.length, adapterCalls });
    if (samples.length === 1) { offset = 10; return 0; }
    return offset;
  } });
  JSON.stringify = function (value, ...args) {
    const bytes = Reflect.apply(originalStringify, this, [value, ...args]);
    if (value?.plan?.version === 2 && typeof value.planHash === 'string' && Object.isFrozen(value.plan) && Object.hasOwn(value, 'nextCursor')) {
      // Work is observed after native stringify returns. Verify hashing/canonical
      // preparation already happened; the test does not synthesize an envelope.
      preparations.push({ plan: value.plan, hash: value.planHash, bytes, statements: calls.length, adapterCalls });
      offset = ++envelopes === 1 ? scenario.terminal : scenario.tail;
    }
    return bytes;
  };
  try {
    observed(f, () => { try { answer = api.previewMaintenance({ kind: 'expire' }); } catch (e) { caught = e; } });
  } finally {
    JSON.stringify = originalStringify;
    if (ownNow) Object.defineProperty(performance, 'now', ownNow); else delete performance.now;
  }
  assert.ok(samples.some(s => s.value === 10 && s.envelopes === 0));
  assert.ok(preparations.length >= 1, 'substantial canonical preparation reached');
  for (const entry of preparations) {
    assert.deepEqual(decodeMaintenancePlan(Buffer.from(JSON.stringify(entry.plan))), entry.plan);
    assert.equal(entry.hash, sha(Buffer.concat([Buffer.from('a2a-msg.im.maintenance.plan.v2\0'), Buffer.from(JSON.stringify(entry.plan))])));
    assert.ok(Buffer.byteLength(entry.bytes) <= 65536);
    assert.equal(entry.statements, calls.length, 'no SQL work hidden after canonical envelope preparation');
    assert.equal(entry.adapterCalls, adapterCalls, 'no adapter work hidden after canonical envelope preparation');
  }
  assert.ok(samples.some(s => s.envelopes === 1 && s.value === scenario.terminal), 'sample after prepared envelope');
  if (scenario.ok) {
    assert.equal(caught, undefined); checkPlan(answer); assert.equal(answer.complete, true);
    assert.equal(answer.plan.scan.elapsedMs, scenario.terminal, 'reports terminal preparation, not early or veto sample');
    assert.equal(envelopes, 2, 'one preparation and one bounded scalar seal, no recursive timing/hash loop');
    const beforeSeal = structuredClone(preparations[0].plan), afterSeal = structuredClone(answer.plan);
    beforeSeal.scan.elapsedMs = afterSeal.scan.elapsedMs;
    assert.deepEqual(beforeSeal, afterSeal, 'bounded sealing changes only the elapsed scalar');
    assert.equal(preparations[0].plan.scan.elapsedMs, 10, 'preparation used the actual early observation');
    assert.ok(samples.some(s => s.envelopes === 2 && s.value === scenario.tail), 'tail has a veto-only observation');
  } else {
    assert.equal(answer, undefined); assert.equal(caught?.code, 'MAINTENANCE_READ_UNAVAILABLE');
    assert.equal(caught?.message, 'Maintenance preview rejected');
  }
});

test('fixed-cutoff continuation advances wall but admits only eligible new suffix facts', unix, t => {
  const f = fixture(t), cutoff = 20000000000, through = cutoff - 15552000000;
  audit(f, -1, 'message.read', through - 10); audit(f, 0, 'message.read', through - 5);
  let wall = cutoff;
  const firstApi = setup(f, { clock: () => wall });
  const first = observed(f, () => firstApi.api.previewMaintenance({ kind: 'audit', limit: 1 })); checkPlan(first);
  firstApi.readTarget.invalidate();
  // Offline owner inserts between separate snapshots, before the next zero-write
  // window. New eligible suffix is visible; already-passed prefix needs restart.
  audit(f, -2, 'message.read', through - 20);
  audit(f, 1, 'message.read', through); audit(f, 2, 'message.read', through + 1);
  wall += 100;
  const { api } = setup(f, { clock: () => wall });
  const next = observed(f, () => api.previewMaintenance({ kind: 'audit', after: first.nextCursor })); checkPlan(next);
  assert.equal(next.plan.clockObservedAt, wall); assert.equal(next.plan.selection.cutoffAt, cutoff);
  assert.equal(next.plan.selection.eligibleThroughAt, through);
  assert.deepEqual(next.plan.candidates.map(c => c.auditId), [0, 1]);
  assert.deepEqual(next.plan.candidates.map(c => c.expectedFingerprint), [0, 1].map(n => auditOracle(f.db, n)));
  const fresh = observed(f, () => api.previewMaintenance({ kind: 'audit' })); checkPlan(fresh);
  assert.deepEqual(fresh.plan.candidates.map(c => c.auditId), [-2, -1, 0, 1, 2]);
});

for (const [label, sql] of [
  ['ACK timestamp', 'UPDATE im_deliveries SET acked_at=100 WHERE message_id=?'],
  ['read timestamp', 'UPDATE im_deliveries SET read_at=103 WHERE message_id=?'],
  ['retry deadline', 'UPDATE im_send_keys SET retry_until=retry_until+1 WHERE message_id=?'],
  ['conversation birth', 'UPDATE im_conversations SET created_at=0 WHERE conversation_id=(SELECT conversation_id FROM im_messages WHERE message_id=?)'],
]) test(`descriptor sensitivity valid single retained fact: ${label}`, unix, t => {
  const f = fixture(t), key = content(f); assertImSchemaV4(f.db);
  const beforeDescriptor = messageDescriptor(f.db, key), initial = setup(f);
  const before = observed(f, () => initial.api.previewMaintenance({ kind: 'expire' })); checkPlan(before);
  assert.equal(before.plan.candidates[0].expectedFingerprint, H('a2a-msg.im.maintenance.message.v1', beforeDescriptor));
  initial.readTarget.invalidate(); f.db.prepare(sql).run(key); assertImSchemaV4(f.db);
  const afterDescriptor = messageDescriptor(f.db, key);
  assert.equal(beforeDescriptor.flat(Infinity).filter((v, i) => v !== afterDescriptor.flat(Infinity)[i]).length, 1);
  const after = observed(f, () => setup(f).api.previewMaintenance({ kind: 'expire' })); checkPlan(after);
  assert.equal(after.plan.candidates[0].expectedFingerprint, H('a2a-msg.im.maintenance.message.v1', afterDescriptor));
  assert.notEqual(after.plan.candidates[0].expectedFingerprint, before.plan.candidates[0].expectedFingerprint);
  assert.notEqual(after.plan.candidateDigest, before.plan.candidateDigest);
});

test('descriptor sensitivity: lawful SQL NULL versus empty title with identical logical bytes', unix, t => {
  const f = fixture(t), key = content(f, 100, { attachment: false, text: 'x', title: null, correlation: null });
  assert.equal(assertImSchemaV4(f.db), true);
  const beforeDescriptor = messageDescriptor(f.db, key), beforeImage = image(f), initial = setup(f);
  const before = observed(f, () => initial.api.previewMaintenance({ kind: 'expire' })); checkPlan(before);
  assert.equal(beforeDescriptor[2][7], null);
  assert.equal(before.plan.candidates[0].expectedFingerprint, H('a2a-msg.im.maintenance.message.v1', beforeDescriptor));
  initial.readTarget.invalidate();
  // Owned fixture writes occur strictly outside observation. The frozen v2 send
  // fingerprint is unprefixed SHA256(C(array)), with wire ID (not storage ID).
  const sendHash = title => sha(JSON.stringify(['a2a-msg.im.v2', id(2), id(12), id(11), id(1100), title, 'x', null, null, null]));
  assert.equal(beforeDescriptor[5][2], sendHash(null));
  f.db.prepare('UPDATE im_messages SET title=? WHERE message_id=?').run('', key);
  f.db.prepare('UPDATE im_send_keys SET payload_hash=? WHERE message_id=?').run(sendHash(''), key);
  assert.equal(assertImSchemaV4(f.db), true);
  const afterDescriptor = messageDescriptor(f.db, key), afterImage = image(f);
  assert.deepEqual(afterDescriptor[2][7], [0, H('a2a-msg.im.maintenance.text.v1', '')]);
  const logicalTitleBytes = value => value === null ? 0 : Buffer.byteLength(value, 'utf8');
  assert.equal(logicalTitleBytes(null), 0); assert.equal(logicalTitleBytes(''), 0);
  assert.notDeepEqual(F(beforeDescriptor[2][7]), F(afterDescriptor[2][7]));
  assert.notDeepEqual(F(beforeDescriptor), F(afterDescriptor));
  // Exactly the title fact and its required original-send hash change; policy,
  // IDs, accepted/deadline times, delivery and all other stored rows are fixed.
  const normalized = structuredClone(afterDescriptor);
  normalized[2][7] = beforeDescriptor[2][7]; normalized[5][2] = beforeDescriptor[5][2];
  assert.deepEqual(normalized, beforeDescriptor);
  for (const name of Object.keys(beforeImage.rows)) if (!['im_messages', 'im_send_keys'].includes(name)) {
    assert.deepEqual(afterImage.rows[name], beforeImage.rows[name], name);
  }
  assert.deepEqual(afterImage.schema, beforeImage.schema);
  const after = observed(f, () => setup(f).api.previewMaintenance({ kind: 'expire' })); checkPlan(after);
  assert.deepEqual(after.plan.selection, before.plan.selection);
  assert.equal(after.plan.candidates[0].expectedFingerprint, H('a2a-msg.im.maintenance.message.v1', afterDescriptor));
  assert.notEqual(after.plan.candidates[0].expectedFingerprint, before.plan.candidates[0].expectedFingerprint);
  assert.notEqual(after.plan.scan.rangeDigest, before.plan.scan.rangeDigest);
  assert.notEqual(after.plan.candidateDigest, before.plan.candidateDigest);
  assert.equal(after.plan.candidates[0].expectedRows, before.plan.candidates[0].expectedRows);
  assert.equal(after.plan.candidates[0].expectedBytes, before.plan.candidates[0].expectedBytes);
  t.diagnostic(JSON.stringify({ titleLogicalBytes: [0, 0], descriptorBytes: [F(beforeDescriptor).length, F(afterDescriptor).length],
    fingerprints: [before.plan.candidates[0].expectedFingerprint, after.plan.candidates[0].expectedFingerprint],
    rangeDigests: [before.plan.scan.rangeDigest, after.plan.scan.rangeDigest] }));
});
