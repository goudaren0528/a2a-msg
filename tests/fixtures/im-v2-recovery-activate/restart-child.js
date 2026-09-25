// Persisted-root handoff crosses an actual process exit, never facade-only reopening.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createImV2BackupRegistry } from '../../../src/im/v2/backup-registry.js';
import { createImV2RecoveryServices } from '../../../src/im/v2/recovery.js';
import { authority } from '../im-v2-backup/helpers.js';
import { policy } from '../im-v2-schema/helpers.js';
import { setup, context, query, tree, snapshot } from './helpers.js';
import { observeNative } from './native-observer.js';
import { sha } from '../../../src/im/v2/recovery-records.js';

const mode = process.argv[2];
function facts(p) {
  return { workspace: tree(p.root), registry: tree(p.registryRoot), candidate: sha(fs.readFileSync(p.path)),
    completion: fs.readFileSync(p.completion).toString('hex'), database: query(p.path, snapshot), source: sha(fs.readFileSync(p.sourcePath)) };
}
function observe(p, api) {
  const native = observeNative({ candidate: p.path, completion: p.completion, directory: p.dir, readonly: true });
  try {
    const status = api.getRecoveryStatus({ runId: p.runId }, context), prepared = api.prepareRecovery(p.prepareInput, context);
    assert.equal(status.state, 'active'); assert.equal(prepared.status, 'active');
    assert.equal(native.events.length, 0); assert.deepEqual(native.mutations, []);
    return { status, prepared };
  } finally { native.restore(); }
}
if (mode === 'publish') {
  const s = await setup({ after() {} }, 'snapshot'); // Parent owns removal only after confirmed exit/close.
  const seal = s.api.verifyRecovery(s.verifyInput, context), plan = s.api.previewActivation(s.previewInput(seal), context);
  const input = s.activateInput(seal, plan), completion = join(s.dir, 'activation-complete.json');
  const p = { root: s.root, fixtureRoot: s.f.root, registryRoot: s.f.registryRoot, sourcePath: s.sourcePath,
    path: s.path, dir: s.dir, completion, input, prepareInput: s.prepareInput, runId: s.staged.runId,
    backupId: s.options.sourceCatalog.source.backupId, now: s.state.now + 900000, registryNow: s.registryClock.now };
  const sourceBefore = sha(fs.readFileSync(s.sourcePath)), registryBefore = tree(s.f.registryRoot);
  const native = observeNative({ candidate: s.path, completion, directory: s.dir, publication: true, fault: 'publication-directory' });
  try {
    assert.throws(() => s.api.activateRecovery(input, context), { code: 'RECOVERY_DURABILITY_UNCERTAIN' });
    assert.equal(native.fired, true); assert.equal(native.publicationComplete, true);
    assert.ok(native.events.some(e => e.phase === 'publication-directory' && e.fault === 'before-native' && !e.native));
  } finally { native.restore(); }
  assert.equal(query(s.path, db => db.prepare('SELECT status FROM im_recovery_runs').get().status), 'active');
  assert.equal(fs.statSync(completion).nlink, 1);
  assert.equal(fs.readdirSync(s.dir).some(n => n.endsWith('.pending')), false);
  assert.equal(sha(fs.readFileSync(s.sourcePath)), sourceBefore); assert.deepEqual(tree(s.f.registryRoot), registryBefore);
  s.state.now = p.now; s.state.prepare = false; s.state.activate = false; s.state.reviewed = false;
  const before = facts(p), visible = observe(p, s.open());
  assert.deepEqual(facts(p), before);
  s.f.db.close();
  const exitTimer = setTimeout(() => { console.error('publisher exit barrier timed out; retaining fixture'); process.exit(1); }, 10000);
  process.send({ phase: 'published-before-native-failure', persisted: p, visible, before, events: native.events });
  process.once('message', message => {
    clearTimeout(exitTimer);
    assert.equal(message.mode, 'exit-with-owned-locks');
    // Three genuinely native sidecar connections are intentionally released by
    // process exit, not a facade reconstruction or a test cleanup callback.
    const locks = [join(p.registryRoot, 'coordination.sqlite'), join(p.root, 'requests/coordination.sqlite'), join(p.dir, 'coordination.sqlite')].map(path => {
      const db = new DatabaseSync(path); db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'); return db;
    });
    process.send({ phase: 'exiting-with-owned-locks' }, () => { assert.equal(locks.length, 3); process.exit(0); });
  });
} else {
  const readyTimer = setTimeout(() => { console.error('retry ready barrier timed out'); process.exit(1); }, 10000);
  process.send({ phase: 'ready' });
  process.once('message', p => {
    clearTimeout(readyTimer);
    try {
      let clocks = 0, approvals = 0, reviews = 0;
      const registry = createImV2BackupRegistry({ root: p.registryRoot, authority, clock: () => p.registryNow });
      const api = createImV2RecoveryServices({ root: p.root, policy: policy(), authority,
        sourceCatalog: { source: { kind: 'registered-backup', registry, backupId: p.backupId } },
        clock: () => { clocks++; throw Error('exact active retry cannot invoke candidate/source clock guard'); },
        approvalAuthority: { authorizeApproval() { approvals++; return false; } },
        evidenceAuthority: { assertSourceIsolation: () => true, authorizeSourceClosedEvidence: () => true,
          assertAuthReview() { reviews++; return false; } } });
      const before = facts(p), visible = observe(p, api);
      assert.deepEqual(visible, p.visible); assert.deepEqual(before, p.before); assert.deepEqual(facts(p), before);
      const locks = [join(p.registryRoot, 'coordination.sqlite'), join(p.root, 'requests/coordination.sqlite'), join(p.dir, 'coordination.sqlite')];
      const failed = observeNative({ candidate: p.path, completion: p.completion, directory: p.dir, fault: p.fault, locks });
      try {
        assert.throws(() => api.activateRecovery(p.input, context), { code: 'RECOVERY_DURABILITY_UNCERTAIN' });
        assert.equal(failed.fired, true); assert.deepEqual(failed.mutations, []);
      } finally { failed.restore(); }
      assert.deepEqual(facts(p), before); assert.deepEqual(observe(p, api), visible);
      const success = observeNative({ candidate: p.path, completion: p.completion, directory: p.dir, locks });
      let result;
      try {
        result = api.activateRecovery(p.input, context); assert.equal(result.status, 'active');
        assert.deepEqual(success.events.filter(e => e.operation === 'fsync').map(e => [e.phase, e.native]),
          ['candidate-file', 'candidate-directory', 'completion-file', 'completion-directory'].map(phase => [phase, true]));
        assert.deepEqual(success.mutations, []);
        const firstEvents = success.events.length;
        assert.deepEqual(api.activateRecovery(p.input, context), result, 'every exact retry resyncs even after successful retry in same process');
        assert.deepEqual(success.events.slice(firstEvents).filter(e => e.operation === 'fsync').map(e => [e.phase, e.native]),
          ['candidate-file', 'candidate-directory', 'completion-file', 'completion-directory'].map(phase => [phase, true]));
        assert.deepEqual(success.mutations, []);
      } finally { success.restore(); }
      assert.deepEqual(facts(p), before); assert.deepEqual(observe(p, api), visible);
      assert.equal(clocks, 0); assert.equal(approvals, 0); assert.equal(reviews, 0);
      process.send({ phase: 'complete', fault: p.fault, failed: failed.events, succeeded: success.events,
        visible, candidateHash: before.candidate, completionHash: sha(Buffer.from(before.completion, 'hex')), clocks, approvals, reviews });
    } catch (error) { process.exitCode = 1; console.error(error); process.send({ phase: 'failure', code: error.code, message: error.message }); }
    finally { process.disconnect(); }
  });
}
