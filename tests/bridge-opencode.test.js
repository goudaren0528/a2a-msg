import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createOpenCodeRunner, discoverService, OpenCodeDiscoveryError } from '../src/bridge/opencode.js';

function fakeService({ outcome = 'succeeded', pending = [], messages = [], sessionID = 'ses_test', failAt, notFoundAt, wire = value => value, overrides = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname;
    calls.push({ path, ...options, data: options.body && JSON.parse(options.body) });
    if (path === failAt) throw new Error('connection lost');
    if (path === notFoundAt) return { ok: false, status: 404 };
    let value;
    if (path === '/api/session' && options.method === 'POST') value = { id: sessionID };
    else if (path === `/api/session/${sessionID}`) value = outcome === null ? { id: sessionID } : { id: sessionID, outcome };
    else if (path === `/api/session/${sessionID}/permission`) value = pending;
    else if (path === `/api/session/${sessionID}/message`) value = messages;
    else if (path.endsWith('/reply')) return { ok: true, status: 204 };
    else value = { id: 'inbox_record' };
    if (Object.hasOwn(overrides, path)) value = overrides[path];
    return { ok: true, status: 200, json: async () => wire(value) };
  };
  return { calls, runner: createOpenCodeRunner({ baseUrl: 'http://localhost:1234', fetchImpl }) };
}

const task = { directory: 'D:/allowed-project', requirement: 'Fix the failing tests' };
const assistant = (text) => ({ info: { role: 'assistant' }, parts: [{ type: 'text', text }] });
const realAssistant = (text) => ({ type: 'assistant', content: [{ type: 'text', text }] });

test('real enveloped session, outcome and message wire shapes produce last assistant summary', async () => {
  const { runner } = fakeService({ wire: data => ({ data, meta: {} }), messages: [realAssistant('Earlier'),
    { type: 'user', content: [{ type: 'text', text: 'Prompt' }] }, realAssistant('Real final answer')] });
  const result = await runner.runTask(task);
  assert.equal(result.status, 'completed');
  assert.equal(result.sessionID, 'ses_test');
  assert.equal(result.summary, 'Real final answer');
});

test('real enveloped permissions and messages remain actionable in run and inspection', async () => {
  const pending = [{ id: 'per_real', action: 'bash', resources: ['command'] }];
  const options = { wire: data => ({ data }), pending, messages: [realAssistant('Approval needed')] };
  for (const inspect of [false, true]) {
    const { runner } = fakeService(options);
    const result = inspect ? await runner.inspectSession({ sessionID: 'ses_test', directory: task.directory }) : await runner.runTask(task);
    assert.equal(result.status, 'needs_approval');
    assert.equal(result.summary, 'Approval needed');
    assert.deepEqual(result.pendingPermissions, [{ requestID: 'per_real', action: 'bash', resources: ['command'] }]);
  }
});

test('inspection reads real enveloped session outcome and last assistant message', async () => {
  const { runner } = fakeService({ wire: data => ({ data }), messages: [realAssistant('First'), realAssistant('Final')] });
  const result = await runner.inspectSession({ sessionID: 'ses_test', directory: task.directory });
  assert.equal(result.status, 'completed');
  assert.equal(result.summary, 'Final');
});

test('real paginated messages skip contentless idle and user entries in run and inspection', async () => {
  const messages = { data: [{ type: 'idle' }, realAssistant('Actual answer'), { type: 'user' }], cursor: {} };
  for (const inspect of [false, true]) {
    const { runner } = fakeService({ messages });
    const result = inspect ? await runner.inspectSession({ sessionID: 'ses_test', directory: task.directory }) : await runner.runTask(task);
    assert.equal(result.status, 'completed');
    assert.equal(result.summary, 'Actual answer');
  }
});

test('non-assistant messages and empty assistant text produce no summary without error', async () => {
  for (const messages of [
    { data: [{ type: 'idle' }, { type: 'user' }], cursor: {} },
    { data: [{ type: 'assistant', content: [{ type: 'text', text: '   ' }] }, { type: 'user' }], cursor: {} },
  ]) {
    for (const inspect of [false, true]) {
      const { runner } = fakeService({ messages });
      const result = inspect ? await runner.inspectSession({ sessionID: 'ses_test', directory: task.directory }) : await runner.runTask(task);
      assert.equal(result.status, 'completed');
      assert.equal(Object.hasOwn(result, 'summary'), false);
    }
  }
});

test('malformed message list bodies remain typed transport failures', async () => {
  for (const messages of [{ data: 'not an array', cursor: {} }, 'not an object or array', 42, null, { unexpected: [] }]) {
    for (const inspect of [false, true]) {
      const { runner } = fakeService({ messages });
      const result = inspect ? await runner.inspectSession({ sessionID: 'ses_test', directory: task.directory }) : await runner.runTask(task);
      assert.equal(result.status, 'transport_error');
      assert.match(result.reason, /Invalid message list response/);
    }
  }
});

test('unrecognized response shapes do not fabricate success', async () => {
  for (const [path, value, expected] of [
    ['/api/session', { unexpected: 'session' }, /creation returned no id/],
    ['/api/session/ses_test/permission', { unexpected: [] }, /Invalid permission list/],
    ['/api/session/ses_test/message', { unknown: 'message' }, /Invalid message list/],
  ]) {
    const { runner } = fakeService({ overrides: { [path]: value } });
    const result = await runner.runTask(task);
    assert.equal(result.status, 'transport_error');
    assert.match(result.reason, expected);
  }
  const { runner } = fakeService({ overrides: { '/api/session/ses_test': { id: 'ses_test', unexpected: true } } });
  assert.equal((await runner.runTask(task)).status, 'unknown');
});

test('pending permissions take precedence over idle and succeeded outcome', async () => {
  const pending = [{ id: 'per_1', action: 'bash', resources: ['npm install'] }];
  const { runner, calls } = fakeService({ pending, messages: [assistant('Waiting for approval')] });
  const result = await runner.runTask(task);
  assert.equal(result.status, 'needs_approval');
  assert.deepEqual(result.pendingPermissions, [{ requestID: 'per_1', action: 'bash', resources: ['npm install'] }]);
  assert.equal(result.summary, 'Waiting for approval');
  assert.equal(calls.some((call) => call.path.endsWith('/reply')), false);
  assert.deepEqual(calls.find((call) => call.path === '/api/session').data.location, { directory: task.directory });
  const wait = calls.find((call) => call.path.endsWith('/wait'));
  assert.equal(wait.method, 'POST');
  assert.equal(wait.body, undefined);
});

test('succeeded uses last assistant text, not prompt inbox; prompt never carries agent', async () => {
  const { runner, calls } = fakeService({ messages: [assistant('first'), { info: { role: 'user' }, parts: [{ type: 'text', text: 'user input' }] }, assistant('Final answer')] });
  const result = await runner.runTask({ ...task, agent: 'build', permissions: [{ action: '*', resource: '*', effect: 'ask' }] });
  assert.equal(result.status, 'completed');
  assert.equal(result.summary, 'Final answer');
  assert.equal(calls.find((call) => call.path === '/api/session').data.agent, 'build');
  assert.deepEqual(calls.find((call) => call.path.endsWith('/prompt')).data, { text: task.requirement });
});

test('failed outcome reports failure', async () => {
  const { runner } = fakeService({ outcome: 'failed', messages: [assistant('Build failed')] });
  const result = await runner.runTask(task);
  assert.equal(result.status, 'failed');
  assert.equal(result.summary, 'Build failed');
});

test('interrupted outcome is a failure with an explicit reason', async () => {
  const { runner } = fakeService({ outcome: 'interrupted' });
  const result = await runner.runTask(task);
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /interrupt/i);
  assert.equal(Object.hasOwn(result, 'summary'), false);
});

test('missing or unfamiliar outcome is unknown, never completed', async () => {
  for (const outcome of [null, 'other']) {
    const { runner } = fakeService({ outcome });
    const result = await runner.runTask(task);
    assert.equal(result.status, 'unknown');
    assert.match(result.reason, /状态未知/);
  }
});

test('explicit permission reply sends decision and accepts 204', async () => {
  const { runner, calls } = fakeService();
  await runner.replyPermission({ sessionID: 'ses_test', requestID: 'per_1', decision: 'once', message: 'Approved' });
  assert.deepEqual(calls[0].data, { decision: 'once', message: 'Approved' });
  assert.equal(calls[0].path, '/api/session/ses_test/permission/per_1/reply');
});

test('invalid permission decision is rejected before any request', async () => {
  const { runner, calls } = fakeService();
  await assert.rejects(runner.replyPermission({ sessionID: 'ses_test', requestID: 'per_1', decision: 'approve' }), /decision/);
  assert.equal(calls.length, 0);
});

test('transport error is distinct from a legitimate failed run', async () => {
  const { runner } = fakeService({ failAt: '/api/session/ses_test/permission' });
  const result = await runner.runTask(task);
  assert.equal(result.status, 'transport_error');
  assert.match(result.reason, /transport/i);
  assert.notEqual(result.status, 'failed');
});

test('reuse validates session before prompting', async () => {
  const { runner, calls } = fakeService();
  const result = await runner.runTask({ ...task, sessionID: 'ses_test' });
  assert.equal(result.status, 'completed');
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].path, '/api/session/ses_test');
  assert.equal(calls.some((call) => call.path === '/api/session' && call.method === 'POST'), false);
  assert.equal(calls[1].path, '/api/session/ses_test/prompt');
});

test('session creation callback is awaited before posting a prompt', async () => {
  const { runner, calls } = fakeService();
  const order = [];
  const result = await runner.runTask({ ...task, onSessionCreated: async (id) => {
    assert.equal(id, 'ses_test');
    order.push('record start');
    await Promise.resolve();
    order.push('record done');
    assert.deepEqual(calls.map(({ path }) => path), ['/api/session']);
  } });
  assert.equal(result.status, 'completed');
  assert.deepEqual(order, ['record start', 'record done']);
  assert.deepEqual(calls.slice(0, 2).map(({ path }) => path), ['/api/session', '/api/session/ses_test/prompt']);
});

test('session recording failure is distinct and aborts before prompting', async () => {
  const { runner, calls } = fakeService();
  const result = await runner.runTask({ ...task, onSessionCreated: async () => { throw new Error('private storage diagnostic'); } });
  assert.equal(result.status, 'session_record_error');
  assert.equal(result.sessionID, 'ses_test');
  assert.equal(result.reason.includes('private storage diagnostic'), false);
  assert.deepEqual(calls.map(({ path }) => path), ['/api/session']);
});

test('reuse invokes session callback after validation and before prompting', async () => {
  const { runner, calls } = fakeService({ wire: data => ({ data }) });
  const result = await runner.runTask({ ...task, sessionID: 'ses_test', onSessionCreated: async id => {
    assert.equal(id, 'ses_test');
    assert.deepEqual(calls.map(({ path }) => path), ['/api/session/ses_test']);
  } });
  assert.equal(result.status, 'completed');
  assert.equal(calls[1].path, '/api/session/ses_test/prompt');
});

test('reuse callback failure aborts before prompting', async () => {
  const { runner, calls } = fakeService();
  const result = await runner.runTask({ ...task, sessionID: 'ses_test', onSessionCreated: () => { throw new Error('private diagnostic'); } });
  assert.equal(result.status, 'session_record_error');
  assert.equal(result.sessionID, 'ses_test');
  assert.equal(result.reason.includes('private diagnostic'), false);
  assert.deepEqual(calls.map(({ path }) => path), ['/api/session/ses_test']);
});

test('inspection gives pending permissions priority and never posts', async () => {
  const { runner, calls } = fakeService({ pending: [{ id: 'per_1', action: 'bash', resources: ['npm install'] }], messages: [assistant('Waiting')] });
  const result = await runner.inspectSession({ sessionID: 'ses_test', directory: task.directory });
  assert.equal(result.status, 'needs_approval');
  assert.deepEqual(result.pendingPermissions, [{ requestID: 'per_1', action: 'bash', resources: ['npm install'] }]);
  assert.equal(result.summary, 'Waiting');
  assert.equal(calls[0].path, '/api/session/ses_test/permission');
  assert.equal(calls.some(({ method }) => method === 'POST'), false);
});

test('inspection maps succeeded, failed, interrupted and unrecognized outcomes without posting', async () => {
  for (const [outcome, status] of [['succeeded', 'completed'], ['failed', 'failed'], ['interrupted', 'failed'], [null, 'unknown'], ['other', 'unknown']]) {
    const { runner, calls } = fakeService({ outcome, messages: [assistant('first'), assistant('Last answer')] });
    const result = await runner.inspectSession({ sessionID: 'ses_test', directory: task.directory });
    assert.equal(result.status, status);
    assert.equal(result.summary, 'Last answer');
    if (outcome === 'interrupted') assert.match(result.reason, /interrupt/i);
    assert.deepEqual(calls.map(({ path }) => path), ['/api/session/ses_test/permission', '/api/session/ses_test', '/api/session/ses_test/message']);
    assert.equal(calls.some(({ method }) => method === 'POST'), false);
  }
});

test('inspection does not fabricate assistant output when no assistant message exists', async () => {
  const { runner } = fakeService({ messages: [{ info: { role: 'user' }, parts: [{ type: 'text', text: 'prompt' }] }] });
  const result = await runner.inspectSession({ sessionID: 'ses_test', directory: task.directory });
  assert.equal(result.status, 'completed');
  assert.equal(Object.hasOwn(result, 'summary'), false);
});

test('inspection classifies missing session as unknown, not completed', async () => {
  const { runner, calls } = fakeService({ notFoundAt: '/api/session/ses_test' });
  const result = await runner.inspectSession({ sessionID: 'ses_test', directory: task.directory });
  assert.equal(result.status, 'unknown');
  assert.equal(result.httpStatus, 404);
  assert.match(result.reason, /not found/i);
  assert.equal(calls.some(({ method }) => method === 'POST'), false);
});

test('inspection distinguishes transport failure from a legitimate failed session', async () => {
  const { runner, calls } = fakeService({ failAt: '/api/session/ses_test/permission' });
  const result = await runner.inspectSession({ sessionID: 'ses_test', directory: task.directory });
  assert.equal(result.status, 'transport_error');
  assert.match(result.reason, /transport/i);
  assert.equal(calls.some(({ method }) => method === 'POST'), false);
});

function tempRegistration(t) {
  const home = mkdtempSync(join(tmpdir(), 'bridge-discovery-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const registrationPath = join(home, '.local', 'state', 'opencode', 'service.json');
  mkdirSync(join(home, '.local', 'state', 'opencode'), { recursive: true });
  return { home, registrationPath };
}

test('service discovery uses the home state registration and Basic authentication', (t) => {
  const { home } = tempRegistration(t);
  const registrationPath = join(home, '.local', 'state', 'opencode', 'service.json');
  writeFileSync(registrationPath, JSON.stringify({ id: 'srv_1', version: '2.0.15', url: 'http://127.0.0.1:4312', pid: 234, password: 'dummy-secret' }));
  const discovered = discoverService({ env: { HOME: home } });
  assert.deepEqual(discovered, {
    baseUrl: 'http://127.0.0.1:4312',
    headers: { Authorization: `Basic ${Buffer.from('opencode:dummy-secret').toString('base64')}` },
    version: '2.0.15', pid: 234,
  });
  assert.equal(JSON.stringify(discovered).includes('dummy-secret'), false);
  const calls = [];
  const runner = createOpenCodeRunner({ ...discovered, fetchImpl: async (url, options) => {
    calls.push(options);
    return { ok: true, status: 204 };
  } });
  return runner.replyPermission({ sessionID: 'ses_1', requestID: 'per_1', decision: 'reject' }).then(() => {
    assert.equal(calls[0].headers.Authorization, discovered.headers.Authorization);
  });
});

test('service discovery rejects missing file, malformed JSON, and incomplete registration with typed sanitized errors', (t) => {
  const { registrationPath } = tempRegistration(t);
  const password = 'dummy-secret';
  const check = (code) => assert.throws(() => discoverService({ registrationPath }), (error) => {
    assert.ok(error instanceof OpenCodeDiscoveryError);
    assert.equal(error.code, code);
    assert.equal(error.message.includes(password), false);
    assert.equal(String(error).includes(password), false);
    return true;
  });
  check('REGISTRATION_UNREADABLE');
  writeFileSync(registrationPath, `{ "password": "${password}", broken`);
  check('REGISTRATION_INVALID');
  writeFileSync(registrationPath, JSON.stringify({ password }));
  check('URL_MISSING');
  writeFileSync(registrationPath, JSON.stringify({ url: 'http://localhost:9876' }));
  check('PASSWORD_MISSING');
});

test('service discovery refuses non-loopback URLs without leaking the credential', (t) => {
  const { registrationPath } = tempRegistration(t);
  for (const url of ['http://example.com:1234', 'http://127.0.0.2:1234', 'http://localhost.evil.test:1234', 'file:///local', 'http://opencode:dummy-secret@localhost:1234']) {
    writeFileSync(registrationPath, JSON.stringify({ url, password: 'dummy-secret' }));
    assert.throws(() => discoverService({ registrationPath }), (error) => {
      assert.ok(error instanceof OpenCodeDiscoveryError);
      assert.equal(error.code, 'URL_NOT_LOOPBACK');
      assert.equal(String(error).includes('dummy-secret'), false);
      return true;
    });
  }
});

test('service discovery accepts IPv6 loopback', (t) => {
  const { registrationPath } = tempRegistration(t);
  writeFileSync(registrationPath, JSON.stringify({ url: 'http://[::1]:4312', password: 'dummy-secret' }));
  assert.equal(discoverService({ registrationPath }).baseUrl, 'http://[::1]:4312');
});
