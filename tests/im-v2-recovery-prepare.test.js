// Retained old-API seam probes plus P5-B core tests. Locator-first uses the new intent scope.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTrustedImV2BackupServices, withRecoverySource } from '../src/im/v2/backup-registry.js';
import { context, fixture, unsupported } from './fixtures/im-v2-backup/helpers.js';
import { createClosedV3Source, createImV2RecoveryServices } from '../src/im/v2/recovery.js';
import { policy, snapshot } from './fixtures/im-v2-schema/helpers.js';
import { backup as nativeBackup, DatabaseSync } from 'node:sqlite';
import { sha } from '../src/im/v2/recovery-records.js';
import { hashRecoveryRequestRef } from '../src/im/v2/recovery-plan.js';
import { legacyPublished } from './fixtures/im-v2-backup/legacy-published.js';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function setup(f, catalog = {}) {
  const root = join(f.root, 'workspace'); mkdirSync(root, { mode: 0o700 });
  const state = { now: Date.now(), approved: true, isolated: true };
  const evidenceAuthority = {
    assertSourceIsolation: () => state.isolated,
    getSourceClosedEvidence: binding => ({ version: 1, evidenceRef: 'fixture-closed', ...binding, issuedAt: state.now }),
    authorizeSourceClosedEvidence: () => state.isolated,
  };
  const options = { root, sourceCatalog: catalog, policy: policy(), authority: f.options.authority, evidenceAuthority,
    approvalAuthority: { authorizeApproval: (input, ctx) => ctx === context && input.kind === 'prepare' && input.approvalRef === 'prepare-ok' && state.approved },
    clock: () => state.now };
  return { root, state, options, evidenceAuthority, open: () => createImV2RecoveryServices(options) };
}
const stageInput = (kind = 'fresh_bootstrap', requestRef = 'request') => ({ requestRef, candidateKind: kind,
  sourceRef: kind === 'fresh_bootstrap' ? null : 'source', isolationAckRef: kind === 'fresh_bootstrap' ? null : 'isolated' });
function tree(path) {
  return Object.fromEntries(readdirSync(path, { recursive: true }).sort().map(name => {
    const p = join(path, name), st = statSync(p);
    return [name, st.isDirectory() ? 'directory' : `${sha(readFileSync(p))}:${st.mtimeMs}:${st.size}`];
  }));
}
function query(path, callback) { const db = new DatabaseSync(path, { readOnly: true }); try { return callback(db); } finally { db.close(); } }
function reopened(t, input) {
  const args = [fileURLToPath(new URL('./fixtures/im-v2-recovery-prepare/reopen.js', import.meta.url)), JSON.stringify(input)];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 0, result.stderr);
  t.diagnostic(JSON.stringify({ child: 'reopen.js', pid: result.pid, status: result.status, signal: result.signal, error: null }));
  return JSON.parse(result.stdout);
}

test('Windows recovery strict protection reports unsupported', { skip: !unsupported }, t => {
  const f = fixture(t), s = setup(f);
  assert.throws(s.open, { code: 'RECOVERY_UNSUPPORTED' });
});

test('fresh actual P1 staging, immutable preview, prepare binding and expired readonly exact retry', { skip: unsupported }, t => {
  const f = fixture(t), s = setup(f), api = s.open();
  assert.deepEqual(Object.keys(api), ['stageCandidate', 'previewRecovery', 'prepareRecovery', 'getRecoveryStatus', 'verifyRecovery', 'previewActivation', 'activateRecovery', 'releaseRecoveryHold']);
  assert.ok(Object.isFrozen(api));
  for (const name of ['path', 'writer', 'db', 'cleanup', 'registry', 'publisher']) assert.equal(Object.hasOwn(api, name), false);
  const staged = api.stageCandidate(stageInput(), context);
  assert.equal(staged.holdId, null); assert.ok(Object.isFrozen(staged));
  assert.deepEqual(s.open().stageCandidate(stageInput(), context), staged);
  assert.throws(() => api.stageCandidate(stageInput('fresh_bootstrap', 'request\n'), context), { code: 'RECOVERY_INVALID' });
  const preview = api.previewRecovery({ runId: staged.runId }, context);
  assert.deepEqual(api.previewRecovery({ runId: staged.runId }, context), preview);
  assert.equal(preview.preparePlan.newEpoch, staged.initialEpoch); assert.equal(preview.preparePlan.rpoReport, null);
  assert.equal(api.getRecoveryStatus({ runId: staged.runId }, context).nextAction, 'APPROVE_PREPARE');
  const request = { runId: staged.runId, preparePlanHash: preview.preparePlanHash, approvalRef: 'prepare-ok' };
  const prepared = api.prepareRecovery(request, context);
  assert.equal(prepared.status, 'prepared');
  const path = join(s.root, staged.candidateReference);
  query(path, db => {
    assert.equal(db.prepare('SELECT approved_plan_hash FROM im_recovery_runs').get().approved_plan_hash, preview.preparePlanHash);
    assert.equal(db.prepare('SELECT write_mode FROM im_settings').get().write_mode, 'paused');
  });
  s.state.now += 900000; s.state.approved = false;
  const before = tree(s.root);
  assert.deepEqual(s.open().prepareRecovery(request, context), prepared);
  assert.equal(s.open().getRecoveryStatus({ runId: staged.runId }, context).state, 'prepared');
  assert.deepEqual(tree(s.root), before, 'completed retry/status are byte/mtime readonly');
});

for (const enabled of [false, true]) test(`closed v3 ${enabled ? 'enabled' : 'paused'} independent copy, pause proof and P1 import`, { skip: unsupported }, async t => {
  const f = fixture(t, { v3: true }), s = setup(f);
  if (enabled) f.db.exec("UPDATE im_settings SET write_mode='enabled'");
  const source = join(f.root, 'closed.sqlite'); await nativeBackup(f.db, source); chmodSync(source, 0o600);
  s.options.sourceCatalog = { source: { kind: 'closed-v3', source: createClosedV3Source({ path: source, sourceRef: 'source', evidenceAuthority: s.evidenceAuthority }) } };
  const before = readFileSync(source), original = snapshot(f.db), api = s.open();
  const staged = api.stageCandidate(stageInput('v3_import'), context);
  const dir = join(s.root, 'runs', staged.runId), paused = JSON.parse(readFileSync(join(dir, 'paused.json')));
  assert.equal(paused.changed, enabled); assert.equal(staged.holdId, null);
  assert.deepEqual(readFileSync(source), before); assert.deepEqual(snapshot(f.db), original);
  const closure = readFileSync(join(dir, 'source-closed.json'));
  s.state.now += 1000;
  assert.deepEqual(s.open().stageCandidate(stageInput('v3_import'), context), staged);
  assert.deepEqual(readFileSync(join(dir, 'source-closed.json')), closure);
  const preview = api.previewRecovery({ runId: staged.runId }, context);
  assert.equal(preview.preparePlan.rpoReport.missingAcceptedCount, null);
  api.prepareRecovery({ runId: staged.runId, preparePlanHash: preview.preparePlanHash, approvalRef: 'prepare-ok' }, context);
  query(join(dir, 'candidate.sqlite'), db => {
    const run = db.prepare('SELECT * FROM im_recovery_runs').get();
    for (const column of ['backup_id', 'backup_file_hash', 'manifest_hash', 'candidate_base_hash']) assert.equal(run[column], null);
    assert.equal(db.prepare('SELECT count(*) n FROM im_receiver_leases').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM im_lease_requests').get().n, 1);
    assert.equal(db.prepare('SELECT count(*) n FROM im_messages').get().n, 2);
  });
  assert.deepEqual(readFileSync(source), before);
});

test('registered snapshot keeps immutable source and hold, new epoch with genuine ACK prefix and retained history', { skip: unsupported }, async t => {
  const f = fixture(t);
  // Legitimate ACK ahead of a lagging persisted cursor/progress.
  f.db.exec('UPDATE im_deliveries SET acked_at=100,read_at=100');
  f.db.exec("UPDATE im_settings SET write_mode='enabled'");
  const services = createTrustedImV2BackupServices(f.options);
  const { record } = await services.publisher.publish({ approvalRef: 'test-approved' }, context); await services.publisher.drain();
  const s = setup(f, { source: { kind: 'registered-backup', registry: services.registry, backupId: record.backupId } });
  const original = snapshot(f.db), artifacts = tree(join(f.registryRoot, 'registry/artifacts')), api = s.open();
  const staged = api.stageCandidate(stageInput('snapshot_recovery'), context);
  assert.ok(staged.holdId); assert.equal(api.getRecoveryStatus({ runId: staged.runId }, context).writeMode, 'enabled');
  const preview = api.previewRecovery({ runId: staged.runId }, context);
  assert.notEqual(preview.preparePlan.newEpoch, staged.initialEpoch);
  const request = { runId: staged.runId, preparePlanHash: preview.preparePlanHash, approvalRef: 'prepare-ok' };
  api.prepareRecovery(request, context);
  query(join(s.root, staged.candidateReference), db => {
    assert.equal(db.prepare('SELECT handled_through FROM im_sync_progress WHERE center_epoch=?').get(preview.preparePlan.newEpoch).handled_through, 2);
    assert.equal(db.prepare('SELECT count(*) n FROM im_sync_progress').get().n, 2);
    assert.equal(db.prepare('SELECT count(*) n FROM im_lease_requests').get().n, 1);
    assert.equal(db.prepare('SELECT count(*) n FROM im_receiver_leases').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM im_messages').get().n, 2);
  });
  assert.deepEqual(snapshot(f.db), original); assert.deepEqual(tree(join(f.registryRoot, 'registry/artifacts')), artifacts);
  assert.equal(services.registry.getHold({ holdId: staged.holdId }, context).binding.preparePlanHash, preview.preparePlanHash);
  const before = tree(s.root), registryBefore = tree(f.registryRoot);
  s.state.now += 900000; s.state.approved = false;
  assert.equal(s.open().prepareRecovery(request, context).status, 'prepared');
  assert.equal(s.open().getRecoveryStatus({ runId: staged.runId }, context).state, 'prepared');
  assert.deepEqual(tree(s.root), before); assert.deepEqual(tree(f.registryRoot), registryBefore);
});

test('locator repair retains run/P1 IDs and original closure across facade clock changes', { skip: unsupported }, t => {
  const f = fixture(t), s = setup(f), api = s.open();
  const staged = api.stageCandidate(stageInput(), context), dir = join(s.root, 'runs', staged.runId);
  const locator = readFileSync(join(s.root, 'requests', `${hashRecoveryRequestRef('request')}.json`));
  unlinkSync(join(dir, 'stage.json')); unlinkSync(join(dir, 'staged.json'));
  assert.equal(api.getRecoveryStatus({ runId: staged.runId }, context).nextAction, 'RETRY_STAGE');
  s.state.now += 1000;
  assert.deepEqual(s.open().stageCandidate(stageInput(), context), staged);
  assert.deepEqual(readFileSync(join(s.root, 'requests', `${hashRecoveryRequestRef('request')}.json`)), locator);
});

test('async admin is zero-prefix rejected; literal true and strict input required', { skip: unsupported }, t => {
  const f = fixture(t), s = setup(f); let calls = 0;
  s.options.authority = { async authorizeAdmin() { calls++; return true; } };
  const api = s.open(); assert.throws(() => api.stageCandidate(stageInput(), context), { code: 'RECOVERY_AUTH_DENIED' });
  assert.equal(calls, 0); assert.deepEqual(readdirSync(s.root), []);
  for (const result of [1, 'true', Promise.reject(new Error('test-only'))]) {
    s.options.authority = { authorizeAdmin: () => result };
    assert.throws(() => s.open().stageCandidate(stageInput(), context), { code: 'RECOVERY_AUTH_DENIED' });
  }
  s.options.authority = f.options.authority;
  assert.throws(() => s.open().stageCandidate({ ...stageInput(), path: 'forbidden' }, context), { code: 'RECOVERY_INVALID' });
});

test('expiry equality refuses prepare and a backward clock cannot lower the candidate floor', { skip: unsupported }, t => {
  const f = fixture(t), s = setup(f), api = s.open(), staged = api.stageCandidate(stageInput(), context);
  const preview = api.previewRecovery({ runId: staged.runId }, context);
  s.state.now = preview.preparePlan.expiresAt;
  assert.throws(() => api.prepareRecovery({ runId: staged.runId, preparePlanHash: preview.preparePlanHash, approvalRef: 'prepare-ok' }, context), { code: 'RECOVERY_PLAN_STALE' });
  assert.throws(() => api.previewRecovery({ runId: staged.runId }, context), { code: 'RECOVERY_PLAN_STALE' });
  assert.equal(api.getRecoveryStatus({ runId: staged.runId }, context).nextAction, 'PLAN_EXPIRED');
  const candidate = join(s.root, staged.candidateReference);
  const before = query(candidate, db => snapshot(db));
  const floor = query(candidate, db => db.prepare('SELECT last_observed_at FROM im_clock').get().last_observed_at);
  assert.ok(floor >= preview.preparePlan.expiresAt);
  s.state.now = preview.preparePlan.createdAt + 1;
  assert.ok(s.state.now < floor);
  assert.throws(() => s.open().prepareRecovery({ runId: staged.runId, preparePlanHash: preview.preparePlanHash, approvalRef: 'prepare-ok' }, context), { code: 'RECOVERY_EVIDENCE_MISMATCH' });
  query(candidate, db => {
    assert.equal(db.prepare('SELECT count(*) n FROM im_recovery_runs').get().n, 0);
    assert.equal(db.prepare('SELECT last_observed_at FROM im_clock').get().last_observed_at, floor);
    assert.deepEqual(snapshot(db), before, 'clock rollback leaves candidate business state unchanged');
  });
});

test('third approval revocation refuses an unexpired plan without committing business changes', { skip: unsupported }, t => {
  const f = fixture(t), s = setup(f), api = s.open(), staged = api.stageCandidate(stageInput(), context);
  const preview = api.previewRecovery({ runId: staged.runId }, context);
  const candidate = join(s.root, staged.candidateReference);
  const before = query(candidate, db => snapshot(db));
  const initialFloor = query(candidate, db => db.prepare('SELECT last_observed_at FROM im_clock').get().last_observed_at);
  assert.ok(s.state.now >= initialFloor && s.state.now < preview.preparePlan.expiresAt);
  let approvals = 0;
  s.options.approvalAuthority = { authorizeApproval() { return ++approvals < 3; } };
  assert.throws(() => s.open().prepareRecovery({ runId: staged.runId, preparePlanHash: preview.preparePlanHash, approvalRef: 'prepare-ok' }, context), { code: 'RECOVERY_APPROVAL_DENIED' });
  assert.equal(approvals, 3, 'first and second phases approve; final phase revokes');
  query(candidate, db => {
    assert.equal(db.prepare('SELECT count(*) n FROM im_recovery_runs').get().n, 0);
    const after = snapshot(db);
    assert.deepEqual(after.schema, before.schema);
    for (const [table, rows] of Object.entries(before.rows)) {
      if (table !== 'im_clock') assert.deepEqual(after.rows[table], rows, `${table} unchanged`);
    }
    const floor = db.prepare('SELECT last_observed_at FROM im_clock').get().last_observed_at;
    assert.ok(floor >= initialFloor, 'safe observations never lower the persisted floor');
    assert.ok(floor <= s.state.now, 'floor cannot exceed the supplied safe clock');
  });
});

test('registered v3 uses genuine old-to-new import, full provenance and candidate-only enabled pause', { skip: unsupported }, async t => {
  const f = fixture(t, { v3: true }); f.db.exec("UPDATE im_settings SET write_mode='enabled'");
  const old = await legacyPublished(t, f), services = createTrustedImV2BackupServices(f.options);
  const { record, sourceEvidence } = services.publisher.importRegisteredV3({ sourceRegistry: old.old.registry, backupId: old.output.backupId }, context);
  const s = setup(f, { source: { kind: 'registered-backup', registry: services.registry, backupId: record.backupId } });
  const before = tree(join(f.registryRoot, 'registry/artifacts')), original = snapshot(f.db);
  const api = s.open(), staged = api.stageCandidate(stageInput('v3_import'), context);
  const preview = api.previewRecovery({ runId: staged.runId }, context);
  assert.deepEqual(preview.preparePlan.sourceEvidence, sourceEvidence);
  assert.equal(sourceEvidence.registryFormat, 2); assert.match(sourceEvidence.importedRecordHash, /^[0-9a-f]{64}$/);
  api.prepareRecovery({ runId: staged.runId, preparePlanHash: preview.preparePlanHash, approvalRef: 'prepare-ok' }, context);
  query(join(s.root, staged.candidateReference), db => {
    const run = db.prepare('SELECT * FROM im_recovery_runs').get();
    assert.equal(run.backup_id, record.backupId); assert.equal(run.candidate_base_hash, record.fileHash);
    assert.equal(run.backup_file_hash, record.fileHash); assert.equal(run.manifest_hash, record.manifestHash);
  });
  assert.deepEqual(tree(join(f.registryRoot, 'registry/artifacts')), before); assert.deepEqual(snapshot(f.db), original);
});

test('native publication observer: locator file+directory durable before run/proof/stage, then hold, then copy', { skip: unsupported }, async t => {
  const f = fixture(t), services = createTrustedImV2BackupServices(f.options);
  const { record } = await services.publisher.publish({ approvalRef: 'test-approved' }, context); await services.publisher.drain();
  const s = setup(f, { source: { kind: 'registered-backup', registry: services.registry, backupId: record.backupId } });
  const original = { openSync: fs.openSync, closeSync: fs.closeSync, fsyncSync: fs.fsyncSync, linkSync: fs.linkSync, writeSync: fs.writeSync };
  const descriptors = new Map(), events = [];
  fs.openSync = (...args) => { const fd = original.openSync(...args); descriptors.set(fd, String(args[0])); return fd; };
  fs.closeSync = fd => { const result = original.closeSync(fd); descriptors.delete(fd); return result; };
  fs.fsyncSync = fd => { const result = original.fsyncSync(fd); events.push(['sync', descriptors.get(fd)]); return result; };
  fs.linkSync = (...args) => { const result = original.linkSync(...args); events.push(['publish', String(args[1])]); return result; };
  fs.writeSync = (...args) => { const result = original.writeSync(...args); if (args[1]?.subarray?.(0, 16).toString() === 'SQLite format 3\0') events.push(['copy', descriptors.get(args[0])]); return result; };
  syncBuiltinESMExports();
  let staged;
  try { staged = s.open().stageCandidate(stageInput('snapshot_recovery'), context); }
  finally { Object.assign(fs, original); syncBuiltinESMExports(); }
  const requestPath = join(s.root, 'requests', `${hashRecoveryRequestRef('request')}.json`), dir = join(s.root, 'runs', staged.runId);
  const index = (kind, path) => events.findIndex(e => e[0] === kind && e[1] === path);
  const locatorIndex = index('publish', requestPath), locatorSync = events.findIndex((e, i) => i > locatorIndex && e[0] === 'sync' && e[1] === join(s.root, 'requests'));
  const proofIndex = index('publish', join(dir, 'source-closed.json')), stageIndex = index('publish', join(dir, 'stage.json'));
  const holdIndex = index('publish', join(f.registryRoot, 'registry/holds', `${staged.holdId}.json`));
  const holdSync = events.findIndex((e, i) => i > holdIndex && e[0] === 'sync' && e[1] === join(f.registryRoot, 'registry/holds'));
  const copyIndex = events.findIndex(e => e[0] === 'copy');
  assert.ok(locatorIndex >= 0 && locatorSync > locatorIndex && proofIndex > locatorSync && stageIndex > proofIndex && holdIndex > stageIndex && holdSync > holdIndex && copyIndex > holdSync);
  t.diagnostic(JSON.stringify({ locatorIndex, locatorSync, proofIndex, stageIndex, holdIndex, holdSync, copyIndex }));
});

test('forged catalog capability, kind downgrade, closure mismatch, request conflict and mutated plan refuse', { skip: unsupported }, async t => {
  const f = fixture(t), services = createTrustedImV2BackupServices(f.options);
  const { record } = await services.publisher.publish({ approvalRef: 'test-approved' }, context); await services.publisher.drain();
  const s = setup(f, { source: { kind: 'registered-backup', registry: { ...services.registry }, backupId: record.backupId } });
  assert.throws(() => s.open().stageCandidate(stageInput('snapshot_recovery'), context), { code: 'RECOVERY_EVIDENCE_MISMATCH' });
  s.options.sourceCatalog.source.registry = services.registry;
  assert.throws(() => s.open().stageCandidate(stageInput('v3_import'), context), { code: 'RECOVERY_EVIDENCE_MISMATCH' });
  const getProof = s.evidenceAuthority.getSourceClosedEvidence;
  s.evidenceAuthority.getSourceClosedEvidence = binding => ({ ...getProof(binding), fileHash: 'a'.repeat(64) });
  assert.throws(() => s.open().stageCandidate(stageInput('snapshot_recovery'), context), { code: 'RECOVERY_EVIDENCE_MISMATCH' });
  s.evidenceAuthority.getSourceClosedEvidence = getProof;
  const api = s.open(), staged = api.stageCandidate(stageInput('snapshot_recovery'), context);
  assert.throws(() => api.stageCandidate(stageInput(), context), { code: 'RECOVERY_INVALID' });
  const preview = api.previewRecovery({ runId: staged.runId }, context), path = join(s.root, 'runs', staged.runId, `prepare-${preview.preparePlanHash}.json`);
  writeFileSync(path, readFileSync(path).toString().replace('COMPARISON_INCOMPLETE', 'SOURCE_UNAVAILABLE'));
  assert.throws(() => api.prepareRecovery({ runId: staged.runId, preparePlanHash: preview.preparePlanHash, approvalRef: 'prepare-ok' }, context), { code: 'RECOVERY_EVIDENCE_MISMATCH' });
  assert.equal(api.getRecoveryStatus({ runId: staged.runId }, context).nextAction, 'MANUAL_RECONCILIATION');
});

test('status is zero SQL/FS writes, missing run versus binding corruption, and unknown WAL is conservative', { skip: unsupported }, t => {
  const f = fixture(t), s = setup(f), api = s.open(), staged = api.stageCandidate(stageInput(), context);
  const before = tree(s.root), originalFs = { writeSync: fs.writeSync, fsyncSync: fs.fsyncSync, linkSync: fs.linkSync, mkdirSync: fs.mkdirSync, unlinkSync: fs.unlinkSync };
  const originalExec = DatabaseSync.prototype.exec; let writes = 0;
  for (const key of Object.keys(originalFs)) fs[key] = () => { writes++; throw new Error('unexpected filesystem write'); };
  DatabaseSync.prototype.exec = function(sql) { if (/\b(UPDATE|INSERT|DELETE|CREATE|DROP|REPLACE|CHECKPOINT)\b/i.test(sql)) { writes++; throw new Error('unexpected SQL write'); } return originalExec.call(this, sql); };
  syncBuiltinESMExports();
  try { assert.equal(s.open().getRecoveryStatus({ runId: staged.runId }, context).nextAction, 'PREVIEW_PREPARE'); }
  finally { Object.assign(fs, originalFs); DatabaseSync.prototype.exec = originalExec; syncBuiltinESMExports(); }
  assert.equal(writes, 0); assert.deepEqual(tree(s.root), before);
  assert.throws(() => api.getRecoveryStatus({ runId: randomUUID() }, context), { code: 'RECOVERY_NOT_FOUND' });
  writeFileSync(join(s.root, staged.candidateReference) + '-wal', '', { mode: 0o600 });
  const walBefore = tree(s.root);
  assert.equal(api.getRecoveryStatus({ runId: staged.runId }, context).state, 'indeterminate');
  assert.deepEqual(tree(s.root), walBefore);
  const requestPath = join(s.root, 'requests', `${hashRecoveryRequestRef('request')}.json`);
  writeFileSync(requestPath, readFileSync(requestPath).toString() + '\n');
  assert.throws(() => api.getRecoveryStatus({ runId: staged.runId }, context), { code: 'RECOVERY_EVIDENCE_MISMATCH' });
});

test('final fresh expiry rolls back inserted run/epoch and retains observed clock floor', { skip: unsupported }, t => {
  const f = fixture(t), s = setup(f), api = s.open(), staged = api.stageCandidate(stageInput(), context);
  const preview = api.previewRecovery({ runId: staged.runId }, context); let approvals = 0;
  s.options.approvalAuthority = { authorizeApproval() { if (++approvals === 3) s.state.now = preview.preparePlan.expiresAt; return true; } };
  assert.throws(() => s.open().prepareRecovery({ runId: staged.runId, preparePlanHash: preview.preparePlanHash, approvalRef: 'prepare-ok' }, context), { code: 'RECOVERY_PLAN_STALE' });
  query(join(s.root, staged.candidateReference), db => {
    assert.equal(db.prepare('SELECT count(*) n FROM im_recovery_runs').get().n, 0);
    assert.equal(db.prepare('SELECT last_observed_at FROM im_clock').get().last_observed_at, preview.preparePlan.expiresAt);
  });
});

for (const point of ['locator', 'candidate', 'paused', 'staged']) test(`real post-publication interruption at ${point} recovers identity or stops conservatively`, { skip: unsupported }, async t => {
  const f = fixture(t, { v3: true }), s = setup(f); f.db.exec("UPDATE im_settings SET write_mode='enabled'");
  const source = join(f.root, 'closed.sqlite'); await nativeBackup(f.db, source); chmodSync(source, 0o600);
  s.options.sourceCatalog = { source: { kind: 'closed-v3', source: createClosedV3Source({ path: source, sourceRef: 'source', evidenceAuthority: s.evidenceAuthority }) } };
  const link = fs.linkSync; let reached = false;
  fs.linkSync = (...args) => {
    const result = link(...args), target = String(args[1]);
    if (!reached && (point === 'locator' ? target.includes('/requests/') && target.endsWith('.json') : target.endsWith(`/${point === 'candidate' ? 'candidate.sqlite' : point + '.json'}`))) {
      reached = true; throw new Error('post-link response interruption');
    }
    return result;
  };
  syncBuiltinESMExports();
  try { assert.throws(() => s.open().stageCandidate(stageInput('v3_import'), context), { code: 'RECOVERY_DURABILITY_UNCERTAIN' }); }
  finally { fs.linkSync = link; syncBuiltinESMExports(); }
  assert.ok(reached);
  // A thrown link result retains an unproven two-link pending/final pair: the
  // facade must not unlink or adopt it. Full kill/reconciliation belongs to D.
  const before = tree(s.root);
  assert.throws(() => s.open().stageCandidate(stageInput('v3_import'), context));
  assert.deepEqual(tree(s.root), before);
});

test('new process exact stage identity and committed prepare response loss return readonly despite revoked approval', { skip: unsupported }, t => {
  const f = fixture(t), s = setup(f), api = s.open(), staged = api.stageCandidate(stageInput(), context);
  assert.deepEqual(reopened(t, { root: s.root, now: s.state.now + 1, operation: 'stage', request: stageInput() }), staged);
  const preview = api.previewRecovery({ runId: staged.runId }, context);
  const request = { runId: staged.runId, preparePlanHash: preview.preparePlanHash, approvalRef: 'prepare-ok' };
  const exec = DatabaseSync.prototype.exec; let interrupted = false;
  DatabaseSync.prototype.exec = function(sql) {
    const result = exec.call(this, sql);
    if (!interrupted && sql === 'COMMIT') {
      const table = this.prepare("SELECT 1 FROM sqlite_master WHERE name='im_recovery_runs'").get();
      if (table && this.prepare('SELECT 1 FROM im_recovery_runs WHERE run_id=?').get(staged.runId)) {
        interrupted = true; throw new Error('lost prepare commit response');
      }
    }
    return result;
  };
  try { assert.throws(() => api.prepareRecovery(request, context)); }
  finally { DatabaseSync.prototype.exec = exec; }
  assert.ok(interrupted);
  const before = tree(s.root);
  const actual = reopened(t, { root: s.root, now: preview.preparePlan.expiresAt + 1, operation: 'prepare', request });
  assert.deepEqual(actual, { runId: staged.runId, candidateReference: staged.candidateReference, newEpoch: preview.preparePlan.newEpoch, status: 'prepared' });
  assert.deepEqual(tree(s.root), before);
});

for (const point of ['locator-durable', 'pause-commit', 'p1-commit']) test(`real ${point} interruption: original identity recovered or missing pause proof stops`, { skip: unsupported }, async t => {
  const f = fixture(t, { v3: true }), s = setup(f); f.db.exec("UPDATE im_settings SET write_mode='enabled'");
  const source = join(f.root, 'closed.sqlite'); await nativeBackup(f.db, source); chmodSync(source, 0o600);
  s.options.sourceCatalog = { source: { kind: 'closed-v3', source: createClosedV3Source({ path: source, sourceRef: 'source', evidenceAuthority: s.evidenceAuthority }) } };
  const sourceBefore = readFileSync(source), mkdir = fs.mkdirSync, exec = DatabaseSync.prototype.exec; let interrupted = false;
  fs.mkdirSync = (...args) => {
    if (point === 'locator-durable' && /\/runs\/[0-9a-f-]{36}$/.test(String(args[0]))) { interrupted = true; throw new Error('before run dir'); }
    return mkdir(...args);
  };
  DatabaseSync.prototype.exec = function(sql) {
    const result = exec.call(this, sql);
    if (point !== 'locator-durable' && !interrupted && sql === 'COMMIT') {
      const table = this.prepare("SELECT 1 FROM sqlite_master WHERE name='im_schema'").get();
      if (table) {
        const version = this.prepare('SELECT version FROM im_schema').get().version;
        if (point === 'pause-commit' && version === 3 || point === 'p1-commit' && version === 4) { interrupted = true; throw new Error('after native commit'); }
      }
    }
    return result;
  };
  syncBuiltinESMExports();
  try { assert.throws(() => s.open().stageCandidate(stageInput('v3_import'), context)); }
  finally { fs.mkdirSync = mkdir; DatabaseSync.prototype.exec = exec; syncBuiltinESMExports(); }
  assert.ok(interrupted);
  const locatorPath = join(s.root, 'requests', `${hashRecoveryRequestRef('request')}.json`), locatorBytes = readFileSync(locatorPath), locator = JSON.parse(locatorBytes);
  const state = s.open().getRecoveryStatus({ runId: locator.runId }, context);
  assert.equal(state.state, 'indeterminate');
  if (point === 'pause-commit') {
    assert.equal(state.nextAction, 'MANUAL_RECONCILIATION');
    assert.throws(() => s.open().stageCandidate(stageInput('v3_import'), context), { code: 'RECOVERY_INDETERMINATE' });
    assert.equal(existsSync(join(s.root, 'runs', locator.runId, 'paused.json')), false);
  } else {
    const ids = point === 'p1-commit' ? query(join(s.root, locator.stage.candidateReference), db => db.prepare('SELECT initial_epoch,import_epoch FROM im_schema_preparations WHERE preparation_ref=?').get(locator.stage.preparationRef)) : null;
    s.state.now += 1000;
    const result = s.open().stageCandidate(stageInput('v3_import'), context);
    assert.equal(result.runId, locator.runId);
    if (ids) { assert.equal(result.initialEpoch, ids.initial_epoch); assert.equal(result.importEpoch, ids.import_epoch); }
  }
  assert.deepEqual(readFileSync(locatorPath), locatorBytes); assert.deepEqual(readFileSync(source), sourceBefore);
});

test('known async proof and approval adapters do not execute prefixes; isolation revocation and lower budgets refuse', { skip: unsupported }, async t => {
  const f = fixture(t), services = createTrustedImV2BackupServices(f.options);
  const { record } = await services.publisher.publish({ approvalRef: 'test-approved' }, context); await services.publisher.drain();
  const s = setup(f, { source: { kind: 'registered-backup', registry: services.registry, backupId: record.backupId } });
  let calls = 0; const proof = s.evidenceAuthority.getSourceClosedEvidence;
  s.evidenceAuthority.getSourceClosedEvidence = async () => { calls++; throw new Error('prefix must not run'); };
  assert.throws(() => s.open().stageCandidate(stageInput('snapshot_recovery'), context)); assert.equal(calls, 0);
  s.evidenceAuthority.getSourceClosedEvidence = proof;
  const staged = s.open().stageCandidate(stageInput('snapshot_recovery'), context), preview = s.open().previewRecovery({ runId: staged.runId }, context);
  s.options.approvalAuthority = { async authorizeApproval() { calls++; return true; } };
  assert.throws(() => s.open().prepareRecovery({ runId: staged.runId, preparePlanHash: preview.preparePlanHash, approvalRef: 'prepare-ok' }, context), { code: 'RECOVERY_APPROVAL_DENIED' });
  assert.equal(calls, 0);
  s.state.isolated = false;
  assert.throws(() => s.open().getRecoveryStatus({ runId: staged.runId }, context), { code: 'RECOVERY_EVIDENCE_MISMATCH' });
  s.state.isolated = true; s.options.limits = { maxMessages: 1 };
  assert.throws(() => s.open().previewRecovery({ runId: staged.runId }, context), { code: 'RECOVERY_BUSY' });
});

test('partial registered copy retains hold and pending bytes, cannot be adopted or overwritten', { skip: unsupported }, async t => {
  const f = fixture(t), services = createTrustedImV2BackupServices(f.options);
  const { record } = await services.publisher.publish({ approvalRef: 'test-approved' }, context); await services.publisher.drain();
  const s = setup(f, { source: { kind: 'registered-backup', registry: services.registry, backupId: record.backupId } });
  const write = fs.writeSync; let interrupted = false;
  fs.writeSync = (...args) => {
    if (!interrupted && args[1]?.subarray?.(0, 16).toString() === 'SQLite format 3\0') {
      write(args[0], args[1], args[2], 16); interrupted = true; throw new Error('partial copy');
    }
    return write(...args);
  };
  syncBuiltinESMExports();
  try { assert.throws(() => s.open().stageCandidate(stageInput('snapshot_recovery'), context)); }
  finally { fs.writeSync = write; syncBuiltinESMExports(); }
  assert.ok(interrupted);
  const locator = JSON.parse(readFileSync(join(s.root, 'requests', `${hashRecoveryRequestRef('request')}.json`)));
  const dir = join(s.root, 'runs', locator.runId), pending = readdirSync(dir).find(name => name.endsWith('.pending'));
  assert.ok(pending); assert.equal(statSync(join(dir, pending)).size, 16);
  assert.equal(services.registry.checkCleanup({ backupId: record.backupId }, context).reason, 'HOLD');
  assert.equal(s.open().getRecoveryStatus({ runId: locator.runId }, context).nextAction, 'MANUAL_RECONCILIATION');
  assert.throws(() => s.open().stageCandidate(stageInput('snapshot_recovery'), context), { code: 'RECOVERY_INDETERMINATE' });
  assert.equal(statSync(join(dir, pending)).size, 16); assert.equal(existsSync(join(dir, 'candidate.sqlite')), false);
});

test('synthetic verified observation is retained but fake active without protected C proof refuses readonly', { skip: unsupported }, t => {
  const f = fixture(t), s = setup(f), api = s.open(), staged = api.stageCandidate(stageInput(), context);
  const preview = api.previewRecovery({ runId: staged.runId }, context), request = { runId: staged.runId, preparePlanHash: preview.preparePlanHash, approvalRef: 'prepare-ok' };
  api.prepareRecovery(request, context);
  const path = join(s.root, staged.candidateReference);
  for (const state of ['verified', 'active']) {
    const db = new DatabaseSync(path);
    try {
      db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
      if (state === 'verified') {
        db.prepare("UPDATE im_recovery_runs SET status='verified',verified_at=?").run(s.state.now);
        db.exec("UPDATE im_center_state SET status='verified'");
      } else {
        db.prepare("UPDATE im_recovery_runs SET status='active',activated_at=?,activation_ref='fixture-active',auth_review_ref='fixture-auth',activation_plan_hash=?,activation_approval_ref='fixture-approval'").run(s.state.now, 'a'.repeat(64));
        db.exec("UPDATE im_center_state SET status='active',activation_ref='fixture-active'");
      }
      db.exec('COMMIT');
    } finally { db.close(); }
    s.state.approved = false; s.state.now += 900000;
    const before = tree(s.root);
    if (state === 'verified') {
      assert.equal(s.open().prepareRecovery(request, context).status, state);
      assert.equal(s.open().getRecoveryStatus({ runId: staged.runId }, context).state, state);
    } else {
      assert.throws(() => s.open().prepareRecovery(request, context), { code: 'RECOVERY_EVIDENCE_MISMATCH' });
      assert.equal(s.open().getRecoveryStatus({ runId: staged.runId }, context).state, 'indeterminate');
    }
    assert.deepEqual(tree(s.root), before);
  }
});

test('real C verified/active facts survive expired B plan and revoked mutation approval with zero fsync or writes', { skip: unsupported }, t => {
  const f = fixture(t), s = setup(f);
  s.state.now += 60000; // Candidate P1 initialization has its own fresh clock.
  s.evidenceAuthority.assertAuthReview = (input, ctx) => ctx === context && input.authReviewRef === 'fixture-auth';
  s.options.approvalAuthority = { authorizeApproval: (input, ctx) => ctx === context && s.state.approved &&
    (input.kind === 'prepare' && input.approvalRef === 'prepare-ok' || input.kind === 'activate' && input.approvalRef === 'activate-ok') };
  const api = s.open(), staged = api.stageCandidate(stageInput(), context);
  const preview = api.previewRecovery({ runId: staged.runId }, context);
  const request = { runId: staged.runId, preparePlanHash: preview.preparePlanHash, approvalRef: 'prepare-ok' };
  api.prepareRecovery(request, context);
  const seal = api.verifyRecovery({ runId: staged.runId, preparePlanHash: preview.preparePlanHash }, context);
  const path = join(s.root, staged.candidateReference);
  for (const state of ['verified', 'active']) {
    if (state === 'active') {
      s.state.approved = true;
      const plan = api.previewActivation({ runId: staged.runId, sealReference: seal.sealReference,
        activationRef: 'fixture-active', authReviewRef: 'fixture-auth', isolationAckRef: null }, context);
      assert.equal(api.activateRecovery({ runId: staged.runId, sealReference: seal.sealReference,
        activationPlanHash: plan.activationPlanHash, activationApprovalRef: 'activate-ok' }, context).status, 'active');
    }
    s.state.now += 900000; s.state.approved = false;
    const before = tree(s.root), rows = query(path, snapshot);
    const real = { fsyncSync: fs.fsyncSync, writeSync: fs.writeSync, linkSync: fs.linkSync, unlinkSync: fs.unlinkSync };
    let writes = 0;
    for (const name of Object.keys(real)) fs[name] = () => { writes++; throw Error('readonly B/C observation attempted write or sync'); };
    syncBuiltinESMExports();
    try {
      assert.equal(s.open().prepareRecovery(request, context).status, state);
      assert.equal(s.open().getRecoveryStatus({ runId: staged.runId }, context).state, state);
    } finally { Object.assign(fs, real); syncBuiltinESMExports(); }
    assert.equal(writes, 0); assert.deepEqual(tree(s.root), before); assert.deepEqual(query(path, snapshot), rows);
  }
});

test('visible prepare plan after directory fsync failure is immutable and resynced before prepare', { skip: unsupported }, t => {
  const f = fixture(t), s = setup(f), api = s.open(), staged = api.stageCandidate(stageInput(), context);
  const dir = join(s.root, 'runs', staged.runId), original = { openSync: fs.openSync, closeSync: fs.closeSync, linkSync: fs.linkSync, fsyncSync: fs.fsyncSync };
  const descriptors = new Map(); let planPublished = false, failed = false;
  fs.openSync = (...args) => { const fd = original.openSync(...args); descriptors.set(fd, String(args[0])); return fd; };
  fs.closeSync = fd => { const result = original.closeSync(fd); descriptors.delete(fd); return result; };
  fs.linkSync = (...args) => { const result = original.linkSync(...args); if (String(args[1]).includes('/prepare-')) planPublished = true; return result; };
  fs.fsyncSync = fd => {
    const result = original.fsyncSync(fd);
    if (planPublished && !failed && descriptors.get(fd) === dir) { failed = true; throw new Error('uncertain directory sync response'); }
    return result;
  };
  syncBuiltinESMExports();
  try { assert.throws(() => api.previewRecovery({ runId: staged.runId }, context), { code: 'RECOVERY_DURABILITY_UNCERTAIN' }); }
  finally { Object.assign(fs, original); syncBuiltinESMExports(); }
  assert.ok(failed);
  const file = readdirSync(dir).find(name => name.startsWith('prepare-')), bytes = readFileSync(join(dir, file));
  const planHash = file.slice(8, -5); let planSynced = false, directorySynced = false;
  fs.openSync = (...args) => { const fd = original.openSync(...args); descriptors.set(fd, String(args[0])); return fd; };
  fs.closeSync = fd => { const result = original.closeSync(fd); descriptors.delete(fd); return result; };
  fs.fsyncSync = fd => { const result = original.fsyncSync(fd); if (descriptors.get(fd) === join(dir, file)) planSynced = true; if (planSynced && descriptors.get(fd) === dir) directorySynced = true; return result; };
  syncBuiltinESMExports();
  try { assert.equal(s.open().prepareRecovery({ runId: staged.runId, preparePlanHash: planHash, approvalRef: 'prepare-ok' }, context).status, 'prepared'); }
  finally { Object.assign(fs, original); syncBuiltinESMExports(); }
  assert.ok(planSynced && directorySynced); assert.deepEqual(readFileSync(join(dir, file)), bytes);
});

test('unbound orphan run refuses a new request identity and status cannot authenticate it', { skip: unsupported }, t => {
  const f = fixture(t), s = setup(f), api = s.open();
  api.stageCandidate(stageInput(), context);
  const orphan = randomUUID(); mkdirSync(join(s.root, 'runs', orphan), { mode: 0o700 });
  assert.throws(() => api.stageCandidate(stageInput('fresh_bootstrap', 'another'), context), { code: 'RECOVERY_INDETERMINATE' });
  assert.throws(() => api.getRecoveryStatus({ runId: orphan }, context), { code: 'RECOVERY_EVIDENCE_MISMATCH' });
  assert.equal(existsSync(join(s.root, 'requests', `${hashRecoveryRequestRef('another')}.json`)), false);
});

test('B seam probe: recovery callback first receives control after durable hold publication', { skip: unsupported }, async t => {
  const f = fixture(t);
  const { publisher, registry } = createTrustedImV2BackupServices(f.options);
  const { record } = await publisher.publish({ approvalRef: 'test-approved' }, context);
  await publisher.drain();
  const input = { backupId: record.backupId, recoveryRunId: randomUUID(), stageHash: 'a'.repeat(64), preparePlanHash: null };
  let hold;
  const consumerRefusal = Object.assign(new Error('consumer refuses before locator publication'), { code: 'RECOVERY_EVIDENCE_MISMATCH' });
  assert.throws(() => withRecoverySource(registry, input, context, proof => {
    hold = proof.hold;
    const stored = JSON.parse(readFileSync(join(f.registryRoot, 'registry/holds', `${hold.holdId}.json`), 'utf8'));
    assert.deepEqual(stored, hold);
    assert.equal(stored.stageHash, input.stageHash);
    assert.equal(existsSync(join(f.registryRoot, 'requests')), false);
    assert.equal(existsSync(join(f.registryRoot, 'runs')), false);
    throw consumerRefusal;
  }), error => error === consumerRefusal);
  // A correctly retains this hold; B has no release authority to undo it.
  assert.deepEqual(registry.getHold({ holdId: hold.holdId }, context), { hold, binding: null, release: null });
  assert.equal(registry.checkCleanup({ backupId: record.backupId }, context).reason, 'HOLD');
});

test('B seam probe: verified observation cannot nest public hold creation under its source lock', { skip: unsupported }, async t => {
  const f = fixture(t);
  const { publisher, registry } = createTrustedImV2BackupServices(f.options);
  const { record } = await publisher.publish({ approvalRef: 'test-approved' }, context);
  await publisher.drain();
  const input = { backupId: record.backupId, recoveryRunId: randomUUID(), stageHash: 'b'.repeat(64) };
  registry.withVerifiedBackup({ backupId: record.backupId }, context, proof => {
    assert.equal(proof.record.backupId, record.backupId);
    assert.throws(() => registry.createStageHold(input, context), { code: 'RECOVERY_BUSY' });
  });
  assert.equal(registry.checkCleanup({ backupId: record.backupId }, context).reason, 'DISABLED');
});
