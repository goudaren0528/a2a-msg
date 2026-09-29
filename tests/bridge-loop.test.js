import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridgeConfig } from '../src/bridge/config.js';
import { createTaskStore } from '../src/bridge/tasks.js';
import { createBridge } from '../src/bridge/bridge.js';

const sender = randomUUID(), other = randomUUID(), bridgeId = randomUUID();
function setup(t, runTask = async () => ({ status: 'completed', summary: 'done' })) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-loop-'));
  const config = createBridgeConfig({ agentId: bridgeId, serverUrl: 'https://localhost:1234',
    credentialFile: join(root, 'credential'), journalPath: join(root, 'journal'), statePath: join(root, 'tasks'),
    allowedSenders: [sender], projects: [{ projectKey: 'alpha', directory: root, description: 'Alpha' },
      { projectKey: 'beta', directory: join(root, 'beta'), description: 'Beta' }] });
  const tasks = createTaskStore(config.statePath);
  t.after(() => { tasks.close(); rmSync(root, { recursive: true, force: true }); });
  const incoming = [], sent = [], calls = [];
  const runner = { async runTask(input) { calls.push(input); return runTask(input); },
    replyPermission() { throw Error('must never auto approve'); } };
  const imClient = { renewLease: async () => ({ expiresAt: 1000000 }), ackPending: async () => ({}), receiveOnce: async () => ({ items: incoming.splice(0).map(message => ({ message })) }),
    ensureConversation: async () => ({ conversationId: randomUUID() }),
    send: async request => { sent.push({ request, body: JSON.parse(request.text) }); } };
  const bridge = createBridge({ config, tasks, runner, imClient, clock: () => 100 });
  const put = (body, from = sender) => incoming.push({ senderAgentId: from, conversationId: randomUUID(),
    messageId: randomUUID(), text: typeof body === 'string' ? body : JSON.stringify(body) });
  return { config, tasks, bridge, incoming, sent, calls, put, imClient, runner };
}
const task = (taskId = 'Task1', requirement = 'Update docs', projectKey = 'alpha') => ({ taskId, requirement, projectKey });

test('unauthorized sender denied, unknown project rejected with only visible projects', async t => {
  const x = setup(t);
  x.put(task(), other); x.put(task('Task2', 'Update docs', 'hidden'));
  await x.bridge.processOnce();
  assert.deepEqual(x.sent.map(s => s.body.status), ['failed', 'failed']);
  assert.equal(x.sent[0].body.summary, 'UNKNOWN_SENDER');
  assert.equal(x.sent[0].body.projects, undefined);
  assert.deepEqual(x.sent[1].body.projects, [{ projectKey: 'alpha', description: 'Alpha' }, { projectKey: 'beta', description: 'Beta' }]);
  assert.equal(x.calls.length, 0);
});

test('project listing does not disclose directories and malformed payload does not break loop', async t => {
  const x = setup(t);
  x.put('{broken'); x.put({ type: 'project_list' });
  await x.bridge.processOnce();
  assert.deepEqual(x.sent.map(s => s.body), [{ projects: [{ projectKey: 'alpha', description: 'Alpha' },
    { projectKey: 'beta', description: 'Beta' }] }]);
  assert.ok(!JSON.stringify(x.sent).includes(x.config.statePath));
});

test('duplicate same requirement returns stored result; conflict refuses execution', async t => {
  const x = setup(t);
  x.put(task()); await x.bridge.processOnce();
  x.put(task()); x.put(task('Task1', 'different requirement')); await x.bridge.processOnce();
  assert.equal(x.calls.length, 1);
  assert.deepEqual(x.sent.map(s => s.body.status), ['accepted', 'running', 'completed', 'completed', 'failed']);
  assert.equal(x.tasks.getTask(sender, 'Task1').status, 'completed');
  assert.match(x.sent.at(-1).body.summary, /冲突/);
});

test('approval requests are reported and never approved automatically', async t => {
  const x = setup(t, async () => ({ status: 'needs_approval', sessionID: 'session-123',
    pendingPermissions: [{ action: 'bash', requestID: 'x' }] }));
  x.put(task()); await x.bridge.processOnce();
  assert.equal(x.sent.at(-1).body.status, 'needs_approval');
  assert.match(x.sent.at(-1).body.summary, /bash/);
  assert.match(x.sent.at(-1).body.summary, /session-123/);
});

test('read-only inspection confirms approval completed and releases project without resubmitting', async t => {
  const x = setup(t, async input => input.requirement === 'Update docs' ?
    { status: 'needs_approval', sessionID: 'approved-session', pendingPermissions: [{ action: 'shell', requestID: 'p' }] } :
    { status: 'completed', summary: 'Second task completed' });
  x.put(task()); await x.bridge.processOnce();
  let inspected = 0;
  x.runner.inspectSession = async input => {
    inspected++;
    assert.equal(input.sessionID, 'approved-session');
    return { status: 'completed', summary: 'Approved task finished safely' };
  };
  const previous = x.incoming[0] ?? { senderAgentId: sender, conversationId: randomUUID(),
    messageId: randomUUID(), text: JSON.stringify(task()) };
  x.imClient.listReceived = async () => [{ message: previous }];
  x.put(task('Following', 'Second requirement'));
  await x.bridge.processOnce();
  assert.ok(inspected > 0);
  assert.equal(x.calls.filter(call => call.requirement === 'Update docs').length, 1);
  assert.equal(x.calls.length, 2);
  assert.equal(x.tasks.getTask(sender, 'Task1').status, 'completed');
  assert.equal(x.tasks.getTask(sender, 'Following').status, 'completed');
  assert.match(x.sent.find(s => s.body.taskId === 'Task1' && s.body.status === 'completed').body.summary, /Approved task finished safely/);
});

test('session is durably recorded before prompt and recording failure prevents submission', async t => {
  const x = setup(t);
  x.runner.runTask = async input => {
    assert.equal(x.tasks.getTask(sender, 'Task1').sessionID, null);
    await input.onSessionCreated('early-session');
    assert.equal(x.tasks.getTask(sender, 'Task1').sessionID, 'early-session');
    x.calls.push(input);
    return { status: 'completed', sessionID: 'early-session', summary: 'done' };
  };
  x.put(task()); await x.bridge.processOnce();
  assert.equal(x.calls.length, 1);
  const y = setup(t);
  const store = { ...y.tasks, setSessionID() { throw Error('disk unavailable'); } };
  let prompted = false;
  y.runner.runTask = async input => {
    try { await input.onSessionCreated('not-recorded'); }
    catch { return { status: 'session_record_error', sessionID: 'not-recorded' }; }
    prompted = true;
    return { status: 'completed' };
  };
  const bridge = createBridge({ config: y.config, tasks: store, runner: y.runner, imClient: y.imClient, clock: () => 100 });
  y.put(task()); await bridge.processOnce();
  assert.equal(prompted, false);
  assert.match(y.sent.at(-1).body.summary, /未提交/);
});

test('running but never submitted is rescheduled from matching durable receipt', async t => {
  const x = setup(t);
  const { requirementFingerprint } = await import('../src/bridge/protocol.js');
  x.tasks.registerTask({ senderAgentId: sender, taskId: 'Task1', projectKey: 'alpha',
    requirementFingerprint: requirementFingerprint('Update docs') });
  x.tasks.recordStatus(sender, 'Task1', 'running', 'Pre-submit crash');
  x.imClient.listReceived = async () => [{ message: { senderAgentId: sender, conversationId: randomUUID(),
    messageId: randomUUID(), text: JSON.stringify(task()) } }];
  await x.bridge.processOnce();
  assert.equal(x.calls.length, 1);
  assert.equal(x.tasks.getTask(sender, 'Task1').status, 'completed');
});

test('receipt identity mismatch cannot execute previously accepted task', async t => {
  const x = setup(t);
  x.tasks.registerTask({ senderAgentId: sender, taskId: 'Task1', projectKey: 'alpha',
    requirementFingerprint: 'a'.repeat(64) });
  x.imClient.listReceived = async () => [{ message: { senderAgentId: sender, conversationId: randomUUID(),
    messageId: randomUUID(), text: JSON.stringify(task()) } }];
  await x.bridge.processOnce();
  assert.equal(x.calls.length, 0);
  assert.match(x.sent.at(-1).body.summary, /冲突/);
});

test('unassociated legacy task blocks optimistic new work', async t => {
  const x = setup(t);
  x.tasks.registerTask({ senderAgentId: sender, taskId: 'Legacy', requirementFingerprint: 'a'.repeat(64) });
  x.tasks.markSubmittedOutcomeUnknown(sender, 'Legacy');
  x.put(task()); await x.bridge.processOnce();
  assert.equal(x.calls.length, 0);
  assert.equal(x.sent.at(-1).body.status, 'failed');
  assert.match(x.sent.at(-1).body.summary, /Legacy/);
});

test('operator attestation resolves unassociated legacy blocker without silently clearing it', async t => {
  const x = setup(t);
  x.tasks.registerTask({ senderAgentId: sender, taskId: 'Legacy', requirementFingerprint: 'a'.repeat(64) });
  x.tasks.markSubmittedOutcomeUnknown(sender, 'Legacy');
  x.put(task('Before')); await x.bridge.processOnce();
  assert.equal(x.calls.length, 0);
  await assert.rejects(x.bridge.resolveBlockedTask({ senderAgentId: sender, taskId: 'Legacy' }), /evidence/i);
  assert.equal(x.tasks.getTask(sender, 'Legacy').outcomeConfirmed, false);
  await x.bridge.resolveBlockedTask({ senderAgentId: sender, taskId: 'Legacy', evidence: 'Verified remote session stopped out of band' });
  assert.equal(x.tasks.listUnassociatedUnfinished().length, 0);
  x.put(task('After')); await x.bridge.processOnce();
  assert.equal(x.calls.length, 1);
  assert.equal(x.tasks.getTask(sender, 'After').status, 'completed');
});

test('session creation transport failure before session ID confirms non-submission and releases project', async t => {
  const x = setup(t, async input => input.requirement === 'Update docs' ?
    { status: 'transport_error', reason: 'OpenCode service unavailable' } : { status: 'completed' });
  x.put(task()); await x.bridge.processOnce();
  assert.equal(x.tasks.getTask(sender, 'Task1').outcomeConfirmed, true);
  assert.match(x.tasks.getTask(sender, 'Task1').summary, /未提交/);
  x.put(task('Next', 'Other work')); await x.bridge.processOnce();
  assert.equal(x.calls.length, 2);
  assert.equal(x.tasks.getTask(sender, 'Next').status, 'completed');
});

test('confirmed interruption releases project without repeated remote inspection', async t => {
  const x = setup(t, async input => input.requirement === 'Update docs' ?
    { status: 'failed', sessionID: 'interrupted-session', reason: 'OpenCode run interrupted', summary: 'Stopped' } :
    { status: 'completed' });
  x.put(task()); await x.bridge.processOnce();
  assert.equal(x.tasks.getTask(sender, 'Task1').outcomeConfirmed, true);
  let inspected = 0;
  x.runner.inspectSession = async () => { inspected++; return { status: 'failed', reason: 'OpenCode run interrupted' }; };
  x.imClient.listReceived = async () => [{ message: { senderAgentId: sender, conversationId: randomUUID(),
    messageId: randomUUID(), text: JSON.stringify(task()) } }];
  x.put(task('Next', 'Other work')); await x.bridge.processOnce();
  assert.equal(inspected, 0);
  assert.equal(x.calls.length, 2);
});

test('fence lost during running reply aborts before runner posts a prompt', async t => {
  const x = setup(t);
  let renewals = 0, posted = false;
  x.imClient.renewLease = async () => {
    if (++renewals >= 2) throw Object.assign(Error('fence lost'), { code: 'LEASE_CONFLICT' });
    return { expiresAt: 1000000 };
  };
  x.imClient.acquire = async () => { throw Object.assign(Error('another receiver owns lease'), { code: 'LEASE_CONFLICT' }); };
  x.runner.runTask = async input => {
    try { await input.onSessionCreated('created-before-prompt'); }
    catch { return { status: 'session_record_error', sessionID: 'created-before-prompt' }; }
    posted = true;
    return { status: 'completed' };
  };
  x.put(task()); await x.bridge.processOnce();
  assert.equal(posted, false);
  assert.equal(x.tasks.getTask(sender, 'Task1').outcomeConfirmed, true);
  assert.match(x.tasks.getTask(sender, 'Task1').summary, /未提交/);
});

test('failed lease renewal and reacquire prevent scheduling until fence is restored', async t => {
  const x = setup(t);
  x.imClient.renewLease = async () => { throw Object.assign(Error('expired'), { code: 'LEASE_EXPIRED' }); };
  x.imClient.acquire = async () => { throw Object.assign(Error('held elsewhere'), { code: 'LEASE_CONFLICT' }); };
  x.imClient.listReceived = async () => [{ message: { senderAgentId: sender, conversationId: randomUUID(),
    messageId: randomUUID(), text: JSON.stringify(task()) } }];
  await assert.rejects(x.bridge.processOnce(), /held elsewhere/);
  assert.equal(x.calls.length, 0);
  x.imClient.acquire = async () => ({ expiresAt: 1000000 });
  await x.bridge.processOnce();
  assert.equal(x.calls.length, 1);
});

test('runner receives exact project ruleset; same project blocked after approval, different project runs', async t => {
  const x = setup(t, async input => input.directory === x.config.resolveProject(sender, 'alpha').directory ?
    { status: 'needs_approval', sessionID: 'session-approval', pendingPermissions: [{ action: 'shell', requestID: 'p' }] } :
    { status: 'completed' });
  x.put(task()); await x.bridge.processOnce();
  assert.deepEqual(x.calls[0].permissions, x.config.resolveProject(sender, 'alpha').permissions);
  assert.equal(x.tasks.getTask(sender, 'Task1').sessionID, 'session-approval');
  x.put(task('Blocked')); x.put(task('Other', 'Do other work', 'beta')); await x.bridge.processOnce();
  assert.equal(x.calls.length, 2);
  assert.deepEqual(x.calls[1].permissions, x.config.resolveProject(sender, 'beta').permissions);
  assert.equal(x.sent.find(s => s.body.taskId === 'Blocked').body.status, 'failed');
  assert.match(x.sent.find(s => s.body.taskId === 'Blocked').body.summary, /未完成\/待确认任务 Task1/);
  assert.equal(x.sent.find(s => s.body.taskId === 'Other' && s.body.status === 'completed').body.status, 'completed');
});

test('restart reconstructs occupied project and session association from task store', async t => {
  const x = setup(t, async () => ({ status: 'transport_error', sessionID: 'session-restart' }));
  x.put(task());
  const received = x.incoming[0];
  await x.bridge.processOnce();
  assert.equal(x.tasks.getTask(sender, 'Task1').sessionID, 'session-restart');
  const restarted = createBridge({ config: x.config, tasks: x.tasks, runner: x.runner, imClient: x.imClient, clock: () => 100 });
  await restarted.recoverOnRestart();
  x.put(task('AfterRestart'));
  await restarted.processOnce();
  assert.equal(x.calls.length, 1);
  assert.equal(x.sent.at(-1).body.status, 'failed');
  assert.match(x.sent.at(-1).body.summary, /未完成\/待确认任务 Task1/);
});

test('expired lease re-acquires and subsequent polls keep receiving', async t => {
  const x = setup(t);
  let acquired = 0;
  x.imClient.renewLease = async () => {
    if (!acquired) throw Object.assign(Error('expired'), { code: 'LEASE_EXPIRED' });
    return { expiresAt: 1000000 };
  };
  x.imClient.acquire = async () => { acquired++; return { expiresAt: 1000000 }; };
  x.put(task()); await x.bridge.processOnce();
  x.put(task('Next')); await x.bridge.processOnce();
  assert.equal(acquired, 1);
  assert.equal(x.calls.length, 2);
});

test('accepted and running send failures do not wedge the same-project queue', async t => {
  const x = setup(t);
  const send = x.imClient.send;
  x.imClient.send = async request => {
    if (['accepted', 'running'].includes(JSON.parse(request.text)?.status)) throw Error('IM unavailable');
    return send(request);
  };
  x.put(task('First')); x.put(task('Second'));
  await x.bridge.processOnce();
  assert.equal(x.calls.length, 2);
  assert.deepEqual(x.sent.map(s => s.body.status), ['completed', 'completed']);
});

test('terminal reply send failure retries original clientMessageId without another execution', async t => {
  const x = setup(t);
  const original = x.imClient.send;
  const terminalIDs = [];
  let failed = false;
  x.imClient.send = async request => {
    if (JSON.parse(request.text)?.status === 'completed') {
      terminalIDs.push(request.clientMessageId);
      if (!failed) { failed = true; throw Error('IM unavailable'); }
    }
    return original(request);
  };
  const message = { senderAgentId: sender, conversationId: randomUUID(), messageId: randomUUID(), text: JSON.stringify(task()) };
  x.imClient.listReceived = async () => [{ message }];
  x.incoming.push(message);
  await x.bridge.processOnce();
  assert.equal(x.calls.length, 1);
  assert.equal(x.sent.filter(s => s.body.status === 'completed').length, 1);
  assert.deepEqual(terminalIDs, [terminalIDs[0], terminalIDs[0]]);
  assert.match(terminalIDs[0], /^[a-f0-9-]{36}$/);
});

test('runtime reconciliation processes ACKed receipt without task row once and never reruns completed task', async t => {
  const x = setup(t);
  const message = { senderAgentId: sender, conversationId: randomUUID(), messageId: randomUUID(), text: JSON.stringify(task()) };
  x.imClient.listReceived = async () => [{ message }];
  await x.bridge.processOnce();
  assert.equal(x.tasks.getTask(sender, 'Task1').status, 'completed');
  await x.bridge.processOnce();
  assert.equal(x.calls.length, 1);
});

test('restart handles unconfirmed old submission before new receipts; only other project executes', async t => {
  const x = setup(t);
  x.tasks.registerTask({ senderAgentId: sender, taskId: 'Prior', projectKey: 'alpha',
    requirementFingerprint: 'a'.repeat(64) });
  x.tasks.markSubmittedOutcomeUnknown(sender, 'Prior');
  x.imClient.listReceived = async () => [
    { message: { senderAgentId: sender, conversationId: randomUUID(), messageId: randomUUID(), text: JSON.stringify(task('Blocked')) } },
    { message: { senderAgentId: sender, conversationId: randomUUID(), messageId: randomUUID(), text: JSON.stringify(task('Other', 'Other work', 'beta')) } }];
  await x.bridge.recoverOnRestart();
  assert.equal(x.calls.length, 1);
  assert.equal(x.tasks.getTask(sender, 'Blocked').status, 'failed');
  assert.match(x.tasks.getTask(sender, 'Blocked').summary, /Prior/);
  assert.equal(x.tasks.getTask(sender, 'Other').status, 'completed');
  assert.equal(x.tasks.getTask(sender, 'Prior').outcomeConfirmed, false);
});

test('completion includes sanitized assistant result but not configured credentials', async t => {
  const x = setup(t, async () => ({ status: 'completed', sessionID: 'session-summary',
    summary: 'Updated token parser; 12 tests passed\nIM credential: actual-im-secret\nBasic: b3BlbmNvZGU6cGFzc3dvcmQ=' }));
  const bridge = createBridge({ config: x.config, tasks: x.tasks, runner: x.runner, imClient: x.imClient,
    clock: () => 100, secrets: ['actual-im-secret', 'password', 'b3BlbmNvZGU6cGFzc3dvcmQ='] });
  x.put(task()); await bridge.processOnce();
  const summary = x.sent.at(-1).body.summary;
  assert.match(summary, /Updated token parser; 12 tests passed/);
  assert.match(summary, /session-summary/);
  assert.doesNotMatch(summary, /actual-im-secret|b3BlbmNvZGU6cGFzc3dvcmQ=/);
});

test('project with no resolvable ruleset fails closed', async t => {
  const x = setup(t);
  const bridge = createBridge({ config: { ...x.config, resolveProject: () => ({ ok: true, directory: x.config.resolveProject(sender, 'alpha').directory }) },
    tasks: x.tasks, runner: x.runner, imClient: x.imClient, clock: () => 100 });
  x.put(task()); await bridge.processOnce();
  assert.equal(x.calls.length, 0);
  assert.equal(x.sent.at(-1).body.status, 'failed');
  assert.match(x.sent.at(-1).body.summary, /缺少安全权限规则/);
});

test('unknown result reports failure and explicitly unconfirmed outcome, not approval', async t => {
  const x = setup(t, async () => ({ status: 'unknown', reason: 'unconfirmed', sessionID: 'idle-session-1' }));
  x.put(task()); await x.bridge.processOnce();
  assert.equal(x.sent.at(-1).body.status, 'failed');
  assert.notEqual(x.sent.at(-1).body.status, 'needs_approval');
  assert.match(x.sent.at(-1).body.summary, /状态未知/);
  assert.match(x.sent.at(-1).body.summary, /执行结果无法确认/);
  assert.match(x.sent.at(-1).body.summary, /idle-session-1/);
  assert.equal(x.tasks.getTask(sender, 'Task1').status, 'failed');
  assert.equal(x.tasks.getTask(sender, 'Task1').submittedOutcomeUnknown, true);
});

test('runner transport failure reports failed with actionable category and HTTP status', async t => {
  const x = setup(t, async () => ({ status: 'transport_error', sessionID: 'session-transport', httpStatus: 503 }));
  x.put(task()); await x.bridge.processOnce();
  assert.equal(x.sent.at(-1).body.status, 'failed');
  assert.match(x.sent.at(-1).body.summary, /传输失败.*执行结果无法确认/);
  assert.match(x.sent.at(-1).body.summary, /HTTP 503/);
  assert.match(x.sent.at(-1).body.summary, /session-transport/);
  x.put(task('AfterTransport')); await x.bridge.processOnce();
  assert.equal(x.calls.length, 1);
  assert.equal(x.sent.at(-1).body.status, 'failed');
  assert.match(x.sent.at(-1).body.summary, /未完成\/待确认任务 Task1/);
});

test('runner transport exception is not silently treated as approval', async t => {
  const x = setup(t, async () => { const error = new Error('secret must not escape');
    error.name = 'OpenCodeTransportError'; throw error; });
  x.put(task()); await x.bridge.processOnce();
  assert.equal(x.sent.at(-1).body.status, 'failed');
  assert.match(x.sent.at(-1).body.summary, /传输异常.*执行结果无法确认/);
  assert.doesNotMatch(JSON.stringify(x.sent), /secret must not escape/);
});

test('approval without actual pending request reports failed rather than needs_approval', async t => {
  const x = setup(t, async () => ({ status: 'needs_approval', pendingPermissions: [] }));
  x.put(task()); await x.bridge.processOnce();
  assert.equal(x.sent.at(-1).body.status, 'failed');
  assert.match(x.sent.at(-1).body.summary, /未提供待批准权限请求/);
});

test('same project tasks execute serially', async t => {
  let active = 0, max = 0;
  const x = setup(t, async () => { active++; max = Math.max(max, active);
    await new Promise(done => setTimeout(done, 10)); active--; return { status: 'completed' }; });
  x.put(task('First')); x.put(task('Second'));
  await x.bridge.processOnce();
  assert.equal(max, 1);
  assert.equal(x.calls.length, 2);
  assert.deepEqual(x.sent.filter(s => s.body.status === 'completed').map(s => s.body.taskId), ['First', 'Second']);
});

test('restart recovery reports interrupted task and does not resubmit', async t => {
  const x = setup(t);
  x.tasks.registerTask({ senderAgentId: sender, taskId: 'Task1', requirementFingerprint: 'a'.repeat(64) });
  x.tasks.markSubmittedOutcomeUnknown(sender, 'Task1');
  await x.bridge.recoverOnRestart();
  assert.equal(x.calls.length, 0);
  assert.equal(x.sent.at(-1).body.status, 'failed');
  assert.match(x.sent.at(-1).body.summary, /状态未知/);
  assert.equal(x.tasks.getTask(sender, 'Task1').status, 'failed');
});

test('duplicate of previously submitted but unconfirmed accepted task is failed, never accepted again', async t => {
  const x = setup(t);
  const { requirementFingerprint } = await import('../src/bridge/protocol.js');
  x.tasks.registerTask({ senderAgentId: sender, taskId: 'Task1',
    requirementFingerprint: requirementFingerprint('Update docs') });
  x.tasks.markSubmittedOutcomeUnknown(sender, 'Task1');
  x.put(task()); await x.bridge.processOnce();
  assert.equal(x.calls.length, 0);
  assert.equal(x.sent.at(-1).body.status, 'failed');
  assert.match(x.sent.at(-1).body.summary, /结果无法确认/);
});
