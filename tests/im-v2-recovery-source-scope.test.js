import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createImV2BackupRegistry, createTrustedImV2BackupServices, withRecoverySource } from '../src/im/v2/backup-registry.js';
import { sha } from '../src/im/v2/recovery-records.js';
import { fixture, unsupported, context } from './fixtures/im-v2-backup/helpers.js';
import { legacyPublished } from './fixtures/im-v2-backup/legacy-published.js';

test('recovery source scope binds real source, frozen proof, durable exact hold and independent copy', { skip: unsupported }, async t => {
  const f = fixture(t), services = createTrustedImV2BackupServices(f.options);
  const { record, sourceEvidence } = await services.publisher.publish({ approvalRef: 'test-approved' }, context);
  await services.publisher.drain();
  const other = createImV2BackupRegistry(f.options);
  const input = { backupId: record.backupId, recoveryRunId: randomUUID(), stageHash: 'a'.repeat(64), preparePlanHash: 'b'.repeat(64) };
  const original = readFileSync(join(f.registryRoot, record.artifactReference));
  let escaped, held, bound;
  const run = registry => withRecoverySource(registry, input, context, proof => {
    assert.deepEqual(proof.record, record); assert.deepEqual(proof.sourceEvidence, sourceEvidence);
    assert.ok(Object.isFrozen(proof) && Object.isFrozen(proof.record) && Object.isFrozen(proof.sourceEvidence));
    assert.ok(Object.isFrozen(proof.hold) && Object.isFrozen(proof.binding));
    assert.equal(proof.binding.holdId, proof.hold.holdId);
    assert.equal(proof.hold.stageHash, input.stageHash);
    held = proof.hold; bound = proof.binding; escaped = proof.copyTo;
    const chunks = [];
    proof.copyTo(chunk => { chunks.push(chunk); assert.throws(() => other.verify({ backupId: record.backupId }, context), { code: 'RECOVERY_BUSY' }); });
    assert.deepEqual(Buffer.concat(chunks), original);
    assert.throws(() => other.checkCleanup({ backupId: record.backupId }, context), { code: 'RECOVERY_BUSY' });
    return 'done';
  });
  assert.equal(run(services.registry), 'done');
  const first = { held, bound };
  assert.equal(run(other), 'done');
  assert.deepEqual({ held, bound }, first);
  assert.throws(() => escaped(() => {}), { code: 'RECOVERY_INVALID' });
  assert.equal(sha(readFileSync(join(f.registryRoot, record.artifactReference))), record.fileHash);
  assert.deepEqual(other.getHold({ holdId: held.holdId }, context), { hold: held, binding: bound, release: null });
  assert.equal(other.checkCleanup({ backupId: record.backupId }, context).reason, 'HOLD');
  assert.throws(() => withRecoverySource(other, { ...input, preparePlanHash: 'c'.repeat(64) }, context, () => {}), { code: 'RECOVERY_EVIDENCE_MISMATCH' });
  assert.throws(() => withRecoverySource(other, { ...input, stageHash: 'c'.repeat(64) }, context, () => {}), { code: 'RECOVERY_EVIDENCE_MISMATCH' });
});

test('scope authenticates facade and input and rejects async callbacks before hold creation', { skip: unsupported }, async t => {
  const f = fixture(t), services = createTrustedImV2BackupServices(f.options);
  const { record } = await services.publisher.publish({ approvalRef: 'test-approved' }, context);
  await services.publisher.drain();
  const input = { backupId: record.backupId, recoveryRunId: randomUUID(), stageHash: 'a'.repeat(64), preparePlanHash: null };
  assert.throws(() => withRecoverySource({ ...services.registry }, input, context, () => {}), { code: 'RECOVERY_EVIDENCE_MISMATCH' });
  assert.throws(() => withRecoverySource(services.registry, { ...input, root: f.root }, context, () => {}), { code: 'RECOVERY_EVIDENCE_MISMATCH' });
  assert.throws(() => withRecoverySource(services.registry, input, context, async () => {}), { code: 'RECOVERY_EVIDENCE_MISMATCH' });
  assert.equal(services.registry.checkCleanup({ backupId: record.backupId }, context).reason, 'DISABLED');
  let escaped;
  withRecoverySource(services.registry, input, context, proof => {
    assert.equal(proof.binding, null); escaped = proof.copyTo;
    let calls = 0;
    assert.throws(() => proof.copyTo(async () => { calls++; }), { code: 'RECOVERY_EVIDENCE_MISMATCH' });
    assert.equal(calls, 0);
  });
  assert.throws(() => escaped(() => {}), { code: 'RECOVERY_INVALID' });
  assert.equal(services.registry.checkCleanup({ backupId: record.backupId }, context).reason, 'HOLD');
});

test('scope keeps hold on callback failure, preserves falsy exceptions and observes returned rejection', { skip: unsupported }, async t => {
  const f = fixture(t), { publisher, registry } = createTrustedImV2BackupServices(f.options);
  const { record } = await publisher.publish({ approvalRef: 'test-approved' }, context); await publisher.drain();
  const input = { backupId: record.backupId, recoveryRunId: randomUUID(), stageHash: 'a'.repeat(64), preparePlanHash: null };
  let holdId;
  assert.throws(() => withRecoverySource(registry, input, context, proof => { holdId = proof.hold.holdId; throw null; }), e => e === null);
  assert.equal(registry.getHold({ holdId }, context).hold.holdId, holdId);
  assert.equal(registry.checkCleanup({ backupId: record.backupId }, context).reason, 'HOLD');
  const sink = new Error('sink');
  assert.throws(() => withRecoverySource(registry, input, context, proof => proof.copyTo(() => { throw sink; })), e => e === sink);
  const unhandled = []; const onUnhandled = e => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    assert.throws(() => withRecoverySource(registry, input, context, () => Promise.reject(Error('late'))), { code: 'RECOVERY_EVIDENCE_MISMATCH' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally { process.off('unhandledRejection', onUnhandled); }
  assert.equal(registry.getHold({ holdId }, context).binding, null);
});

test('imported registered v3 source is independently copied through the same durable scope', { skip: unsupported }, async t => {
  const f = fixture(t, { v3: true });
  const { old, output } = await legacyPublished(t, f);
  const services = createTrustedImV2BackupServices(f.options);
  const { record } = services.publisher.importRegisteredV3({ sourceRegistry: old.registry, backupId: output.backupId }, context);
  const input = { backupId: record.backupId, recoveryRunId: randomUUID(), stageHash: 'a'.repeat(64), preparePlanHash: null };
  let id;
  withRecoverySource(services.registry, input, context, proof => {
    assert.equal(proof.record.publicationKind, 'imported-registered-v3');
    assert.equal(proof.binding, null); id = proof.hold.holdId;
    const chunks = []; proof.copyTo(chunk => chunks.push(chunk));
    assert.equal(sha(Buffer.concat(chunks)), record.fileHash);
  });
  assert.equal(services.registry.getHold({ holdId: id }, context).hold.backupId, record.backupId);
});
