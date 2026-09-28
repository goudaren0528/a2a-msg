// Native fault/IPC observer. Every wrapper invokes real native I/O except
// explicitly labelled before-native faults. No product injection options.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname } from 'node:path';
import { createImV2BackupRegistry, withRecoverySource } from '../../../src/im/v2/backup-registry.js';
import { context, authority, wrapFs, paths, sameInode } from './helpers.js';

function send(value) { process.send(value); }
function barrier(phase) {
  send({ type: phase });
  const one = Buffer.alloc(1); assert.equal(fs.readSync(0, one, 0, 1, null), 1, 'owned parent native I/O release');
}
process.once('message', input => {
  let restore = () => {};
  try {
    const p = paths(input.root, input.backupId), syncs = [];
    const registry = createImV2BackupRegistry({ root: input.root, authority });
    send({ type: 'ready', pid: process.pid });
    if (input.mode === 'true-postcallback') {
      let armed = false, callbackDepth = 0, held = false, bytes = 0, operation;
      const identity = fs.statSync(p.artifact);
      restore = wrapFs({ readSync: real => (fd, ...args) => {
        const n = real(fd, ...args), st = fs.fstatSync(fd);
        if (armed && callbackDepth === 0 && !held && n > 0 && sameInode(st, identity)) {
          held = true;
          operation = { target: fs.readlinkSync(`/proc/self/fd/${fd}`), dev: st.dev, ino: st.ino, bytes: n, nativeCompleted: true, callbackDepth };
          send({ type: 'postcallback-held', callbackReturned: true, operation });
          const one = Buffer.alloc(1); assert.equal(fs.readSync(0, one, 0, 1, null), 1);
        }
        return n;
      } });
      const returned = withRecoverySource(registry, { backupId: input.backupId, recoveryRunId: input.runId, stageHash: 'a'.repeat(64), preparePlanHash: null }, context, proof => {
        callbackDepth++;
        try { proof.copyTo(chunk => { bytes += chunk.length; }); return 'consumer-returned'; }
        finally { callbackDepth--; armed = true; }
      });
      assert.equal(returned, 'consumer-returned'); assert.equal(held, true); assert.ok(bytes > 0);
      restore(); restore = () => {}; send({ type: 'result', code: null, callbackReturned: true, operation, copied: bytes });
      return;
    }
    if (input.mode === 'verify') {
      restore = wrapFs({ fsyncSync: real => fd => {
        const st = fs.fstatSync(fd), path = fs.readlinkSync(`/proc/self/fd/${fd}`);
        syncs.push({ path, directory: st.isDirectory() });
        const selected = input.failKind && (input.directory ? path === dirname(p[input.failKind]) : path === p[input.failKind]);
        if (selected && input.position === 'before-native') throw Error('B2 labelled before-native fsync failure');
        const result = real(fd);
        if (selected) throw Error('B2 labelled after-native fsync failure');
        return result;
      } });
      let result, code = null;
      try { result = registry.verify({ backupId: input.backupId }, context); } catch (error) { code = error.code; }
      restore(); restore = () => {};
      send({ type: 'result', code, syncs, backupId: result?.record.backupId ?? null });
    } else if (input.mode === 'held-copy') {
      registry.withVerifiedBackup({ backupId: input.backupId }, context, proof => {
        let bytes = 0, held = false;
        proof.copyTo(chunk => { bytes += chunk.length; if (!held) { held = true; barrier('copy-held'); } });
        assert.ok(bytes > 0);
      });
      send({ type: 'result', code: null });
    } else if (input.mode === 'source-postverify') {
      withRecoverySource(registry, { backupId: input.backupId, recoveryRunId: input.runId, stageHash: 'a'.repeat(64), preparePlanHash: null }, context, proof => {
        let bytes = 0; proof.copyTo(chunk => { bytes += chunk.length; }); assert.ok(bytes > 0);
        barrier('source-postverify-held');
      });
      send({ type: 'result', code: null });
    } else if (input.mode === 'resync-held') {
      let held = false;
      restore = wrapFs({ fsyncSync: real => fd => {
        const result = real(fd), actual = fs.fstatSync(fd);
        if (!held && sameInode(actual, fs.statSync(p.record))) { held = true; barrier('resync-held'); }
        return result;
      } });
      registry.verify({ backupId: input.backupId }, context); assert.equal(held, true, 'actual native5 record resync reached');
      restore(); restore = () => {}; send({ type: 'result', code: null });
    } else throw Error(`unknown bounded B2 worker mode ${input.mode}`);
  } catch (error) { send({ type: 'failure', code: error.code ?? null, message: error.message, stack: error.stack }); process.exitCode = 1; }
  finally { restore(); process.disconnect(); }
});
