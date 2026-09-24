import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { once } from 'node:events';

// Install only observational wrappers before importing production modules. Every
// statement still executes on the original native connection. No registry,
// verifier, guard, authority result, transaction, or factory override is injected.
const nativePrepare = DatabaseSync.prototype.prepare;
const nativeExec = DatabaseSync.prototype.exec;
let job, live, phaseNumber = 0, bindingObserved = false;
const control = new SharedArrayBuffer(4), state = new Int32Array(control);
const barrier = new Worker(new URL('./barrier.js', import.meta.url), { workerData: { state: control } });
const barrierReady = once(barrier, 'message');
barrier.on('error', error => { console.error(error); process.exit(91); });
await barrierReady;

function pause(phase, evidence) {
  const sequence = ++phaseNumber;
  process.send({ type: 'phase', phase, sequence, evidence });
  const deadline = Date.now() + 20000;
  while (Atomics.load(state, 0) < sequence) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw Error(`barrier timeout: ${phase}`);
    Atomics.wait(state, 0, sequence - 1, remaining);
  }
  assert.equal(Atomics.load(state, 0), sequence);
}
DatabaseSync.prototype.prepare = function (sql) {
  const statement = nativePrepare.call(this, sql);
  if (!job?.observe) return statement;
  if (this === live && /^INSERT INTO im_legacy_bindings\b/i.test(sql)) {
    const run = statement.run.bind(statement);
    statement.run = (...args) => {
      const result = run(...args);
      if (!bindingObserved) {
        bindingObserved = true;
        assert.equal(live.isTransaction, true);
        if (job.observe === 'crash-before') pause('first-binding-inserted', {
          transaction: live.isTransaction,
          bindings: nativePrepare.call(live, 'SELECT count(*) n FROM im_legacy_bindings').get().n,
        });
      }
      return result;
    };
  }
  if (job.observe === 'physical-verify' && /^PRAGMA integrity_check$/i.test(sql)) {
    const location = nativePrepare.call(this, 'PRAGMA database_list').all().find(row => row.name === 'main')?.file;
    // A concrete probe INSIDE backup.js inspect(), after SQLite integrity_check
    // has executed, before its result returns to the real verifier. Source/lock
    // DB checks and resolver entry cannot satisfy this barrier.
    if (location?.startsWith(join(job.root, 'registry', 'artifacts') + '/') && location.endsWith('.sqlite')) {
      const all = statement.all.bind(statement);
      statement.all = (...args) => {
        const rows = all(...args);
        assert.deepEqual(rows.map(row => row.integrity_check), ['ok']);
        assert.equal(live.isTransaction, false);
        pause('physical-integrity-checked-before-return', { liveTransaction: live.isTransaction,
          artifactDatabase: true, integrityCheck: rows.map(row => row.integrity_check) });
        return rows;
      };
    }
  }
  return statement;
};
DatabaseSync.prototype.exec = function (sql) {
  const businessCommit = this === live && bindingObserved && /^COMMIT$/i.test(sql);
  if (businessCommit && job.observe === 'lock-scope') {
    assert.equal(live.isTransaction, true);
    pause('before-live-commit', { transaction: true });
  }
  const result = nativeExec.call(this, sql);
  if (businessCommit && ['lock-scope', 'crash-after'].includes(job.observe)) {
    assert.equal(live.isTransaction, false);
    const run = nativePrepare.call(live, 'SELECT run_id,status,completed_at FROM im_migration_runs').get();
    pause('after-live-commit-before-response', { transaction: false, run: { ...run } });
  }
  return result;
};

const { open, sendNormal, time } = await import('./state.js');
const { getInstanceIdentity } = await import('../../../src/im/schema.js');
const { createTrustedMigrationServices } = await import('../../../src/im/migration-services.js');
const { createBackupRegistry } = await import('../../../src/im/backup-registry.js');

function receive(type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(Error(`IPC timeout: ${type}`)), 20000);
    const disconnected = () => finish(Error('parent disconnected'));
    const message = value => {
      if (value?.type !== type) return finish(Error(`expected ${type}, received ${value?.type}`));
      finish(null, value);
    };
    function finish(error, value) {
      clearTimeout(timer); process.off('message', message); process.off('disconnect', disconnected);
      if (error) reject(error); else resolve(value);
    }
    process.on('message', message); process.once('disconnect', disconnected);
  });
}
function send(value) {
  return new Promise((resolve, reject) => process.send(value, error => error ? reject(error) : resolve()));
}
const input = receive('go');
await send({ type: 'ready', pid: process.pid });
try {
  ({ job } = await input);
  const clock = () => job.now ?? time;
  const context = Object.freeze({ caseId: job.caseId, operation: job.operation, requestId: job.requestId });
  // The trusted adapter checks the exact per-process capability object AND the
  // separately supplied grant. It never accepts arbitrary truthy admin input or
  // learns which approval to accept from the untrusted commit request.
  const authority = {
    authorizeAdmin: candidate => candidate === context && candidate.caseId === job.caseId &&
      candidate.operation === job.operation && candidate.requestId === job.requestId,
    publicationActors: candidate => {
      assert.equal(authority.authorizeAdmin(candidate), true);
      assert.equal(job.operation, 'publish');
      return { executorActorId: `executor-${job.caseId}`, backupApproverId: `backup-reviewer-${job.caseId}` };
    },
  };
  const approvalAuthority = { authorizeApproval: (approval, candidate) =>
    authority.authorizeAdmin(candidate) === true && job.operation === 'commit' &&
    job.grant?.caseId === job.caseId && job.grant?.active === true &&
    approval?.approver === job.grant.approver && approval?.planHash === job.grant.planHash &&
    approval?.backupId === job.grant.backupId };
  let result;
  if (['revoke', 'cleanup'].includes(job.operation)) {
    const registry = createBackupRegistry({ dir: join(job.root, 'registry'), authority, clock });
    registry[job.operation === 'revoke' ? 'revokeBackup' : 'cleanupBackup']({ backupId: job.backupId, adminContext: context });
    result = { ok: true };
  } else {
    live = open(job.root);
    assert.deepEqual(getInstanceIdentity(live), job.identity);
    if (job.operation === 'writer') result = sendNormal(live, clock, job.traffic, job.clientMessageId);
    else {
      const { publisher, runner, registry } = createTrustedMigrationServices({ db: live,
        dir: join(job.root, 'registry'), authority, approvalAuthority,
        actorId: `operator-${job.caseId}`, clock, approvalTtlMs: 1000 });
      if (job.operation === 'publish') {
        const published = await publisher.publish({ adminContext: context, approvalId: `backup-approval-${job.caseId}` });
        // Deliberately do not export or remember any hash from publication.
        result = { backupId: published.backupId, identity: getInstanceIdentity(live) };
      } else if (job.operation === 'preview') {
        assert.deepEqual(registry.getInstance(), { instanceId: job.identity.instanceId,
          instanceCreatedAt: job.identity.createdAt, registrationGeneration: 1 });
        const preview = runner.preview(job.bindings, { backupId: job.backupId }, context);
        const approvalResponse = receive('approve');
        await send({ type: 'approval-needed', preview });
        const { approval } = await approvalResponse;
        assert.equal(approval.planHash, preview.planHash);
        assert.equal(approval.backupId, job.backupId);
        result = { ...preview, approval };
      } else if (job.operation === 'commit') result = runner.commit(job.request, context);
      else throw Error('unknown operation');
    }
  }
  await send({ type: 'result', result });
} catch (error) {
  await send({ type: 'failure', code: error.code ?? 'HARNESS_ERROR', message: error.message, stack: error.stack });
  process.exitCode = 1;
} finally {
  live?.close();
  DatabaseSync.prototype.prepare = nativePrepare;
  DatabaseSync.prototype.exec = nativeExec;
  await barrier.terminate();
  process.disconnect();
}
