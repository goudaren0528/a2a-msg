import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createImV2BackupRegistry } from '../../../src/im/v2/backup-registry.js';
import { createImV2RecoveryServices } from '../../../src/im/v2/recovery.js';
import { authority } from '../im-v2-backup/helpers.js';
import { policy } from '../im-v2-schema/helpers.js';
import { setup, context, tree, query, snapshot } from './helpers.js';
import { observe } from './observer.js';
const mode = process.argv[2];
const facts = p => ({ workspace: tree(p.root), registry: tree(p.registryRoot),
  candidate: fs.readFileSync(p.path).toString('hex'), database: query(p.path, snapshot),
  marker: fs.readFileSync(p.marker).toString('hex'), markerInode: fs.statSync(p.marker).ino,
  source: fs.readFileSync(p.sourcePath).toString('hex') });
if (mode === 'publish') {
  const s = await setup({ after() {} }), input = s.releaseInput();
  const p = { root: s.root, fixtureRoot: s.f.root, registryRoot: s.f.registryRoot, sourcePath: s.sourcePath,
    path: s.path, dir: s.dir, completion: s.completion, marker: s.marker, locks: s.locks, input,
    prepareInput: s.prepareInput, activationInput: s.activationInput, backupId: s.options.sourceCatalog.source.backupId };
  const before = { workspace: tree(s.root), source: snapshot(s.f.db), backup: fs.readFileSync(s.sourcePath).toString('hex') };
  const watch = observe(s, { fault: 'marker-directory' });
  try {
    assert.throws(() => s.api.releaseRecoveryHold(input, context), { code: 'RECOVERY_DURABILITY_UNCERTAIN' });
    assert.equal(watch.published, true); assert.equal(watch.fired, true);
  } finally { watch.restore(); }
  assert.deepEqual(tree(s.root), before.workspace); assert.deepEqual(snapshot(s.f.db), before.source);
  assert.equal(fs.readFileSync(s.sourcePath).toString('hex'), before.backup);
  assert.equal(fs.statSync(s.marker).nlink, 1);
  p.before = facts(p);
  s.f.db.close();
  const timer = setTimeout(() => { console.error('exit barrier timeout'); process.exit(1); }, 10000);
  process.send({ phase: 'published', persisted: p, events: watch.events });
  process.once('message', message => {
    clearTimeout(timer); assert.equal(message.mode, 'exit');
    const held = s.locks.map(path => { const db = new DatabaseSync(path); db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'); return db; });
    assert.equal(held.length, 3); process.exit(0);
  });
} else {
  const timer = setTimeout(() => process.exit(1), 10000);
  process.send({ phase: 'ready' });
  process.once('message', p => {
    clearTimeout(timer);
    try {
      let clocks = 0;
      const clock = () => { clocks++; throw Error('retry must not sample clock'); };
      const registry = createImV2BackupRegistry({ root: p.registryRoot, authority, clock });
      const api = createImV2RecoveryServices({ root: p.root, sourceCatalog: { source: { kind: 'registered-backup', registry, backupId: p.backupId } },
        policy: policy(), clock, authority,
        approvalAuthority: { authorizeApproval: input => input.kind === 'release-hold' && input.approvalRef === 'release-ok' && input.planHash === p.input.releasePlanHash },
        evidenceAuthority: { assertSourceIsolation: () => true, authorizeSourceClosedEvidence: () => true } });
      assert.deepEqual(facts(p), p.before);
      const readonly = observe(p, { readonly: true });
      try {
        const status = api.getRecoveryStatus({ runId: p.input.runId }, context);
        assert.equal(status.state, 'active'); assert.equal(status.nextAction, 'NONE'); assert.equal(status.releasePlanHash, p.input.releasePlanHash);
        assert.equal(api.prepareRecovery(p.prepareInput, context).status, 'active'); assert.deepEqual(readonly.events, []);
      } finally { readonly.restore(); }
      const failed = observe(p, { fault: p.fault });
      try { assert.throws(() => api.releaseRecoveryHold(p.input, context), { code: 'RECOVERY_DURABILITY_UNCERTAIN' }); assert.equal(failed.fired, true); }
      finally { failed.restore(); }
      assert.deepEqual(facts(p), p.before);
      const success = observe(p);
      try {
        for (let i = 0; i < 2; i++) assert.deepEqual(api.releaseRecoveryHold(p.input, context), { runId: p.input.runId, holdId: p.input.holdId, state: 'released', releasePlanHash: p.input.releasePlanHash });
        assert.deepEqual(success.events.map(e => [e.phase, e.native]), Array(2).fill(['candidate-file', 'candidate-directory', 'completion-file', 'completion-directory', 'marker-file', 'marker-directory']).flat().map(phase => [phase, true]));
      } finally { success.restore(); }
      assert.equal(clocks, 0); assert.deepEqual(facts(p), p.before);
      process.send({ phase: 'complete', clocks, failed: failed.events, succeeded: success.events });
    } catch (error) { console.error(error); process.exitCode = 1; process.send({ phase: 'failure', code: error.code, message: error.message }); }
    finally { process.disconnect(); }
  });
}
