import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createImV2BackupRegistry, createTrustedImV2BackupServices } from '../src/im/v2/backup-registry.js';
import { sha } from '../src/im/v2/recovery-records.js';
import { fixture, unsupported, context } from './fixtures/im-v2-backup/helpers.js';
import { legacyPublished } from './fixtures/im-v2-backup/legacy-published.js';
import { processes } from './fixtures/im-v2-recovery-source/processes.js';

async function setup(t, { v3 = false, bound = true } = {}) {
  const teardown = [], lifecycle = { after: callback => teardown.push(callback) };
  const children = processes();
  // Confirm ALL children are gone before any reused helper removes its fixture.
  t.after(async () => { await children.stop(); for (const cleanup of teardown) await cleanup(); });
  const f = fixture(lifecycle, { v3 });
  const services = createTrustedImV2BackupServices(f.options);
  let record;
  if (v3) {
    const { old, output } = await legacyPublished(lifecycle, f);
    ({ record } = services.publisher.importRegisteredV3({ sourceRegistry: old.registry, backupId: output.backupId }, context));
  } else {
    ({ record } = await services.publisher.publish({ approvalRef: 'test-approved' }, context));
    await services.publisher.drain();
  }
  const input = { backupId: record.backupId, recoveryRunId: randomUUID(), stageHash: 'a'.repeat(64), preparePlanHash: bound ? 'b'.repeat(64) : null };
  const artifact = join(f.registryRoot, record.artifactReference);
  const manifest = join(f.registryRoot, 'registry/artifacts', `${record.backupId}.manifest.json`);
  const before = { artifact: sha(readFileSync(artifact)), manifest: sha(readFileSync(manifest)) };
  assert.equal(before.artifact, record.fileHash); assert.equal(before.manifest, record.manifestHash);
  const coordinator = join(f.registryRoot, 'coordination.sqlite');
  const inode = lstatSync(coordinator);
  function unchanged() {
    const after = lstatSync(coordinator);
    assert.equal(after.ino, inode.ino); assert.equal(after.dev, inode.dev);
    assert.equal(after.nlink, 1);
    assert.deepEqual({ artifact: sha(readFileSync(artifact)), manifest: sha(readFileSync(manifest)) }, before);
  }
  function singleHold(hold, binding) {
    assert.deepEqual(readdirSync(join(f.registryRoot, 'registry/holds')).sort(),
      [`${hold.holdId}.json`, ...(binding ? [`${hold.holdId}.binding.json`] : [])].sort());
    assert.deepEqual(createImV2BackupRegistry(f.options).getHold({ holdId: hold.holdId }, context), { hold, binding, release: null });
  }
  const start = (mode, extra = {}) => children.start({ mode, root: f.registryRoot, input, target: join(f.root, 'copied.sqlite'), ...extra });
  async function contend(busy, holderPid, hold) {
    const child = start('contender'); await child.go();
    const result = await child.next('contender'); await child.ended();
    assert.notEqual(result.pid, process.pid); assert.notEqual(result.pid, holderPid);
    for (const [operation, outcome] of Object.entries(result.results)) {
      if (busy) assert.deepEqual(outcome, { ok: false, code: 'RECOVERY_BUSY' }, operation);
      else assert.equal(outcome.ok, true, `${operation}: ${JSON.stringify(outcome)}`);
    }
    if (!busy) {
      assert.deepEqual(result.results.verify.value.record, record);
      assert.deepEqual(result.results.createStageHold.value, hold);
      assert.deepEqual(result.results.checkCleanup.value, { allowed: false, reason: 'HOLD' });
    }
    t.diagnostic(JSON.stringify({ phase: busy ? 'contender-busy' : 'contender-released', holderPid, contenderPid: result.pid,
      operations: Object.fromEntries(Object.entries(result.results).map(([key, value]) => [key, value.ok ? 'OK' : value.code])) }));
  }
  return { ...f, input, record, start, contend, singleHold, unchanged };
}

for (const v3 of [false, true]) test(`withRecoverySource real ${v3 ? 'imported-v3' : 'native-v4'} process lock spans callback, copy and postverification`, { skip: unsupported, timeout: 45000 }, async t => {
  const f = await setup(t, { v3 });
  const holder = f.start('holder'); await holder.go();
  let first;
  for (const phase of ['callback-entry-durable-hold', 'copy-chunk-after-second-facade', 'copy-returned-target-verified', 'post-callback-source-verification']) {
    const observed = await holder.next(phase); first ??= observed;
    assert.deepEqual(observed.hold, first.hold); assert.deepEqual(observed.binding, first.binding);
    assert.equal(observed.binding.preparePlanHash, f.input.preparePlanHash);
    if (phase === 'copy-chunk-after-second-facade') assert.ok(observed.copied > 0);
    if (phase === 'copy-returned-target-verified') assert.equal(observed.targetHash, f.record.fileHash);
    if (phase === 'post-callback-source-verification') assert.ok(observed.readBytes > 0);
    t.diagnostic(JSON.stringify({ phase, holderPid: holder.pid, holdId: observed.hold.holdId }));
    await f.contend(true, holder.pid);
    await holder.release(observed.sequence);
  }
  const complete = await holder.next('complete'); await holder.ended();
  assert.equal(complete.expired, true); assert.equal(complete.observedPostVerification, true);
  await f.contend(false, holder.pid, first.hold);
  const retry = f.start('retry'); await retry.go();
  const repeated = await retry.next('complete'); await retry.ended();
  assert.deepEqual(repeated.hold, first.hold); assert.deepEqual(repeated.binding, first.binding);
  f.singleHold(first.hold, first.binding); f.unchanged();
});

for (const bound of [true, false]) test(`SIGKILL inside recovery source retains exact ${bound ? 'bound' : 'null-plan'} hold across restart`, { skip: unsupported, timeout: 30000 }, async t => {
  const f = await setup(t, { bound });
  const holder = f.start('holder'); await holder.go();
  const first = await holder.next('callback-entry-durable-hold');
  await holder.release(first.sequence);
  const copied = await holder.next('copy-chunk-after-second-facade');
  assert.ok(copied.copied > 0);
  await f.contend(true, holder.pid);
  holder.kill(); await holder.ended({ code: null, signal: 'SIGKILL' });
  f.unchanged();
  const retry = f.start('retry'); await retry.go();
  const repeated = await retry.next('complete'); await retry.ended();
  assert.deepEqual(repeated.hold, first.hold); assert.deepEqual(repeated.binding, first.binding);
  assert.equal(repeated.binding === null, !bound);
  await f.contend(false, holder.pid, first.hold);
  f.singleHold(first.hold, first.binding); f.unchanged();
  t.diagnostic(JSON.stringify({ phase: 'scope-crash-restart', signal: 'SIGKILL', exitAndCloseConfirmed: true, bound, holdId: first.hold.holdId, coordinatorInodeUnchanged: true }));
});

test('callback Error and falsy throws preserve hold, expire capability and release process lock', { skip: unsupported, timeout: 30000 }, async t => {
  const f = await setup(t, { bound: false });
  let first;
  for (const failureKind of ['error', 'null', 'false', 'zero', 'empty']) {
    const holder = f.start('failure', { failureKind }); await holder.go();
    const result = await holder.next('complete'); await holder.ended();
    assert.equal(result.thrown, true); assert.equal(result.expired, true);
    first ??= result.hold; assert.deepEqual(result.hold, first); assert.equal(result.binding, null);
    await f.contend(false, holder.pid, first);
    f.singleHold(first, null); f.unchanged();
    t.diagnostic(JSON.stringify({ phase: 'callback-failure-released', failureKind, holdId: first.holdId }));
  }
});

test('Windows native gate honestly rejects registry construction', { skip: !unsupported }, () => {
  assert.throws(() => createImV2BackupRegistry({ root: process.cwd() }), { code: 'RECOVERY_UNSUPPORTED' });
});
