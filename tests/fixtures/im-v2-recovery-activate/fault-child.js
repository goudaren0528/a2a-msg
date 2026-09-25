// Isolated native wrappers perform the real operation BEFORE the reported fault.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { syncBuiltinESMExports } from 'node:module';
import { setup, context, query, tree } from './helpers.js';
import { sha } from '../../../src/im/v2/recovery-records.js';
import { observeNative } from './native-observer.js';
const cleanup = [];
const mode = process.argv[2];
const s = await setup({ after: fn => cleanup.push(fn) });
let restore = () => {}, phase = null;
try {
  const verifiedAt = () => query(s.path, db => db.prepare('SELECT verified_at FROM im_recovery_runs').get().verified_at);
  if (mode === 'seal-sync') {
    const real = { openSync: fs.openSync, closeSync: fs.closeSync, fsyncSync: fs.fsyncSync, linkSync: fs.linkSync };
    const descriptors = new Map(); let published = false;
    fs.openSync = (...args) => { const fd = real.openSync(...args); descriptors.set(fd, String(args[0])); return fd; };
    fs.closeSync = fd => { const result = real.closeSync(fd); descriptors.delete(fd); return result; };
    fs.linkSync = (...args) => { const result = real.linkSync(...args); if (String(args[1]).includes('/seals/')) published = true; return result; };
    fs.fsyncSync = fd => {
      const result = real.fsyncSync(fd);
      if (published && descriptors.get(fd) === join(s.dir, 'seals')) { phase = 'actual-seal-link-unlink-directory-fsync'; throw Error('fixture'); }
      return result;
    };
    syncBuiltinESMExports(); restore = () => { Object.assign(fs, real); syncBuiltinESMExports(); };
    assert.throws(() => s.api.verifyRecovery(s.verifyInput, context), { code: 'RECOVERY_DURABILITY_UNCERTAIN' });
    const at = verifiedAt(), dbHash = sha(fs.readFileSync(s.path));
    assert.throws(() => s.open().verifyRecovery(s.verifyInput, context), { code: 'RECOVERY_DURABILITY_UNCERTAIN' });
    restore(); restore = () => {};
    const result = s.open().verifyRecovery(s.verifyInput, context);
    assert.equal(verifiedAt(), at); assert.equal(sha(fs.readFileSync(s.path)), dbHash);
    assert.equal(fs.readdirSync(join(s.dir, 'seals')).filter(n => n.endsWith('.json')).length, 1);
    assert.equal(JSON.parse(fs.readFileSync(join(s.root, result.sealReference))).verifiedAt, at);
  } else {
    const seal = s.api.verifyRecovery(s.verifyInput, context), plan = s.api.previewActivation(s.previewInput(seal), context);
    const input = s.activateInput(seal, plan);
    if (mode === 'close-response') {
      const real = DatabaseSync.prototype.close;
      let fired = false;
      DatabaseSync.prototype.close = function() {
        let active = false;
        try { active = this.prepare('SELECT status FROM im_recovery_runs WHERE run_id=?').get(s.staged.runId)?.status === 'active'; } catch { /* coordinator */ }
        const result = Reflect.apply(real, this, []);
        if (active && !fired) { fired = true; phase = 'actual-active-native-close-before-return'; throw Error('fixture'); }
        return result;
      };
      restore = () => { DatabaseSync.prototype.close = real; };
      assert.equal(s.api.activateRecovery(input, context).status, 'active'); assert(fired);
    } else if (mode === 'commit-response') {
      const real = DatabaseSync.prototype.exec;
      let fired = false;
      DatabaseSync.prototype.exec = function(sql) {
        const result = Reflect.apply(real, this, [sql]);
        if (!fired && sql === 'COMMIT' && this.prepare("SELECT status FROM im_recovery_runs WHERE run_id=?").get(s.staged.runId)?.status === 'active') {
          fired = true; phase = 'actual-active-native-COMMIT-before-return'; throw Error('fixture');
        }
        return result;
      };
      restore = () => { DatabaseSync.prototype.exec = real; };
      assert.equal(s.api.activateRecovery(input, context).status, 'active'); assert(fired);
    } else {
      const real = { openSync: fs.openSync, closeSync: fs.closeSync, fsyncSync: fs.fsyncSync, linkSync: fs.linkSync };
      const descriptors = new Map(); let published = false;
      fs.openSync = (...args) => { const fd = real.openSync(...args); descriptors.set(fd, String(args[0])); return fd; };
      fs.closeSync = fd => { const result = real.closeSync(fd); descriptors.delete(fd); return result; };
      fs.linkSync = (...args) => { const result = real.linkSync(...args); if (String(args[1]).endsWith('/activation-complete.json')) published = true; return result; };
      fs.fsyncSync = fd => {
        const result = real.fsyncSync(fd);
        if (published && descriptors.get(fd) === s.dir) { phase = 'actual-completion-link-unlink-directory-fsync'; throw Error('fixture'); }
        return result;
      };
      syncBuiltinESMExports(); restore = () => { Object.assign(fs, real); syncBuiltinESMExports(); };
      assert.throws(() => s.api.activateRecovery(input, context), { code: 'RECOVERY_DURABILITY_UNCERTAIN' });
      const before = tree(s.root);
      const observations = observeNative({ candidate: s.path, completion: join(s.dir, 'activation-complete.json'), directory: s.dir, readonly: true });
      try {
        assert.equal(s.open().getRecoveryStatus({ runId: s.staged.runId }, context).state, 'active');
        assert.equal(s.open().prepareRecovery(s.prepareInput, context).status, 'active');
        assert.equal(observations.events.length, 0); assert.deepEqual(observations.mutations, []);
      } finally { observations.restore(); }
      assert.deepEqual(tree(s.root), before);
      assert.throws(() => s.open().activateRecovery(input, context), { code: 'RECOVERY_DURABILITY_UNCERTAIN' });
      const completion = fs.readFileSync(join(s.dir, 'activation-complete.json'));
      restore(); restore = () => {};
      assert.equal(s.open().activateRecovery(input, context).status, 'active');
      assert.deepEqual(fs.readFileSync(join(s.dir, 'activation-complete.json')), completion);
    }
    assert.equal(query(s.path, db => db.prepare("SELECT count(*) n FROM im_audit WHERE action='recovery.activate'").get().n), 1);
  }
  assert(phase);
  console.log(JSON.stringify({ mode, phase, success: true }));
} finally {
  restore(); for (const fn of cleanup.reverse()) fn();
}
