import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { parseImConfig } from '../src/im/config.js';
import { parseNanaConfig } from '../src/nana/config.js';

const script = resolve('scripts/im-nana-provision.mjs');
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 30000 });
const trust = process.platform === 'win32' ? ['--trust-windows-permissions'] : [];
// os.tmpdir() may itself contain symlinks (macOS /var -> /private/var); resolve it so
// the provisioned root only depends on real directories.
const temporaryParent = () => mkdtempSync(join(realpathSync(tmpdir()), 'im-nana-provision-test-'));

test('--help prints usage without creating files', () => {
  const result = run('--help');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:.*--root.*--agent-a-display/);
});

test('existing root is refused without changing it', () => {
  const parent = temporaryParent();
  try {
    const root = join(parent, 'existing');
    mkdirSync(root);
    const result = run('--root', root, ...trust);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must not already exist/);
    assert.deepEqual(readdirSync(root), []);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('invalid display names, duplicate names and bad server URLs are refused before root creation', () => {
  const parent = temporaryParent();
  try {
    const cases = [
      [['--agent-a-display', 'bad\nname'], /display name/],
      [['--agent-a-display', 'x'.repeat(256)], /display name/],
      [['--agent-a-display', 'same', '--agent-b-display', 'same'], /must differ/],
      [['--server-url', 'http://localhost:8787'], /bare https origin/],
      [['--server-url', 'https://user:pass@localhost:8787'], /bare https origin/],
      [['--tls-key', join(parent, 'missing.key')], /--tls-key requires --tls-cert|absolute path/],
    ];
    for (const [options, message] of cases) {
      const root = join(parent, `unused-${Math.random().toString(36).slice(2)}`);
      const result = run('--root', root, ...options, ...trust);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, message);
      assert.equal(existsSync(root), false);
    }
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('provision creates an isolated center, two identities, host configs and no stdout secrets', () => {
  const parent = temporaryParent();
  try {
    const root = join(parent, 'fresh');
    const result = run('--root', root, '--agent-a-display', 'nana-home', '--agent-b-display', 'nana-office',
      '--server-url', 'https://localhost:18787', ...trust);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.signal, null);
    const center = JSON.parse(readFileSync(join(root, 'center-config.json'), 'utf8'));
    assert.equal(parseImConfig(center.policy).writeMode, 'enabled');
    assert.equal(center.dbPath, join(root, 'center-v3.sqlite'));
    const hostA = parseNanaConfig(JSON.parse(readFileSync(join(root, 'host-a/nana.json'), 'utf8')));
    const hostB = parseNanaConfig(JSON.parse(readFileSync(join(root, 'host-b/nana.json'), 'utf8')));
    assert.notEqual(hostA.agentId, hostB.agentId);
    assert.equal(hostA.serverUrl, 'https://localhost:18787');
    assert.equal(hostA.evidencePath, join(root, 'host-a/evidence.jsonl'));
    assert.ok(existsSync(hostA.attachmentDirectory));
    assert.ok(existsSync(hostB.attachmentDirectory));
    const db = new DatabaseSync(center.dbPath, { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT COUNT(*) n FROM im_agents').get().n, 2);
      assert.deepEqual(db.prepare('SELECT display_name d FROM im_agents ORDER BY display_name').all().map(row => row.d),
        ['nana-home', 'nana-office']);
      // Contacts are stored once per canonical (agent_low, agent_high) pair and apply both ways.
      assert.equal(db.prepare('SELECT COUNT(*) n FROM im_contacts WHERE allowed=1').get().n, 1);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM im_credentials').get().n, 2);
      assert.equal(db.prepare('SELECT write_mode FROM im_settings').get().write_mode, 'enabled');
    } finally { db.close(); }
    const adminSecret = readFileSync(join(root, 'admin-secret'), 'utf8').trim();
    const credentialA = readFileSync(hostA.credentialFile, 'utf8').trim();
    const credentialB = readFileSync(hostB.credentialFile, 'utf8').trim();
    for (const secret of [adminSecret, credentialA, credentialB]) assert.equal(result.stdout.includes(secret), false);
    assert.match(result.stdout, /node scripts\/im-center\.mjs/);
    assert.match(result.stdout, /node scripts\/im-nana-session\.mjs receive/);
    assert.match(result.stdout, /node scripts\/im-nana-session\.mjs send/);
    if (process.platform !== 'win32') {
      for (const dir of [root, join(root, 'credentials'), join(root, 'host-a'), join(root, 'host-b'),
        hostA.attachmentDirectory, hostB.attachmentDirectory]) assert.equal(statSync(dir).mode & 0o777, 0o700);
      for (const file of [center.dbPath, join(root, 'admin-secret'), join(root, 'center-config.json'),
        join(root, 'host-a/nana.json'), hostA.credentialFile]) assert.equal(statSync(file).mode & 0o777, 0o600);
    }
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
