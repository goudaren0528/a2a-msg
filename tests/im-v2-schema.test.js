import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as legacySchema from '../src/im/schema.js';
import * as schema from '../src/im/v2/schema.js';
import * as migration from '../src/im/v2/migration.js';
import { V1_DDL } from './fixtures/im-schema/v1.js';
import { V2_DDL } from './fixtures/im-schema/v2.js';
import { tables, indexes, foreignKeys, nullable, primaryKeys, uniqueKeys } from './fixtures/im-v2-schema/contract-manifest.js';
import { pinnedV1Hash, rejectedCandidateUnchanged, validCandidateUnchanged, expire, receipt,
  retainedCorruptions } from './fixtures/im-v2-schema/q-regressions.js';
import { database, legacy, golden, v3Manifest, manifest, sha, insert, policy, putPolicy,
  freshOptions, importOptions, mismatch, recoveryRow, bindRun, maintenance, addMessage } from './fixtures/im-v2-schema/helpers.js';

const { assertImSchemaV4 } = schema;
const { initializeImSchemaV4, migrateImSchemaV4 } = migration;
const checkFailure = error => error.code === 'ERR_SQLITE_ERROR' && /CHECK constraint failed/i.test(error.message);
const v4Manifest = JSON.parse(readFileSync(new URL('./fixtures/im-v2-schema/v4-manifest.json', import.meta.url), 'utf8'));

test('F1: public exports exact; immutable legacy schema and runner plus reviewed publisher baseline', () => {
  assert.deepEqual(Object.keys(schema).sort(), ['IM_V2_SCHEMA_VERSION', 'SUPPORTED_IM_V2_SCHEMA_VERSIONS', 'assertImSchemaV4'].sort());
  assert.deepEqual(Object.keys(migration).sort(), ['initializeImSchemaV4', 'migrateImSchemaV4'].sort());
  assert.equal(schema.IM_V2_SCHEMA_VERSION, 4);
  assert.deepEqual(schema.SUPPORTED_IM_V2_SCHEMA_VERSIONS, [4]);
  assert.ok(Object.isFrozen(schema.SUPPORTED_IM_V2_SCHEMA_VERSIONS));
  assert.equal(legacySchema.IM_SCHEMA_VERSION, 3);
  assert.deepEqual(legacySchema.SUPPORTED_IM_SCHEMA_VERSIONS, [1, 2, 3]);
  for (const path of ['src/im/schema.js', 'src/im/migration-runner.js']) {
    const committed = execFileSync('git', ['show', `61052a3:${path}`], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
    assert.equal(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n'), committed.replace(/\r\n/g, '\n'), path);
  }
  // Approved P5 standalone-WAL artifact-read adapter exception; pin every other publisher byte too.
  const publisher = readFileSync(new URL('../src/im/backup-publisher.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(createHash('sha256').update(publisher).digest('hex'),
    'bb37b40b891e7a17716ab0d25524ac27ba36649b6d9cc4358545272f181ebc37', 'reviewed publisher source');
  for (const file of readdirSync(new URL('../src/im/v2/', import.meta.url)).filter(name => /^(schema(?:-history|-internal)?|migration)\.js$/.test(name))) {
    const source = readFileSync(new URL(`../src/im/v2/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /(?:from\s*|import\s*\()\s*['"]\.\.\/(?:schema|contracts|delivery|messages)\.js['"]/, `${file} must not depend on mutable legacy validators`);
  }
});

test('F1: independently frozen v1/v2/v3 per-object manifests and old checksum goldens', t => {
  const current = database(t);
  initializeImSchemaV4(current, freshOptions());
  const objects = manifest(current);
  for (const [version, ddl] of [[1, V1_DDL], [2, V2_DDL], [3, v3Manifest.map(r => r[3])]]) {
    const old = database(t);
    for (const sql of ddl.filter(sql => /^CREATE TABLE/.test(sql))) old.exec(sql);
    for (const sql of ddl.filter(sql => /^CREATE INDEX/.test(sql))) old.exec(sql);
    const expected = manifest(old);
    assert.equal(sha(JSON.stringify(expected)), golden[`v${version}`], `literal historical v${version} golden`);
    for (const row of expected.filter(r => r[1] !== 'im_schema'))
      assert.deepEqual(objects.find(r => r[1] === row[1]), row, `v${version}: ${row[1]}`);
  }
  const original = database(t);
  legacySchema.migrateImSchemaV3(original);
  assert.deepEqual(manifest(original), v3Manifest, 'literal v3 fixture matches real committed legacy DDL');
  assert.equal(golden.v4, 'c950eb40692a72f918c8976d4bef8cab0b9e357495b01df75e0ab2d1b0b5f216', 'reviewed v4 checksum');
  assert.equal(v4Manifest.length, 54, 'reviewed complete v4 object count');
  assert.equal(sha(JSON.stringify(v4Manifest)), golden.v4, 'literal v4 fixture checksum');
  assert.deepEqual(objects, v4Manifest, 'every actual v4 SQLite object matches reviewed literal SQL');
  assert.equal(sha(JSON.stringify(objects)), golden.v4, 'runtime v4 checksum');
  assert.equal(current.prepare('SELECT migration_checksum FROM im_schema').get().migration_checksum, golden.v4, 'persisted v4 marker');
  assert.throws(() => legacySchema.assertImSchema(current), mismatch);
});

test('F1: legacy business constructors reject a valid v4 database at their schema gate', async t => {
  const db = database(t); initializeImSchemaV4(db, freshOptions());
  for (const [file, factory] of [['auth', 'createImAuth'], ['acl', 'createImAcl'], ['admin', 'createImAdmin'],
    ['messages', 'createImMessages'], ['delivery', 'createImDelivery'], ['migration', 'createImMigration'], ['server', 'createImCenter']]) {
    const module = await import(`../src/im/${file}.js`);
    assert.throws(() => module[factory]({ db }), mismatch, factory);
  }
});

test('S1: independently authored eleven-table/eighteen-index contract and keyset SEARCH', t => {
  const db = database(t);
  initializeImSchemaV4(db, freshOptions());
  const inherited = new Set(v3Manifest.map(r => r[1]));
  const added = manifest(db).filter(r => !inherited.has(r[1]));
  assert.deepEqual(added.filter(r => r[0] === 'table').map(r => r[1]).sort(), Object.keys(tables).sort());
  assert.deepEqual(added.filter(r => r[0] === 'index').map(r => r[1]).sort(), Object.keys(indexes).sort());
  assert.equal(Object.keys(tables).length, 11);
  assert.equal(Object.keys(indexes).length, 18);
  for (const [table, columns] of Object.entries(tables)) {
    const info = db.prepare(`PRAGMA table_info(${table})`).all();
    assert.deepEqual(info.map(r => r.name), columns.split(' '), table);
    assert.deepEqual(info.filter(r => !r.notnull).map(r => r.name).sort(), [...nullable[table]].sort(), `${table} exact nullability`);
    assert.equal(info.filter(r => r.pk).sort((a, b) => a.pk - b.pk).map(r => r.name).join(','), primaryKeys[table], `${table} PK`);
    const unique = db.prepare(`PRAGMA index_list(${table})`).all().filter(r => r.origin === 'u')
      .map(r => db.prepare(`PRAGMA index_info(${r.name})`).all().map(c => c.name).join(','));
    assert.deepEqual(unique.sort(), [...uniqueKeys[table]].sort(), `${table} UNIQUE bindings`);
    const groups = new Map();
    for (const fk of db.prepare(`PRAGMA foreign_key_list(${table})`).all()) {
      assert.equal(fk.on_delete, 'NO ACTION');
      if (!groups.has(fk.id)) groups.set(fk.id, []);
      groups.get(fk.id).push(fk);
    }
    const actualForeignKeys = [...groups.values()].map(rows => {
      rows.sort((a, b) => a.seq - b.seq);
      return `${rows.map(r => r.from).join(',')}->${rows[0].table}(${rows.map(r => r.to).join(',')})`;
    });
    assert.deepEqual(actualForeignKeys.sort(), [...foreignKeys[table]].sort(), `${table} foreign keys`);
  }
  for (const [index, [table, columns]] of Object.entries(indexes)) {
    const object = added.find(r => r[1] === index);
    assert.equal(object[2], table);
    assert.deepEqual(db.prepare(`PRAGMA index_info(${index})`).all().map(r => r.name), columns.split(','));
    assert.equal(db.prepare(`PRAGMA index_list(${table})`).all().find(r => r.name === index).partial, 0);
  }
  for (const [index, sql, parameter] of [
    ['im_content_expiry', "SELECT message_id FROM im_content_state WHERE state='live' AND expires_at>? ORDER BY expires_at,message_id LIMIT 10", 1],
    ['im_content_scrub', "SELECT message_id FROM im_content_state WHERE state='expired' AND scrubbed_at IS NULL AND expires_at>? ORDER BY expires_at,message_id LIMIT 10", 1],
    ['im_operation_epoch', 'SELECT * FROM im_send_operation_keys WHERE origin_epoch=? ORDER BY sender_id,client_message_id LIMIT 10', randomUUID()],
  ]) assert.match(db.prepare('EXPLAIN QUERY PLAN ' + sql).all(parameter).map(r => r.detail).join(' '), new RegExp(`SEARCH .*${index}`));
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('S1: missing, extra, wrong objects, marker and disabled FK are refused', async t => {
  const mutations = [
    ['missing index', db => db.exec('DROP INDEX im_content_expiry')],
    ['missing table', db => db.exec('DROP TABLE im_expiry_receipts')],
    ['wrong index', db => db.exec('DROP INDEX im_content_expiry; CREATE INDEX im_content_expiry ON im_content_state(message_id,state)')],
    ['extra table', db => db.exec('CREATE TABLE im_unexpected(x)')],
    ['extra index', db => db.exec('CREATE INDEX im_unexpected ON im_agents(display_name)')],
    ['trigger', db => db.exec('CREATE TRIGGER im_unexpected AFTER INSERT ON im_agents BEGIN SELECT 1; END')],
    ['non-prefixed trigger on IM table', db => db.exec('CREATE TRIGGER unexpected AFTER INSERT ON im_agents BEGIN SELECT 1; END')],
    ['view', db => db.exec('CREATE VIEW im_unexpected AS SELECT * FROM im_agents')],
    ['forged checksum', db => db.prepare('UPDATE im_schema SET migration_checksum=?').run('0'.repeat(64))],
    ['foreign key corruption', db => {
      db.exec('PRAGMA foreign_keys=OFF');
      db.prepare('UPDATE im_center_state SET center_epoch=?').run(randomUUID());
      db.exec('PRAGMA foreign_keys=ON');
      assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 1);
    }],
    ['foreign keys off', db => db.exec('PRAGMA foreign_keys=OFF')],
  ];
  for (const [label, mutate] of mutations) await t.test(label, t => {
    const db = database(t); initializeImSchemaV4(db, freshOptions());
    mutate(db);
    assert.throws(() => assertImSchemaV4(db), mismatch);
    assert.throws(() => initializeImSchemaV4(db, freshOptions()), mismatch);
  });
});

test('S1: native scalar CHECKs reject malformed UUID/hash/integers/enums and enforce nullable values', t => {
  const db = database(t); initializeImSchemaV4(db, freshOptions());
  const epoch = { center_epoch: randomUUID(), created_at: 0, origin: 'fresh', recovery_counter: 0 };
  for (const patch of [{ center_epoch: '-'.repeat(36) }, { created_at: -1 }, { created_at: 1.5 },
    { recovery_counter: 9007199254740992 }, { origin: 'unknown' }])
    assert.throws(() => insert(db, 'im_center_epochs', { ...epoch, ...patch }), checkFailure);
  const row = recoveryRow(db, 'fresh_bootstrap');
  for (const patch of [{ approved_plan_hash: 'G'.repeat(64) }, { candidate_reference: '' },
    { candidate_reference: 'x'.repeat(256) }, { verified_at: -1 }, { created_at: 1.5 }])
    assert.throws(() => insert(db, 'im_recovery_runs', { ...row, ...patch }), checkFailure);
  // Legal upper bound proves the test is not simply observing an unrelated FK/uniqueness failure.
  insert(db, 'im_center_epochs', { ...epoch, created_at: 9007199254740991, recovery_counter: 9007199254740991 });
});

test('S2: existing valid attachment cannot be emptied; reservation and FK-safe payload deletion', t => {
  const { db, messages: [message] } = legacy(t);
  migrateImSchemaV4(db, importOptions());
  assert.equal(assertImSchemaV4(db), true);
  assert.throws(() => db.exec("UPDATE im_attachments SET data=x''"), checkFailure);
  assert.equal(db.prepare('SELECT length(data) n FROM im_attachments').get().n, 18);
  const reservation = db.prepare('SELECT * FROM im_attachment_reservations').get();
  const expiry = maintenance(db, 'expire'); const scrub = maintenance(db, 'scrub');
  db.prepare("UPDATE im_content_state SET state='expired',expired_at=expires_at,expiry_run_id=? WHERE message_id=?").run(expiry, message);
  assert.equal(assertImSchemaV4(db), true, 'expired but unscrubbed payload is still valid');
  db.exec('BEGIN IMMEDIATE');
  db.prepare('DELETE FROM im_attachments WHERE message_id=?').run(message);
  db.prepare("UPDATE im_messages SET text='',title=NULL,correlation=NULL WHERE message_id=?").run(message);
  db.prepare('UPDATE im_content_state SET scrubbed_at=expired_at,scrub_run_id=? WHERE message_id=?').run(scrub, message);
  db.exec('COMMIT');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.deepEqual(db.prepare('SELECT * FROM im_attachment_reservations').get(), reservation);
  assert.equal(assertImSchemaV4(db), true);
});

test('S1: operation namespace encoding is exact and two epochs can retain the same wire UUID', t => {
  const f = legacy(t, { attachment: false }); const { db } = f;
  const result = migrateImSchemaV4(db, importOptions());
  const old = db.prepare('SELECT * FROM im_send_operation_keys').get();
  assert.equal(old.storage_client_message_id, old.client_message_id);
  assert.throws(() => db.exec("UPDATE im_send_operation_keys SET source_protocol='a2a-msg.im.v2'"), checkFailure);
  const id = addMessage(f, { text: 'new v2 fixture', title: null });
  const storage = `v2:${result.initialEpoch}:${old.client_message_id}`;
  assert.equal(storage.length, 76);
  db.prepare('UPDATE im_messages SET client_message_id=? WHERE message_id=?').run(storage, id);
  const fingerprint = sha(JSON.stringify(['a2a-msg.im.v2', result.initialEpoch, f.conversation, f.b,
    old.client_message_id, null, 'new v2 fixture', null, null, null]));
  db.prepare('UPDATE im_send_keys SET client_message_id=?,payload_hash=? WHERE message_id=?').run(storage, fingerprint, id);
  insert(db, 'im_content_state', { message_id: id, state: 'live', expires_at: 7776000100,
    policy_hash: db.prepare('SELECT policy_hash FROM im_schema_preparations').get().policy_hash });
  insert(db, 'im_send_operation_keys', { sender_id: f.a, origin_epoch: result.initialEpoch,
    client_message_id: old.client_message_id, storage_client_message_id: storage,
    source_protocol: 'a2a-msg.im.v2', message_id: id });
  assert.equal(db.prepare('SELECT count(*) n FROM im_send_operation_keys WHERE client_message_id=?').get(old.client_message_id).n, 2);
  assert.equal(assertImSchemaV4(db), true);
  assert.throws(() => db.prepare('UPDATE im_send_operation_keys SET storage_client_message_id=? WHERE message_id=?').run('v2:' + old.client_message_id, id), checkFailure);
  assert.throws(() => db.prepare('UPDATE im_send_operation_keys SET client_message_id=? WHERE message_id=?').run('-'.repeat(36), id), checkFailure);
});

test('S2: text-only scrub requires empty text/null title/null correlation; nullable CHECK gaps refused', async t => {
  for (const field of [null, 'text', 'title', 'correlation']) await t.test(field ?? 'fully scrubbed control', t => {
    const { db, messages: [id] } = legacy(t, { attachment: false }); migrateImSchemaV4(db, importOptions());
    const expiry = maintenance(db, 'expire'); const scrub = maintenance(db, 'scrub');
    assert.throws(() => db.exec("UPDATE im_content_state SET state='expired'"), checkFailure);
    db.prepare("UPDATE im_content_state SET state='expired',expired_at=expires_at,expiry_run_id=?").run(expiry);
    assert.throws(() => db.exec('UPDATE im_content_state SET scrubbed_at=expired_at'), checkFailure);
    db.prepare('UPDATE im_content_state SET scrubbed_at=expired_at,scrub_run_id=?').run(scrub);
    db.prepare("UPDATE im_messages SET text='',title=NULL,correlation=NULL WHERE message_id=?").run(id);
    if (field) {
      assert.equal(db.prepare(`UPDATE im_messages SET ${field}=? WHERE message_id=?`).run('retained', id).changes, 1);
      assert.throws(() => assertImSchemaV4(db), mismatch);
    } else assert.equal(assertImSchemaV4(db), true);
  });
});

test('S2: payload/reservation one-to-one is checked in every content state', async t => {
  for (const damage of ['live missing payload', 'expired missing payload', 'orphan payload', 'reservation mismatch', 'scrubbed retained payload']) await t.test(damage, t => {
    const { db } = legacy(t); migrateImSchemaV4(db, importOptions());
    if (damage.startsWith('expired') || damage.startsWith('scrubbed')) {
      const expiry = maintenance(db, 'expire');
      db.prepare("UPDATE im_content_state SET state='expired',expired_at=expires_at,expiry_run_id=?").run(expiry);
    }
    if (damage === 'scrubbed retained payload') {
      const scrub = maintenance(db, 'scrub');
      db.prepare('UPDATE im_content_state SET scrubbed_at=expired_at,scrub_run_id=?').run(scrub);
      db.exec("UPDATE im_messages SET text='',title=NULL,correlation=NULL");
    } else if (damage.includes('missing payload')) db.exec('DELETE FROM im_attachments');
    else if (damage === 'orphan payload') db.exec('DELETE FROM im_attachment_reservations');
    else db.exec('UPDATE im_attachment_reservations SET size=size+1');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [], 'semantic setup remains FK-valid');
    assert.throws(() => assertImSchemaV4(db), mismatch);
  });
});

test('S3: all three recovery candidate kinds have legal prepared SQL fixtures', async t => {
  for (const kind of ['fresh_bootstrap', 'v3_import', 'snapshot_recovery']) await t.test(kind, t => {
    const db = kind === 'v3_import' ? legacy(t).db : database(t);
    if (kind === 'v3_import') migrateImSchemaV4(db, importOptions()); else initializeImSchemaV4(db, freshOptions());
    let row = recoveryRow(db, kind);
    if (kind === 'snapshot_recovery') {
      const epoch = randomUUID();
      insert(db, 'im_center_epochs', { center_epoch: epoch, created_at: 100, origin: 'recovery', recovery_counter: 1 });
      row = { ...row, preparation_ref: null, old_epoch: row.new_epoch, new_epoch: epoch, backup_id: randomUUID(),
        backup_file_hash: 'b'.repeat(64), manifest_hash: 'c'.repeat(64), candidate_base_hash: 'b'.repeat(64) };
      db.prepare('UPDATE im_center_state SET center_epoch=?,recovery_counter=1').run(epoch);
    }
    bindRun(db, row);
    assert.equal(assertImSchemaV4(db), true);
  });
});

test('S3: kind nullable CHECKs reject SQL three-valued loopholes without relying on validator', async t => {
  const cases = [
    ['fresh requires preparation', 'fresh_bootstrap', { preparation_ref: null }],
    ['fresh forbids backup', 'fresh_bootstrap', { backup_id: randomUUID() }],
    ['import requires isolation', 'v3_import', { isolation_ack_ref: null }],
    ['import requires RPO', 'v3_import', { rpo_report_json: null }],
    ['import all-or-none backup', 'v3_import', { backup_id: randomUUID() }],
    ['import cannot invent old epoch', 'v3_import', 'old'],
    ['snapshot requires old epoch', 'snapshot_recovery', { old_epoch: null }],
    ['snapshot requires full backup', 'snapshot_recovery', { candidate_base_hash: null }],
  ];
  for (const [label, kind, change] of cases) await t.test(label, t => {
    const db = kind === 'v3_import' ? legacy(t).db : database(t);
    if (kind === 'v3_import') migrateImSchemaV4(db, importOptions()); else initializeImSchemaV4(db, freshOptions());
    let row = recoveryRow(db, kind);
    if (kind === 'snapshot_recovery') {
      const epoch = randomUUID();
      insert(db, 'im_center_epochs', { center_epoch: epoch, created_at: 100, origin: 'recovery', recovery_counter: 1 });
      row = { ...row, preparation_ref: null, old_epoch: row.new_epoch, new_epoch: epoch, backup_id: randomUUID(),
        backup_file_hash: 'b'.repeat(64), manifest_hash: 'c'.repeat(64), candidate_base_hash: 'b'.repeat(64) };
    }
    if (change === 'old') row.old_epoch = db.prepare('SELECT import_epoch FROM im_schema_preparations').get().import_epoch;
    else Object.assign(row, change);
    assert.throws(() => insert(db, 'im_recovery_runs', row), checkFailure);
  });
});

test('S3: backed import control, activation evidence, verified run requirement, failed center rules', async t => {
  await t.test('backed import valid with actual four fields and no old epoch', t => {
    const { db } = legacy(t); migrateImSchemaV4(db, importOptions());
    bindRun(db, recoveryRow(db, 'v3_import', { backup_id: randomUUID(), backup_file_hash: 'b'.repeat(64),
      manifest_hash: 'c'.repeat(64), candidate_base_hash: 'b'.repeat(64) }));
    assert.equal(assertImSchemaV4(db), true);
  });
  for (const missing of ['activation_plan_hash', 'activation_approval_ref', 'auth_review_ref', 'activation_ref', 'activated_at', 'verified_at']) await t.test(`active requires ${missing}`, t => {
    const db = database(t); initializeImSchemaV4(db, freshOptions());
    const row = recoveryRow(db, 'fresh_bootstrap', { status: 'active', verified_at: 101, activated_at: 102,
      activation_ref: 'activation', auth_review_ref: 'auth-review', activation_plan_hash: 'd'.repeat(64), activation_approval_ref: 'activation-approval' });
    row[missing] = null;
    assert.throws(() => insert(db, 'im_recovery_runs', row), checkFailure);
  });
  for (const centerStatus of ['prepared', 'verified', 'active']) await t.test(`failed run with ${centerStatus} center`, t => {
    const db = database(t); initializeImSchemaV4(db, freshOptions());
    assert.throws(() => db.exec("UPDATE im_center_state SET status='verified'"), checkFailure);
    const row = recoveryRow(db, 'fresh_bootstrap', { status: 'failed', failure_code: 'FIXTURE_FAILURE', verified_at: 101 });
    bindRun(db, row);
    if (centerStatus === 'prepared') assert.equal(assertImSchemaV4(db), true);
    else {
      db.prepare('UPDATE im_center_state SET status=?,activation_ref=?').run(centerStatus, centerStatus === 'active' ? 'activation' : null);
      assert.throws(() => assertImSchemaV4(db), mismatch);
    }
  });
});

test('S3: preparation kind/source and candidate cross-row epoch bindings', async t => {
  for (const sql of [
    "UPDATE im_schema_preparations SET kind='v3_import'",
    'UPDATE im_schema_preparations SET source_version=3',
    "UPDATE im_schema_preparations SET source_schema_checksum='" + 'a'.repeat(64) + "'",
  ]) await t.test(sql, t => {
    const db = database(t); initializeImSchemaV4(db, freshOptions());
    assert.throws(() => db.exec(sql), checkFailure);
  });
  for (const damage of ['preparation kind', 'run epoch', 'center counter']) await t.test(damage, t => {
    const db = database(t); initializeImSchemaV4(db, freshOptions());
    const row = recoveryRow(db, 'fresh_bootstrap'); bindRun(db, row);
    if (damage === 'preparation kind') db.exec("UPDATE im_recovery_runs SET candidate_kind='v3_import',isolation_ack_ref='isolation',rpo_report_json='{}'");
    else if (damage === 'run epoch') {
      const epoch = randomUUID(); insert(db, 'im_center_epochs', { center_epoch: epoch, created_at: 100, origin: 'fresh', recovery_counter: 0 });
      db.prepare('UPDATE im_recovery_runs SET new_epoch=?').run(epoch);
    } else db.exec('UPDATE im_center_state SET recovery_counter=1');
    assert.throws(() => assertImSchemaV4(db), mismatch);
  });
});

test('M4: canonical policy gates are booleans even when hash matches invalid JSON', async t => {
  for (const value of [false, true]) await t.test(`valid ${value}`, t => {
    const db = database(t); initializeImSchemaV4(db, freshOptions());
    // Unreferenced additional policy isolates policy validation from preparation input_hash validation.
    putPolicy(db, { ...policy(), effectiveAt: 1, expiryEnabled: value, purgeEnabled: value, backupCleanupEnabled: value,
      backupRetentionMs: value === true ? 2592000000 : null });
    assert.equal(assertImSchemaV4(db), true);
  });
  // One gate changes per case: validating just expiryEnabled must not hide missing checks on the other two.
  for (const gate of ['expiryEnabled', 'purgeEnabled', 'backupCleanupEnabled']) for (const value of [0, 'false', null]) await t.test(`${gate}=${JSON.stringify(value)}`, t => {
    const db = database(t); initializeImSchemaV4(db, freshOptions());
    putPolicy(db, { ...policy(), effectiveAt: 1, [gate]: value });
    assert.throws(() => assertImSchemaV4(db), mismatch);
  });
});

test('Q1: handled prefix needs continuous real ACK or exact-scope expired receipts', async t => {
  for (const state of ['live', 'expired']) await t.test(`unproved second ${state} delivery`, t => {
    const f = legacy(t, { messages: 2, acks: [true, false] });
    migrateImSchemaV4(f.db, importOptions());
    if (state === 'expired') expire(f.db, [f.messages[1]]);
    assert.equal(f.db.prepare('SELECT count(*) n FROM im_expiry_receipts').get().n, 0);
    assert.equal(f.db.prepare('UPDATE im_sync_progress SET handled_through=2').run().changes, 1);
    assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
    rejectedCandidateUnchanged(f.db);
  });
  await t.test('real ACK positive control', t => {
    const { db } = legacy(t, { messages: 2, acks: [true, true] });
    migrateImSchemaV4(db, importOptions());
    assert.equal(db.prepare('SELECT handled_through FROM im_sync_progress').get().handled_through, 2);
    validCandidateUnchanged(db);
  });
  for (const handled of [1, 3]) await t.test(`receipt bridges ACK gap; persisted handled=${handled}`, t => {
    const f = legacy(t, { messages: 3, acks: [true, false, true] });
    const result = migrateImSchemaV4(f.db, importOptions());
    expire(f.db, [f.messages[1]]); assert.equal(receipt(f, result).changes, 1);
    f.db.prepare('UPDATE im_sync_progress SET handled_through=?').run(handled);
    assert.equal(f.db.prepare('SELECT acked_through FROM im_receive_state').get().acked_through, 1);
    const delivery = f.db.prepare('SELECT acked_at,read_at FROM im_deliveries WHERE seq=2').get();
    assert.equal(delivery.acked_at, null); assert.equal(delivery.read_at, null);
    validCandidateUnchanged(f.db); // §5 progressPending permits lag; do not demand maximal advancement.
  });
  for (const binding of ['center', 'stream', 'seq', 'message', 'recipient']) await t.test(`legal wrong-${binding} receipt cannot prove seq2`, t => {
    const f = legacy(t, { messages: 2, acks: [true, false] });
    let other;
    if (binding === 'recipient') {
      insert(f.db, 'im_receive_state', { agent_id: f.a, stream_epoch: randomUUID() });
      other = addMessage(f, { sender: f.b, recipient: f.a });
    }
    const result = migrateImSchemaV4(f.db, importOptions());
    expire(f.db, other ? [f.messages[0], f.messages[1], other] : f.messages);
    let overrides = {};
    if (binding === 'center' || binding === 'stream') {
      const progress = f.db.prepare('SELECT * FROM im_sync_progress WHERE recipient_id=?').get(f.b);
      overrides = binding === 'center' ? { center_epoch: result.importEpoch } : { stream_epoch: randomUUID() };
      assert.equal(insert(f.db, 'im_sync_progress', { ...progress, ...overrides }).changes, 1);
    } else if (binding === 'seq') overrides = { seq: 1 };
    else if (binding === 'message') overrides = { message_id: f.messages[0] };
    else overrides = { recipient_id: f.a, stream_epoch: f.db.prepare('SELECT stream_epoch FROM im_receive_state WHERE agent_id=?').get(f.a).stream_epoch,
      seq: 1, message_id: other };
    assert.equal(receipt(f, result, overrides).changes, 1, 'receipt actually inserted under native constraints');
    assert.equal(f.db.prepare('UPDATE im_sync_progress SET handled_through=2 WHERE recipient_id=? AND center_epoch=? AND stream_epoch=?')
      .run(f.b, result.initialEpoch, f.stream).changes, 1);
    assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
    rejectedCandidateUnchanged(f.db);
  });
  await t.test('missing delivery cannot be crossed even with later real ACK', t => {
    const { db } = legacy(t, { messages: 3, acks: [true, false, true] });
    migrateImSchemaV4(db, importOptions());
    assert.equal(db.prepare('DELETE FROM im_deliveries WHERE seq=2').run().changes, 1);
    db.exec('UPDATE im_sync_progress SET handled_through=3');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    rejectedCandidateUnchanged(db);
  });
});

test('Q1: v4 persisted ACK cursor may lag real continuous ACKs, never lead proof', t => {
  const f = legacy(t, { messages: 3, acks: [true, true, true] });
  migrateImSchemaV4(f.db, importOptions());
  assert.equal(f.db.prepare('SELECT acked_through FROM im_receive_state').get().acked_through, 3);
  f.db.exec('UPDATE im_receive_state SET acked_through=1; UPDATE im_sync_progress SET handled_through=1');
  validCandidateUnchanged(f.db);
  f.db.exec('UPDATE im_receive_state SET acked_through=2');
  rejectedCandidateUnchanged(f.db); // Stored ACK cannot exceed stored handled progress.
  f.db.exec('UPDATE im_sync_progress SET handled_through=2');
  validCandidateUnchanged(f.db);
  f.db.exec('UPDATE im_deliveries SET read_at=NULL,acked_at=NULL WHERE seq=2');
  rejectedCandidateUnchanged(f.db); // Cannot count an unACKed delivery even if later rows ACKed.
  f.db.exec('UPDATE im_deliveries SET acked_at=10 WHERE seq=2');
  validCandidateUnchanged(f.db);
  f.db.exec('UPDATE im_deliveries SET seq=4 WHERE seq=2');
  rejectedCandidateUnchanged(f.db); // A missing sequence cannot be crossed.
});

test('Q2: content deadline is exact safe acceptedAt plus historical 90-day policy', async t => {
  for (const expires of [0, 7776000101]) await t.test(`corrupt deadline ${expires}`, t => {
    const { db } = legacy(t); migrateImSchemaV4(db, importOptions());
    assert.equal(db.prepare('SELECT accepted_at FROM im_messages').get().accepted_at, 100);
    assert.equal(db.prepare('SELECT expires_at FROM im_content_state').get().expires_at, 7776000100);
    assert.equal(db.prepare('UPDATE im_content_state SET expires_at=?').run(expires).changes, 1);
    rejectedCandidateUnchanged(db);
  });
  await t.test('safe stored integers whose 90-day addition overflows', t => {
    const { db, messages: [id] } = legacy(t, { acks: [false] });
    migrateImSchemaV4(db, importOptions());
    const accepted = Number.MAX_SAFE_INTEGER - 604800000 - 1;
    assert.equal(Number.isSafeInteger(accepted + 604800000), true);
    assert.equal(Number.isSafeInteger(accepted + 7776000000), false);
    db.prepare('UPDATE im_messages SET accepted_at=?').run(accepted);
    db.prepare('UPDATE im_send_keys SET created_at=?,retry_until=?').run(accepted, accepted + 604800000);
    db.prepare('UPDATE im_content_state SET expires_at=?').run(Number.MAX_SAFE_INTEGER);
    assert.equal(db.prepare('SELECT payload_hash FROM im_send_keys').get().payload_hash, pinnedV1Hash(db, id),
      'acceptedAt is absent from the pinned old fingerprint; no unrelated hash failure');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    rejectedCandidateUnchanged(db);
  });
  await t.test('new correctly hashed policy gates preserve historical binding and deadline', t => {
    const { db } = legacy(t); migrateImSchemaV4(db, importOptions());
    const original = db.prepare('SELECT * FROM im_content_state').get();
    const newer = putPolicy(db, { ...policy(), effectiveAt: 200, expiryEnabled: true, purgeEnabled: true });
    assert.notEqual(newer, original.policy_hash);
    validCandidateUnchanged(db);
    assert.deepEqual(db.prepare('SELECT * FROM im_content_state').get(), original);
    assert.equal(original.expires_at, 7776000100);
  });
});

test('Q3: retained live and expired-unscrubbed content revalidates fingerprint, bytes and wire bounds', async t => {
  for (const state of ['live', 'expired']) for (const [label, corrupt] of retainedCorruptions) await t.test(`${state}: ${label}`, t => {
    const { db, messages: [id] } = legacy(t); migrateImSchemaV4(db, importOptions());
    assert.equal(db.prepare('SELECT source_protocol FROM im_send_operation_keys').get().source_protocol, 'a2a-msg.im.v1');
    assert.equal(db.prepare('SELECT payload_hash FROM im_send_keys').get().payload_hash, pinnedV1Hash(db, id));
    if (state === 'expired') expire(db, [id]);
    validCandidateUnchanged(db);
    corrupt(db, id);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    rejectedCandidateUnchanged(db);
  });
  for (const attachment of [false, true]) await t.test(`scrubbed ${attachment ? 'attachment' : 'text-only'} preserves historical evidence`, t => {
    const { db, messages: [id] } = legacy(t, { attachment }); migrateImSchemaV4(db, importOptions());
    const key = db.prepare('SELECT * FROM im_send_keys').get();
    const reservations = db.prepare('SELECT * FROM im_attachment_reservations').all();
    expire(db, [id]); const run = maintenance(db, 'scrub');
    db.exec('BEGIN IMMEDIATE');
    assert.equal(db.prepare('DELETE FROM im_attachments WHERE message_id=?').run(id).changes, attachment ? 1 : 0);
    db.prepare("UPDATE im_messages SET text='',title=NULL,correlation=NULL WHERE message_id=?").run(id);
    db.prepare('UPDATE im_content_state SET scrubbed_at=expired_at,scrub_run_id=? WHERE message_id=?').run(run, id);
    db.exec('COMMIT');
    assert.notEqual(pinnedV1Hash(db, id), key.payload_hash, 'deleted payload cannot reconstruct original hash');
    validCandidateUnchanged(db);
    assert.deepEqual(db.prepare('SELECT * FROM im_send_keys').get(), key);
    assert.deepEqual(db.prepare('SELECT * FROM im_attachment_reservations').all(), reservations);
  });
});
