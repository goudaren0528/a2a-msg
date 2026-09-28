import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { createImV2Backup } from '../src/im/v2/backup.js';
import { createTrustedImV2BackupServices, createImV2BackupRegistry, withRecoveryHold, withRecoverySource,
  createRecoveryHoldReleaser, withRecoverySourceIntent } from '../src/im/v2/backup-registry.js';
import { sourceTable } from '../src/im/v2/recovery-source.js';
import { operationBudget } from '../src/im/v2/recovery-records.js';
import { validationLimits } from '../src/im/v2/backup.js';
import { assertImSchemaV5 } from '../src/im/v2/schema-v5.js';
import { createImV2RecoveryServices } from '../src/im/v2/recovery.js';
import { fixture as v4Fixture, context as v4Context } from './fixtures/im-v2-backup/helpers.js';
import { policy } from './fixtures/im-v2-schema/helpers.js';
import { fixture, context, authority, unsupported, unsupportedError, busy, mismatch, assertChain, inventory, paths,
  fileState, wrapFs, sameInode, frozen, addValidMessage, growAnchors, snapshot, liveSource } from './fixtures/im-v2-backup-v5/helpers.js';

async function published(t) {
  const f = fixture(t), services = createTrustedImV2BackupServices(f.options);
  const output = await services.publisher.publish({ approvalRef: 'b2-approved' }, context); await services.publisher.drain();
  assertChain(f, output); return { ...f, ...services, ...output };
}
function recovery(f, catalog) {
  const root = join(f.root, `old-target4-${randomUUID()}`); fs.mkdirSync(root, { mode: 0o700 });
  const options = { root, sourceCatalog: catalog, policy: policy(), authority,
    evidenceAuthority: { assertSourceIsolation: () => true, getSourceClosedEvidence: binding => ({ version: 1, evidenceRef: 'b2-fixture-closed', ...binding, issuedAt: Date.now() }), authorizeSourceClosedEvidence: () => true },
    approvalAuthority: { authorizeApproval: () => true } };
  return { root, options, api: createImV2RecoveryServices(options) };
}
const stageInput = requestRef => ({ requestRef, candidateKind: 'snapshot_recovery', sourceRef: 'source', isolationAckRef: 'b2-isolated' });

test('B2 genuine native5 source proof positive, existing eight-operation target4 stage UNSUPPORTED before holds or source copy', { skip: unsupported }, async t => {
  const f = await published(t), before = inventory(join(f.registryRoot, 'registry'));
  assert.equal(f.registry.verify({ backupId: f.record.backupId }, context).record.schemaVersion, 5);
  const s = recovery(f, { source: { kind: 'registered-backup', registry: f.registry, backupId: f.record.backupId } });
  assert.deepEqual(Object.keys(s.api), ['stageCandidate', 'previewRecovery', 'prepareRecovery', 'getRecoveryStatus', 'verifyRecovery', 'previewActivation', 'activateRecovery', 'releaseRecoveryHold']);
  const writes = [];
  const restore = wrapFs({ linkSync: real => (a, b) => { writes.push(b); return real(a, b); }, writeSync: real => (fd, ...args) => { writes.push(fs.readlinkSync(`/proc/self/fd/${fd}`)); return real(fd, ...args); } });
  try { assert.throws(() => s.api.stageCandidate(stageInput('b2-native5-unsupported'), context), unsupportedError); }
  finally { restore(); }
  assert.deepEqual(inventory(join(f.registryRoot, 'registry')), before);
  assert.deepEqual(writes, [], 'admission before stage/locator/hold/candidate writes');
  assert.deepEqual(fs.readdirSync(join(f.registryRoot, 'registry/holds')), []);
});

test('B2 target4 prepare distinct catalog backupId is identity conflict before native5 admission; no new writes', { skip: unsupported }, async t => {
  const f = await published(t), old = v4Fixture(t), oldServices = createTrustedImV2BackupServices(old.options);
  const oldOutput = await oldServices.publisher.publish({ approvalRef: 'test-approved' }, v4Context); await oldServices.publisher.drain();
  // Give this composition the original v4 authority context while staging, then
  // reopen using the same catalog key pointing at a genuine native5 registry.
  const s = recovery(f, { source: { kind: 'registered-backup', registry: oldServices.registry, backupId: oldOutput.record.backupId } });
  s.options.authority = old.options.authority;
  const oldApi = createImV2RecoveryServices(s.options), staged = oldApi.stageCandidate(stageInput('b2-old4-positive'), v4Context);
  const preview = oldApi.previewRecovery({ runId: staged.runId }, v4Context);
  s.options.sourceCatalog = { source: { kind: 'registered-backup', registry: f.registry, backupId: f.record.backupId } };
  s.options.authority = authority;
  const api = createImV2RecoveryServices(s.options);
  const before = { workspace: inventory(s.root), oldRegistry: inventory(join(old.registryRoot, 'registry')), newRegistry: inventory(join(f.registryRoot, 'registry')) };
  assert.throws(() => api.prepareRecovery({ runId: staged.runId, preparePlanHash: preview.preparePlanHash, approvalRef: 'b2-prepare' }, context), mismatch);
  assert.deepEqual({ workspace: inventory(s.root), oldRegistry: inventory(join(old.registryRoot, 'registry')), newRegistry: inventory(join(f.registryRoot, 'registry')) }, before);
});

test('B2 C correlated native5 admission: public stage, sourceTable read/stage/prepare and refusal-only scopes have zero consumption/sync/hold', { skip: unsupported }, async t => {
  const f = await published(t), catalog = { source: { kind: 'registered-backup', registry: f.registry, backupId: f.record.backupId } };
  assert.equal(f.registry.verify({ backupId: f.record.backupId }, context).record.schemaVersion, 5);
  const s = recovery(f, catalog), table = sourceTable(catalog, s.options.evidenceAuthority, Date.now);
  for (const mode of ['public-stage', 'read', 'stage', 'prepare', 'refusal-intent', 'refusal-source']) {
    const before = { registry: inventory(join(f.registryRoot, 'registry')), workspace: inventory(s.root) };
    let consumes = 0, admissions = 0; const events = { syncs: [], writes: [], links: [] };
    const budget = operationBudget(validationLimits()), binding = { recoveryRunId: randomUUID(), stageHash: 'a'.repeat(64), preparePlanHash: 'b'.repeat(64) };
    const consume = () => { consumes++; }, admit = () => { admissions++; throw Object.assign(Error('RECOVERY_UNSUPPORTED'), unsupportedError); };
    const restore = wrapFs({
      fsyncSync: real => fd => { events.syncs.push(fs.readlinkSync(`/proc/self/fd/${fd}`)); return real(fd); },
      writeSync: real => (fd, ...args) => { events.writes.push(fs.readlinkSync(`/proc/self/fd/${fd}`)); return real(fd, ...args); },
      linkSync: real => (a, b) => { events.links.push(b); return real(a, b); },
    });
    try {
      assert.throws(() => {
        if (mode === 'public-stage') return s.api.stageCandidate(stageInput('b2-correlated'), context);
        if (mode === 'refusal-intent') return withRecoverySourceIntent(f.registry, { backupId: f.record.backupId }, context, consume, budget, admit);
        if (mode === 'refusal-source') return withRecoverySource(f.registry, { backupId: f.record.backupId, ...binding }, context, consume, budget, admit);
        return table.withSource(stageInput('b2-correlated'), context, budget, mode, binding, consume);
      }, unsupportedError);
    } finally { restore(); }
    assert.equal(consumes, 0); assert.equal(admissions, 0); assert.deepEqual(events, { syncs: [], writes: [], links: [] });
    assert.deepEqual({ registry: inventory(join(f.registryRoot, 'registry')), workspace: inventory(s.root) }, before);
    assert.deepEqual(fs.readdirSync(join(f.registryRoot, 'registry/holds')), []);
    t.diagnostic(JSON.stringify({ criterion: 'C', mode, consumes, admissions, ...events, holds: 0 }));
  }
});

test('B2 native5 held inspection works but target4 releaser rejects before terminal verifier/capability even when verifier returns true', { skip: unsupported }, async t => {
  const f = await published(t), runId = randomUUID(); let held;
  withRecoverySource(f.registry, { backupId: f.record.backupId, recoveryRunId: runId, stageHash: 'a'.repeat(64), preparePlanHash: 'b'.repeat(64) }, context, proof => { held = proof; });
  const input = { backupId: f.record.backupId, holdId: held.hold.holdId };
  withRecoveryHold(f.registry, input, context, proof => { frozen(proof); assert.equal(proof.record.schemaVersion, 5); assert.deepEqual(proof.binding, held.binding); });
  const before = inventory(join(f.registryRoot, 'registry')); let calls = 0;
  const releaser = createRecoveryHoldReleaser({ registry: f.registry, authority,
    approvalAuthority: { authorizeApproval: () => true }, verifyTerminal: () => { calls++; return true; } });
  assert.throws(() => releaser.release({ ...input, runId, releasePlanHash: 'c'.repeat(64), approvalRef: 'b2-release' }, context), unsupportedError);
  assert.equal(calls, 0); assert.deepEqual(inventory(join(f.registryRoot, 'registry')), before);
  assert.deepEqual(f.registry.checkCleanup({ backupId: f.record.backupId }, context), { allowed: false, reason: 'HOLD' });
  const marker = { version: 1, holdId: held.hold.holdId, recoveryRunId: runId, terminalState: 'active', stateEvidenceHash: 'd'.repeat(64), approvalRef: 'b2-fixture-marker', releasedAt: held.binding.boundAt };
  const path = join(f.registryRoot, 'registry/releases', `${held.hold.holdId}.json`);
  fs.writeFileSync(path, JSON.stringify(marker), { mode: 0o600, flag: 'wx' });
  const markerBefore = fileState(path);
  assert.deepEqual(f.registry.checkCleanup({ backupId: f.record.backupId }, context), { allowed: false, reason: 'HOLD' });
  assert.deepEqual(fileState(path), markerBefore);
  assert.ok(fs.existsSync(paths(f.registryRoot, f.record.backupId).artifact));
});

test('B2 no caller schema/tag/path/registerArtifact selectors, auth remains literal', { skip: unsupported }, async t => {
  const f = fixture(t), s = createTrustedImV2BackupServices(f.options);
  for (const extra of [{ schemaVersion: 5 }, { tag: 'native-v5' }, { path: 'caller.sqlite' }, { registerArtifact: true }])
    await assert.rejects(s.publisher.publish({ approvalRef: 'b2-approved', ...extra }, context));
  await assert.rejects(s.publisher.publish({ approvalRef: 'b2-approved' }, {}), { code: 'RECOVERY_AUTH_DENIED' });
  await assert.rejects(s.publisher.publish({ approvalRef: 'wrong' }, context), { code: 'RECOVERY_APPROVAL_DENIED' });
  assert.deepEqual(fs.readdirSync(join(f.registryRoot, 'registry/records')), []);
});

// Observe actual native statement result boundaries, never fabricate budget
// fields or wrap the genuine budget object (its private identity must survive).
function observeNative(after) {
  const original = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (sql) {
    const statement = original.call(this, sql);
    return new Proxy(statement, { get(target, method) {
      if (method === 'iterate') return function* (...args) {
        for (const row of target.iterate(...args)) { after(sql, method, row); yield row; }
        after(sql, 'iterate:end');
      };
      if (['get', 'all', 'run'].includes(method)) return (...args) => { const value = target[method](...args); after(sql, method, value); return value; };
      const value = target[method]; return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  return () => { DatabaseSync.prototype.prepare = original; };
}

test('B2 native5 file cap stops before first actual artifact hash/read, entry cap still applies', { skip: unsupported }, async t => {
  const f = await published(t), p = paths(f.registryRoot, f.record.backupId), st = fs.statSync(p.artifact); let reads = 0;
  const restore = wrapFs({ readSync: real => (fd, ...args) => { if (sameInode(fs.fstatSync(fd), st)) reads++; return real(fd, ...args); } });
  try {
    const limits = { maxFileBytes: st.size - 1 };
    assert.throws(() => createImV2Backup({ ...f.options, limits }).verify({ backupId: f.record.backupId }), busy);
    assert.throws(() => createImV2BackupRegistry({ ...f.options, limits }).verify({ backupId: f.record.backupId }, context), busy);
    assert.equal(reads, 0);
  } finally { restore(); }
  for (let i = 0; i < 2; i++) f.registry.createStageHold({ backupId: f.record.backupId, recoveryRunId: randomUUID(), stageHash: `${i + 1}`.repeat(64) }, context);
  assert.throws(() => createImV2BackupRegistry({ ...f.options, limits: { maxMetadataEntries: 1 } }).checkCleanup({ backupId: f.record.backupId }, context), busy);
});

test('B2 v5 inherited content length/count projection refuses before heavy fetch and maps schema budget to RECOVERY_BUSY', { skip: unsupported }, async t => {
  const f = fixture(t), calls = [], services = createTrustedImV2BackupServices({ ...f.options, limits: { maxVerifiedContentBytes: 1 } });
  const restore = observeNative((sql, method) => calls.push({ sql, method }));
  try { await assert.rejects(services.publisher.publish({ approvalRef: 'b2-approved' }, context), busy); await services.publisher.drain(); }
  finally { await services.publisher.drain(); restore(); }
  assert.ok(calls.some(value => /count\(\*\).*im_messages LIMIT \?/.test(value.sql)));
  assert.ok(calls.some(value => /length\(CAST\(text AS BLOB\)\)/.test(value.sql)));
  assert.equal(calls.some(value => /a\.data|SELECT \* FROM im_center_schema_transitions/.test(value.sql)), false);
});

for (const phase of ['final-snapshot-validation', 'private-source-commit', 'private-record-commit']) {
  test(`B2 authenticated original publisher budget survives ${phase} (9ms then 11ms, lower 10ms deadline)`, { skip: unsupported }, async t => {
    const f = fixture(t); let now = 100, heads = 0, advanced = false;
    t.mock.method(performance, 'now', () => now);
    const services = createTrustedImV2BackupServices({ ...f.options, limits: { maxElapsedMs: 10 } });
    const restoreNative = observeNative(sql => {
      if (sql === 'SELECT * FROM im_maintenance_time_head LIMIT 2') {
        heads++; if (heads === 1) now = 109;
        if (phase === 'final-snapshot-validation' && heads === 2) { now = 111; advanced = true; }
      }
    });
    const restoreFs = wrapFs({ linkSync: real => (a, b) => {
      const result = real(a, b);
      if ((phase === 'private-source-commit' && b.endsWith('.source.json')) ||
          (phase === 'private-record-commit' && /registry[\\/]records[\\/][0-9a-f-]{36}\.json$/.test(b))) { now = 111; advanced = true; }
      return result;
    } });
    try { await assert.rejects(services.publisher.publish({ approvalRef: 'b2-approved' }, context), busy); await services.publisher.drain(); }
    finally { await services.publisher.drain(); restoreFs(); restoreNative(); }
    assert.ok(heads >= 1, 'actual full validator head boundary reached');
    assert.equal(advanced, true, `actual ${phase} reached; refusal is original deadline, not fixture rejection`);
  });
}

test('B2 registered revalidation original deadline includes actual full validation then file/directory resync', { skip: unsupported }, async t => {
  const f = await published(t); let now = 100, reachedHead = false, reachedSync = false;
  t.mock.method(performance, 'now', () => now);
  const restoreNative = observeNative(sql => { if (sql === 'SELECT * FROM im_maintenance_time_head LIMIT 2') { reachedHead = true; now = 109; } });
  const restoreFs = wrapFs({ fsyncSync: real => fd => { const result = real(fd); if (reachedHead) { now = 111; reachedSync = true; } return result; } });
  try { assert.throws(() => createImV2BackupRegistry({ ...f.options, limits: { maxElapsedMs: 10 } }).verify({ backupId: f.record.backupId }, context), busy); }
  finally { restoreFs(); restoreNative(); }
  assert.equal(reachedHead, true); assert.equal(reachedSync, true);
});

test('B2 E fully correlated two-message native5: positive higher-cap publication then early maxMessages refusal', { skip: unsupported }, async t => {
  const f = fixture(t); addValidMessage(f); assertImSchemaV5(f.db);
  const live = await liveSource(t, f), before = fileState(live.path), facts = snapshot(live.db);
  const positive = createTrustedImV2BackupServices({ ...f.options, db: live.db, limits: { maxMessages: 2 } });
  const output = await positive.publisher.publish({ approvalRef: 'b2-approved' }, context); await positive.publisher.drain();
  assertChain(f, output, facts);
  const root = join(f.root, 'lower-count'); fs.mkdirSync(root, { mode: 0o700 });
  const negative = createTrustedImV2BackupServices({ ...f.options, root, db: live.db, limits: { maxMessages: 1 } });
  const calls = [], restore = observeNative((sql, method, result) => calls.push({ sql, method, result }));
  try { await assert.rejects(negative.publisher.publish({ approvalRef: 'b2-approved' }, context), busy); await negative.publisher.drain(); }
  finally { await negative.publisher.drain(); restore(); }
  assert.ok(calls.some(x => /count\(\*\).*im_messages LIMIT \?/.test(x.sql) && x.result?.n === 2));
  assert.equal(calls.some(x => /a\.data|SELECT \* FROM im_center_schema_transitions/.test(x.sql)), false);
  assert.deepEqual(fs.readdirSync(join(root, 'registry/records')), []);
  assert.deepEqual(snapshot(live.db), facts); assert.deepEqual(fileState(live.path), before);
  t.diagnostic(JSON.stringify({ criterion: 'E', realMessages: 2, acceptedCap: 2, refusedCap: 1, code: 'RECOVERY_BUSY', heavyFetch: false }));
});

test('B2 F lawful anchor history crosses DEFAULT 10485760 metadata charge below file/count/time caps; projection refuses before metadata fetch', { skip: unsupported, timeout: 60000 }, async t => {
  const f = fixture(t), low = growAnchors(f.db, 500); assertImSchemaV5(f.db);
  const positive = createTrustedImV2BackupServices(f.options);
  const output = await positive.publisher.publish({ approvalRef: 'b2-approved' }, context); await positive.publisher.drain();
  assertChain(f, output);
  const high = growAnchors(f.db, 800);
  assert.ok(low.anchorProjectionBytes < 10485760); assert.ok(high.anchorProjectionBytes > 10485760);
  assert.throws(() => assertImSchemaV5(f.db), { code: 'IM_V2_BUDGET_EXCEEDED' });
  const live = await liveSource(t, f), before = fileState(live.path), facts = snapshot(live.db);
  assert.ok(before.size < 134217728, 'no competing file cap');
  const root = join(f.root, 'default-metadata'); fs.mkdirSync(root, { mode: 0o700 });
  const negative = createTrustedImV2BackupServices({ ...f.options, db: live.db, root });
  let projected = 0, charged = 0, count = 0, fullAnchorFetch = 0, fullTransitionFetch = 0;
  const begin = performance.now();
  const restore = observeNative((sql, method, result) => {
    if (/count\(\*\).*im_maintenance_time_anchors LIMIT \?/.test(sql)) count = result.n;
    if (/^SELECT coalesce\(length\(CAST\(.* AS bytes FROM im_maintenance_time_anchors LIMIT \?/.test(sql) && method === 'iterate') { projected++; charged += result.bytes * 12 + 4096; }
    if (/SELECT \* FROM im_maintenance_time_anchors/.test(sql)) fullAnchorFetch++;
    if (/SELECT \* FROM im_center_schema_transitions/.test(sql)) fullTransitionFetch++;
  });
  try { await assert.rejects(negative.publisher.publish({ approvalRef: 'b2-approved' }, context), busy); await negative.publisher.drain(); }
  finally { await negative.publisher.drain(); restore(); }
  const elapsed = performance.now() - begin;
  assert.equal(count, 800); assert.ok(projected > 500 && projected <= 800);
  assert.ok(charged > 10000000, 'actual observed charge approaches the fixed ceiling; manifest/other metadata supplies the remainder');
  assert.equal(fullAnchorFetch, 0); assert.equal(fullTransitionFetch, 0);
  assert.ok(elapsed < 10000, 'refusal precedes unchanged original elapsed ceiling');
  assert.deepEqual(fs.readdirSync(join(root, 'registry/records')), []);
  assert.deepEqual(snapshot(live.db), facts); assert.deepEqual(fileState(live.path), before);
  t.diagnostic(JSON.stringify({ criterion: 'F', low, high, count, projected, charged, defaultCeiling: 10485760, fileBytes: before.size, elapsed, fullAnchorFetch, fullTransitionFetch,
    qualification: 'lawful independently chained metadata; full default validator admits 500 then budget-refuses 800, no raised caps' }));
});
