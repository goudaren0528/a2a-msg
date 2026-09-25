import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { V4_DDL, V4_CHECKSUM, assertImSchemaV4Internal } from '../src/im/v2/schema-internal.js';
import { V3_DDL, V3_CHECKSUM } from '../src/im/v2/schema-history.js';
import { DEFAULT_POLICY, DEFAULT_MAINTENANCE, parseImV2Config } from '../src/im/v2/config.js';
import { activeFixture, journalFixture } from './fixtures/im-v2-maintenance-read-target/legal-fixtures.js';

// Observe native statements on the REAL receiver, never a substituted db facade.
// Install before import so module-captured native entrypoints remain observable.
const calls = [];
let observing = false, onStatement = null;
const prepare = DatabaseSync.prototype.prepare, exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.prepare = function (sql) {
  if (observing) { calls.push(sql); onStatement?.(sql); }
  return prepare.call(this, sql);
};
DatabaseSync.prototype.exec = function (sql) {
  if (observing) { calls.push(sql); onStatement?.(sql); }
  return exec.call(this, sql);
};
const { createImV2MaintenanceReadTarget: target, withMaintenanceReadSnapshot: scope } =
  await import('../src/im/v2/maintenance-read-target.js');
const native = { skip: process.platform === 'win32' ? 'Windows protection unsupported (strict fail-closed tested separately)' : false };
const sha = x => createHash('sha256').update(x).digest('hex');
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const error = suffix => ({ code: `MAINTENANCE_${suffix}`, message: 'Maintenance preview rejected' });
const p = { ...DEFAULT_POLICY, effectiveAt: 1 };
const ph = sha(JSON.stringify(p));
const config = parseImV2Config({ enabled: true, writeMode: 'paused',
  transport: { mode: 'local-test', serverUrl: 'http://127.0.0.1/' }, retention: { policy: p, policyHash: ph },
  lease: { ttlMs: 1000, renewalMs: 500 }, limits: { maxAttachmentBytes: 10485760, maxBodyBytes: 65536,
    maxFileBodyBytes: 15000000, maxConnections: 1, maxRequestsPerMinute: 1 },
  maintenance: { ...DEFAULT_MAINTENANCE, maxKeyReservations: 100 } });

// Deliberately independent F size oracle, matching typed column-array framing.
function fsize(x) {
  if (x === null) return 2;
  if (Array.isArray(x)) return Buffer.byteLength(`a${x.length}:`) + x.reduce((n, v) => n + fsize(v), 0);
  if (typeof x === 'number') return Buffer.byteLength(`i${x};`);
  const bytes = typeof x === 'string' ? Buffer.byteLength(x) : x.length;
  return Buffer.byteLength(`x${bytes}:`) + bytes;
}
function ledger(options = {}) {
  const limits = { maxScanRows: 10000, maxScanBytes: 104857600, maxScanMs: 1000, ...options };
  let rows = 0, bytes = 0, heldRows = 0, heldBytes = 0, stopped = null;
  const start = performance.now(), tickets = new Set();
  return {
    config, limits,
    check() { return stopped || (Math.ceil(performance.now() - start) > limits.maxScanMs ? 'SCAN_TIME' : null); },
    reserve(r, b) {
      if (rows + heldRows + r > limits.maxScanRows) return 'SCAN_ROWS';
      if (bytes + heldBytes + b > limits.maxScanBytes) return 'SCAN_BYTES';
      if (this.check()) return 'SCAN_TIME';
      const token = { r, b }; tickets.add(token); heldRows += r; heldBytes += b; return token;
    },
    settle(token, r, b) {
      assert.ok(tickets.delete(token)); assert.ok(r <= token.r); assert.ok(b <= token.b);
      heldRows -= token.r; heldBytes -= token.b; rows += r; bytes += b;
    },
    stats: () => ({ rows, bytes, heldRows, heldBytes, tickets: tickets.size }),
    stop: () => { stopped = 'SCAN_TIME'; },
  };
}
function insert(db, name, row) {
  db.prepare(`INSERT INTO ${name} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
}
function fixture(t, { mode = 'paused', version = 4 } = {}) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'maintenance-target-'));
  fs.chmodSync(dir, 0o700);
  const databasePath = join(dir, 'candidate.db');
  const db = new DatabaseSync(databasePath);
  db.enableDefensive(false); // test-only corruption/cookie fixtures are explicit
  db.exec('PRAGMA journal_mode=DELETE');
  for (const ddl of version === 3 ? V3_DDL : V4_DDL) db.exec(ddl);
  insert(db, 'im_schema', { version, migration_checksum: version === 3 ? V3_CHECKSUM : V4_CHECKSUM });
  insert(db, 'im_settings', { singleton: 1, write_mode: mode });
  insert(db, 'im_clock', { singleton: 1, last_observed_at: 100 });
  insert(db, 'im_instance_identity', { singleton: 1, instance_id: id(1), created_at: 1 });
  if (version === 4) {
    insert(db, 'im_retention_policies', { policy_hash: ph, version: 2, effective_at: 1,
      message_retention_ms: p.messageRetentionMs, attachment_retention_ms: p.attachmentRetentionMs,
      safe_retry_window_ms: p.safeRetryWindowMs, audit_retention_ms: p.auditRetentionMs, canonical_json: JSON.stringify(p) });
    insert(db, 'im_center_epochs', { center_epoch: id(2), created_at: 1, origin: 'fresh', recovery_counter: 0 });
    insert(db, 'im_schema_preparations', { preparation_ref: 'fixture-preparation', kind: 'fresh',
      input_hash: sha(JSON.stringify(['fresh', null, null, p, 'fixture-preparation'])), source_version: null,
      source_schema_checksum: null, import_epoch: null, initial_epoch: id(2), policy_hash: ph, created_at: 1 });
    // SQL-only legal C-proof relationship, produced BEFORE capability creation.
    // No production staging, preparation, verification or activation services.
    insert(db, 'im_recovery_runs', { run_id: 'fixture-run', candidate_kind: 'fresh_bootstrap',
      preparation_ref: 'fixture-preparation', backup_id: null, backup_file_hash: null, manifest_hash: null,
      candidate_base_hash: null, candidate_reference: 'fixture-candidate', old_epoch: null, new_epoch: id(2),
      approved_plan_hash: sha('approved-plan'), approval_ref: 'approval', isolation_ack_ref: null, rpo_report_json: null,
      auth_review_ref: 'auth-review', activation_plan_hash: sha('activation-plan'), activation_approval_ref: 'activation-approval',
      status: 'active', created_at: 1, verified_at: 2, activated_at: 3, activation_ref: 'activation', failure_code: null });
    insert(db, 'im_center_state', { singleton: 1, center_epoch: id(2), recovery_counter: 0,
      status: 'active', activation_ref: 'activation', recovery_run_id: 'fixture-run', updated_at: 3 });
    for (const n of [-1, 0, 1]) insert(db, 'im_audit', { id: n, actor_kind: 'system', actor_id: 'fixture',
      action: n === 0 ? 'unknown' : 'conversation.created', target_ids_json: '[]', occurred_at: 10, safe_details_json: '{"é":"字"}' });
    assertImSchemaV4Internal(db); // test oracle only, before target creation/observation
  }
  fs.chmodSync(databasePath, 0o600);
  const readTarget = target({ db, databasePath });
  t.after(() => { observing = false; onStatement = null; readTarget.invalidate(); if (db.isOpen) db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { db, databasePath, dir, readTarget };
}
function image(f) {
  const schema = f.db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name').all();
  const tables = Object.fromEntries(schema.filter(r => r.type === 'table').map(r => [r.name,
    f.db.prepare(`SELECT * FROM "${r.name}"`).all().map(x => JSON.stringify(x, (_, v) => v instanceof Uint8Array ? [...v] : v)).sort()]));
  const files = fs.readdirSync(f.dir).sort().map(name => {
    const full = join(f.dir, name), stat = fs.lstatSync(full, { bigint: true });
    return [name, stat.ino.toString(), stat.mtimeNs.toString(), sha(fs.readFileSync(full))];
  });
  return { schema, tables, files };
}
function observed(f, callback) {
  const before = image(f);
  const forbidden = ['openSync', 'readFileSync', 'writeFileSync', 'appendFileSync', 'fsyncSync', 'fdatasyncSync',
    'unlinkSync', 'renameSync', 'chmodSync', 'mkdirSync', 'rmSync', 'truncateSync'];
  const originals = Object.fromEntries(forbidden.map(k => [k, fs[k]]));
  for (const k of forbidden) fs[k] = () => assert.fail(`observed module scope invoked forbidden fs.${k}`);
  calls.length = 0; observing = true;
  try { return callback(); } finally {
    observing = false;
    for (const k of forbidden) fs[k] = originals[k];
    assert.deepEqual(image(f), before, 'all tables, clock/run, file bytes/mtime/inventory unchanged');
    assert.equal(f.db.isOpen, true);
    assert.ok(calls.every(sql => /^(SELECT|PRAGMA main\.(schema_version|data_version|journal_mode)|BEGIN$|COMMIT$|ROLLBACK$)/.test(sql)), calls.join('\n'));
    assert.ok(!calls.some(sql => /BEGIN IMMEDIATE|SELECT \*|pragma_foreign_key_check|UPDATE |COUNT\(/i.test(sql)));
  }
}
function contentFixture(f) {
  for (const n of [10, 11]) insert(f.db, 'im_agents', { agent_id: id(n), display_name: 'fixture', status: 'active', created_at: 1 });
  insert(f.db, 'im_conversations', { conversation_id: id(12), agent_low: id(10), agent_high: id(11), created_at: 1 });
  const data = Buffer.from('payload-é');
  insert(f.db, 'im_messages', { message_id: id(13), conversation_id: id(12), sender_id: id(10), recipient_id: id(11),
    client_message_id: `v2:${id(2)}:${id(14)}`, accepted_at: 10, title: null, text: '字é', correlation: '' });
  insert(f.db, 'im_attachments', { attachment_id: id(15), message_id: id(13), name: 'fixture.txt', mime: null,
    size: data.length, sha256: sha(data), data });
  insert(f.db, 'im_attachment_reservations', { attachment_id: id(15), message_id: id(13), size: data.length, sha256: sha(data) });
  const fingerprint = sha(JSON.stringify(['a2a-msg.im.v2', id(2), id(12), id(11), id(14), null, '字é',
    ['fixture.txt', null, data.length, sha(data)], null, '']));
  insert(f.db, 'im_send_keys', { sender_id: id(10), client_message_id: `v2:${id(2)}:${id(14)}`, payload_hash: fingerprint,
    message_id: id(13), created_at: 10, retry_until: 604800010, status: 'live' });
  insert(f.db, 'im_send_operation_keys', { sender_id: id(10), origin_epoch: id(2), client_message_id: id(14),
    storage_client_message_id: `v2:${id(2)}:${id(14)}`, source_protocol: 'a2a-msg.im.v2', message_id: id(13) });
  insert(f.db, 'im_content_state', { message_id: id(13), state: 'live', expires_at: 7776000010, policy_hash: ph });
  insert(f.db, 'im_receive_state', { agent_id: id(11), next_seq: 2, acked_through: 1, retained_floor: 1, stream_epoch: id(16) });
  insert(f.db, 'im_deliveries', { recipient_id: id(11), seq: 1, message_id: id(13), acked_at: 20, read_at: 21 });
  insert(f.db, 'im_sync_progress', { recipient_id: id(11), center_epoch: id(2), stream_epoch: id(16), handled_through: 1, updated_at: 21 });
  assertImSchemaV4Internal(f.db);
  return data;
}

function v1OperationFixture(f, originEpoch, { verify = true } = {}) {
  for (const n of [110, 111]) insert(f.db, 'im_agents', { agent_id: id(n), display_name: 'fixture', status: 'active', created_at: 1 });
  insert(f.db, 'im_conversations', { conversation_id: id(112), agent_low: id(110), agent_high: id(111), created_at: 1 });
  const message = { message_id: id(113), conversation_id: id(112), sender_id: id(110), recipient_id: id(111),
    client_message_id: id(114), accepted_at: 10, title: null, text: 'v1 historical', correlation: '' };
  insert(f.db, 'im_messages', message);
  const fingerprint = sha(JSON.stringify(['a2a-msg.im.v1', id(112), id(111), id(114), null, 'v1 historical', null, null, '']));
  insert(f.db, 'im_send_keys', { sender_id: id(110), client_message_id: id(114), payload_hash: fingerprint,
    message_id: id(113), created_at: 10, retry_until: 604800010, status: 'live' });
  insert(f.db, 'im_send_operation_keys', { sender_id: id(110), origin_epoch: originEpoch, client_message_id: id(114),
    storage_client_message_id: id(114), source_protocol: 'a2a-msg.im.v1', message_id: id(113) });
  insert(f.db, 'im_content_state', { message_id: id(113), state: 'live', expires_at: 7776000010, policy_hash: ph });
  insert(f.db, 'im_receive_state', { agent_id: id(111), next_seq: 2, acked_through: 1, retained_floor: 1, stream_epoch: id(116) });
  insert(f.db, 'im_deliveries', { recipient_id: id(111), seq: 1, message_id: id(113), acked_at: 20, read_at: 21 });
  insert(f.db, 'im_sync_progress', { recipient_id: id(111), center_epoch: id(2), stream_epoch: id(116), handled_through: 1, updated_at: 21 });
  if (verify) assertImSchemaV4Internal(f.db);
  return message.message_id;
}

test('constructor has only invalidate; zero SQLite statements/filesystem calls, native forms and branding', t => {
  const f = fixture(t), fsCalls = [];
  const methods = ['lstatSync', 'realpathSync', 'openSync', 'readFileSync', 'statSync', 'readdirSync'];
  const originals = Object.fromEntries(methods.map(k => [k, fs[k]]));
  calls.length = 0; observing = true;
  for (const k of methods) fs[k] = (...args) => { fsCalls.push(k); return originals[k](...args); };
  try {
    const rt = target({ db: f.db, databasePath: f.databasePath });
    assert.equal(Object.isFrozen(rt), true); assert.deepEqual(Object.keys(rt), ['invalidate']);
    assert.deepEqual(calls, []); assert.deepEqual(fsCalls, []);
    for (const db of [{}, Object.create(DatabaseSync.prototype), new Proxy(f.db, {})]) {
      assert.throws(() => target({ db, databasePath: f.databasePath }), error('INVALID'));
    }
    const copied = Object.create(DatabaseSync.prototype, Object.getOwnPropertyDescriptors(f.db));
    assert.throws(() => target({ db: copied, databasePath: f.databasePath }), error('INVALID'));
    const bound = Object.create(DatabaseSync.prototype);
    for (const name of ['isOpen', 'isTransaction']) Object.defineProperty(bound, name, {
      get: Object.getOwnPropertyDescriptor(f.db, name).get.bind(f.db), configurable: false });
    assert.throws(() => target({ db: bound, databasePath: f.databasePath }), error('INVALID'));
    for (const options of [{ db: f.db, databasePath: 'relative' }, { db: f.db, databasePath: f.databasePath, extra: true },
      { get db() { assert.fail('accessor'); }, databasePath: f.databasePath }]) assert.throws(() => target(options), error('INVALID'));
    for (const facade of [{}, { ...rt }, new Proxy(rt, {})]) assert.throws(() => scope(facade, ledger(), () => true), error('READ_UNAVAILABLE'));
    rt.invalidate(); assert.throws(() => scope(rt, ledger(), () => true), error('TARGET_STALE'));
  } finally { for (const k of methods) fs[k] = originals[k]; observing = false; }
});

test('Windows native target is truthfully unsupported before statements, with zero writes', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t);
  observed(f, () => assert.throws(() => scope(f.readTarget, ledger(), () => assert.fail('must not disclose')), error('READ_UNAVAILABLE')));
  assert.deepEqual(calls, []);
});

for (const mode of ['paused', 'enabled']) test(`native active ${mode} consistent read snapshot, fixed reads and exact observed ledger`, native, t => {
  const f = fixture(t, { mode }), l = ledger();
  observed(f, () => assert.equal(scope(f.readTarget, l, (session, same) => {
    assert.equal(same, l); assert.equal(f.db.isTransaction, true); assert.equal(session.identity.instanceId, id(1));
    assert.equal(session.identity.writeMode, mode); assert.equal(Object.isFrozen(session), true);
    assert.equal('db' in session, false); assert.equal('exec' in session, false);
    assert.deepEqual(session.nextContent('expire', 100), { complete: true, value: null });
    assert.deepEqual(session.nextContent('scrub', 100), { complete: true, value: null });
    let after = null;
    for (const n of [-1, 0, 1]) {
      const next = session.nextAudit(10, after); assert.deepEqual(next.value, [10, n]); after = next.value;
      const projection = session.projectAudit(n); assert.equal(projection.complete, true);
      assert.equal(projection.value.lengths.safe_details_json, Buffer.byteLength('{"é":"字"}'));
      const row = session.readProjected(projection.value); assert.equal(row.value.id, n);
      assert.equal(row.value.safe_details_json, '{"é":"字"}');
    }
    assert.deepEqual(session.nextAudit(10, after), { complete: true, value: null });
    assert.equal(session.readProjected(session.projectMessage(id(99)).value).value, null);
    return 'diagnostic';
  }), 'diagnostic'));
  assert.equal(calls.filter(x => x === 'BEGIN').length, 1); assert.equal(calls.filter(x => x === 'COMMIT').length, 1);
  assert.equal(f.db.isTransaction, false); assert.ok(l.stats().rows > 500); assert.equal(l.stats().tickets, 0);
  // Repeat genuine connection against its successfully bound identity.
  observed(f, () => assert.equal(scope(f.readTarget, ledger(), () => false), false));
});

test('config disabled/incomplete/raised limits reject without target queries', native, t => {
  const f = fixture(t);
  for (const change of [l => { l.config = { ...config, enabled: false }; }, l => { l.config = { enabled: true }; },
    l => { l.limits.maxScanRows = 10001; }]) {
    const l = ledger(); change(l);
    observed(f, () => assert.throws(() => scope(f.readTarget, l, () => assert.fail()), { message: 'Maintenance preview rejected' }));
    assert.deepEqual(calls, []);
  }
});

for (const suffix of ['-wal', '-shm', '-journal']) for (const value of ['', 'residue']) {
  test(`residue ${suffix} ${value || 'empty'} denied before SQL/recovery`, native, t => {
    const f = fixture(t); fs.writeFileSync(f.databasePath + suffix, value);
    // Even the TEST must not query a db with journal residue before the gate:
    // SQLite may recover/delete it. Observe filesystem directly for this path.
    const files = () => fs.readdirSync(f.dir).sort().map(n => [n, sha(fs.readFileSync(join(f.dir, n))),
      fs.statSync(join(f.dir, n), { bigint: true }).mtimeNs.toString()]);
    const before = files(); calls.length = 0; observing = true;
    try { assert.throws(() => scope(f.readTarget, ledger(), () => assert.fail()), error('READ_UNAVAILABLE')); }
    finally { observing = false; }
    assert.deepEqual(calls, []); assert.deepEqual(files(), before);
  });
}

test('closed connection / external transaction / wrong pathname preserve caller ownership', native, t => {
  const f = fixture(t);
  f.db.exec('BEGIN');
  observed(f, () => assert.throws(() => scope(f.readTarget, ledger(), () => true), error('READ_UNAVAILABLE')));
  assert.equal(f.db.isTransaction, true); assert.ok(!calls.includes('ROLLBACK')); f.db.exec('ROLLBACK');
  const otherPath = join(f.dir, 'other.db'); fs.copyFileSync(f.databasePath, otherPath); fs.chmodSync(otherPath, 0o600);
  const wrong = target({ db: f.db, databasePath: otherPath });
  observed(f, () => assert.throws(() => scope(wrong, ledger(), () => true), error('READ_UNAVAILABLE')));
  f.db.close(); assert.throws(() => scope(f.readTarget, ledger(), () => true), error('READ_UNAVAILABLE'));
});

for (const kind of ['symlink', 'hardlink', 'public-file', 'public-parent', 'wal-mode']) test(`unsafe ${kind} rejected`, native, t => {
  const f = fixture(t);
  if (kind === 'symlink') { fs.renameSync(f.databasePath, join(f.dir, 'original')); fs.symlinkSync(join(f.dir, 'original'), f.databasePath); }
  if (kind === 'hardlink') fs.linkSync(f.databasePath, join(f.dir, 'hardlink'));
  if (kind === 'public-file') fs.chmodSync(f.databasePath, 0o644);
  if (kind === 'public-parent') fs.chmodSync(f.dir, 0o777);
  if (kind === 'wal-mode') f.db.exec('PRAGMA journal_mode=WAL');
  assert.throws(() => scope(f.readTarget, ledger(), () => true), error('READ_UNAVAILABLE'));
});

test('schema3, wrong marker2, schema5 marker and extra objects reject without conversion', native, t => {
  const old = fixture(t, { version: 3 });
  observed(old, () => assert.throws(() => scope(old.readTarget, ledger(), () => true), error('SCHEMA_UNSUPPORTED')));
  for (const sql of ["CREATE TABLE extra(x)", "PRAGMA ignore_check_constraints=ON; UPDATE im_schema SET version=5",
    "DROP TABLE im_schema; CREATE TABLE im_schema(version INTEGER); INSERT INTO im_schema VALUES(2)"]) {
    const f = fixture(t); f.db.exec(sql);
    observed(f, () => assert.throws(() => scope(f.readTarget, ledger(), () => true), error('SCHEMA_UNSUPPORTED')));
  }
});

test('actual independent client journal v2 rejects without bytes/schema/business conversion', native, t => {
  const f = journalFixture(t);
  f.readTarget = target({ db: f.db, databasePath: f.databasePath });
  f.beforeClose.push(() => f.readTarget.invalidate());
  observed(f, () => assert.throws(() => scope(f.readTarget, ledger(), () => assert.fail('journal disclosed')), error('SCHEMA_UNSUPPORTED')));
  assert.equal(f.db.isTransaction, false);
});

for (const kind of ['v3_import', 'snapshot_recovery']) for (const mode of ['paused', 'enabled']) {
  test(`native real P1/P5 active ${kind}/${mode} retains receiver and recovery relations`, native, async t => {
    const f = await activeFixture(t, kind, mode);
    f.readTarget = target({ db: f.db, databasePath: f.databasePath });
    f.beforeClose.push(() => f.readTarget.invalidate());
    const l = ledger();
    l.config = parseImV2Config({ ...config, writeMode: mode,
      retention: { policy: f.policy, policyHash: sha(JSON.stringify(f.policy)) } });
    observed(f, () => assert.equal(scope(f.readTarget, l, s => {
      assert.equal(s.identity.centerEpoch, f.state.center_epoch);
      assert.equal(s.identity.writeMode, mode);
      assert.equal(s.identity.executionPolicyHash, sha(JSON.stringify(f.policy)));
      const next = s.nextContent('expire', Number.MAX_SAFE_INTEGER);
      assert.equal(next.complete, true); assert.ok(next.value);
      const row = s.readProjected(s.projectMessage(next.value[1]).value).value;
      assert.equal(row.message_id, next.value[1]);
      return 'real-active';
    }), 'real-active'));
    assert.equal(f.db.isTransaction, false); assert.equal(l.stats().tickets, 0);
  });
}

for (const status of ['prepared', 'verified']) test(`P5 ${status} and fake active words are not active trust`, native, t => {
  const f = fixture(t);
  f.db.exec(`PRAGMA ignore_check_constraints=ON; UPDATE im_center_state SET status='${status}',activation_ref=NULL`);
  observed(f, () => assert.throws(() => scope(f.readTarget, ledger(), () => true), error('DISABLED')));
  f.db.exec("UPDATE im_center_state SET status='active',activation_ref='activation'; UPDATE im_recovery_runs SET auth_review_ref=NULL");
  observed(f, () => assert.throws(() => scope(f.readTarget, ledger(), () => true), error('READ_UNAVAILABLE')));
});

test('trust row/byte/time budget failure discloses no IDs and installs no binding', native, t => {
  const f = fixture(t);
  for (const options of [{ maxScanRows: 1 }, { maxScanBytes: 1 }]) {
    observed(f, () => assert.throws(() => scope(f.readTarget, ledger(options), () => assert.fail('untrusted callback')), error('READ_UNAVAILABLE')));
  }
  const timed = ledger(); timed.stop();
  observed(f, () => assert.throws(() => scope(f.readTarget, timed, () => assert.fail()), error('READ_UNAVAILABLE')));
  f.db.prepare('UPDATE im_instance_identity SET instance_id=?').run(id(8));
  observed(f, () => assert.equal(scope(f.readTarget, ledger(), s => s.identity.instanceId), id(8)));
});

test('SQL blob is length-projected; oversized SQL cannot be read without budget', native, t => {
  const f = fixture(t);
  f.db.exec(`DROP INDEX im_content_expiry; CREATE VIEW extra AS SELECT '${'x'.repeat(200000)}' AS value`);
  observed(f, () => assert.throws(() => scope(f.readTarget, ledger({ maxScanBytes: 80000 }), () => assert.fail()), error('READ_UNAVAILABLE')));
  const retrievals = calls.filter(sql => sql.startsWith('SELECT CAST(sql AS BLOB)'));
  assert.ok(calls.some(sql => sql.includes('length(CAST(sql AS BLOB))')));
  assert.ok(retrievals.length > 0);
});

for (const mutation of ['cookie', 'birth', 'epoch', 'rename', 'replace']) test(`bound target ${mutation} drift cannot rebind`, native, t => {
  const f = fixture(t); scope(f.readTarget, ledger(), () => true);
  if (mutation === 'cookie') f.db.exec('PRAGMA schema_version=999');
  if (mutation === 'birth') f.db.exec('UPDATE im_instance_identity SET created_at=2');
  if (mutation === 'epoch') { f.db.exec('PRAGMA foreign_keys=OFF'); f.db.prepare('UPDATE im_center_state SET center_epoch=?').run(id(9)); }
  if (mutation === 'rename' || mutation === 'replace') {
    fs.renameSync(f.databasePath, join(f.dir, 'old'));
    if (mutation === 'replace') { fs.copyFileSync(join(f.dir, 'old'), f.databasePath); fs.chmodSync(f.databasePath, 0o600); }
  }
  assert.throws(() => scope(f.readTarget, ledger(), () => true), { message: 'Maintenance preview rejected' });
});

test('known async/async generator zero-prefix, returned thenables/rejections/throwing then and falsy throws', native, async t => {
  const f = fixture(t); let prefixes = 0;
  for (const fn of [async () => { prefixes++; }, async function* () { prefixes++; }]) {
    observed(f, () => assert.throws(() => scope(f.readTarget, ledger(), fn), error('INVALID')));
    assert.deepEqual(calls, []);
  }
  assert.equal(prefixes, 0);
  for (const value of [Promise.reject(new Error('private')), { then(resolve, reject) { reject('private'); } },
    { get then() { throw new Error('private'); } }]) {
    observed(f, () => assert.throws(() => scope(f.readTarget, ledger(), () => value), error('INVALID')));
    assert.ok(calls.includes('ROLLBACK'));
  }
  for (const value of [null, undefined, 0, false, '', new Proxy({}, { get() { throw new Error('must not inspect'); } })]) {
    observed(f, () => assert.throws(() => scope(f.readTarget, ledger(), () => { throw value; }), error('READ_UNAVAILABLE')));
  }
  await new Promise(resolve => setImmediate(resolve));
  observed(f, () => assert.equal(scope(f.readTarget, ledger(), () => 0), 0));
});

test('expired session, caught faults, token forgery, reentry and invalidation poison outer', native, t => {
  const f = fixture(t); let escaped;
  scope(f.readTarget, ledger(), s => { escaped = s; });
  assert.throws(() => escaped.nextAudit(10), error('READ_UNAVAILABLE'));
  const other = target({ db: f.db, databasePath: f.databasePath });
  observed(f, () => assert.throws(() => scope(other, ledger(), () => {
    assert.throws(() => escaped.nextAudit(10)); return true;
  }), error('READ_UNAVAILABLE')));
  for (const fault of [s => s.projectMessage('bad'), s => s.readProjected({}), () => escaped.nextAudit(10),
    () => scope(f.readTarget, ledger(), () => true), () => scope(other, ledger(), () => true)]) {
    observed(f, () => assert.throws(() => scope(f.readTarget, ledger(), s => {
      assert.throws(() => fault(s)); return s.identity;
    }), { message: 'Maintenance preview rejected' }));
  }
  observed(f, () => assert.throws(() => scope(f.readTarget, ledger(), () => { f.readTarget.invalidate(); return true; }), error('TARGET_STALE')));
  assert.throws(() => scope(f.readTarget, ledger(), () => true), error('TARGET_STALE'));
});

test('genuine projection tokens are one-use and expire across genuine sessions', native, t => {
  const f = fixture(t); let retained;
  observed(f, () => scope(f.readTarget, ledger(), s => { retained = s.projectAudit(-1).value; }));
  observed(f, () => fixedFailure(() => scope(f.readTarget, ledger(), s => {
    fixedFailure(() => s.readProjected(retained), 'INVALID');
    return 'caught-old-token';
  }), 'INVALID'));
  observed(f, () => fixedFailure(() => scope(f.readTarget, ledger(), s => {
    const token = s.projectAudit(-1).value;
    assert.equal(s.readProjected(token).value.id, -1);
    fixedFailure(() => s.readProjected(token), 'INVALID');
    return 'caught-used-token';
  }), 'INVALID'));
  assert.equal(f.db.isTransaction, false);
});

test('planner exhaustion is an explicit incomplete value, with final trust escrow retained', native, t => {
  const f = fixture(t), l = ledger({ maxScanRows: 3000 });
  observed(f, () => {
    const result = scope(f.readTarget, l, s => {
      let next;
      do { next = s.nextAudit(10); } while (next.complete);
      assert.equal(next.stopReason, 'SCAN_ROWS'); return next;
    });
    assert.deepEqual(result, { complete: false, stopReason: 'SCAN_ROWS' });
  });
  assert.equal(l.stats().tickets, 0); assert.ok(l.stats().rows <= 3000);
});

test('caught session SQL fault and caller transaction interference never succeed; cleanup preserves open DB', native, t => {
  const f = fixture(t);
  observed(f, () => assert.throws(() => scope(f.readTarget, ledger(), s => {
    onStatement = sql => { if (sql.includes('FROM main.im_audit WHERE')) throw new Proxy({}, { get() { assert.fail('inspect'); } }); };
    assert.throws(() => s.nextAudit(10)); onStatement = null; return s.identity;
  }), error('READ_UNAVAILABLE')));
  observed(f, () => assert.throws(() => scope(f.readTarget, ledger(), () => { f.db.exec('ROLLBACK'); return true; }), error('READ_UNAVAILABLE')));
  assert.equal(f.db.isOpen, true);
});

test('final trust budget/time and native cleanup failure cannot return success', native, t => {
  const f = fixture(t), l = ledger();
  observed(f, () => assert.throws(() => scope(f.readTarget, l, () => { l.stop(); return true; }), error('READ_UNAVAILABLE')));
  observed(f, () => {
    onStatement = sql => { if (sql === 'COMMIT') throw Error('private commit error'); };
    assert.throws(() => scope(f.readTarget, ledger(), () => true), error('READ_UNAVAILABLE'));
    onStatement = null;
  });
  assert.equal(f.db.isTransaction, false);
});

// Public adapter instrumentation: identify escrow by the actual outstanding
// reservation carried through legitimate consume, not by reservation size, a
// settle-call ordinal, a source line, or a private target/account field.
function finalSettlementLedger(f, inject) {
  const l = ledger(), reserve = l.reserve, settle = l.settle;
  const live = new Set(), reservations = [], settlements = [], phases = [];
  let escrow, consumed = false, finalCalls = 0;
  l.reserve = function (r, b) {
    const ticket = reserve.call(this, r, b);
    if (typeof ticket === 'object') { live.add(ticket); reservations.push(ticket); }
    return ticket;
  };
  l.settle = function (ticket, r, b) {
    const isEscrow = ticket === escrow;
    phases.push({ isEscrow, consumed, transaction: f.db.isTransaction,
      committed: calls.includes('COMMIT'), live: live.size });
    settlements.push({ ticket, r, b });
    settle.call(this, ticket, r, b); live.delete(ticket);
    if (isEscrow) { finalCalls++; inject?.(); }
  };
  return {
    l,
    consume(s) {
      assert.equal(f.db.isTransaction, true);
      assert.equal(s.identity.instanceId, id(1));
      assert.deepEqual(s.nextAudit(10).value, [10, -1]);
      assert.equal(s.readProjected(s.projectAudit(-1).value).value.id, -1);
      assert.equal(live.size, 1, 'only retained final-trust escrow remains after legitimate session reads');
      [escrow] = live; consumed = true;
      return 'legitimate-result';
    },
    verify() {
      assert.equal(consumed, true, 'initial trust and real session reads completed');
      assert.equal(finalCalls, 1, 'injection ran on the SAME retained escrow ticket exactly once');
      assert.equal(settlements.at(-1).ticket, escrow, 'final callback is final escrow release, not earlier row settlement');
      assert.deepEqual(phases.at(-1), { isEscrow: true, consumed: true, transaction: false, committed: true, live: 1 });
      assert.ok(phases.slice(0, -1).some(x => !x.isEscrow && x.transaction), 'routine settlements independently observed');
      assert.equal(new Set(reservations).size, reservations.length);
      assert.equal(new Set(settlements.map(x => x.ticket)).size, reservations.length);
      assert.equal(live.size, 0);
      const totals = settlements.reduce((a, x) => {
        assert.ok(reservations.includes(x.ticket));
        assert.ok(Number.isSafeInteger(x.r) && x.r >= 0 && x.r <= x.ticket.r);
        assert.ok(Number.isSafeInteger(x.b) && x.b >= 0 && x.b <= x.ticket.b);
        return { rows: a.rows + x.r, bytes: a.bytes + x.b };
      }, { rows: 0, bytes: 0 });
      assert.ok(settlements.at(-1).r > 0 && settlements.at(-1).b > 0, 'escrow accounts actual final trust reads');
      assert.deepEqual(l.stats(), { ...totals, heldRows: 0, heldBytes: 0, tickets: 0 });
      assert.equal(f.db.isOpen, true); assert.equal(f.db.isTransaction, false);
      assert.equal(calls.filter(sql => sql === 'BEGIN').length, 1);
      assert.equal(calls.filter(sql => sql === 'COMMIT').length, 1);
      return totals;
    },
  };
}

function fixedFailure(call, suffix) {
  let caught;
  try { call(); } catch (e) { caught = e; }
  assert.ok(caught instanceof Error);
  assert.equal(caught.code, `MAINTENANCE_${suffix}`);
  assert.equal(caught.message, 'Maintenance preview rejected');
  assert.equal(Object.hasOwn(caught, 'cause'), false);
  assert.deepEqual(Object.keys(caught), ['code']);
  return caught;
}

for (const scenario of ['same-target', 'same-db-facade', 'invalidate', 'expired-session', 'normal']) {
  test(`EXACT final escrow settlement ${scenario}: poison/cleanup/accounting/first-binding`, native, t => {
    const f = fixture(t), other = target({ db: f.db, databasePath: f.databasePath });
    let expired, nestedError, callbackRan = false;
    if (scenario === 'expired-session') {
      // Bind another genuine facade only. The target under test still has never
      // established a binding, and the session is expired before its first use.
      scope(other, ledger(), s => { expired = s; });
      fixedFailure(() => expired.nextAudit(10), 'READ_UNAVAILABLE');
    }
    const watch = finalSettlementLedger(f, () => {
      callbackRan = true;
      if (scenario === 'invalidate') f.readTarget.invalidate();
      else if (scenario !== 'normal') {
        try {
          if (scenario === 'expired-session') expired.nextAudit(10);
          else scope(scenario === 'same-target' ? f.readTarget : other, ledger(), () => assert.fail('nested consume'));
        } catch (e) { nestedError = e; } // Deliberately caught at the final cleanup callback.
      }
    });
    observed(f, () => {
      if (scenario === 'normal') assert.equal(scope(f.readTarget, watch.l, watch.consume), 'legitimate-result');
      else fixedFailure(() => scope(f.readTarget, watch.l, watch.consume), scenario === 'invalidate' ? 'TARGET_STALE' : 'READ_UNAVAILABLE');
    });
    assert.equal(callbackRan, true);
    const charged = watch.verify();
    if (!['normal', 'invalidate'].includes(scenario)) {
      assert.ok(nestedError instanceof Error); assert.deepEqual({ code: nestedError.code, message: nestedError.message }, error('READ_UNAVAILABLE'));
      assert.equal(Object.hasOwn(nestedError, 'cause'), false);
    }
    if (scenario === 'invalidate') {
      observed(f, () => fixedFailure(() => scope(f.readTarget, ledger(), () => assert.fail()), 'TARGET_STALE'));
      assert.deepEqual(calls, [], 'irreversible invalidation never consults or discloses a binding');
      // Same connection is released from active-scope bookkeeping, still open,
      // and usable by the independent genuine facade after the failed cleanup.
      observed(f, () => assert.equal(scope(other, ledger(), () => 'released'), 'released'));
    } else {
      // TEST ONLY between-scope cookie experiment: same protected file, native
      // object and exclusive owner; no close/reopen/rename/epoch fabrication.
      // Failed first establishment must have no binding to this prior cookie.
      // The normal-success control MUST reject this identical change as stale.
      const cookie = f.db.prepare('PRAGMA schema_version').get().schema_version;
      f.db.exec(`PRAGMA schema_version=${cookie + 1}`);
      assertImSchemaV4Internal(f.db);
      if (scenario === 'normal') {
        observed(f, () => fixedFailure(() => scope(f.readTarget, ledger(), () => assert.fail('rebound')), 'TARGET_STALE'));
      } else {
        const retry = finalSettlementLedger(f);
        observed(f, () => assert.equal(scope(f.readTarget, retry.l, retry.consume), 'legitimate-result'));
        assert.deepEqual(retry.verify(), charged, 'failed and successful final release settle exact identical observed work');
      }
    }
    other.invalidate();
  });
}

test('length/detail read charging equals independent typed-frame oracle', native, t => {
  const f = fixture(t), l = ledger();
  observed(f, () => scope(f.readTarget, l, s => {
    const before = l.stats();
    const projection = s.projectAudit(-1);
    const projected = l.stats();
    const row = s.readProjected(projection.value).value;
    const after = l.stats();
    assert.equal(projected.rows - before.rows, 1); assert.equal(after.rows - projected.rows, 1);
    assert.equal(after.bytes - projected.bytes, fsize(Object.values(row)));
    assert.ok(projected.bytes > before.bytes);
  }));
});

test('fixed historical epoch projection returns actual origin, exact charges and no writes', native, t => {
  const f = fixture(t), historical = id(90), l = ledger();
  insert(f.db, 'im_center_epochs', { center_epoch: historical, created_at: 17, origin: 'v3_import', recovery_counter: 0 });
  const messageId = v1OperationFixture(f, historical);
  observed(f, () => scope(f.readTarget, l, s => {
    assert.notEqual(historical, s.identity.centerEpoch);
    const operation = s.readProjected(s.projectOperation(messageId).value).value;
    assert.equal(operation.source_protocol, 'a2a-msg.im.v1'); assert.equal(operation.origin_epoch, historical);
    const before = l.stats(), projected = s.projectEpoch(historical);
    assert.equal(projected.complete, true); assert.equal(projected.value.present, true);
    assert.equal(Object.isFrozen(projected.value), true);
    const middle = l.stats(), materialized = s.readProjected(projected.value);
    assert.equal(materialized.complete, true);
    assert.deepEqual({ ...materialized.value }, {
      center_epoch: historical, created_at: 17, origin: 'v3_import', recovery_counter: 0 });
    assert.equal(Object.isFrozen(materialized.value), true);
    const after = l.stats();
    assert.equal(middle.rows - before.rows, 1);
    assert.equal(after.rows - middle.rows, 1);
    assert.equal(after.bytes - middle.bytes, fsize(Object.values(materialized.value)));
    assert.ok(middle.bytes > before.bytes);
    assert.equal(materialized.value.center_epoch, operation.origin_epoch);
    assert.equal(materialized.value.origin, 'v3_import');
  }));
  assert.deepEqual(l.stats(), { ...l.stats(), heldRows: 0, heldBytes: 0, tickets: 0 });
});

test('real v3 import exposes historical v1 operation epoch distinctly from active epoch', native, async t => {
  const f = await activeFixture(t, 'v3_import', 'paused');
  const p1 = f.db.prepare("SELECT message_id,origin_epoch,source_protocol FROM im_send_operation_keys WHERE source_protocol='a2a-msg.im.v1' LIMIT 1").get();
  assert.ok(p1, 'real migrated v1 operation must exist');
  assert.notEqual(p1.origin_epoch, f.state.center_epoch);
  const actual = f.db.prepare('SELECT center_epoch,created_at,origin,recovery_counter FROM im_center_epochs WHERE center_epoch=?').get(p1.origin_epoch);
  assert.equal(actual.origin, 'v3_import');
  assert.equal(assertImSchemaV4Internal(f.db), true);
  f.readTarget = target({ db: f.db, databasePath: f.databasePath });
  f.beforeClose.push(() => f.readTarget.invalidate());
  const l = ledger();
  l.config = parseImV2Config({ ...config, retention: { policy: f.policy, policyHash: sha(JSON.stringify(f.policy)) } });
  observed(f, () => scope(f.readTarget, l, s => {
    const operation = s.readProjected(s.projectOperation(p1.message_id).value).value;
    assert.equal(operation.origin_epoch, p1.origin_epoch);
    assert.equal(operation.source_protocol, 'a2a-msg.im.v1');
    const projection = s.projectEpoch(operation.origin_epoch);
    assert.equal(projection.complete, true);
    assert.equal(projection.value.present, true);
    const epoch = s.readProjected(projection.value).value;
    assert.deepEqual({ ...epoch }, { ...actual });
    assert.notEqual(epoch.center_epoch, s.identity.centerEpoch);
    assert.equal(epoch.origin, 'v3_import');
  }));
});

test('missing epoch is a null fixed-PK projection, not a trust rejection', native, t => {
  const f = fixture(t), missing = id(91);
  assert.equal(f.db.prepare('SELECT center_epoch FROM im_center_epochs WHERE center_epoch=?').get(missing), undefined);
  observed(f, () => scope(f.readTarget, ledger(), s => {
    const projection = s.projectEpoch(missing);
    assert.equal(projection.complete, true); assert.equal(projection.value.present, false);
    assert.deepEqual(s.readProjected(projection.value), { complete: true, value: null });
  }));
});

test('orphaned non-current v1 operation projects a missing epoch without pretending P1 validation', native, t => {
  const f = fixture(t), missing = id(93);
  // Establish a lawful control first; corruption is deliberately test-owned and occurs before observation.
  insert(f.db, 'im_center_epochs', { center_epoch: missing, created_at: 7, origin: 'v3_import', recovery_counter: 0 });
  const messageId = v1OperationFixture(f, missing);
  f.db.exec('PRAGMA foreign_keys=OFF');
  f.db.prepare('DELETE FROM im_center_epochs WHERE center_epoch=?').run(missing);
  f.db.exec('PRAGMA foreign_keys=ON');
  assert.equal(f.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.equal(f.db.prepare('SELECT center_epoch FROM im_center_epochs WHERE center_epoch=?').get(missing), undefined);
  assert.equal(f.db.prepare('SELECT origin_epoch FROM im_send_operation_keys WHERE message_id=?').get(messageId).origin_epoch, missing);
  assert.ok(f.db.prepare('PRAGMA foreign_key_check').get(), 'test corruption succeeded');
  observed(f, () => scope(f.readTarget, ledger(), s => {
    const operation = s.readProjected(s.projectOperation(messageId).value).value;
    assert.equal(operation.origin_epoch, missing);
    const projection = s.projectEpoch(operation.origin_epoch);
    assert.equal(projection.value.present, false);
    assert.deepEqual(s.readProjected(projection.value), { complete: true, value: null });
  }));
});

test('nonimport origin is exposed, leaving v1 provenance judgment to consumer', native, t => {
  const f = fixture(t), epoch = id(92);
  insert(f.db, 'im_center_epochs', { center_epoch: epoch, created_at: 8, origin: 'v3_import', recovery_counter: 0 });
  const messageId = v1OperationFixture(f, epoch); // full P1 lawful baseline, including provenance
  const before = f.db.prepare('SELECT center_epoch,created_at,origin,recovery_counter FROM im_center_epochs WHERE center_epoch=?').get(epoch);
  const operationBefore = f.db.prepare('SELECT * FROM im_send_operation_keys WHERE message_id=?').get(messageId);
  assert.equal(before.origin, 'v3_import');
  assert.notEqual(epoch, f.db.prepare('SELECT center_epoch FROM im_center_state').get().center_epoch);
  // Test-owned FK-valid corruption changes only the historical epoch's origin.
  assert.equal(f.db.prepare('UPDATE im_center_epochs SET origin=? WHERE center_epoch=?').run('fresh', epoch).changes, 1);
  assert.deepEqual({ ...f.db.prepare('SELECT center_epoch,created_at,origin,recovery_counter FROM im_center_epochs WHERE center_epoch=?').get(epoch) },
    { ...before, origin: 'fresh' });
  assert.deepEqual(f.db.prepare('SELECT * FROM im_send_operation_keys WHERE message_id=?').get(messageId), operationBefore);
  assert.equal(f.db.prepare('PRAGMA foreign_key_check').get(), undefined);
  observed(f, () => scope(f.readTarget, ledger(), s => {
    const operation = s.readProjected(s.projectOperation(messageId).value).value;
    assert.equal(operation.source_protocol, 'a2a-msg.im.v1');
    assert.equal(operation.origin_epoch, epoch);
    const actual = s.readProjected(s.projectEpoch(operation.origin_epoch).value).value;
    assert.equal(actual.center_epoch, operation.origin_epoch);
    assert.equal(actual.origin, 'fresh');
    assert.notEqual(actual.origin, 'v3_import'); // consumer rejects a v1 operation referring to this epoch
  }));
});

test('epoch UUID validation and projection session ownership poison caught faults', native, t => {
  const f = fixture(t); let escaped, old;
  observed(f, () => scope(f.readTarget, ledger(), s => { escaped = s; old = s.projectEpoch(id(2)).value; }));
  fixedFailure(() => escaped.projectEpoch(id(2)), 'READ_UNAVAILABLE');
  for (const bad of [null, '', 'AAAAAAAA-0000-0000-0000-000000000002', { center_epoch: id(2) }, id(2) + 'x']) {
    observed(f, () => fixedFailure(() => scope(f.readTarget, ledger(), s => {
      fixedFailure(() => s.projectEpoch(bad), 'INVALID');
      return 'caught';
    }), 'INVALID'));
  }
  observed(f, () => fixedFailure(() => scope(f.readTarget, ledger(), s => {
    fixedFailure(() => s.readProjected(old), 'INVALID');
  }), 'INVALID'));
  observed(f, () => scope(f.readTarget, ledger(), s => {
    const token = s.projectEpoch(id(2)).value;
    assert.equal(s.readProjected(token).value.center_epoch, id(2));
  }));
});

test('epoch projected length reserves bytes before materialization', native, t => {
  const f = fixture(t), l = ledger(), reserve = l.reserve;
  let requested = false;
  l.reserve = function (rows, bytes) {
    if (requested && rows === 1 && bytes > 100) return 'SCAN_BYTES';
    return reserve.call(this, rows, bytes);
  };
  observed(f, () => scope(f.readTarget, l, s => {
    const projection = s.projectEpoch(id(2));
    assert.equal(projection.complete, true);
    assert.equal(projection.value.present, true);
    const statementsBefore = calls.length;
    const before = l.stats();
    requested = true;
    assert.deepEqual(s.readProjected(projection.value), { complete: false, stopReason: 'SCAN_BYTES' });
    requested = false;
    assert.equal(calls.length, statementsBefore, 'budget rejection appends zero SQL statements before final trust');
    assert.deepEqual(l.stats(), before, 'blocked materialization charges no unperformed row or bytes');
    const control = s.readProjected(projection.value);
    assert.equal(control.complete, true);
    assert.equal(control.value.center_epoch, id(2));
    assert.ok(calls.slice(statementsBefore).some(sql => sql.includes('FROM main.im_center_epochs WHERE center_epoch=? LIMIT 1') &&
      sql.includes('CAST(center_epoch AS BLOB) AS center_epoch')), 'positive control materializes actual epoch SELECT');
    assert.equal(l.stats().rows - before.rows, 1);
    assert.equal(l.stats().bytes - before.bytes, fsize(Object.values(control.value)));
  }));
  assert.ok(calls.some(sql => sql.includes('length(CAST(origin AS BLOB))')));
  assert.equal(l.stats().tickets, 0);
});

test('message dependency projection uses only three columns and charges exact rows/bytes', native, t => {
  const f = fixture(t), l = ledger();
  contentFixture(f);
  const heavy = '字'.repeat(100), body = '字'.repeat(10000), parentId = id(40), childId = id(41);
  insert(f.db, 'im_messages', { message_id: parentId, conversation_id: id(12), sender_id: id(10), recipient_id: id(11),
    client_message_id: id(42), accepted_at: 11, title: heavy, text: body, correlation: heavy });
  insert(f.db, 'im_messages', { message_id: childId, conversation_id: id(12), sender_id: id(10), recipient_id: id(11),
    client_message_id: id(43), accepted_at: 12, in_reply_to: parentId, title: heavy, text: body, correlation: heavy });
  const expected = ['message_id', 'conversation_id', 'in_reply_to'];
  observed(f, () => scope(f.readTarget, l, s => {
    for (const [key, reply] of [[parentId, null], [childId, parentId]]) {
      const before = l.stats(), start = calls.length;
      const projection = s.projectMessageDependencies(key);
      assert.equal(projection.complete, true); assert.equal(projection.value.present, true);
      assert.deepEqual(Object.keys(projection.value.lengths), expected);
      assert.equal(projection.value.lengths.in_reply_to, reply === null ? null : 36);
      const projected = l.stats(), midpoint = calls.length;
      const materialized = s.readProjected(projection.value);
      assert.equal(materialized.complete, true);
      assert.deepEqual(Object.keys(materialized.value), expected);
      assert.deepEqual({ ...materialized.value }, { message_id: key, conversation_id: id(12), in_reply_to: reply });
      assert.ok(Object.isFrozen(materialized.value));
      const after = l.stats();
      assert.equal(projected.rows - before.rows, 1); assert.equal(after.rows - projected.rows, 1);
      assert.equal(after.bytes - projected.bytes, fsize(Object.values(materialized.value)));
      // The native metadata probe returns three (typeof, byte-length, is-null)
      // triples, in descriptor order. Compute its F-frame independently from
      // literal column facts, not from the returned token or ledger delta.
      const metadata = ['text', 36, 0, 'text', 36, 0,
        reply === null ? 'null' : 'text', reply === null ? 0 : 36, reply === null ? 1 : 0];
      const expectedProjectionBytes = fsize(metadata);
      assert.equal(expectedProjectionBytes, reply === null ? 44 : 45);
      assert.equal(projected.bytes - before.bytes, expectedProjectionBytes);
      assert.equal(after.bytes - before.bytes, expectedProjectionBytes + fsize([key, id(12), reply]));
      const projectionSql = calls.slice(start, midpoint), materialSql = calls.slice(midpoint);
      assert.equal(projectionSql.length, 1); assert.equal(materialSql.length, 1);
      for (const sql of [...projectionSql, ...materialSql]) {
        assert.match(sql, /FROM main\.im_messages WHERE message_id=\? LIMIT 1/);
        assert.doesNotMatch(sql, /\b(?:title|correlation|data)\b|\btext\s*(?:\)|,|\bAS\b)|SELECT \*/i);
      }
      assert.match(projectionSql[0], /length\(CAST\(in_reply_to AS BLOB\)\)/);
      assert.match(materialSql[0], reply === null ? /,in_reply_to FROM/ : /CAST\(in_reply_to AS BLOB\) AS in_reply_to/);
    }
    const absent = s.projectMessageDependencies(id(99));
    assert.deepEqual({ complete: absent.complete, present: absent.value.present }, { complete: true, present: false });
    assert.deepEqual(s.readProjected(absent.value), { complete: true, value: null });
    assert.equal(s.readProjected(s.projectMessageDependencies(id(13)).value).value.in_reply_to, null);
  }));
  assert.equal(l.stats().tickets, 0);
});

test('message dependency materialization refuses B-1 reservation then succeeds at B', native, t => {
  const f = fixture(t); contentFixture(f);
  const l = ledger(), reserve = l.reserve;
  let required, cap = Infinity;
  l.reserve = function (rows, bytes) {
    if (cap !== Infinity && bytes > cap) return 'SCAN_BYTES';
    return reserve.call(this, rows, bytes);
  };
  observed(f, () => scope(f.readTarget, l, s => {
    const token = s.projectMessageDependencies(id(13)).value;
    assert.equal(token.present, true);
    required = 2 + String(3).length + 24 * 3 + 36 + 36; // existing fixed arrayBound for three columns
    const before = l.stats(), statements = calls.length;
    cap = required - 1;
    assert.deepEqual(s.readProjected(token), { complete: false, stopReason: 'SCAN_BYTES' });
    assert.equal(calls.length, statements);
    assert.deepEqual(l.stats(), before);
    cap = required;
    const success = s.readProjected(token);
    assert.equal(success.complete, true); assert.equal(success.value.message_id, id(13));
    assert.equal(calls.length, statements + 1);
    assert.equal(l.stats().rows - before.rows, 1);
    assert.equal(l.stats().bytes - before.bytes, fsize(Object.values(success.value)));
    cap = Infinity;
  }));
  assert.equal(l.stats().tickets, 0);
});

test('message dependencies expose mismatched parent conversation, without global validation', native, t => {
  const f = fixture(t); contentFixture(f);
  insert(f.db, 'im_agents', { agent_id: id(55), display_name: 'fixture', status: 'active', created_at: 1 });
  insert(f.db, 'im_conversations', { conversation_id: id(50), agent_low: id(10), agent_high: id(55), created_at: 1 });
  insert(f.db, 'im_messages', { message_id: id(51), conversation_id: id(50), sender_id: id(10), recipient_id: id(55),
    client_message_id: id(52), accepted_at: 11, title: null, text: 'parent', correlation: '' });
  insert(f.db, 'im_messages', { message_id: id(53), conversation_id: id(12), sender_id: id(10), recipient_id: id(11),
    client_message_id: id(54), accepted_at: 12, in_reply_to: id(51), title: null, text: 'child', correlation: '' });
  observed(f, () => scope(f.readTarget, ledger(), s => {
    const child = s.readProjected(s.projectMessageDependencies(id(53)).value).value;
    const parent = s.readProjected(s.projectMessageDependencies(child.in_reply_to).value).value;
    assert.equal(child.in_reply_to, parent.message_id);
    assert.notEqual(parent.conversation_id, child.conversation_id); // future planner must reject
  }));
});

test('dependency projection canonical input and same-session token ownership poison caught faults', native, t => {
  const f = fixture(t); contentFixture(f);
  let expired, prior;
  observed(f, () => scope(f.readTarget, ledger(), s => {
    expired = s; prior = s.projectMessageDependencies(id(13)).value;
  }));
  fixedFailure(() => expired.projectMessageDependencies(id(13)), 'READ_UNAVAILABLE');
  for (const bad of [null, '', 'AAAAAAAA-0000-0000-0000-000000000013', { message_id: id(13) }, id(13) + 'x']) {
    observed(f, () => fixedFailure(() => scope(f.readTarget, ledger(), s => {
      fixedFailure(() => s.projectMessageDependencies(bad), 'INVALID');
    }), 'INVALID'));
  }
  observed(f, () => fixedFailure(() => scope(f.readTarget, ledger(), s => {
    fixedFailure(() => s.readProjected(prior), 'INVALID');
  }), 'INVALID'));
  observed(f, () => fixedFailure(() => scope(f.readTarget, ledger(), s => {
    fixedFailure(() => s.readProjected({ present: true }), 'INVALID');
  }), 'INVALID'));
  observed(f, () => fixedFailure(() => scope(f.readTarget, ledger(), s => {
    const token = s.projectMessageDependencies(id(13)).value;
    assert.equal(s.readProjected(token).value.message_id, id(13));
    fixedFailure(() => s.readProjected(token), 'INVALID');
  }), 'INVALID'));
});

test('fixed content point operations and bounded payload retrieval; module never opens/filesyncs files', native, t => {
  const f = fixture(t), payload = contentFixture(f);
  const original = {}, forbidden = ['openSync', 'readFileSync', 'writeFileSync', 'fsyncSync', 'fdatasyncSync', 'unlinkSync', 'renameSync', 'chmodSync'];
  const before = image(f);
  for (const k of forbidden) { original[k] = fs[k]; fs[k] = () => assert.fail(`module invoked ${k}`); }
  try {
    scope(f.readTarget, ledger(), s => {
      assert.deepEqual(s.nextContent('expire', 7776000010).value, [7776000010, id(13)]);
      assert.equal(s.nextContent('expire', 7776000010, [7776000010, id(13)]).value, null);
      for (const name of ['Message', 'Content', 'SendKey', 'Operation', 'Reservation', 'Attachment', 'Delivery']) {
        const projection = s['project' + name](id(13)).value;
        assert.equal(projection.present, true);
        const row = s.readProjected(projection).value;
        assert.equal(row.message_id, id(13));
        if (name === 'Attachment') assert.deepEqual(Buffer.from(row.data), payload);
        if (name === 'Message') { assert.equal(row.title, null); assert.equal(row.correlation, ''); assert.equal(row.text, '字é'); }
      }
      assert.equal(s.readProjected(s.projectPolicy(ph).value).value.policy_hash, ph);
      assert.equal(s.readProjected(s.projectConversation(id(12)).value).value.conversation_id, id(12));
    });
  } finally { for (const k of forbidden) fs[k] = original[k]; }
  assert.deepEqual(image(f), before);
});

for (const kind of ['expire', 'scrub']) test(`actual ${kind} cursor SQL uses indexed seek/order without sorter and guards keys`, native, t => {
  const f = fixture(t);
  contentFixture(f);
  // Test-owned cursor rows: repeated expiry ties plus a later expiry. No schema
  // change or additional index; scope only tests the bounded content read.
  const keys = [id(13), id(21), id(22), id(23), id(24), id(25)];
  for (const [i, key] of keys.slice(1).entries()) {
    const accepted = i === keys.length - 2 ? 11 : 10;
    const client = id(31 + i), storage = `v2:${id(2)}:${client}`;
    insert(f.db, 'im_messages', { message_id: key, conversation_id: id(12), sender_id: id(10), recipient_id: id(11),
      client_message_id: storage, accepted_at: accepted, title: null, text: 'tie', correlation: '' });
    const fingerprint = sha(JSON.stringify(['a2a-msg.im.v2', id(2), id(12), id(11), client, null, 'tie', null, null, '']));
    insert(f.db, 'im_send_keys', { sender_id: id(10), client_message_id: storage, payload_hash: fingerprint,
      message_id: key, created_at: accepted, retry_until: 604800000 + accepted, status: 'live' });
    insert(f.db, 'im_send_operation_keys', { sender_id: id(10), origin_epoch: id(2), client_message_id: client,
      storage_client_message_id: storage, source_protocol: 'a2a-msg.im.v2', message_id: key });
    insert(f.db, 'im_content_state', { message_id: key, state: 'live', expires_at: 7776000000 + accepted, policy_hash: ph });
    insert(f.db, 'im_deliveries', { recipient_id: id(11), seq: 2 + i, message_id: key, acked_at: null, read_at: null });
  }
  f.db.prepare('UPDATE im_receive_state SET next_seq=? WHERE agent_id=?').run(7, id(11));
  if (kind === 'scrub') {
    insert(f.db, 'im_maintenance_runs', { run_id: 'test-run', center_epoch: id(2), kind: 'expire', execution_policy_hash: ph,
      plan_hash: sha('test-run'), approved_batch_hash: null, approval_ref: null, executor_id: 'test', status: 'previewed',
      candidate_json: '{}', result_json: '{}', previewed_at: 1, expires_at: 2, completed_at: null,
      scan_rows: 0, scan_bytes: 0, changed_rows: 0, changed_bytes: 0 });
    f.db.exec("UPDATE im_content_state SET state='expired',expired_at=7776000011,expiry_run_id='test-run'");
  }
  assertImSchemaV4Internal(f.db);
  const l = ledger(), seen = [], captured = [];
  observed(f, () => scope(f.readTarget, l, s => {
    const cutoff = 7776000011;
    let after = null;
    do {
      const from = calls.length;
      const next = s.nextContent(kind, cutoff, after);
      assert.equal(next.complete, true);
      const sql = calls.slice(from).filter(x => x.includes('FROM main.im_content_state WHERE'));
      assert.equal(sql.length, 1, 'actual executed statement, not a recreated query');
      captured.push({ sql: sql[0], args: after === null ? [cutoff] : [cutoff, ...after] });
      if (next.value === null) break;
      seen.push(next.value);
      after = next.value;
    } while (seen.length <= keys.length);
    assert.deepEqual(seen, keys.map((key, i) => [i === keys.length - 1 ? 7776000011 : 7776000010, key]));
  }));
  assert.equal(captured.length, keys.length + 1, 'start and tail cursors visited each key once');
  for (const { sql, args } of [captured[0], captured[1], captured.at(-1)]) {
    assert.match(sql, /CASE WHEN length\(CAST\(message_id AS BLOB\)\)=36 THEN message_id ELSE NULL END AS message_id/);
    assert.match(sql, /ORDER BY expires_at,im_content_state\.message_id LIMIT 1/);
    assert.match(sql, /expires_at<=\?/);
    if (args.length === 3) assert.match(sql, /\(expires_at,message_id\)>\(\?,\?\)/);
    const details = f.db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...args).map(row => row.detail);
    assert.ok(details.some(detail => /SEARCH .*im_content_state USING (?:COVERING )?INDEX im_content_(?:expiry|scrub)/.test(detail)), details.join('\n'));
    assert.ok(!details.some(detail => /TEMP B-TREE|SCAN im_content_state/.test(detail)), details.join('\n'));
  }
  assert.equal(l.stats().tickets, 0);
});

test('oversized policy and active-run metadata are projected before byte reservation; no raw read', native, t => {
  for (const column of ['canonical_json', 'auth_review_ref']) {
    const f = fixture(t);
    f.db.exec('PRAGMA ignore_check_constraints=ON');
    f.db.prepare(`UPDATE ${column === 'canonical_json' ? 'im_retention_policies' : 'im_recovery_runs'} SET ${column}=?`).run('字'.repeat(100000));
    observed(f, () => assert.throws(() => scope(f.readTarget, ledger({ maxScanBytes: 100000 }), () => assert.fail()), error('READ_UNAVAILABLE')));
    assert.ok(calls.some(sql => sql.includes(`length(CAST(${column} AS BLOB))`)));
    assert.ok(!calls.some(sql => sql.includes(`CAST(${column} AS BLOB) AS ${column},`) || sql.includes(`CAST(${column} AS BLOB) AS ${column} FROM`)));
  }
});

test('post-projection planner byte exhaustion returns incomplete without fetching payload', native, t => {
  const f = fixture(t); contentFixture(f);
  const l = ledger();
  const baseReserve = l.reserve;
  let planner = false, blocked = false;
  l.reserve = function(r, b) { if (planner && blocked) return 'SCAN_BYTES'; return baseReserve.call(this, r, b); };
  observed(f, () => assert.deepEqual(scope(f.readTarget, l, s => {
    planner = true;
    const projection = s.projectAttachment(id(13)).value;
    blocked = true;
    const result = s.readProjected(projection);
    assert.deepEqual(result, { complete: false, stopReason: 'SCAN_BYTES' });
    planner = false;
    return result;
  }), { complete: false, stopReason: 'SCAN_BYTES' }));
  assert.ok(!calls.some(sql => sql.startsWith('SELECT CAST(attachment_id AS BLOB)')));
});

test('detected in-scope cookie change and invalidation fail before disclosure', native, t => {
  const f = fixture(t);
  assert.throws(() => scope(f.readTarget, ledger(), () => {
    f.db.exec('PRAGMA schema_version=999'); return true;
  }), error('READ_UNAVAILABLE'));
  assert.equal(f.db.isTransaction, false);
  // Intentional test-owned transaction interference is outside zero-write claim;
  // its attempted cookie change is rolled back by the scope.
  assert.notEqual(f.db.prepare('PRAGMA schema_version').get().schema_version, 999);
});

test('in-scope caller business writes are detected and never committed by target', native, t => {
  const f = fixture(t), before = f.db.prepare('SELECT action FROM im_audit WHERE id=0').get().action;
  assert.throws(() => scope(f.readTarget, ledger(), () => {
    f.db.prepare('UPDATE im_audit SET action=? WHERE id=0').run('changed-by-test'); return true;
  }), error('READ_UNAVAILABLE'));
  assert.equal(f.db.prepare('SELECT action FROM im_audit WHERE id=0').get().action, before);
  assert.equal(f.db.isTransaction, false);
});
