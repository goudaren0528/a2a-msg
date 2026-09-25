import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import * as api from '../../../src/im/v2/backup-registry.js';
import { authority, context } from '../im-v2-backup/helpers.js';
import { triple, thrown, durableEvidence, hash, directoryState } from './helpers.js';

const send = message => process.send({ ...message, pid: process.pid });
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const outcome = callback => {
  try { return { ok: true, value: callback() }; }
  catch (error) { return { ok: false, code: error?.code ?? 'UNEXPECTED_ERROR' }; }
};
function wrap(replacements) {
  const originals = {};
  for (const [key, factory] of Object.entries(replacements)) { originals[key] = fs[key]; fs[key] = factory(fs[key]); }
  syncBuiltinESMExports();
  return () => { Object.assign(fs, originals); syncBuiltinESMExports(); };
}
let phase = 'startup';
process.once('message', async ({ mode, root, backupId, input, target, kind, observer, exceptional }) => {
  let worker, restore = () => {};
  try {
    const registry = api.createImV2BackupRegistry({ root, authority });
    const enter = callback => api.withRecoverySourceIntent(registry, { backupId }, context, callback);
    if (mode === 'contender') {
      send({ phase: 'contender', results: {
        verify: outcome(() => registry.verify({ backupId }, context)),
        createStageHold: outcome(() => registry.createStageHold({ backupId, recoveryRunId: input.recoveryRunId, stageHash: input.stageHash }, context)),
        checkCleanup: outcome(() => registry.checkCleanup({ backupId }, context)),
      } });
    } else if (mode === 'rejections') {
      const unhandled = []; let prefixes = 0, rejections = 0;
      if (observer) process.on('unhandledRejection', error => unhandled.push(error));
      const before = directoryState(join(root, 'registry'));
      assert.throws(() => enter(async () => { prefixes++; }), { code: 'RECOVERY_EVIDENCE_MISMATCH' });
      assert.deepEqual(directoryState(join(root, 'registry')), before);
      assert.throws(() => enter(() => { rejections++; return Promise.reject(Error('test outer rejection')); }), { code: 'RECOVERY_EVIDENCE_MISMATCH' });
      assert.deepEqual(directoryState(join(root, 'registry')), before);
      enter(intent => {
        const result = intent.establish(triple());
        assert.throws(() => result.copyTo(async () => { prefixes++; }), { code: 'RECOVERY_EVIDENCE_MISMATCH' });
      });
      assert.throws(() => enter(intent => {
        const result = intent.establish(triple());
        result.copyTo(() => { rejections++; return Promise.reject(Error('test sink rejection')); });
      }), { code: 'RECOVERY_EVIDENCE_MISMATCH' });
      // Two event-loop turns allow Node's default rejection machinery to run.
      // No listener in the default child: an unobserved rejection exits nonzero.
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(prefixes, 0); assert.deepEqual(unhandled, []);
      registry.verify({ backupId }, context);
      send({ phase: 'complete', prefixes, rejections, unhandled: unhandled.length });
    } else if (mode === 'durability') {
      const holds = join(root, 'registry/holds'), directory = fs.lstatSync(holds);
      let enabled = true, failedSyncs = 0, retrySyncs = 0, copiesAfterFailure = 0, linked = 0;
      const finals = () => fs.readdirSync(holds).filter(name => kind === 'binding' ? name.endsWith('.binding.json') : /^[0-9a-f-]{36}\.json$/.test(name));
      restore = wrap({
        linkSync: real => (...args) => { const value = real(...args); if (dirname(args[1]) === holds) linked++; return value; },
        fsyncSync: real => fd => {
          const value = real(fd); // Real publication and syscall precede the test fault.
          if (same(fs.fstatSync(fd), directory) && finals().length) {
            if (enabled) { failedSyncs++; throw Error(`test native ${kind} directory fsync failure`); }
            retrySyncs++;
          }
          return value;
        },
      });
      let escaped;
      thrown(() => enter(intent => {
        escaped = intent.establish;
        thrown(() => intent.establish(input), error => error?.code === 'RECOVERY_DURABILITY_UNCERTAIN');
        assert.ok(finals().length > 0, 'actual final record exists before caught establishment failure');
        thrown(() => {
          const copy = intent.establish(input);
          copy.copyTo(() => { copiesAfterFailure++; });
        });
        return 'caught-failure-must-not-be-success';
      }));
      assert.throws(() => escaped(input), { code: 'RECOVERY_INVALID' });
      assert.equal(copiesAfterFailure, 0);
      const holdName = fs.readdirSync(holds).find(name => /^[0-9a-f-]{36}\.json$/.test(name));
      assert.ok(holdName); const holdPath = join(holds, holdName), holdBytes = fs.readFileSync(holdPath), hold = JSON.parse(holdBytes);
      const holdIdentity = fs.lstatSync(holdPath), beforeNames = fs.readdirSync(holds).sort();
      const finalName = finals()[0], finalBytes = fs.readFileSync(join(holds, finalName));
      assert.equal(holdIdentity.nlink, 1);
      // Fresh scope under persistent fault must also refuse, not trust visibility.
      thrown(() => enter(intent => intent.establish(input)), error => error?.code === 'RECOVERY_DURABILITY_UNCERTAIN');
      assert.deepEqual(fs.readdirSync(holds).sort(), beforeNames);
      enabled = false;
      let recovered;
      const fresh = api.createImV2BackupRegistry({ root, authority });
      api.withRecoverySourceIntent(fresh, { backupId }, context, intent => {
        recovered = intent.establish(input); durableEvidence(root, recovered);
        const chunks = []; recovered.copyTo(chunk => chunks.push(chunk));
        assert.equal(hash(Buffer.concat(chunks)), recovered.record.fileHash);
      });
      assert.deepEqual(recovered.hold, hold);
      assert.deepEqual(fs.readFileSync(holdPath), holdBytes);
      assert.equal(same(fs.lstatSync(holdPath), holdIdentity), true);
      assert.deepEqual(fs.readFileSync(join(holds, finalName)), finalBytes);
      assert.ok(retrySyncs > 0, 'new scope actually re-synchronizes final directory');
      assert.deepEqual(fs.readdirSync(holds).sort(), [`${hold.holdId}.json`, `${hold.holdId}.binding.json`].sort());
      assert.equal(linked, 2, 'exactly one actual hold and binding publication across failures and retries');
      send({ phase: 'complete', failedSyncs, retrySyncs, linked, copiesAfterFailure, sameHold: true, holdId: hold.holdId });
    } else if (mode === 'reentrant') {
      let establish, reentered = false, escapedCopy = false, firstError;
      const holds = join(root, 'registry/holds');
      restore = wrap({ linkSync: real => (...args) => {
        const value = real(...args);
        if (!reentered && dirname(args[1]) === holds) {
          reentered = true;
          firstError = thrown(() => establish(input));
        }
        return value;
      } });
      thrown(() => enter(intent => {
        establish = intent.establish;
        thrown(() => { const result = establish(input); escapedCopy = typeof result.copyTo === 'function'; });
        return 'caught reentrant fault';
      }));
      assert.equal(reentered, true); assert.ok(firstError); assert.equal(escapedCopy, false);
      assert.throws(() => establish(input), { code: 'RECOVERY_INVALID' });
      registry.verify({ backupId }, context);
      send({ phase: 'complete', reentered, escapedCopy });
    } else if (mode === 'holder') {
      const state = new Int32Array(new SharedArrayBuffer(8));
      // Reuse the stable, read-only helper: worker services fd4 while sync callback holds lock.
      worker = new Worker(new URL('../im-v2-recovery-source/barrier.js', import.meta.url), { workerData: { state: state.buffer } });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('barrier readiness deadline')), 3000);
        worker.once('message', value => { clearTimeout(timer); assert.equal(value, 'ready'); resolve(); });
        worker.once('error', error => { clearTimeout(timer); reject(error); });
      });
      let sequence = 0, established, escaped, copied = 0, callbackReturned = false, finalObserved = false;
      const barrier = (name, extra = {}) => {
        phase = name;
        send({ phase, sequence: ++sequence, hold: established?.hold, binding: established?.binding, ...extra });
        const deadline = performance.now() + 8000;
        while (Atomics.load(state, 0) < sequence) {
          assert.equal(Atomics.load(state, 1), 0, 'control pipe failed');
          const remaining = deadline - performance.now();
          assert.ok(remaining > 0, `bounded barrier deadline: ${phase}`);
          Atomics.wait(state, 0, sequence - 1, remaining);
        }
      };
      const sourceIdentity = fs.lstatSync(join(root, 'registry/artifacts', `${backupId}.sqlite`));
      restore = wrap({ readSync: real => (...args) => {
        const n = real(...args);
        if (callbackReturned && !finalObserved && n > 0 && same(fs.fstatSync(args[0]), sourceIdentity)) {
          finalObserved = true; barrier('final-source-verification', { readBytes: n });
        }
        return n;
      } });
      const probe = () => {
        const other = api.createImV2BackupRegistry({ root, authority });
        assert.deepEqual(outcome(() => other.verify({ backupId }, context)), { ok: false, code: 'RECOVERY_BUSY' });
      };
      const failure = Error('test exceptional exit after real copied bytes');
      let didThrow = false;
      try {
        enter(intent => {
          escaped = intent.establish;
          assert.equal(intent.copyTo, undefined); assert.equal(intent.record.backupId, backupId);
          assert.deepEqual(fs.readdirSync(join(root, 'registry/holds')), []);
          probe(); barrier('pre-hold-verified');
          established = intent.establish(input); durableEvidence(root, established);
          probe(); barrier('post-hold-durable');
          const fd = fs.openSync(target, 'wx', 0o600);
          try {
            established.copyTo(chunk => {
              fs.writeFileSync(fd, chunk); copied += chunk.length;
              if (copied === chunk.length) { probe(); barrier('actual-copy-after-facade', { copied }); }
              if (exceptional) throw failure;
            });
            fs.fsyncSync(fd);
          } finally { fs.closeSync(fd); }
          assert.equal(hash(fs.readFileSync(target)), established.record.fileHash);
          const db = new DatabaseSync(target, { readOnly: true });
          try { assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); }
          finally { db.close(); }
          callbackReturned = true;
        });
      } catch (error) { if (!exceptional) throw error; assert.equal(error, failure); didThrow = true; }
      assert.equal(didThrow, exceptional); assert.equal(finalObserved, !exceptional);
      assert.throws(() => escaped(input), { code: 'RECOVERY_INVALID' });
      assert.throws(() => established.copyTo(() => assert.fail('expired copy')), { code: 'RECOVERY_INVALID' });
      assert.deepEqual(registry.getHold({ holdId: established.hold.holdId }, context), { hold: established.hold, binding: established.binding, release: null });
      send({ phase: 'complete', expired: true, exceptional, copied });
    } else assert.fail(`unknown isolated mode ${mode}`);
  } catch (error) {
    process.exitCode = 1;
    send({ phase: 'failure', at: phase, code: error?.code, message: error?.message, stack: error?.stack });
  } finally {
    restore();
    if (worker) await worker.terminate();
    process.disconnect();
  }
});
send({ phase: 'ready' });
