import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { scenarios, expectedGroups, operationOrder, baseHead } from './fixtures/im-v2-recovery/scenarios.js';
import { OwnedProcesses, deadlines } from './fixtures/im-v2-recovery/processes.js';
import { setup, saved, tree, retainFiles, inputFor, sha, json, query, snapshot, candidateBusiness,
  semanticUnknown, assertChain, hashFile } from './fixtures/im-v2-recovery/fixture.js';
import { createImV2RecoveryServices } from '../src/im/v2/recovery.js';

const windows = process.platform === 'win32';
test('P5-D portable finite inventory and bounded owned-process configuration', () => {
  assert.equal(scenarios.length, 43); assert.equal(new Set(scenarios.map(s => s.id)).size, 43);
  assert.deepEqual(Object.fromEntries(Object.keys(expectedGroups).map(group => [group, scenarios.filter(s => s.id.startsWith(group)).length])), expectedGroups);
  assert.equal(scenarios.filter(s => s.death === 'K').length, 39);
  assert.equal(scenarios.filter(s => s.death === 'P').length, 4);
  assert.equal(scenarios.filter(s => s.contenders).length, 2);
  assert.deepEqual(deadlines, { ready: 3000, phase: 8000, go: 5000, term: 1000, kill: 3000, case: 60000 });
  assert.match(baseHead, /^[a-f0-9]{40}$/);
});
test('P5-D Windows explicit strict UNSUPPORTED gate', { skip: !windows }, () => {
  assert.throws(() => createImV2RecoveryServices({ root: tmpdir() }), { code: 'RECOVERY_UNSUPPORTED' });
});

function immutableRecords(root) {
  return Object.fromEntries(Object.entries(tree(root)).filter(([name, fact]) => !fact.directory && !name.endsWith('candidate.sqlite') && !name.endsWith('coordination.sqlite')));
}
function actual(s) {
  return query(s.path, db => ({
    center: db.prepare('SELECT * FROM im_center_state').get(),
    runs: db.prepare('SELECT * FROM im_recovery_runs ORDER BY run_id').all(),
    epochs: db.prepare('SELECT * FROM im_center_epochs ORDER BY center_epoch').all(),
    mode: db.prepare('SELECT write_mode FROM im_settings').get().write_mode,
    floor: db.prepare('SELECT last_observed_at FROM im_clock').get().last_observed_at,
    audit: db.prepare("SELECT * FROM im_audit WHERE action='recovery.activate' ORDER BY rowid").all(),
    preparations: db.prepare('SELECT * FROM im_schema_preparations ORDER BY preparation_ref').all(),
  }));
}
function requireSuccess(result, operation) {
  assert.equal(result.operation, operation);
  assert.equal(result.result.ok, true, `${operation}: ${JSON.stringify(result.result)}`);
  return result.result.value;
}
function syncPair(result, suffix, { newlyPublished = false } = {}) {
  const events = result.syncs, index = events.findIndex(e => e.path.endsWith(suffix) && !e.directory);
  if (newlyPublished) {
    const publication = result.publications.find(entry => entry.path.endsWith(suffix));
    assert.ok(publication, `actual no-replace publication ${suffix}`);
    assert.equal(publication.fileSynced, true); assert.equal(publication.pendingUnlinked, true); assert.equal(publication.directorySynced, true);
    const pendingIndex = events.findIndex(e => e.path === publication.pending && !e.directory);
    assert.ok(pendingIndex >= 0, 'new completion fsyncs actual pending inode before link');
    assert.ok(events.slice(pendingIndex + 1).some(e => e.directory && e.path === dirname(publication.path)));
    return;
  }
  assert.ok(index >= 0, `mandatory native file sync ${suffix}`);
  assert.ok(events.slice(index + 1).some(e => e.directory && e.path === dirname(events[index].path)), `mandatory directory sync ${suffix}`);
  for (const e of events) assert.equal(e.nativeCompleted, true);
}

for (const scenario of scenarios) test(`P5-D ${scenario.id} ${scenario.death} ${scenario.route} / ${scenario.phase}`, {
  skip: windows ? 'RECOVERY_UNSUPPORTED: native process matrix requires Unix local ext4' : false,
  timeout: deadlines.case,
}, async t => {
  let f, success = false;
  const diagnostics = [], owned = new OwnedProcesses(message => diagnostics.push(message));
  t.after(async () => {
    let stopped = false;
    try { await owned.stop(); stopped = true; }
    finally {
      if (f) {
        const logs = [...owned.children].map(s => ({ pid: s.child.pid, exit: s.exit, close: s.close, error: s.error, stdout: s.stdout, stderr: s.stderr }));
        fs.writeFileSync(join(f.root, 'process-evidence.json'), JSON.stringify({ caseId: scenario.id, baseHead, success, stopped, diagnostics, logs }, null, 2), { mode: 0o600, flag: 'wx' });
        if (stopped) await f.close(success);
      }
    }
  });
  f = await setup(scenario); t.diagnostic(`caseRoot=${f.root}`);
  const step = async (operation, options = {}) => {
    const expectedInput = options.input ?? inputFor(f.d, operation);
    const child = owned.start(f.descriptor, options.mode ?? 'step', { operation, ...options }); await child.begin();
    const result = await owned.complete(child);
    assert.equal(result.operationHash, sha(JSON.stringify(expectedInput)), 'exact operation binding');
    f.unchanged(); return result;
  };
  if (scenario.operation === 'lineage') {
    const pids = [], results = {};
    for (const operation of operationOrder) {
      if (operation === 'release' && ['fresh', 'closed-v3'].includes(scenario.route)) continue;
      const result = await step(operation); pids.push(result.pid); results[operation] = requireSuccess(result, operation);
      if (operation !== 'stage') assert.ok(result.status, 'independent process observes status before mutation');
    }
    assert.equal(new Set(pids).size, pids.length, 'each lineage step is an independent normal-exit process');
    const s = saved(f.d), facts = actual(s), plan = s.records[s.prepareName];
    assert.equal(facts.center.status, 'active'); assert.equal(facts.mode, 'paused');
    assert.equal(facts.audit.length, 1); assert.equal(facts.center.center_epoch, plan.newEpoch);
    const run = facts.runs.find(r => r.run_id === s.locator.runId);
    assert.equal(run.status, 'active'); assert.equal(run.approved_plan_hash, s.preparePlanHash);
    if (scenario.route === 'fresh') {
      assert.equal(s.locator.stage.sourceEvidence, null); assert.equal(s.locator.sourceClosedEvidence, null);
      assert.equal(s.records['staged.json'].candidateBaseHash, null); assert.equal(s.records['base.json'], undefined);
      assert.equal(plan.newEpoch, facts.preparations[0].initial_epoch); assert.equal(facts.preparations[0].import_epoch, null);
      assert.equal(plan.rpoReport, null);
    } else {
      assertChain(s.dir, { paused: scenario.route.includes('v3') });
      assert.equal(plan.rpoReport.status, 'unknown');
      for (const key of ['missingAcceptedCount', 'missingAckCount', 'missingReadCount', 'comparisonEvidenceHash']) assert.equal(plan.rpoReport[key], null);
      assert.equal(plan.rpoReport.authChanges, 'unknown');
      assert.equal(s.locator.sourceClosedEvidence.fileHash, s.locator.stage.sourceEvidence.fileHash ?? s.locator.stage.sourceEvidence.closedSourceFileHash);
    }
    if (scenario.route === 'fresh' || scenario.route === 'closed-v3') {
      assert.equal(results.stage.holdId, null); assert.equal(s.records['hold.json'], undefined);
      for (const key of ['backup_id', 'backup_file_hash', 'manifest_hash', 'candidate_base_hash']) assert.equal(run[key], null);
      const observed = await step('status'); assert.equal(observed.result.value.releasePlan, null); assert.equal(observed.result.value.releasePlanHash, null);
    } else {
      assert.equal(results.release.state, 'released');
      const hold = s.records['hold.json']; assert.ok(fs.existsSync(join(f.d.registryRoot, 'registry/holds', `${hold.holdId}.json`)));
      assert.equal(hashFile(join(f.d.registryRoot, 'registry/artifacts', `${f.d.backupId}.sqlite`)), run.backup_file_hash);
      if (scenario.route === 'registered-v3') {
        const imported = join(f.d.registryRoot, 'registry/records', `${f.d.backupId}.import.json`);
        assert.equal(s.locator.stage.sourceEvidence.importedRecordHash, hashFile(imported));
        assert.equal(s.locator.stage.sourceEvidence.registryFormat, 2);
        assert.notEqual(fs.statSync(f.old.artifact).ino, fs.statSync(join(f.d.registryRoot, 'registry/artifacts', `${f.d.backupId}.sqlite`)).ino);
        assert.equal(s.records['normalized.json'].changed, true); assert.equal(s.records['paused.json'].changed, true);
        assert.deepEqual(candidateBusiness(s.path), f.sourceBusiness);
      } else {
        assert.notEqual(plan.newEpoch, f.core.centerEpoch); assert.equal(plan.oldEpoch, f.core.centerEpoch);
        assert.equal(plan.recoveryCounter, 1); assert.equal(facts.center.recovery_counter, 1);
        assert.deepEqual(candidateBusiness(s.path), f.beforeBackup);
        const terminal = tree(f.d.workspace); const semantic = semanticUnknown(f, s.path);
        assert.deepEqual(semantic, { code: 'SEND_OUTCOME_UNKNOWN', posts: 0, disposable: true });
        assert.deepEqual(tree(f.d.workspace), terminal, 'semantic read never changes terminal authority');
      }
    }
    f.unchanged(); success = true; return;
  }
  if (scenario.operation !== 'publish') {
    for (const operation of operationOrder.slice(0, operationOrder.indexOf(scenario.operation))) requireSuccess(await step(operation), operation);
  }
  const input = scenario.operation === 'publish' ? null : inputFor(f.d, scenario.operation);
  const holder = owned.start(f.descriptor, 'kill', { operation: scenario.operation }); await holder.begin();
  const marker = await holder.wait(scenario.phase);
  assert.equal(marker.caseId, scenario.id); assert.equal(marker.nativeCompleted, true);
  assert.equal(marker.operationHash, sha(JSON.stringify(input ?? (scenario.route === 'snapshot' ? { approvalRef: 'test-approved' } : { backupId: f.d.oldBackupId }))));
  if (scenario.contenders) {
    const contender = owned.start(f.descriptor, 'contender'); await contender.begin();
    const result = await owned.complete(contender); assert.equal(result.results.length, 3);
  }
  await owned.killAt(holder, scenario.phase);
  f.unchanged();
  const before = saved(f.d), retained = immutableRecords(f.d.workspace), registryBefore = immutableRecords(f.d.registryRoot);
  if (scenario.operation === 'publish') {
    const retry = owned.start(f.descriptor, 'publication-retry'); await retry.begin();
    const result = await owned.complete(retry);
    assert.equal(result.result.ok, scenario.recovery === 'verify-publication');
    if (!result.result.ok) assert.equal(result.result.code, 'RECOVERY_EVIDENCE_MISMATCH');
    assert.deepEqual(immutableRecords(f.d.registryRoot), registryBefore, 'incomplete publications never repaired or removed');
    f.unchanged(); success = true; return;
  }
  assert.ok(before.locator, 'death left original bound run identity');
  if (scenario.phase === 'candidate-publication' && scenario.route !== 'fresh') {
    assert.equal(fs.statSync(before.path).nlink, 1);
    assert.equal(hashFile(before.path), before.locator.stage.sourceEvidence.fileHash);
    assert.equal(fs.readdirSync(before.dir).some(name => name.endsWith('.pending')), false, 'complete publication has no pending second link');
  }
  if (scenario.phase === 'locator-two-links') {
    const locatorFile = fs.readdirSync(join(f.d.workspace, 'requests')).find(name => name.endsWith('.json'));
    assert.equal(fs.statSync(join(f.d.workspace, 'requests', locatorFile)).nlink, 2);
  }
  if (scenario.alias === 'hardlink') fs.linkSync(before.path, join(f.root, 'candidate-alias.sqlite'));
  if (scenario.alias === 'symlink') {
    const original = join(f.root, 'original-candidate.sqlite'); fs.renameSync(before.path, original); fs.symlinkSync(original, before.path);
  }
  const candidateBefore = fs.existsSync(before.path) && !fs.lstatSync(before.path).isSymbolicLink() ? hashFile(before.path) : null;
  const originalFacts = ['C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08', 'C09', 'C10', 'D4', 'D5'].includes(scenario.id) ? actual(before) : null;
  if (scenario.recovery === 'refuse-stage') {
    const workspace = tree(f.d.workspace), registry = tree(f.d.registryRoot);
    const result = await step('stage', { mode: 'retry' });
    assert.equal(result.result.ok, false, 'partial evidence must refuse');
    assert.ok(['RECOVERY_INDETERMINATE', 'RECOVERY_EVIDENCE_MISMATCH'].includes(result.result.code), result.result.code);
    assert.deepEqual(tree(f.d.workspace), workspace); assert.deepEqual(tree(f.d.registryRoot), registry);
    if (result.status?.ok) { assert.equal(result.status.value.state, 'indeterminate'); assert.equal(result.status.value.nextAction, 'MANUAL_RECONCILIATION'); }
  } else if (scenario.recovery === 'reverify') {
    const result = await step('activate', { mode: 'retry', input });
    assert.equal(result.result.ok, false); assert.equal(result.result.code, 'RECOVERY_EVIDENCE_MISMATCH');
    assert.deepEqual(actual(before), originalFacts); assert.equal(hashFile(before.path), candidateBefore);
    const seal = requireSuccess(await step('verify'), 'verify');
    const oldPlan = before.records[before.activationName]; assert.notEqual(seal.sealHash, oldPlan.sealHash);
    const previewInput = { ...inputFor(f.d, 'activation-preview'), sealReference: seal.sealReference, activationRef: 'activation-after-anchor' };
    const preview = requireSuccess(await step('activation-preview', { input: previewInput }), 'activation-preview');
    assert.notEqual(preview.activationPlanHash, before.activationPlanHash);
    // A new explicit approval binding is recorded by the trusted adapter.
    const activation = { runId: before.locator.runId, activationPlanHash: preview.activationPlanHash, activationApprovalRef: 'activate-ok-after-anchor', sealReference: seal.sealReference };
    const completed = await step('activate', { input: activation }); requireSuccess(completed, 'activate');
    assert.ok(completed.approvals.some(a => a.kind === 'activate' && a.planHash === preview.activationPlanHash && a.approvalRef === 'activate-ok-after-anchor'));
    assert.ok(actual(saved(f.d)).floor >= originalFacts.floor);
  } else {
    const operation = scenario.recovery;
    const result = await step(operation, { mode: 'retry', ...(operation === scenario.operation ? { input } : {}), noClock: operation === 'release' });
    const value = requireSuccess(result, operation);
    const after = saved(f.d); assert.deepEqual(after.locator, before.locator, 'original run/locator/timestamps retained');
    if (operation === 'stage') {
      assert.equal(value.runId, before.locator.runId);
      if (marker.preparation) {
        assert.equal(value.initialEpoch, marker.preparation.initial_epoch); assert.equal(value.importEpoch, marker.preparation.import_epoch);
        assert.deepEqual(actual(after).preparations, originalFacts.preparations);
      }
    }
    if (['activate', 'release'].includes(operation)) {
      assert.equal(result.status.ok, true); assert.equal(result.status.value.state, 'active');
      const facts = actual(after); assert.equal(facts.mode, 'paused'); assert.equal(facts.audit.length, 1);
      assert.deepEqual(facts, originalFacts, 'exact retry does not alter DB/audit/epoch/floor/time');
      assert.equal(hashFile(after.path), candidateBefore);
      syncPair(result, '/candidate.sqlite'); syncPair(result, '/activation-complete.json', { newlyPublished: ['C07', 'C08'].includes(scenario.id) });
      if (['C07', 'C08'].includes(scenario.id)) {
        assert.equal(before.records['activation-complete.json'], undefined);
        assert.equal(result.status.value.nextAction, 'RETRY_ACTIVATE');
        assert.equal(result.status.value.releasePlan, null); assert.equal(result.status.value.releasePlanHash, null);
        const run = originalFacts.runs.find(row => row.run_id === before.locator.runId), completion = after.records['activation-complete.json'];
        assert.equal(completion.runId, run.run_id); assert.equal(completion.activationPlanHash, run.activation_plan_hash);
        assert.equal(completion.activationApprovalRef, run.activation_approval_ref); assert.equal(completion.activatedAt, run.activated_at);
        assert.equal(completion.activationRef, run.activation_ref); assert.equal(completion.newEpoch, run.new_epoch);
        assert.equal(completion.recoveryCounter, originalFacts.center.recovery_counter);
      }
      if (operation === 'release') { syncPair(result, `/${value.holdId}.json`); assert.equal(result.clocks, 0); }
      const again = await step(operation, { input, noClock: true }); requireSuccess(again, operation);
      assert.equal(again.clocks, 0); syncPair(again, '/candidate.sqlite'); syncPair(again, '/activation-complete.json');
      assert.deepEqual(actual(after), facts);
    }
    retainFiles(retained, immutableRecords(f.d.workspace), 'immutable workspace records');
    retainFiles(registryBefore, immutableRecords(f.d.registryRoot), 'immutable registry records');
  }
  f.unchanged(); success = true;
});
