import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parseArgs, projectQuery, taskMessage, runReceiveLoop, releaseLease } from '../scripts/im-dispatch.mjs';
import { parseProjectListQuery, parseTaskMessage } from '../src/bridge/protocol.js';

const script = fileURLToPath(new URL('../scripts/im-dispatch.mjs', import.meta.url));
const bridge = '12345678-1234-1234-1234-123456789abc';
const root = fileURLToPath(new URL('../', import.meta.url));
const base = ['--root', root, '--bridge', bridge];
const run = args => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 5000 });

test('--help exits successfully without connecting', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:[\s\S]*im-dispatch\.mjs/);
  assert.match(result.stdout, /projects.*task.*watch/s);
});

test('missing and invalid arguments name the bad part', () => {
  for (const [args, name] of [
    [[], '--root'], [['--root', 'relative', '--bridge', bridge, 'projects'], '--root'],
    [['--root', root, 'projects'], '--bridge'], [[...base], 'command'],
    [[...base, 'task', '--id', 'Good', '--project', 'Good'], '--requirement'],
    [[...base, 'projects', '--id', 'Other'], '--id'],
    [[...base, 'projects', '--timeout', 'bad'], '--timeout'],
  ]) {
    const result = run(args);
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.match(result.stderr, new RegExp(name), JSON.stringify(args));
  }
});

test('invalid taskId and projectKey fail before any connection or bootstrap file read', () => {
  for (const [args, part] of [
    [[...base, 'task', '--id', '3bad', '--project', 'Good', '--requirement', 'Do it'], 'taskId'],
    [[...base, 'task', '--id', 'Good', '--project', '../bad', '--requirement', 'Do it'], 'projectKey'],
  ]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(part));
    assert.doesNotMatch(result.stderr, /ENOENT|ECONNREFUSED/);
  }
});

test('constructed requests agree with real bridge protocol parsers', () => {
  assert.deepEqual(parseProjectListQuery(projectQuery()), { type: 'project_list' });
  assert.deepEqual(parseTaskMessage(taskMessage('Task_1', 'Project-1', 'Read files')), {
    taskId: 'Task_1', projectKey: 'Project-1', requirement: 'Read files',
  });
  const input = parseArgs([...base, 'task', '--id', 'Task_1', '--project', 'Project-1', '--requirement', 'Read files']);
  assert.deepEqual(parseTaskMessage(taskMessage(input.taskId, input.projectKey, input.requirement)),
    { taskId: 'Task_1', projectKey: 'Project-1', requirement: 'Read files' });
});

const rateLimited = () => Object.assign(new Error('RATE_LIMITED'), { code: 'RATE_LIMITED' });
const fakeClock = () => {
  let time = 0;
  const waits = [];
  return { now: () => time, waits, sleep: async ms => { waits.push(ms); time += ms; } };
};
const receiveInput = command => ({ command, bridgeId: bridge, timeout: 10, taskId: 'Task_1' });

test('RATE_LIMITED receive retries after a real timer wait and then returns a projects reply', async () => {
  const clock = fakeClock();
  const logs = [], notes = [];
  let calls = 0;
  const im = { receiveOnce: async () => {
    calls++;
    if (calls === 1) throw rateLimited();
    assert.equal(clock.now(), 5000);
    return { hasMore: false, items: [{ message: { senderAgentId: bridge,
      recipientAgentId: 'abcdefab-1234-1234-1234-123456789abc', inReplyTo: 'sent',
      text: JSON.stringify({ projects: [{ projectKey: 'Project-1', description: 'Ready' }] }) } }] };
  } };
  const result = await runReceiveLoop({ im, input: receiveInput('projects'), sender: 'abcdefab-1234-1234-1234-123456789abc',
    sentMessageId: 'sent', ...clock, log: text => logs.push(text), report: text => notes.push(text) });
  assert.deepEqual(clock.waits, [5000]);
  assert.equal(calls, 2);
  assert.deepEqual(logs, ['Project-1 — Ready']);
  assert.match(notes[0], /rate limited/i);
  assert.deepEqual(result, { outcome: 'reply', exitCode: 0 });
});

test('hasMore pages are spaced apart even while draining a backlog', async () => {
  const clock = fakeClock();
  const calls = [];
  const im = { receiveOnce: async () => {
    calls.push(clock.now());
    return { hasMore: true, items: [] };
  } };
  const result = await runReceiveLoop({ im, input: receiveInput('task'), sender: bridge,
    ...clock, report: () => {} });
  assert.deepEqual(calls, [0, 5000]);
  assert.deepEqual(clock.waits, [5000, 5000]);
  assert.deepEqual(result, { outcome: 'timeout', exitCode: 1 });
});

test('RATE_LIMITED lease release is a cleanup note, not an exit-code override', async () => {
  const notes = [];
  const outcome = { outcome: 'reply', exitCode: 0 };
  const released = await releaseLease({ release: async () => { throw rateLimited(); } }, text => notes.push(text));
  let exitCode = outcome.exitCode;
  if (released === false) exitCode ||= 1; // Same exit-code handling as the CLI.
  assert.equal(released, 'rate-limited');
  assert.equal(exitCode, 0);
  assert.match(notes[0], /RATE_LIMITED.*cleanup note/i);
});

test('timeout reached during rate-limit backoff remains a timeout, not task failure', async () => {
  const clock = fakeClock();
  const notes = [];
  let calls = 0;
  const result = await runReceiveLoop({ im: { receiveOnce: async () => { calls++; throw rateLimited(); } },
    input: { ...receiveInput('task'), timeout: 3 }, sender: bridge, ...clock, report: text => notes.push(text) });
  assert.deepEqual(clock.waits, [3000]);
  assert.equal(calls, 1);
  assert.deepEqual(result, { outcome: 'timeout', exitCode: 1 });
  assert.match(notes.at(-1), /timeout, not a task failure/);
});
