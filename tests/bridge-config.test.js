import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createBridgeConfig } from '../src/bridge/config.js';

const A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const config = () => ({ agentId: C, serverUrl: 'https://example.test', credentialFile: resolve('credentials.json'),
  journalPath: resolve('journal.db'), statePath: resolve('bridge.db'), allowedSenders: [A, B],
  projects: [{ projectKey: 'alpha', directory: resolve('alpha'), description: 'Alpha', allowedSenders: [A] },
    { projectKey: 'beta', directory: resolve('beta'), description: 'Beta', allowedSenders: [B] }] });

test('unknown sender and unauthorized or unknown project are refused separately', () => {
  const bridge = createBridgeConfig(config());
  assert.deepEqual(bridge.resolveProject(C, 'alpha'), { ok: false, code: 'UNKNOWN_SENDER' });
  assert.deepEqual(bridge.resolveProject(A, 'beta'), { ok: false, code: 'UNKNOWN_OR_UNAUTHORIZED_PROJECT' });
  assert.deepEqual(bridge.resolveProject(A, 'missing'), { ok: false, code: 'UNKNOWN_OR_UNAUTHORIZED_PROJECT' });
  assert.deepEqual(bridge.resolveProject(A, 'alpha'), { ok: true, directory: resolve('alpha'),
    permissions: bridge.resolveProject(A, 'alpha').permissions });
  assert.deepEqual(bridge.resolveProject(A, 'alpha').permissions[0], { action: '*', resource: '*', effect: 'deny' });
});

test('explicit ordered permission rules are preserved; invalid rules are rejected', () => {
  const raw = config();
  const rules = [{ action: '*', resource: '*', effect: 'deny' },
    { action: 'read', resource: '*', effect: 'allow' }, { action: 'shell', resource: '*', effect: 'ask' }];
  raw.projects[0].permissions = rules;
  assert.deepEqual(createBridgeConfig(raw).resolveProject(A, 'alpha').permissions, rules);
  for (const invalid of [[], [{ action: 'shell', resource: '*', effect: 'allow' }],
    [{ action: '*', resource: '*', effect: 'allow' }],
    [rules[0], { action: 'shell', resource: '*', effect: 'maybe' }],
    [rules[0], { action: 'read', resource: '*', effect: 'allow', surprise: true }]]) {
    const candidate = config(); candidate.projects[0].permissions = invalid;
    assert.throws(() => createBridgeConfig(candidate), TypeError);
  }
});

test('visible projects expose no directories or other senders projects', () => {
  const bridge = createBridgeConfig(config());
  assert.deepEqual(bridge.visibleProjects(A), [{ projectKey: 'alpha', description: 'Alpha' }]);
  assert.deepEqual(bridge.visibleProjects(B), [{ projectKey: 'beta', description: 'Beta' }]);
  assert.deepEqual(bridge.visibleProjects(C), []);
  assert.doesNotMatch(JSON.stringify(bridge.visibleProjects(A)), /directory|beta/);
});

test('duplicate keys, duplicate directories, and extra config are rejected', () => {
  const duplicateKey = config(); duplicateKey.projects[1].projectKey = 'alpha';
  assert.throws(() => createBridgeConfig(duplicateKey), TypeError);
  const duplicateDirectory = config(); duplicateDirectory.projects[1].directory = resolve('alpha');
  assert.throws(() => createBridgeConfig(duplicateDirectory), TypeError);
  assert.throws(() => createBridgeConfig({ ...config(), surprise: true }), TypeError);
  const unsafeKey = config(); unsafeKey.projects[0].projectKey = '../alpha';
  assert.throws(() => createBridgeConfig(unsafeKey), TypeError);
});
