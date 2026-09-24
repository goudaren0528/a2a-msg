import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, nativeOptions } from './fixtures/im-migration-process/harness.js';
import { snapshot } from './fixtures/im-migration-process/state.js';

// Strict factory: all services use only createTrustedMigrationServices' public
// options. Observation-harness cases are explicitly labelled: they wrap real
// native SQL calls for barriers, not the registry/verifier/lock or their results.
test('strict factory: publish A -> discover/approve B -> commit C -> exact retry D across real exits', nativeOptions, async t => {
  const f = await fixture(t).approved();
  f.assertEmpty();
  const committed = await f.commit();
  const state = f.assertCompleted(committed);
  f.invariants();
  assert.deepEqual(await f.commit(), committed);
  assert.deepEqual(f.state(), state);
  f.invariants();
  // Both independent approval revocation and exclusive expiry apply to retries.
  await f.commit({ grant: { ...f.grant, active: false } }, 'MIGRATION_APPROVAL_INVALID');
  await f.commit({ now: f.request.package.expiresAt }, 'MIGRATION_APPROVAL_INVALID');
  assert.deepEqual(f.state(), state);
  f.invariants();
  assert.equal(new Set(f.children.map(child => child.child.pid)).size, f.children.length);
});

test('SQL observation harness + strict factory: real revoke/cleanup remain BUSY through actual live COMMIT', nativeOptions, async t => {
  const f = await fixture(t).approved();
  const artifacts = f.artifacts();
  assert.equal(Object.keys(artifacts).length, 2);
  const c = await f.start('commit', { request: f.request, grant: f.grant, observe: 'lock-scope' });
  const before = await c.next('phase');
  assert.equal(before.phase, 'before-live-commit');
  assert.deepEqual(before.evidence, { transaction: true });
  f.assertEmpty(); // separate WAL reader cannot see the uncommitted batch
  for (const operation of ['revoke', 'cleanup']) {
    await f.run(operation, { backupId: f.backupId }, 'REGISTRY_BUSY');
    assert.deepEqual(f.artifacts(), artifacts);
  }
  await c.release(before);
  const after = await c.next('phase');
  assert.equal(after.phase, 'after-live-commit-before-response');
  assert.equal(after.evidence.transaction, false);
  assert.equal(after.evidence.run.status, 'completed');
  assert.equal(f.state().bindings.length, 2); // durable writes visible in another connection
  for (const operation of ['revoke', 'cleanup']) {
    await f.run(operation, { backupId: f.backupId }, 'REGISTRY_BUSY');
    assert.deepEqual(f.artifacts(), artifacts);
  }
  await c.release(after);
  const result = (await c.next('result')).result;
  await c.finish();
  f.assertCompleted(result);
  f.invariants();
  await f.run('revoke', { backupId: f.backupId });
  assert.deepEqual(f.artifacts(), artifacts);
  await f.run('cleanup', { backupId: f.backupId });
  assert.deepEqual(f.artifacts(), {});
  f.invariants();
});

test('strict factory: revoke in an exited process precedes commit and produces zero new migration writes', nativeOptions, async t => {
  const f = await fixture(t).approved();
  await f.run('revoke', { backupId: f.backupId });
  await f.commit({}, 'REGISTRY_REVOKED');
  f.assertEmpty();
  f.invariants();
});

test('SQL observation harness + strict factory: kill after first real binding INSERT before COMMIT, reopen and retry', nativeOptions, async t => {
  const f = await fixture(t).approved();
  const c = await f.start('commit', { request: f.request, grant: f.grant, observe: 'crash-before' });
  const phase = await c.next('phase');
  assert.equal(phase.phase, 'first-binding-inserted');
  assert.deepEqual(phase.evidence, { transaction: true, bindings: 1 });
  f.assertEmpty();
  f.invariants();
  await f.killAtBarrier(c);
  // Every inspection opens/closes a fresh live connection after confirmed exit.
  f.assertEmpty();
  f.invariants();
  f.assertCompleted(await f.commit());
  f.invariants();
});

test('SQL observation harness + strict factory: kill after actual COMMIT before response, fresh exact retry returns saved completion', nativeOptions, async t => {
  const f = await fixture(t).approved();
  const c = await f.start('commit', { request: f.request, grant: f.grant, observe: 'crash-after' });
  const phase = await c.next('phase');
  assert.equal(phase.phase, 'after-live-commit-before-response');
  assert.equal(phase.evidence.transaction, false);
  const expected = { runId: phase.evidence.run.run_id, status: 'completed', bindingCount: 2,
    completedAt: phase.evidence.run.completed_at };
  const completed = f.assertCompleted(expected);
  await f.killAtBarrier(c);
  assert.deepEqual(f.state(), completed);
  f.invariants();
  assert.deepEqual(await f.commit(), expected);
  assert.deepEqual(f.state(), completed);
  f.invariants();
});

test('physical SQL observation harness + strict factory: independent normal IM send completes inside real backup verification', nativeOptions, async t => {
  const f = await fixture(t).approved();
  const c = await f.start('commit', { request: f.request, grant: f.grant, observe: 'physical-verify' });
  const phase = await c.next('phase');
  assert.equal(phase.phase, 'physical-integrity-checked-before-return');
  assert.deepEqual(phase.evidence, { liveTransaction: false, artifactDatabase: true, integrityCheck: ['ok'] });
  const key = randomUUID();
  assert.notEqual(key, f.traffic.baselineKey);
  assert.notEqual(key, f.postBackup.clientMessageId);
  // This writer starts AND exits while the verifier remains blocked at its real
  // artifact integrity query. Success is not inferred from scheduling or sleeps.
  const sent = await f.run('writer', { traffic: f.traffic, clientMessageId: key });
  assert.equal(sent.replayed, false);
  assert.equal(sent.deliveredAt, null);
  assert.equal(sent.readAt, null);
  assert.notEqual(sent.messageId, f.traffic.baselineMessageId);
  const concurrent = f.inspect(snapshot);
  const prior = f.baseline;
  for (const table of Object.keys(prior)) {
    if (table === 'im_receive_state') continue;
    const added = ['im_messages', 'im_send_keys', 'im_deliveries', 'im_audit'].includes(table) ? 1 : 0;
    assert.equal(concurrent[table].length, prior[table].length + added, table);
    for (const row of prior[table]) assert.ok(concurrent[table].includes(row), `preserved ${table} row`);
  }
  const beforeStates = prior.im_receive_state.map(JSON.parse);
  const afterStates = concurrent.im_receive_state.map(JSON.parse);
  assert.equal(afterStates.length, beforeStates.length);
  for (const row of beforeStates) {
    const current = afterStates.find(value => value.agent_id === row.agent_id);
    assert.deepEqual(current, { ...row,
      next_seq: row.next_seq + (row.agent_id === f.traffic.recipientAgentId ? 1 : 0) });
  }
  f.inspect(db => {
    assert.equal(db.prepare('SELECT acked_at FROM im_deliveries WHERE message_id=?').get(sent.messageId).acked_at, null);
    assert.equal(db.prepare('SELECT message_id FROM im_send_keys WHERE client_message_id=?').get(key).message_id, sent.messageId);
  });
  f.assertEmpty();
  await c.release(phase);
  const committed = (await c.next('result')).result;
  await c.finish();
  f.assertCompleted(committed);
  assert.deepEqual(f.inspect(snapshot), concurrent);
  assert.deepEqual(await f.commit(), committed);
  assert.deepEqual(f.inspect(snapshot), concurrent);
});
