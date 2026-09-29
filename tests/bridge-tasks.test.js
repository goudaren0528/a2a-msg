import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createTaskStore } from '../src/bridge/tasks.js';
import { requirementFingerprint } from '../src/bridge/protocol.js';

const senderAgentId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const otherSender = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
test('dedup preserves previous state; changed requirement is a typed conflict', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-tasks-'));
  const store = createTaskStore(join(dir, 'tasks.db'));
  try {
    const input = { senderAgentId, taskId: 'task1', requirementFingerprint: requirementFingerprint('Do A') };
    assert.equal(store.registerTask(input).kind, 'registered');
    store.recordStatus(senderAgentId, 'task1', 'running', 'Working');
    assert.deepEqual(store.registerTask(input), { kind: 'existing', task: store.getTask(senderAgentId, 'task1') });
    assert.equal(store.getTask(senderAgentId, 'task1').status, 'running');
    const conflict = store.registerTask({ ...input, requirementFingerprint: requirementFingerprint('Do B') });
    assert.equal(conflict.kind, 'conflict');
    assert.equal(conflict.task.requirementFingerprint, input.requirementFingerprint);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('submitted outcome unknown survives reopening and terminal tasks are excluded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-tasks-'));
  const path = join(dir, 'tasks.db');
  let store;
  try {
    store = createTaskStore(path);
    store.registerTask({ senderAgentId, taskId: 'task1', requirementFingerprint: requirementFingerprint('Do A') });
    store.markSubmittedOutcomeUnknown(senderAgentId, 'task1');
    store.close(); store = undefined;
    store = createTaskStore(path);
    try {
      assert.equal(store.listSubmittedWithoutOutcome().length, 1);
      assert.equal(store.listSubmittedWithoutOutcome()[0].submittedOutcomeUnknown, true);
      store.recordStatus(senderAgentId, 'task1', 'completed', 'Done');
      assert.deepEqual(store.listSubmittedWithoutOutcome(), []);
    } finally { store.close(); store = undefined; }
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('same taskId from different authenticated senders has independent state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-tasks-'));
  const store = createTaskStore(join(dir, 'tasks.db'));
  try {
    const task = { taskId: 'shared', requirementFingerprint: requirementFingerprint('Do A'), projectKey: 'projectA' };
    assert.equal(store.registerTask({ ...task, senderAgentId }).kind, 'registered');
    assert.equal(store.registerTask({ ...task, senderAgentId: otherSender }).kind, 'registered');
    store.recordStatus(senderAgentId, 'shared', 'running', 'Working');
    assert.equal(store.getTask(otherSender, 'shared').status, 'accepted');
    assert.equal(store.listUnfinishedByProject('projectA').length, 2);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('session and project occupancy survive reopening, including uncertain failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-tasks-'));
  const path = join(dir, 'tasks.db');
  let store;
  try {
    store = createTaskStore(path);
    const add = (taskId, projectKey = 'projectA') => store.registerTask({
      senderAgentId, taskId, projectKey, requirementFingerprint: requirementFingerprint(taskId),
    });
    add('approval');
    add('uncertain');
    add('complete');
    add('confirmedFailure');
    add('elsewhere', 'projectB');
    assert.equal(store.setSessionID(senderAgentId, 'approval', 'ses_123').sessionID, 'ses_123');
    store.recordStatus(senderAgentId, 'approval', 'needs_approval', 'Waiting');
    store.markSubmittedOutcomeUnknown(senderAgentId, 'uncertain');
    store.recordStatus(senderAgentId, 'uncertain', 'failed', 'Remote outcome not known');
    store.recordStatus(senderAgentId, 'complete', 'completed', 'Done');
    store.markSubmittedOutcomeUnknown(senderAgentId, 'confirmedFailure');
    store.recordStatus(senderAgentId, 'confirmedFailure', 'failed', 'Remote reported failure',
      { outcomeConfirmed: true });
    store.close(); store = undefined;
    store = createTaskStore(path);
    assert.equal(store.getTask(senderAgentId, 'approval').sessionID, 'ses_123');
    assert.equal(store.getTask(senderAgentId, 'approval').projectKey, 'projectA');
    assert.equal(store.getTask(senderAgentId, 'uncertain').outcomeConfirmed, false);
    assert.equal(store.getTask(senderAgentId, 'confirmedFailure').outcomeConfirmed, true);
    assert.deepEqual(store.listUnfinishedByProject('projectA').map(task => task.taskId),
      ['approval', 'uncertain']);
    assert.deepEqual(store.listUnfinishedByProject('projectB').map(task => task.taskId), ['elsewhere']);
    assert.deepEqual(store.listUnfinishedByProject('projectC'), []);
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('opens and adds columns to a database with the previous schema', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-tasks-'));
  const path = join(dir, 'tasks.db');
  let store;
  try {
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE bridge_tasks (
      sender_agent_id TEXT NOT NULL, task_id TEXT NOT NULL, requirement_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('accepted','running','needs_approval','completed','failed')),
      summary TEXT NOT NULL, submitted_outcome_unknown INTEGER NOT NULL DEFAULT 0
        CHECK(submitted_outcome_unknown IN (0,1)), PRIMARY KEY(sender_agent_id,task_id)
    )`);
    db.prepare(`INSERT INTO bridge_tasks
      (sender_agent_id,task_id,requirement_fingerprint,status,summary,submitted_outcome_unknown)
      VALUES (?,? ,?,'failed','Uncertain',1)`).run(senderAgentId, 'old', requirementFingerprint('old'));
    db.prepare(`INSERT INTO bridge_tasks
      (sender_agent_id,task_id,requirement_fingerprint,status,summary)
      VALUES (?,?,?,'completed','Done')`).run(senderAgentId, 'oldDone', requirementFingerprint('oldDone'));
    db.prepare(`INSERT INTO bridge_tasks
      (sender_agent_id,task_id,requirement_fingerprint,status,summary)
      VALUES (?,?,?,'needs_approval','Waiting')`).run(senderAgentId, 'oldWaiting', requirementFingerprint('oldWaiting'));
    db.close();
    store = createTaskStore(path);
    assert.equal(store.getTask(senderAgentId, 'old').outcomeConfirmed, false);
    assert.equal(store.getTask(senderAgentId, 'old').projectKey, null);
    assert.equal(store.setSessionID(senderAgentId, 'old', 'ses_old').sessionID, 'ses_old');
    store.registerTask({ senderAgentId, taskId: 'new', projectKey: 'projectA',
      requirementFingerprint: requirementFingerprint('new') });
    assert.deepEqual(store.listUnfinishedByProject('projectA').map(task => task.taskId), ['new']);
    assert.deepEqual(store.listUnassociatedUnfinished().map(task => task.taskId), ['old', 'oldWaiting']);
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('an unconfirmed failure can be corrected to a confirmed completion, but not implicitly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-tasks-'));
  const store = createTaskStore(join(dir, 'tasks.db'));
  try {
    const add = taskId => store.registerTask({ senderAgentId, taskId, projectKey: 'projectA',
      requirementFingerprint: requirementFingerprint(taskId) });
    add('corrected');
    add('stillUnconfirmed');
    for (const taskId of ['corrected', 'stillUnconfirmed']) {
      store.markSubmittedOutcomeUnknown(senderAgentId, taskId);
      store.recordStatus(senderAgentId, taskId, 'failed', 'Unknown result');
    }
    assert.equal(store.recordStatus(senderAgentId, 'stillUnconfirmed', 'failed', 'Better reason').outcomeConfirmed, false);
    assert.throws(() => store.recordStatus(senderAgentId, 'stillUnconfirmed', 'completed', 'Done'));
    assert.equal(store.getTask(senderAgentId, 'stillUnconfirmed').status, 'failed');
    const corrected = store.recordStatus(senderAgentId, 'corrected', 'completed', 'Remote finished',
      { outcomeConfirmed: true });
    assert.equal(corrected.status, 'completed');
    assert.equal(corrected.outcomeConfirmed, true);
    assert.deepEqual(store.listUnfinishedByProject('projectA').map(task => task.taskId), ['stillUnconfirmed']);
    assert.equal(store.recordStatus(senderAgentId, 'stillUnconfirmed', 'failed', 'Confirmed reason',
      { outcomeConfirmed: true }).outcomeConfirmed, true);
    assert.deepEqual(store.listUnfinishedByProject('projectA'), []);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('confirmed terminal outcomes cannot change, but needs_approval can resolve', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-tasks-'));
  const store = createTaskStore(join(dir, 'tasks.db'));
  try {
    const add = taskId => store.registerTask({ senderAgentId, taskId, projectKey: 'projectA',
      requirementFingerprint: requirementFingerprint(taskId) });
    for (const taskId of ['complete', 'failed', 'approval']) add(taskId);
    const complete = store.recordStatus(senderAgentId, 'complete', 'completed', 'Done');
    const failed = store.recordStatus(senderAgentId, 'failed', 'failed', 'Confirmed failure');
    store.recordStatus(senderAgentId, 'approval', 'needs_approval', 'Waiting');
    assert.deepEqual(store.listUnfinishedByProject('projectA').map(task => task.taskId), ['approval']);
    assert.throws(() => store.recordStatus(senderAgentId, 'complete', 'failed', 'Incorrect'));
    assert.throws(() => store.recordStatus(senderAgentId, 'failed', 'completed', 'Incorrect',
      { outcomeConfirmed: true }));
    assert.deepEqual(store.getTask(senderAgentId, 'complete'), complete);
    assert.deepEqual(store.getTask(senderAgentId, 'failed'), failed);
    const resolved = store.recordStatus(senderAgentId, 'approval', 'completed', 'Approved and done',
      { outcomeConfirmed: true });
    assert.equal(resolved.outcomeConfirmed, true);
    assert.deepEqual(store.listUnfinishedByProject('projectA'), []);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
