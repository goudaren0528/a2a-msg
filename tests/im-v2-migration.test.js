import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { assertImSchema, migrateImSchema } from '../src/im/schema.js';
import { initializeImSchemaV4, migrateImSchemaV4 } from '../src/im/v2/migration.js';
import { assertImSchemaV4 } from '../src/im/v2/schema.js';
import { V1_DDL, V1_CHECKSUM } from './fixtures/im-schema/v1.js';
import { pinnedV1Hash, retainedCorruptions } from './fixtures/im-v2-schema/q-regressions.js';
import { database, legacy, addMessage, insert, rehash, snapshot, manifest, policy, putPolicy,
  freshOptions, importOptions, mismatch, budgetError, preparationHash, observe, recoveryRow, bindRun } from './fixtures/im-v2-schema/helpers.js';

function rejectedUnchanged(db, call, expected = mismatch) {
  const before = snapshot(db);
  assert.throws(call, expected);
  assert.deepEqual(snapshot(db), before, 'complete schema, marker and every business row remain unchanged');
}
function sourceOtherCount(db) {
  return manifest(db).filter(r => r[0] === 'table' && !['im_messages', 'im_attachments'].includes(r[1]))
    .reduce((n, [, table]) => n + db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
}
function contentBytes(db) {
  const messages = db.prepare('SELECT text,title,correlation FROM im_messages').all();
  const attachments = db.prepare('SELECT name,mime,data FROM im_attachments').all();
  return messages.reduce((n, r) => n + [r.text, r.title, r.correlation].reduce((n, s) => n + Buffer.byteLength(s ?? ''), 0), 0) +
    attachments.reduce((n, r) => n + Buffer.byteLength(r.name) + Buffer.byteLength(r.mime ?? '') + r.data.length, 0);
}

test('fresh and imported candidates: exact DTO, independent preparation hash, immutable old rows, exact retry', async t => {
  for (const kind of ['fresh', 'v3_import']) await t.test(kind, t => {
    const f = kind === 'fresh' ? { db: database(t) } : legacy(t, { messages: 3, acks: [true, false, true], leases: true });
    const { db } = f;
    const before = snapshot(db);
    const options = kind === 'fresh' ? freshOptions() : importOptions();
    const run = kind === 'fresh' ? initializeImSchemaV4 : migrateImSchemaV4;
    const result = run(db, options);
    assert.deepEqual(Object.keys(result).sort(), ['preparationRef', 'instanceId', 'instanceCreatedAt', 'initialEpoch', 'importEpoch', 'schemaVersion', 'status', 'writeMode'].sort());
    assert.equal(result.status, 'prepared'); assert.equal(result.writeMode, 'paused'); assert.equal(result.schemaVersion, 4);
    assert.equal(result.preparationRef, options.creationRef ?? options.migrationRef);
    const prep = db.prepare('SELECT * FROM im_schema_preparations').get();
    assert.equal(prep.input_hash, preparationHash(kind, policy(), result.preparationRef));
    assert.equal(prep.initial_epoch, result.initialEpoch);
    assert.equal(db.prepare('SELECT recovery_run_id FROM im_center_state').get().recovery_run_id, null);
    if (kind === 'fresh') assert.equal(result.importEpoch, null);
    else {
      assert.equal(result.instanceId, f.instanceId); assert.equal(result.instanceCreatedAt, 10);
      assert.notEqual(result.importEpoch, result.initialEpoch);
      for (const [table, rows] of Object.entries(before.rows)) if (table !== 'im_schema') assert.deepEqual(snapshot(db).rows[table], rows, table);
      const progress = db.prepare('SELECT * FROM im_sync_progress').get();
      assert.equal(progress.handled_through, 1, 'ACK [ack,unack,ack] gives prefix 1, never max seq 3');
      assert.equal(progress.center_epoch, result.initialEpoch); assert.equal(progress.stream_epoch, f.stream);
      assert.equal(db.prepare('SELECT count(*) n FROM im_send_operation_keys WHERE source_protocol=?').get('a2a-msg.im.v1').n, 3);
      assert.equal(db.prepare('SELECT count(*) n FROM im_content_state').get().n, 3);
    }
    assert.equal(assertImSchemaV4(db), true);
    const prepared = snapshot(db);
    assert.deepEqual(run(db, { ...options, limits: { maxMessages: 99, maxOtherRecords: 999, maxVerifiedContentBytes: 99999 } }), result);
    assert.deepEqual(snapshot(db), prepared, 'different ample limits are not part of the input hash or identity');
  });
});

test('API gates: required expectedVersion, legacy v1/v2, missing identity, active writes, unknown identity inputs', async t => {
  for (const expectedVersion of [undefined, null, 2, '3', 4]) await t.test(`expectedVersion=${expectedVersion}`, t => {
    const { db } = legacy(t);
    const options = importOptions({ expectedVersion }); if (expectedVersion === undefined) delete options.expectedVersion;
    rejectedUnchanged(db, () => migrateImSchemaV4(db, options), { code: 'IM_V2_INPUT_INVALID' });
  });
  for (const version of [1, 2]) await t.test(`legacy v${version}`, t => {
    const db = database(t);
    if (version === 2) migrateImSchema(db);
    else {
      for (const sql of V1_DDL) db.exec(sql);
      insert(db, 'im_schema', { version: 1, migration_checksum: V1_CHECKSUM });
      db.exec("INSERT INTO im_settings VALUES(1,'paused'); INSERT INTO im_clock VALUES(1,0)");
    }
    rejectedUnchanged(db, () => migrateImSchemaV4(db, importOptions()));
  });
  for (const damage of ['identity', 'enabled', 'marker', 'foreign keys']) await t.test(damage, t => {
    const { db } = legacy(t);
    if (damage === 'identity') db.exec('DELETE FROM im_instance_identity');
    if (damage === 'enabled') db.exec("UPDATE im_settings SET write_mode='enabled'");
    if (damage === 'marker') db.prepare('UPDATE im_schema SET migration_checksum=?').run('0'.repeat(64));
    if (damage === 'foreign keys') db.exec('PRAGMA foreign_keys=OFF');
    rejectedUnchanged(db, () => migrateImSchemaV4(db, importOptions()), damage === 'identity' ? { code: 'IM_IDENTITY_MISSING' } : mismatch);
  });
  for (const key of ['initialEpoch', 'importEpoch', 'stableInstanceId', 'epoch']) await t.test(key, t => {
    const db = database(t);
    rejectedUnchanged(db, () => initializeImSchemaV4(db, freshOptions({ [key]: randomUUID() })), { code: 'IM_V2_INPUT_INVALID' });
  });
  await t.test('partial IM schema is not adopted', t => {
    const db = database(t); db.exec('CREATE TABLE im_unknown(x)');
    rejectedUnchanged(db, () => initializeImSchemaV4(db, freshOptions()));
    rejectedUnchanged(db, () => migrateImSchemaV4(db, importOptions()));
  });
  await t.test('fresh initializer does not upgrade v3', t => {
    const { db } = legacy(t); rejectedUnchanged(db, () => initializeImSchemaV4(db, freshOptions()));
  });
  await t.test('import requires a source', t => {
    const db = database(t); rejectedUnchanged(db, () => migrateImSchemaV4(db, importOptions()));
  });
});

test('M1: first import and exact retry enforce lowered projection limits before FK/payload validation', async t => {
  for (const retry of [false, true]) for (const dimension of ['maxMessages', 'maxVerifiedContentBytes', 'maxOtherRecords']) await t.test(`${retry ? 'retry' : 'first'} ${dimension}`, t => {
    const { db, messages } = legacy(t, { messages: 2 });
    db.prepare('UPDATE im_messages SET text=?,title=?,correlation=? WHERE message_id=?').run('界🙂', '题', '联', messages[0]);
    db.exec("UPDATE im_attachments SET name='附件',mime='文/本'"); rehash(db, messages[0]);
    const limits = { [dimension]: dimension === 'maxMessages' ? 1 : dimension === 'maxVerifiedContentBytes' ? contentBytes(db) - 1 : sourceOtherCount(db) - 1 };
    if (retry) migrateImSchemaV4(db, importOptions());
    const events = [];
    const wrapped = observe(db, event => events.push(event));
    rejectedUnchanged(db, () => migrateImSchemaV4(wrapped, importOptions({ limits })), budgetError);
    assert.ok(events.some(e => /count\s*\(|length\s*\(/i.test(e.sql)), 'projection actually ran');
    assert.equal(events.filter(e => /foreign_key_check/i.test(e.sql)).length, 0, 'no heavy FK scan before budget refusal');
    assert.equal(events.filter(e => /\b(?:a\.)?data\b/i.test(e.sql) && /^\s*SELECT/i.test(e.sql) && !/length\s*\(/i.test(e.sql)).length, 0, 'no attachment bytes loaded before refusal');
  });
});

test('M1: ancillary audit, lease requests and receive states all consume maxOtherRecords', async t => {
  for (const table of ['im_audit', 'im_lease_requests', 'im_receive_state']) await t.test(table, t => {
    const f = legacy(t, { leases: table === 'im_lease_requests' }); const { db } = f;
    const baseline = sourceOtherCount(db);
    if (table === 'im_audit') insert(db, table, { actor_kind: 'system', actor_id: 'fixture', action: 'fixture', target_ids_json: '[]', occurred_at: 0, safe_details_json: '{}' });
    if (table === 'im_receive_state') insert(db, table, { agent_id: f.c, stream_epoch: randomUUID() });
    if (table === 'im_lease_requests') {
      const row = db.prepare('SELECT * FROM im_lease_requests').get();
      insert(db, table, { ...row, request_id: randomUUID() });
    }
    assert.equal(sourceOtherCount(db), baseline + 1);
    rejectedUnchanged(db, () => migrateImSchemaV4(db, importOptions({ limits: { maxOtherRecords: baseline } })), budgetError);
    assert.equal(migrateImSchemaV4(db, importOptions({ limits: { maxOtherRecords: baseline + 1 } })).status, 'prepared');
  });
});

test('M1: caller cannot raise or disable any limit; exact UTF-8 budget boundary succeeds', async t => {
  for (const limits of [{ maxMessages: 10001 }, { maxVerifiedContentBytes: 104857601 }, { maxOtherRecords: 10001 },
    { maxElapsedMs: 10001 }, { maxMessages: 0 }, { maxElapsedMs: '50' }, { unknown: 1 }]) await t.test(JSON.stringify(limits), t => {
    const { db } = legacy(t);
    rejectedUnchanged(db, () => migrateImSchemaV4(db, importOptions({ limits })), { code: 'IM_V2_INPUT_INVALID' });
  });
  await t.test('all UTF-8 fields plus BLOB counted exactly', t => {
    const { db, messages: [id] } = legacy(t);
    db.prepare('UPDATE im_messages SET text=?,title=?,correlation=?').run('界🙂', '题', '联');
    db.exec("UPDATE im_attachments SET name='附件',mime='文/本'"); rehash(db, id);
    const bytes = contentBytes(db);
    const options = importOptions({ limits: { maxVerifiedContentBytes: bytes } });
    const first = migrateImSchemaV4(db, options);
    assert.deepEqual(migrateImSchemaV4(db, options), first);
  });
});

test('M1: final native validation consumes monotonic budget and refuses BEFORE COMMIT, including retry', async t => {
  // No sleeps or production injection hooks. The real SQLite statement runs before the fake clock advances.
  for (const mode of ['fresh', 'import', 'retry']) await t.test(mode, t => {
    const db = mode === 'fresh' ? database(t) : legacy(t).db;
    const run = mode === 'fresh' ? initializeImSchemaV4 : migrateImSchemaV4;
    const options = mode === 'fresh' ? freshOptions() : importOptions();
    if (mode === 'retry') run(db, options);
    let elapsed = 0; let finalValidationReached = false; const events = [];
    t.mock.method(performance, 'now', () => elapsed);
    const wrapped = observe(db, event => {
      events.push(event.sql);
      if (/foreign_key_check/i.test(event.sql) && db.prepare("SELECT 1 FROM sqlite_master WHERE name='im_center_state'").get() &&
          db.prepare('SELECT count(*) n FROM im_schema_preparations').get().n) {
        finalValidationReached = true; elapsed = 51;
      }
    });
    rejectedUnchanged(db, () => run(wrapped, { ...options, limits: { maxElapsedMs: 50 } }), budgetError);
    assert.equal(finalValidationReached, true, 'real final validation crossed the controlled budget');
    assert.equal(events.some(sql => /^\s*COMMIT\b/i.test(sql)), false);
    assert.ok(events.some(sql => /^\s*ROLLBACK\b/i.test(sql)));
  });
});

test('M2: source missing receive state with valid message/key/delivery seq42 is rejected atomically', t => {
  const { db } = legacy(t);
  db.exec('DELETE FROM im_receive_state; UPDATE im_deliveries SET seq=42');
  assert.equal(assertImSchema(db), true, 'old schema and native FKs allow this semantic corruption');
  rejectedUnchanged(db, () => migrateImSchemaV4(db, importOptions()));
});

test('M2: current progress missing/wrong center/wrong stream refused on assert and retry; empty flow accepted', async t => {
  for (const damage of ['missing', 'center', 'stream', 'empty']) await t.test(damage, t => {
    const { db } = legacy(t, { messages: damage === 'empty' ? 0 : 1 });
    const result = migrateImSchemaV4(db, importOptions());
    if (damage === 'empty') {
      assert.equal(db.prepare('SELECT handled_through FROM im_sync_progress').get().handled_through, 0);
      assert.equal(assertImSchemaV4(db), true); return;
    }
    if (damage === 'missing') db.exec('DELETE FROM im_sync_progress');
    else if (damage === 'center') db.prepare('UPDATE im_sync_progress SET center_epoch=?').run(result.importEpoch);
    else db.prepare('UPDATE im_sync_progress SET stream_epoch=?').run(randomUUID());
    assert.throws(() => assertImSchemaV4(db), mismatch);
    rejectedUnchanged(db, () => migrateImSchemaV4(db, importOptions()));
  });
});

test('M3: legacy nullable primary IDs cannot silently import; optional NULL reply remains valid', async t => {
  for (const table of ['im_agents', 'im_credentials', 'im_conversations', 'im_receive_state', 'im_attachments', 'im_messages', 'im_receiver_leases']) await t.test(table, t => {
    const f = legacy(t); const { db } = f;
    if (table === 'im_agents') insert(db, table, { agent_id: null, display_name: 'Null', status: 'active', created_at: 0 });
    if (table === 'im_credentials') insert(db, table, { credential_id: null, agent_id: f.a, secret_hash: 'synthetic', created_at: 0 });
    if (table === 'im_conversations') {
      const [low, high] = [f.a, f.c].sort(); insert(db, table, { conversation_id: null, agent_low: low, agent_high: high, created_at: 0 });
    }
    if (table === 'im_receive_state') insert(db, table, { agent_id: null, stream_epoch: randomUUID() });
    if (table === 'im_attachments') assert.equal(db.prepare('UPDATE im_attachments SET attachment_id=NULL').run().changes, 1);
    if (table === 'im_messages') insert(db, table, { message_id: null, conversation_id: f.conversation, sender_id: f.a,
      recipient_id: f.b, client_message_id: randomUUID(), text: 'null-id message', accepted_at: 100 });
    if (table === 'im_receiver_leases') insert(db, table, { agent_id: null, instance_id: randomUUID(), generation: 1,
      expires_at: 1000, credential_id: f.receiverCredential });
    assert.equal(assertImSchema(db), true);
    rejectedUnchanged(db, () => migrateImSchemaV4(db, importOptions()));
  });
  await t.test('NULL reply control', t => {
    const { db } = legacy(t); assert.equal(db.prepare('SELECT in_reply_to FROM im_messages').get().in_reply_to, null);
    assert.equal(migrateImSchemaV4(db, importOptions()).status, 'prepared');
  });
});

test('M3: cross-conversation reply has valid FK and EXACT old fingerprint but must reject', t => {
  const f = legacy(t); const { db } = f;
  const otherConversation = randomUUID(); const [low, high] = [f.c, f.b].sort();
  insert(db, 'im_conversations', { conversation_id: otherConversation, agent_low: low, agent_high: high, created_at: 0 });
  const reply = addMessage(f, { conversation: otherConversation, sender: f.c, recipient: f.b });
  assert.equal(db.prepare('UPDATE im_messages SET in_reply_to=? WHERE message_id=?').run(reply, f.messages[0]).changes, 1);
  rehash(db, f.messages[0]);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  rejectedUnchanged(db, () => migrateImSchemaV4(db, importOptions()));
});

test('M3: semantic corruption fixtures succeed natively before migration rejection', async t => {
  const cases = [
    ['fingerprint', f => f.db.prepare('UPDATE im_send_keys SET payload_hash=?').run('0'.repeat(64))],
    ['attachment hash', f => f.db.prepare('UPDATE im_attachments SET data=?').run(Buffer.from('changed attachment'))],
    ['reserved wire prefix', f => { f.db.exec("UPDATE im_messages SET client_message_id='v2:reserved'; UPDATE im_send_keys SET client_message_id='v2:reserved'"); rehash(f.db, f.messages[0]); }],
    ['delivery gap', f => f.db.exec('UPDATE im_deliveries SET seq=2')],
    ['ACK prefix', f => f.db.exec('UPDATE im_receive_state SET acked_through=0')],
    ['retained floor', f => f.db.exec('UPDATE im_receive_state SET retained_floor=2')],
    ['subject mismatch', f => {
      assert.equal(f.db.prepare('UPDATE im_messages SET recipient_id=?').run(f.c).changes, 1);
      rehash(f.db, f.messages[0]);
    }],
    ['title wire bound', f => { f.db.prepare('UPDATE im_messages SET title=?').run('t'.repeat(101)); rehash(f.db, f.messages[0]); }],
    ['correlation wire bound', f => { f.db.prepare('UPDATE im_messages SET correlation=?').run('c'.repeat(201)); rehash(f.db, f.messages[0]); }],
    ['text UTF16 bound', f => { f.db.prepare('UPDATE im_messages SET text=?').run('🙂'.repeat(16001)); rehash(f.db, f.messages[0]); }],
    ['filename traversal', f => { f.db.exec("UPDATE im_attachments SET name='../x'"); rehash(f.db, f.messages[0]); }],
    ['mime wire bound', f => { f.db.prepare('UPDATE im_attachments SET mime=?').run('m'.repeat(101)); rehash(f.db, f.messages[0]); }],
  ];
  for (const [label, damage] of cases) await t.test(label, t => {
    const f = legacy(t); damage(f); // Do not catch or continue if the fixture failed to reach its intended state.
    assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
    rejectedUnchanged(f.db, () => migrateImSchemaV4(f.db, importOptions()));
  });
  await t.test('exact wire boundary control', t => {
    const { db, messages: [id] } = legacy(t);
    db.prepare('UPDATE im_messages SET title=?,correlation=?,text=?').run('t'.repeat(100), 'c'.repeat(200), '🙂'.repeat(16000));
    db.prepare('UPDATE im_attachments SET name=?,mime=?').run('n'.repeat(200), 'm'.repeat(100)); rehash(db, id);
    assert.equal(migrateImSchemaV4(db, importOptions()).status, 'prepared');
  });
});

test('M3: valid lease/request baseline, then JSON/instance/generation/subject corruption individually rejected', async t => {
  const cases = [
    ['valid', () => {}],
    ['DTO missing fields', f => f.db.exec("UPDATE im_lease_requests SET result_json='{}'")],
    ['DTO extra field', f => f.db.exec("UPDATE im_lease_requests SET result_json=json_set(result_json,'$.extra',1)")],
    ['DTO wrong instance', f => f.db.prepare("UPDATE im_lease_requests SET result_json=json_set(result_json,'$.instanceId',?)").run(randomUUID())],
    ['DTO wrong generation', f => f.db.exec("UPDATE im_lease_requests SET result_json=json_set(result_json,'$.generation',2)")],
    ['DTO wrong scalar', f => f.db.exec("UPDATE im_lease_requests SET result_json=json_set(result_json,'$.historical',0)")],
    ['malformed canonical instance', f => f.db.prepare('UPDATE im_receiver_leases SET instance_id=?').run('-'.repeat(36))],
    ['lease credential subject', f => f.db.prepare('UPDATE im_receiver_leases SET credential_id=?').run(f.credential)],
    ['request subject binding', f => f.db.prepare('UPDATE im_lease_requests SET agent_id=?').run(f.c)],
  ];
  for (const [label, damage] of cases) await t.test(label, t => {
    const f = legacy(t, { leases: true }); damage(f);
    assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
    if (label === 'valid') assert.equal(migrateImSchemaV4(f.db, importOptions()).status, 'prepared');
    else rejectedUnchanged(f.db, () => migrateImSchemaV4(f.db, importOptions()));
  });
});

test('M4: preparation policy reference/input hash and epoch origin/counter drift cannot be adopted', async t => {
  for (const damage of ['policy reference', 'input hash', 'initial origin', 'import origin', 'initial counter', 'import counter']) await t.test(damage, t => {
    const { db } = legacy(t); const result = migrateImSchemaV4(db, importOptions());
    const beforeHash = db.prepare('SELECT input_hash FROM im_schema_preparations').get().input_hash;
    if (damage === 'policy reference') {
      const hash = putPolicy(db, { ...policy(), effectiveAt: 1 });
      db.prepare('UPDATE im_schema_preparations SET policy_hash=?').run(hash);
      assert.equal(db.prepare('SELECT input_hash FROM im_schema_preparations').get().input_hash, beforeHash);
    } else if (damage === 'input hash') db.prepare('UPDATE im_schema_preparations SET input_hash=?').run('0'.repeat(64));
    else {
      const epoch = damage.startsWith('initial') ? result.initialEpoch : result.importEpoch;
      db.prepare(`UPDATE im_center_epochs SET ${damage.endsWith('origin') ? "origin='recovery'" : 'recovery_counter=1'} WHERE center_epoch=?`).run(epoch);
    }
    assert.throws(() => assertImSchemaV4(db), mismatch);
    rejectedUnchanged(db, () => migrateImSchemaV4(db, importOptions()));
  });
});

test('M4: fresh/import exact retry returns verified/active status and actual write mode with zero new rows', async t => {
  for (const kind of ['fresh', 'v3_import']) for (const status of ['verified', 'active']) await t.test(`${kind} ${status}`, t => {
    const db = kind === 'fresh' ? database(t) : legacy(t).db;
    const run = kind === 'fresh' ? initializeImSchemaV4 : migrateImSchemaV4;
    const options = kind === 'fresh' ? freshOptions() : importOptions();
    const first = run(db, options);
    const row = recoveryRow(db, kind === 'fresh' ? 'fresh_bootstrap' : 'v3_import', { status, verified_at: 101,
      ...(status === 'active' ? { activated_at: 102, activation_ref: 'activation', auth_review_ref: 'review',
        activation_plan_hash: 'd'.repeat(64), activation_approval_ref: 'activation-approval' } : {}) });
    bindRun(db, row);
    db.exec("UPDATE im_settings SET write_mode='enabled'");
    assert.equal(assertImSchemaV4(db), true);
    const before = snapshot(db);
    assert.deepEqual(run(db, options), { ...first, status, writeMode: 'enabled' });
    assert.deepEqual(snapshot(db), before);
  });
});

test('M4: conflicting reference/policy and missing preparation refuse, without changing identity', async t => {
  for (const change of ['reference', 'policy', 'preparation']) await t.test(change, t => {
    const db = database(t); initializeImSchemaV4(db, freshOptions());
    if (change === 'preparation') db.exec('DELETE FROM im_schema_preparations');
    const options = freshOptions(change === 'reference' ? { creationRef: 'another' } : change === 'policy' ? { policy: { ...policy(), effectiveAt: 1 } } : {});
    rejectedUnchanged(db, () => initializeImSchemaV4(db, options), change === 'preparation' ? mismatch : { code: 'IM_V2_PREPARATION_CONFLICT' });
  });
});

test('M5: native mutation THEN injected failure rolls back complete source and removal of fault permits retry', async t => {
  const points = [
    ['new DDL', e => e.method === 'exec' && /CREATE TABLE im_center_epochs\b/i.test(e.sql)],
    ['epoch', e => e.method === 'run' && /INSERT INTO im_center_epochs\b/i.test(e.sql)],
    ['preparation', e => e.method === 'run' && /INSERT INTO im_schema_preparations\b/i.test(e.sql)],
    ['first backfill', e => e.method === 'run' && /INSERT INTO im_content_state\b/i.test(e.sql)],
    ['marker write', e => e.method === 'run' && /INSERT INTO im_schema\b/i.test(e.sql)],
    ['final validation', (e, db) => /foreign_key_check/i.test(e.sql) && db.prepare("SELECT 1 FROM sqlite_master WHERE name='im_content_state'").get() && db.prepare('SELECT count(*) n FROM im_content_state').get().n > 0],
  ];
  for (const [label, atPoint] of points) await t.test(label, t => {
    const { db, a } = legacy(t, { messages: 3, acks: [true, false, true], leases: true });
    insert(db, 'im_audit', { actor_kind: 'system', actor_id: 'fixture', action: 'fixture', target_ids_json: '[]', occurred_at: 0, safe_details_json: '{}' });
    insert(db, 'im_migration_runs', { run_id: 'historical-run', preview_hash: 'e'.repeat(64), status: 'completed', actor_id: 'fixture', created_at: 0, completed_at: 1 });
    insert(db, 'im_legacy_bindings', { legacy_member: 'synthetic-member', agent_id: a, approval_ref: 'historical-approval',
      migration_run_id: 'historical-run', status: 'active', source: 'legacy_ip' });
    const failure = Object.assign(new Error(`test-only post-native failure: ${label}`), { code: 'TEST_NATIVE_FAULT' });
    let hit = false;
    const wrapped = observe(db, e => { if (!hit && atPoint(e, db)) { hit = true; throw failure; } });
    rejectedUnchanged(db, () => migrateImSchemaV4(wrapped, importOptions()), error => hit && (error === failure || error.code === 'IM_SCHEMA_MISMATCH'));
    assert.equal(hit, true, 'failure boundary executed natively');
    assert.equal(assertImSchema(db), true);
    assert.equal(migrateImSchemaV4(db, importOptions()).status, 'prepared');
    assert.equal(assertImSchemaV4(db), true);
  });
  for (const [label, atPoint] of points.filter(([label]) => !['first backfill', 'final validation'].includes(label))) await t.test(`fresh ${label}`, t => {
    const db = database(t); let hit = false;
    const failure = Object.assign(new Error('test-only fresh native fault'), { code: 'TEST_NATIVE_FAULT' });
    const wrapped = observe(db, e => { if (!hit && atPoint(e, db)) { hit = true; throw failure; } });
    rejectedUnchanged(db, () => initializeImSchemaV4(wrapped, freshOptions()), error => hit && (error === failure || error.code === 'IM_SCHEMA_MISMATCH'));
    assert.equal(hit, true); assert.deepEqual(manifest(db), []);
    assert.equal(initializeImSchemaV4(db, freshOptions()).status, 'prepared');
  });
  await t.test('fresh final validation', t => {
    const db = database(t); let hit = false;
    const failure = Object.assign(new Error('test-only fresh final validation fault'), { code: 'TEST_NATIVE_FAULT' });
    const wrapped = observe(db, e => {
      if (!hit && /foreign_key_check/i.test(e.sql) && db.prepare("SELECT 1 FROM sqlite_master WHERE name='im_schema_preparations'").get() &&
          db.prepare('SELECT count(*) n FROM im_schema_preparations').get().n === 1) { hit = true; throw failure; }
    });
    rejectedUnchanged(db, () => initializeImSchemaV4(wrapped, freshOptions()), error => hit && (error === failure || error.code === 'IM_SCHEMA_MISMATCH'));
    assert.equal(hit, true); assert.deepEqual(manifest(db), []);
    assert.equal(initializeImSchemaV4(db, freshOptions()).status, 'prepared');
  });
});

test('Q2/Q3: real backfill followed by late semantic tamper rolls back DDL, marker and every old row', async t => {
  const cases = [
    ...[0, 7776000101].map(deadline => [`deadline ${deadline}`, db => {
      assert.equal(db.prepare('SELECT expires_at FROM im_content_state LIMIT 1').get().expires_at, 7776000100);
      assert.equal(db.prepare('UPDATE im_content_state SET expires_at=?').run(deadline).changes, 2);
    }]),
    ...retainedCorruptions,
  ];
  for (const [label, corrupt] of cases) await t.test(label, t => {
    const { db, messages: [id] } = legacy(t, { messages: 2, acks: [true, false], leases: true });
    insert(db, 'im_audit', { actor_kind: 'system', actor_id: 'fixture', action: 'late-validation', target_ids_json: '[]',
      occurred_at: 0, safe_details_json: '{}' });
    let hit = false; const events = [];
    const wrapped = observe(db, event => {
      events.push(event.sql);
      if (hit || event.method !== 'run' || !/INSERT INTO im_schema\b/i.test(event.sql)) return;
      assert.equal(db.prepare('SELECT version FROM im_schema').get().version, 4, 'actual v4 marker write completed');
      assert.equal(db.prepare('SELECT count(*) n FROM im_content_state').get().n, 2, 'all actual content backfill completed');
      assert.equal(db.prepare('SELECT count(*) n FROM im_send_operation_keys').get().n, 2);
      assert.equal(db.prepare('SELECT count(*) n FROM im_attachment_reservations').get().n, 1);
      assert.equal(db.prepare('SELECT payload_hash FROM im_send_keys WHERE message_id=?').get(id).payload_hash, pinnedV1Hash(db, id));
      corrupt(db, id); // A native successful mutation, never an injected throw masquerading as validation.
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      hit = true;
    });
    rejectedUnchanged(db, () => migrateImSchemaV4(wrapped, importOptions()));
    assert.equal(hit, true, 'corruption was introduced after actual backfill, not during source preflight');
    assert.equal(events.some(sql => /^\s*COMMIT\b/i.test(sql)), false);
    assert.ok(events.some(sql => /^\s*ROLLBACK\b/i.test(sql)));
    assert.equal(assertImSchema(db), true);
    assert.equal(migrateImSchemaV4(db, importOptions()).status, 'prepared', 'without observer original source is still importable');
  });
});

test('Q3: final retained-payload validation is streaming and charged to monotonic budget before COMMIT', async t => {
  for (const mode of ['import', 'retry']) for (const overBudget of [false, true]) await t.test(`${mode} ${overBudget ? 'elapsed refusal' : 'one-BLOB reads'}`, t => {
    const f = legacy(t); addMessage(f, { attachment: true });
    const { db } = f; const options = importOptions();
    if (mode === 'retry') migrateImSchemaV4(db, options);
    let finalPhase = mode === 'retry'; let finalBlobReads = 0; let elapsed = 0;
    const events = [];
    t.mock.method(performance, 'now', () => elapsed);
    const wrapped = observe(db, event => {
      events.push(event.sql);
      if (event.method === 'run' && /INSERT INTO im_schema\b/i.test(event.sql)) finalPhase = true;
      if (!finalPhase || !['get', 'all', 'iterate'].includes(event.method)) return;
      const rows = Array.isArray(event.result) ? event.result : [event.result];
      const blobs = rows.flatMap(row => row && typeof row === 'object' ? Object.values(row) : [])
        .filter(value => value instanceof Uint8Array);
      assert.ok(blobs.length <= 1, 'native statement result materializes at most one attachment BLOB');
      if (blobs.length) {
        finalBlobReads++;
        if (overBudget) elapsed = 51; // Advances only AFTER the real expensive final-validation read.
      }
    });
    if (overBudget) {
      rejectedUnchanged(db, () => migrateImSchemaV4(wrapped, { ...options, limits: { maxElapsedMs: 50 } }), budgetError);
      assert.ok(finalBlobReads >= 1, 'final validation actually read retained bytes before budget refusal');
      assert.equal(events.some(sql => /^\s*COMMIT\b/i.test(sql)), false);
      assert.ok(events.some(sql => /^\s*ROLLBACK\b/i.test(sql)));
    } else {
      const before = mode === 'retry' ? snapshot(db) : null;
      assert.equal(migrateImSchemaV4(wrapped, options).status, 'prepared');
      assert.ok(finalBlobReads >= 2, 'both retained attachments were read during final validation');
      if (before) assert.deepEqual(snapshot(db), before);
    }
  });
});
