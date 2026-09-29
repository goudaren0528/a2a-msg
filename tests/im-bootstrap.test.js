import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createBridgeConfig } from '../src/bridge/config.js';
import { parseImConfig } from '../src/im/config.js';

const script = resolve('scripts/im-bootstrap.mjs');
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 15000 });
const trust = process.platform === 'win32' ? ['--trust-windows-permissions'] : [];

test('--help prints usage without creating files', () => {
  const result = run('--help');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:.*--root.*--project/);
});

test('existing root is refused without changing it', () => {
  const parent = mkdtempSync(join(tmpdir(), 'im-bootstrap-test-'));
  try {
    const root = join(parent, 'existing');
    mkdirSync(root);
    const result = run('--root', root, '--project', `Sample=${parent}`, ...trust);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must not already exist/);
    assert.deepEqual(readdirSync(root), []);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('missing and invalid projects are refused before root creation', () => {
  const parent = mkdtempSync(join(tmpdir(), 'im-bootstrap-test-'));
  try {
    for (const [options, message] of [[[], /at least one --project/],
      [['--project', 'bad-key?=/tmp'], /--project key/],
      [['--project', 'Good=relative'], /--project directory/],
      [['--project', `Same=${parent}`, '--project', `Same=${parent}`], /duplicate --project key/]]) {
      const root = join(parent, `unused-${options.length}-${Math.random().toString(36).slice(2)}`);
      const result = run('--root', root, ...options, ...trust);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, message);
      assert.equal(existsSync(root), false);
    }
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('bootstrap produces usable config, credentials and no stdout secret values', () => {
  const parent = mkdtempSync(join(tmpdir(), 'im-bootstrap-test-'));
  try {
    const root = join(parent, 'fresh');
    const project = join(parent, 'project');
    mkdirSync(project);
    const result = run('--root', root, '--project', `Demo=${project}|示例项目`, ...trust);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.signal, null);
    const bridge = JSON.parse(readFileSync(join(root, 'bridge.json'), 'utf8'));
    const center = JSON.parse(readFileSync(join(root, 'center-config.json'), 'utf8'));
    assert.deepEqual(Object.keys(bridge).sort(), ['agentId', 'serverUrl', 'credentialFile', 'journalPath', 'statePath', 'allowedSenders', 'projects'].sort());
    assert.deepEqual(createBridgeConfig(bridge).visibleProjects(bridge.allowedSenders[0]),
      [{ projectKey: 'Demo', description: '示例项目' }]);
    assert.equal(bridge.projects[0].directory, project);
    if (process.platform === 'win32') {
      assert.match(project, /^[A-Za-z]:[\\/]/);
      assert.equal((result.stderr.match(/WINDOWS_PERMISSION_UNVERIFIED/g) ?? []).length, 1);
      assert.match(result.stderr, /accepts UNVERIFIED NTFS ACLs/);
    }
    assert.equal(parseImConfig(center.policy).writeMode, 'enabled');
    assert.equal(center.dbPath, join(root, 'center-v3.sqlite'));
    const db = new DatabaseSync(center.dbPath, { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT COUNT(*) n FROM im_agents').get().n, 2);
      assert.equal(db.prepare('SELECT write_mode FROM im_settings').get().write_mode, 'enabled');
    } finally { db.close(); }
    const adminSecret = readFileSync(join(root, 'admin-secret'), 'utf8').trim();
    const upstream = readFileSync(join(root, 'credentials', 'upstream-credential'), 'utf8').trim();
    const credential = readFileSync(bridge.credentialFile, 'utf8').trim();
    for (const secret of [adminSecret, upstream, credential]) assert.equal(result.stdout.includes(secret), false);
    assert.match(result.stdout, /node scripts\/im-center\.mjs/);
    assert.match(result.stdout, /node src\/bridge\/run\.mjs/);
    if (process.platform !== 'win32') {
      for (const dir of [root, join(root, 'credentials')]) assert.equal(statSync(dir).mode & 0o777, 0o700);
      for (const file of [center.dbPath, bridge.credentialFile, join(root, 'admin-secret'), join(root, 'bridge.json')])
        assert.equal(statSync(file).mode & 0o777, 0o600);
    }
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
