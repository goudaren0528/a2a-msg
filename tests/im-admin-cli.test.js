import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, chmodSync, readFileSync, rmSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdminAuthority, createLocalKeystore, WINDOWS_PERMISSION_WARNING } from '../src/im/keystore.js';
import { createImAdminCli } from '../src/im/admin-cli.js';
import { createImAuth } from '../src/im/auth.js';
import { migrateImSchema } from '../src/im/schema.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'im-local-admin-'));
  const db = new DatabaseSync(join(directory, 'temporary.sqlite'));
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  db.exec('PRAGMA foreign_keys=ON');
  migrateImSchema(db);
  const secretFile = join(directory, 'admin.key');
  const secret = 'a'.repeat(64);
  writeFileSync(secretFile, `${secret}\n`, { mode: 0o600 });
  mkdirSync(join(directory, 'credentials'), { mode: 0o700 });
  const warnings = [];
  const options = { trustWindowsPermissions: process.platform === 'win32', report: warning => warnings.push(warning) };
  const cli = createImAdminCli({ db, secretFile, credentialDirectory: join(directory, 'credentials'), ...options });
  const ctx = { adminSecret: secret };
  return { db, directory, secretFile, secret, cli, ctx, warnings, options };
}

test('missing, permissive POSIX, and invalid admin key fail closed', t => {
  const f = fixture(t);
  assert.throws(() => createAdminAuthority({ secretFile: join(f.directory, 'absent'), ...f.options }).authorizeAdmin(f.ctx), /LOCAL_AUTH_UNAVAILABLE/);
  writeFileSync(f.secretFile, 'invalid\n');
  assert.throws(() => f.cli.execute('register-agent', { displayName: 'a' }, f.ctx), /ADMIN_OPERATION_FAILED/);
  writeFileSync(f.secretFile, `${f.secret}\n`);
  if (process.platform !== 'win32') {
    chmodSync(f.secretFile, 0o644);
    assert.throws(() => f.cli.execute('register-agent', { displayName: 'a' }, f.ctx), /ADMIN_OPERATION_FAILED/);
  }
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM im_agents').get().n, 0);
});

test('all subcommands require authority, write mode starts paused and needs complete policy', t => {
  const f = fixture(t);
  const bad = { adminSecret: 'b'.repeat(64) };
  const a = f.cli.execute('register-agent', { displayName: 'a' }, f.ctx);
  const b = f.cli.execute('register-agent', { displayName: 'b' }, f.ctx);
  const examples = [
    ['register-agent', { displayName: 'c' }],
    ['issue-credential', { agentId: a.agentId, expiresAt: null }],
    ['revoke-credential', { credentialId: a.agentId, reason: 'test' }],
    ['set-status', { agentId: a.agentId, status: 'disabled', reason: 'test' }],
    ['set-contact', { agentA: a.agentId, agentB: b.agentId, allowed: true, reason: 'test' }],
    ['takeover-receiver', { agentId: a.agentId, reason: 'test' }],
    ['write-mode', { mode: 'paused', reason: 'test' }],
  ];
  for (const [command, input] of examples) assert.throws(() => f.cli.execute(command, input, bad), /ADMIN_OPERATION_FAILED/);
  assert.equal(f.db.prepare('SELECT write_mode FROM im_settings').get().write_mode, 'paused');
  assert.throws(() => f.cli.execute('write-mode', { mode: 'enabled', reason: 'test' }, f.ctx), /ADMIN_OPERATION_FAILED/);
  assert.equal(f.db.prepare('SELECT write_mode FROM im_settings').get().write_mode, 'paused');
  const policy = { enabled: true, writeMode: 'enabled', transport: { mode: 'local-test', serverUrl: 'http://localhost/' },
    retention: { policy: { messageRetentionMs: 1000, attachmentRetentionMs: 1000, idempotencyRetentionMs: 2000, safeRetryWindowMs: 1000 } },
    lease: { ttlMs: 1000, renewalMs: 500 } };
  assert.deepEqual(f.cli.execute('write-mode', { mode: 'enabled', reason: 'test', policy }, f.ctx), { mode: 'enabled' });
  assert.deepEqual(f.cli.execute('write-mode', { mode: 'paused', reason: 'test' }, f.ctx), { mode: 'paused' });
  assert.equal(f.cli.execute('set-contact', examples[4][1], f.ctx).allowed, true);
  assert.equal(f.cli.execute('set-status', examples[3][1], f.ctx).status, 'disabled');
  assert.equal(f.cli.execute('takeover-receiver', examples[5][1], f.ctx).changed, false);
});

test('credential issuance only returns plaintext once; revocation immediately invalidates auth; errors never echo secrets', t => {
  const f = fixture(t);
  const agent = f.cli.execute('register-agent', { displayName: 'agent' }, f.ctx);
  const issued = f.cli.execute('issue-credential', { agentId: agent.agentId, expiresAt: null }, f.ctx);
  const auth = createImAuth({ db: f.db });
  assert.equal(auth.authenticate(issued.credential).agentId, agent.agentId);
  assert.equal(f.db.prepare('SELECT secret_hash FROM im_credentials WHERE credential_id=?').get(issued.credentialId).secret_hash.length, 64);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM im_audit WHERE safe_details_json LIKE ?').get(`%${issued.credential}%`).n, 0);
  const record = f.cli.execute('revoke-credential', { credentialId: issued.credentialId, reason: 'rotation' }, f.ctx);
  assert.equal(record.credentialId, issued.credentialId);
  assert.equal(Object.hasOwn(record, 'credential'), false);
  assert.throws(() => auth.authenticate(issued.credential), error => error.code === 'INVALID_CREDENTIAL');
  assert.throws(() => f.cli.execute('issue-credential', { agentId: issued.credential, expiresAt: null }, f.ctx), error =>
    error.message === 'ADMIN_OPERATION_FAILED' && !error.stack.includes(issued.credential));
  assert.equal(f.warnings.join(' ').includes(f.secret), false);
  assert.equal(f.warnings.join(' ').includes(issued.credential), false);
});

test('protected store and Windows permission uncertainty are explicit', t => {
  const f = fixture(t);
  if (process.platform === 'win32') {
    assert.throws(() => createAdminAuthority({ secretFile: f.secretFile }).authorizeAdmin(f.ctx), /LOCAL_AUTH_UNAVAILABLE/);
    assert.equal(createAdminAuthority({ secretFile: f.secretFile, ...f.options }).authorizeAdmin(f.ctx), true);
    assert.ok(f.warnings.includes(WINDOWS_PERMISSION_WARNING));
    assert.throws(() => createLocalKeystore({ directory: join(f.directory, 'other') }).createAdminSecret(join(f.directory, 'other.key')), /LOCAL_AUTH_UNAVAILABLE/);
  } else {
    assert.equal(createAdminAuthority({ secretFile: f.secretFile }).authorizeAdmin(f.ctx), true);
  }
  mkdirSync(join(f.directory, 'other'), { mode: 0o700 });
  const store = createLocalKeystore({ directory: join(f.directory, 'other'), ...f.options });
  const path = join(f.directory, 'new-admin.key');
  const generated = store.createAdminSecret(path);
  assert.equal(readFileSync(path, 'utf8').trim(), generated);
  assert.equal(createAdminAuthority({ secretFile: path, ...f.options }).authorizeAdmin({ adminSecret: generated }), true);
});

test('B2: write, flush and protection failures after exclusive create leave no credential or owned file', t => {
  const f = fixture(t);
  const agent = f.cli.execute('register-agent', { displayName: 'agent' }, f.ctx);
  const credentials = join(f.directory, 'credentials');
  for (const stage of ['after-write', 'after-flush', 'after-check']) {
    const cli = createImAdminCli({ db: f.db, secretFile: f.secretFile, credentialDirectory: credentials,
      ...f.options, storageFault: at => { if (at === stage) throw new Error(`secret-${f.secret}`); } });
    assert.throws(() => cli.execute('issue-credential', { agentId: agent.agentId, expiresAt: null }, f.ctx),
      error => error.message === 'ADMIN_OPERATION_FAILED' && !error.stack.includes(f.secret));
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM im_credentials').get().n, 0);
    assert.deepEqual(readdirSync(credentials), []);
  }
  assert.equal(f.warnings.join(' ').includes(f.secret), false);
});

test('B2: database registration failure removes prepared credential; failed revoke compensation cannot leave active row', t => {
  const f = fixture(t);
  const agent = f.cli.execute('register-agent', { displayName: 'agent' }, f.ctx);
  f.db.exec(`CREATE TRIGGER fail_issue BEFORE INSERT ON im_credentials BEGIN SELECT RAISE(ABORT, 'blocked'); END;
    CREATE TRIGGER fail_revoke BEFORE UPDATE ON im_credentials BEGIN SELECT RAISE(ABORT, 'blocked'); END;`);
  assert.throws(() => f.cli.execute('issue-credential', { agentId: agent.agentId, expiresAt: null }, f.ctx),
    error => error.message === 'ADMIN_OPERATION_FAILED' && !error.stack.includes(f.secret));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM im_credentials').get().n, 0);
  assert.deepEqual(readdirSync(join(f.directory, 'credentials')), []);
});

test('B2: failed local cleanup reports nonsecret credential ID and no active DB row', t => {
  const f = fixture(t);
  const agent = f.cli.execute('register-agent', { displayName: 'agent' }, f.ctx);
  const cli = createImAdminCli({ db: f.db, secretFile: f.secretFile,
    credentialDirectory: join(f.directory, 'credentials'), ...f.options,
    storageFault: at => { if (at === 'after-write' || at === 'before-cleanup') throw new Error(f.secret); } });
  assert.throws(() => cli.execute('issue-credential', { agentId: agent.agentId, expiresAt: null }, f.ctx), error =>
    error.message === 'ADMIN_CLEANUP_INCOMPLETE' && /^[0-9a-f-]{36}$/.test(error.credentialId) &&
    !error.stack.includes(f.secret));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM im_credentials').get().n, 0);
  assert.equal(readdirSync(join(f.directory, 'credentials')).length, 1);
});

test('B2: DB rollback plus failed artifact cleanup reports credential ID without activating it', t => {
  const f = fixture(t);
  const agent = f.cli.execute('register-agent', { displayName: 'agent' }, f.ctx);
  const cli = createImAdminCli({ db: f.db, secretFile: f.secretFile,
    credentialDirectory: join(f.directory, 'credentials'), ...f.options,
    storageFault: at => { if (at === 'before-cleanup') throw new Error(f.secret); } });
  f.db.exec(`CREATE TRIGGER fail_issue_cleanup BEFORE INSERT ON im_credentials BEGIN SELECT RAISE(ABORT, 'blocked'); END;`);
  assert.throws(() => cli.execute('issue-credential', { agentId: agent.agentId, expiresAt: null }, f.ctx), error =>
    error.message === 'ADMIN_CLEANUP_INCOMPLETE' && /^[0-9a-f-]{36}$/.test(error.credentialId) &&
    !error.stack.includes(f.secret));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM im_credentials').get().n, 0);
  assert.equal(readdirSync(join(f.directory, 'credentials')).length, 1);
});
