import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTaskMessage, parseProjectListQuery, buildTaskReply, buildProjectListReply,
  requirementFingerprint } from '../src/bridge/protocol.js';

test('task parsing rejects extra, missing, invalid and overlong fields', () => {
  const task = { taskId: 'task1', projectKey: 'alpha', requirement: 'Implement the fix' };
  assert.deepEqual(parseTaskMessage(task), task);
  for (const bad of [{ ...task, directory: '/secret' }, { ...task, requirement: undefined },
    { ...task, requirement: 'x'.repeat(32001) }, { ...task, taskId: 5 },
    { ...task, projectName: null }, { ...task, projectKey: '../secret' }])
    assert.throws(() => parseTaskMessage(bad), TypeError);
});

test('project list query and outbound DTOs reject unknown fields', () => {
  assert.deepEqual(parseProjectListQuery({ type: 'project_list' }), { type: 'project_list' });
  assert.throws(() => parseProjectListQuery({ type: 'project_list', sender: 'a' }), TypeError);
  assert.deepEqual(buildProjectListReply([{ projectKey: 'alpha', description: 'Alpha' }]),
    { projects: [{ projectKey: 'alpha', description: 'Alpha' }] });
  assert.throws(() => buildProjectListReply([{ projectKey: 'alpha', directory: '/private' }]), TypeError);
  assert.deepEqual(buildTaskReply({ taskId: 'task1', status: 'failed', summary: 'Reason' }),
    { taskId: 'task1', status: 'failed', summary: 'Reason' });
  assert.throws(() => buildTaskReply({ taskId: 'task1', status: 'done', summary: 'OK' }), TypeError);
  assert.notEqual(requirementFingerprint('A'), requirementFingerprint('B'));
});
