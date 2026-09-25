import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { createImV2BackupRegistry, withRecoverySource } from '../../../src/im/v2/backup-registry.js';
import { decode, readBytes, sha, writeAll } from '../../../src/im/v2/recovery-records.js';
import { authority, context } from '../im-v2-backup/helpers.js';

let phase = 'startup';
function send(message) { process.send({ ...message, pid: process.pid }); }
function outcome(callback) {
  try { return { ok: true, value: callback() }; }
  catch (error) { return { ok: false, code: error?.code ?? 'UNEXPECTED_ERROR' }; }
}
process.once('message', async ({ mode, root, input, target, failureKind }) => {
  let worker, escaped, held, bound, copied = 0;
  const originalRead = fs.readSync;
  try {
    const registry = createImV2BackupRegistry({ root, authority });
    if (mode === 'contender') {
      const stage = { backupId: input.backupId, recoveryRunId: input.recoveryRunId, stageHash: input.stageHash };
      send({ phase: 'contender', results: {
        verify: outcome(() => registry.verify({ backupId: input.backupId }, context)),
        createStageHold: outcome(() => registry.createStageHold(stage, context)),
        checkCleanup: outcome(() => registry.checkCleanup({ backupId: input.backupId }, context)),
      } });
    } else {
      let sequence = 0, state;
      if (mode === 'holder') {
        state = new Int32Array(new SharedArrayBuffer(8));
        worker = new Worker(new URL('./barrier.js', import.meta.url), { workerData: { state: state.buffer } });
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(Error('barrier worker readiness timeout')), 3000);
          worker.once('message', value => { clearTimeout(timer); assert.equal(value, 'ready'); resolve(); });
          worker.once('error', error => { clearTimeout(timer); reject(error); });
        });
      }
      const barrier = (name, evidence = {}) => {
        phase = name;
        send({ phase, sequence: ++sequence, hold: held, binding: bound, ...evidence });
        const deadline = performance.now() + 5000;
        while (Atomics.load(state, 0) < sequence) {
          assert.equal(Atomics.load(state, 1), 0, 'control pipe failed');
          const remaining = deadline - performance.now();
          assert.ok(remaining > 0, `bounded barrier timeout: ${phase}`);
          Atomics.wait(state, 0, sequence - 1, remaining);
        }
      };
      let callbackReturned = false, observedPostVerification = false;
      const artifactIdentity = fs.lstatSync(join(root, 'registry/artifacts', `${input.backupId}.sqlite`));
      if (mode === 'holder') {
        // Read-only TEST observer, installed only in this owned process. It pauses
        // an actual artifact read in verifyLocked AFTER the callback has returned.
        fs.readSync = (...args) => {
          const n = originalRead(...args);
          if (callbackReturned && !observedPostVerification && n > 0) {
            const identity = fs.fstatSync(args[0]);
            if (identity.dev === artifactIdentity.dev && identity.ino === artifactIdentity.ino) {
              observedPostVerification = true;
              barrier('post-callback-source-verification', { readBytes: n });
            }
          }
          return n;
        };
        syncBuiltinESMExports();
      }
      const failure = failureKind === 'error' ? Error('synthetic callback failure') :
        ({ null: null, false: false, zero: 0, empty: '' })[failureKind];
      let thrown = false;
      try {
        withRecoverySource(registry, input, context, proof => {
          escaped = proof.copyTo; held = proof.hold; bound = proof.binding;
          assert.deepEqual(decode('hold', readBytes(join(root, 'registry/holds', `${held.holdId}.json`))), held);
          if (bound) assert.deepEqual(decode('binding', readBytes(join(root, 'registry/holds', `${held.holdId}.binding.json`))), bound);
          else assert.equal(fs.existsSync(join(root, 'registry/holds', `${held.holdId}.binding.json`)), false);
          if (mode === 'holder') barrier('callback-entry-durable-hold');
          if (mode === 'failure') throw failure;
          if (mode === 'retry') return;
          const fd = fs.openSync(target, 'wx', 0o600);
          let chunks = 0;
          try {
            proof.copyTo(chunk => {
              writeAll(fd, chunk); copied += chunk.length; chunks++;
              if (chunks === 1) {
                // Creating and using a second genuine facade must not drop the
                // first connection's POSIX lock through an unmanaged fd close.
                const second = createImV2BackupRegistry({ root, authority });
                const nested = outcome(() => second.verify({ backupId: input.backupId }, context));
                assert.deepEqual(nested, { ok: false, code: 'RECOVERY_BUSY' });
                barrier('copy-chunk-after-second-facade', { copied, nested });
              }
            });
            fs.fsyncSync(fd);
          } finally { fs.closeSync(fd); }
          const targetHash = sha(fs.readFileSync(target));
          assert.equal(targetHash, proof.record.fileHash);
          const db = new DatabaseSync(target, { readOnly: true });
          try {
            assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
            assert.equal(db.prepare('SELECT version FROM im_schema').get().version, proof.record.schemaVersion);
          } finally { db.close(); }
          barrier('copy-returned-target-verified', { copied, targetHash });
          callbackReturned = true;
        });
      } catch (error) {
        if (mode !== 'failure') throw error;
        assert.equal(error, failure); thrown = true;
      }
      assert.equal(thrown, mode === 'failure');
      if (mode === 'holder') assert.equal(observedPostVerification, true);
      assert.throws(() => escaped(() => assert.fail('expired sink called')), { code: 'RECOVERY_INVALID' });
      const durable = registry.getHold({ holdId: held.holdId }, context);
      assert.deepEqual(durable, { hold: held, binding: bound, release: null });
      send({ phase: 'complete', hold: held, binding: bound, copied, observedPostVerification, thrown, expired: true });
    }
  } catch (error) {
    process.exitCode = 1;
    send({ phase: 'failure', at: phase, code: error?.code, message: error?.message });
  } finally {
    fs.readSync = originalRead; syncBuiltinESMExports();
    if (worker) await worker.terminate();
    process.disconnect();
  }
});
send({ phase: 'ready' });
