import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeImSchemaV4, migrateImSchemaV4 } from '../src/im/v2/migration.js';
import { assertImSchemaV4 } from '../src/im/v2/schema.js';
import { createImV2ClockGuard } from '../src/im/v2/clock.js';
import { createImV2Auth } from '../src/im/v2/auth.js';
import { createImV2Acl } from '../src/im/v2/acl.js';
import { hashRetentionPolicy, DEFAULT_POLICY, DEFAULT_MAINTENANCE } from '../src/im/v2/config.js';
import { PROTOCOL, fingerprintMessage, storageOperationKey } from '../src/im/v2/contracts.js';
import { database, freshOptions, insert, recoveryRow, bindRun, putPolicy, legacy, importOptions,
  preparationHash, snapshot, observe, maintenance } from './fixtures/im-v2-schema/helpers.js';

const code = name => ({ code: name });
function fixture(t, { active = true, enabled = true, writeMode = 'enabled', effectiveAt = 1,
  kind = 'fresh_bootstrap', construct = true, onStatement } = {}) {
  const native = kind === 'v3_import' ? legacy(t, { messages: 0 }).db : database(t);
  const db = native;
  db.exec('PRAGMA synchronous=FULL');
  if (kind === 'v3_import') migrateImSchemaV4(db, importOptions());
  else initializeImSchemaV4(db, freshOptions());
  const p = { ...DEFAULT_POLICY, effectiveAt };
  const hash = putPolicy(db, p);
  const row = recoveryRow(db, kind === 'v3_import' ? kind : 'fresh_bootstrap', active ? { status: 'active', verified_at: 101,
    activated_at: 102, activation_ref: 'activation-fixture', auth_review_ref: 'review-fixture',
    activation_plan_hash: 'a'.repeat(64), activation_approval_ref: 'approval-fixture' } : {});
  bindRun(db, row);
  const centerEpoch = kind === 'snapshot_recovery' ? transitionEpoch(db) : row.new_epoch;
  const scope = { protocol: PROTOCOL, centerEpoch };
  const a = randomUUID(), b = randomUUID(), stranger = randomUUID();
  for (const [id, name] of [[a,'Alice'],[b,'Bob'],[stranger,'Stranger']])
    insert(db, 'im_agents', { agent_id: id, display_name: name, status: 'active', created_at: 0, revoked_at: null });
  const [low, high] = [a,b].sort();
  insert(db, 'im_contacts', { agent_low: low, agent_high: high, allowed: 1, version: 1, updated_at: 0 });
  const conversationId = randomUUID();
  insert(db, 'im_conversations', { conversation_id: conversationId, agent_low: low, agent_high: high, created_at: 0 });
  const messageId = randomUUID(), attachmentId = randomUUID(), clientMessageId = randomUUID();
  const storageKey = storageOperationKey(centerEpoch, clientMessageId);
  insert(db, 'im_messages', { message_id: messageId, conversation_id: conversationId, sender_id: a,
    recipient_id: b, client_message_id: storageKey, title: null, text: 'hello', in_reply_to: null,
    correlation: null, accepted_at: 10 });
  insert(db, 'im_content_state', { message_id: messageId, state: 'live', expires_at: 7776000010,
    expired_at: null, scrubbed_at: null, policy_hash: hash, expiry_run_id: null, scrub_run_id: null });
  const bytes = Buffer.from('test-only attachment');
  const digest = createHash('sha256').update(bytes).digest('hex');
  insert(db, 'im_attachments', { attachment_id: attachmentId, message_id: messageId,
    name: 'a.txt', mime: 'text/plain', size: bytes.length, sha256: digest, data: bytes });
  insert(db, 'im_attachment_reservations', { attachment_id: attachmentId, message_id: messageId,
    size: bytes.length, sha256: digest });
  const fingerprint = fingerprintMessage({ protocol: PROTOCOL, centerEpoch, originEpoch: centerEpoch,
    clientMessageId, conversationId, recipientAgentId: b, title: null, text: 'hello',
    attachment: { name: 'a.txt', mime: 'text/plain', size: bytes.length, sha256: digest, bytes },
    inReplyTo: null, correlation: null });
  insert(db, 'im_send_keys', { sender_id: a, client_message_id: storageKey, payload_hash: fingerprint,
    message_id: messageId, created_at: 10, retry_until: 604800010, status: 'live' });
  insert(db, 'im_send_operation_keys', { sender_id: a, origin_epoch: centerEpoch,
    client_message_id: clientMessageId, storage_client_message_id: storageKey,
    source_protocol: PROTOCOL, message_id: messageId });
  const streamEpoch = randomUUID();
  insert(db, 'im_receive_state', { agent_id: b, next_seq: 2, acked_through: 0,
    retained_floor: 1, stream_epoch: streamEpoch });
  insert(db, 'im_sync_progress', { recipient_id: b, center_epoch: centerEpoch, stream_epoch: streamEpoch,
    handled_through: 0, updated_at: 10 });
  insert(db, 'im_deliveries', { recipient_id: b, seq: 1, message_id: messageId,
    acked_at: null, read_at: null });
  const credentialId = randomUUID(), secret = randomBytes(32).toString('base64url');
  const credential = `${credentialId}.${secret}`;
  insert(db, 'im_credentials', { credential_id: credentialId, agent_id: a,
    secret_hash: createHash('sha256').update(secret).digest('hex'), created_at: 0,
    expires_at: null, revoked_at: null });
  db.prepare('UPDATE im_settings SET write_mode=?').run(writeMode);
  let now = 103;
  const clock = () => now;
  const policy = { enabled, writeMode, transport: { mode: 'local-test', serverUrl: 'http://localhost/' },
    retention: { policy: p, policyHash: hashRetentionPolicy(p) }, lease: { ttlMs: 1000, renewalMs: 500 },
    limits: { maxAttachmentBytes: 10485760, maxBodyBytes: 65536, maxFileBodyBytes: 16777216,
      maxConnections: 10, maxRequestsPerMinute: 100 },
    maintenance: { ...DEFAULT_MAINTENANCE, maxKeyReservations: 1000 } };
  assert.equal(assertImSchemaV4(db), true, 'SQL-only candidate fixture satisfies the full P1 assertion');
  const connection = onStatement ? observe(db, onStatement) : db;
  const auth = construct ? createImV2Auth({ db: connection, policy, clock }) : undefined;
  const acl = construct ? createImV2Acl({ db: connection, auth, clock }) : undefined;
  return { db: connection, auth, acl, clock, policy, scope, a, b, stranger, low, high, credentialId, credential,
    conversationId, messageId, attachmentId, setTime: value => { now = value; } };
}

// SQL fixtures, not production activation APIs. Old operation keys/progress remain historical.
function transitionEpoch(db) {
  const old = db.prepare('SELECT center_epoch,recovery_counter FROM im_center_state').get();
  const next = randomUUID();
  const counter = old.recovery_counter + 1;
  insert(db, 'im_center_epochs', { center_epoch: next, created_at: 100, origin: 'recovery', recovery_counter: counter });
  const row = recoveryRow(db, 'snapshot_recovery', { run_id: `snapshot-${next}`, preparation_ref: null,
    old_epoch: old.center_epoch, new_epoch: next, backup_id: randomUUID(), backup_file_hash: 'b'.repeat(64),
    manifest_hash: 'c'.repeat(64), candidate_base_hash: 'b'.repeat(64), status: 'active', verified_at: 101,
    activated_at: 102, activation_ref: `activation-${next}`, auth_review_ref: 'fixture-auth-review',
    activation_plan_hash: 'd'.repeat(64), activation_approval_ref: 'fixture-activation-approval' });
  insert(db, 'im_recovery_runs', row);
  db.prepare('UPDATE im_center_state SET center_epoch=?,recovery_counter=?,recovery_run_id=?,status=?,activation_ref=?,updated_at=102')
    .run(next, counter, row.run_id, row.status, row.activation_ref);
  db.prepare(`INSERT INTO im_sync_progress(recipient_id,center_epoch,stream_epoch,handled_through,updated_at)
    SELECT recipient_id,?,stream_epoch,handled_through,updated_at FROM im_sync_progress WHERE center_epoch=?`)
    .run(next, old.center_epoch);
  assert.equal(assertImSchemaV4(db), true, 'complete snapshot transition is P1-valid');
  return next;
}

function otherPreparation(f) {
  const original = f.db.prepare('SELECT * FROM im_schema_preparations').get();
  const policy = JSON.parse(f.db.prepare('SELECT canonical_json FROM im_retention_policies WHERE policy_hash=?')
    .get(original.policy_hash).canonical_json);
  const ref = 'other-legal-preparation', epoch = randomUUID();
  insert(f.db, 'im_center_epochs', { center_epoch: epoch, created_at: 0, origin: 'fresh', recovery_counter: 0 });
  insert(f.db, 'im_schema_preparations', { ...original, preparation_ref: ref, initial_epoch: epoch,
    input_hash: preparationHash('fresh', policy, ref) });
  assert.notEqual(epoch, f.scope.centerEpoch);
  assert.equal(assertImSchemaV4(f.db), true, 'both preparations are legal before runtime drift');
  return ref;
}

function businessSnapshot(db) {
  const result = snapshot(db);
  delete result.rows.im_clock; // The clock anchor is independently durable even when business rolls back.
  return result;
}

function sentinel(f) {
  f.db.prepare('UPDATE im_agents SET display_name=? WHERE agent_id=?').run('business-sentinel', f.a);
}

function thirdParty(f) {
  const id = randomUUID(), secret = randomBytes(32).toString('base64url');
  insert(f.db, 'im_credentials', { credential_id: id, agent_id: f.stranger,
    secret_hash: createHash('sha256').update(secret).digest('hex'), created_at: 0 });
  return f.auth.authenticate(`${id}.${secret}`);
}

function expireContent(f) {
  const run = maintenance(f.db, 'expire');
  f.db.prepare("UPDATE im_content_state SET state='expired',expired_at=7776000100,expiry_run_id=? WHERE message_id=?")
    .run(run, f.messageId);
  assert.equal(assertImSchemaV4(f.db), true, 'expired content fixture is P1-valid');
}

test('TEST ONLY candidate fixture authenticates, guards scopes and grants metadata, not payload', t => {
  const f = fixture(t);
  const principal = f.auth.authenticate(f.credential);
  assert.deepEqual(Object.keys(principal), ['agentId','credentialId']);
  assert.equal(Object.isFrozen(principal), true);
  assert.equal(f.auth.me(f.credential).agentId, f.a);
  assert.equal(f.acl.requirePeer(principal, f.scope, f.b).peerAgentId, f.b);
  assert.equal(f.acl.requireConversation(principal, f.scope, f.conversationId).conversationId, f.conversationId);
  assert.equal(f.acl.requireMessage(principal, f.scope, f.messageId).contentState, 'live');
  assert.equal(f.acl.requireLiveMessage(principal, f.scope, f.messageId).messageId, f.messageId);
  assert.equal(f.acl.assertAttachmentAccess(principal, f.scope, f.attachmentId).attachmentId, f.attachmentId);
  assert.equal(f.auth.withWrite(principal, f.scope, () => 12), 12);
  assert.throws(() => f.auth.assertActive(principal), code('INVALID_REQUEST'));
  assert.throws(() => f.auth.withRead({ ...principal }, f.scope, () => {}), code('INVALID_CREDENTIAL'));
  assert.throws(() => f.auth.withRead(principal, { ...f.scope, centerEpoch: randomUUID() }, () => {}), code('RECOVERY_RECONCILIATION_REQUIRED'));
  assert.throws(() => f.auth.withRead(principal, { ...f.scope, protocol: 'wrong' }, () => {}), code('INVALID_REQUEST'));
  assert.throws(() => f.acl.requireMessage(principal, f.scope, randomUUID()), code('RESOURCE_NOT_FOUND'));
  assert.throws(() => f.acl.assertAttachmentAccess(principal, f.scope, randomUUID()), code('RESOURCE_NOT_FOUND'));
  f.db.prepare('UPDATE im_contacts SET allowed=0').run();
  assert.throws(() => f.acl.requireLiveMessage(principal, f.scope, f.messageId), code('RESOURCE_NOT_FOUND'));
  assert.throws(() => f.acl.assertAttachmentAccess(principal, f.scope, f.attachmentId), code('RESOURCE_NOT_FOUND'));
});

test('credentials are exact canonical strings, bound to instance, rechecked and expired at equality', t => {
  const f = fixture(t);
  for (const invalid of [f.credential.slice(0,-1), f.credential.replace(/.$/,'!'),
    `${f.credentialId}.${'A'.repeat(43)}`, `${randomUUID()}.${f.credential.split('.')[1]}`])
    assert.throws(() => f.auth.authenticate(invalid), code('INVALID_CREDENTIAL'));
  assert.throws(() => f.auth.authenticate(), code('AUTH_REQUIRED'));
  const p = f.auth.authenticate(f.credential);
  const other = createImV2Auth({ db: f.db, policy: f.policy, clock: f.clock });
  assert.throws(() => other.withRead(p, f.scope, () => {}), code('INVALID_CREDENTIAL'));
  assert.throws(() => f.auth.withRead({ ...p }, f.scope, () => {}), code('INVALID_CREDENTIAL'));
  f.db.prepare('UPDATE im_credentials SET expires_at=103 WHERE credential_id=?').run(f.credentialId);
  assert.throws(() => f.auth.withRead(p, f.scope, () => {}), code('INVALID_CREDENTIAL'));
  assert.throws(() => f.auth.authenticate(f.credential), code('INVALID_CREDENTIAL'));
});

test('prepared state disables, business rollback and final refreshed credential check', t => {
  const f = fixture(t, { active: false });
  const p = f.auth.authenticate(f.credential);
  assert.throws(() => f.auth.me(f.credential), code('IM_DISABLED'));
  assert.throws(() => f.auth.withWrite(p, f.scope, () => assert.fail('no callback')), code('IM_DISABLED'));
  const g = fixture(t);
  const principal = g.auth.authenticate(g.credential);
  assert.throws(() => g.auth.withWrite(principal, g.scope, async () => assert.fail('async prefix')), code('INVALID_REQUEST'));
  assert.throws(() => g.auth.withWrite(principal, g.scope, () => {
    g.db.prepare('UPDATE im_settings SET write_mode=?').run('paused');
    return { then() {} };
  }), code('INVALID_REQUEST'));
  assert.equal(g.db.prepare('SELECT write_mode FROM im_settings').get().write_mode, 'enabled');
  assert.throws(() => g.auth.withWrite(principal, g.scope, () => {
    g.db.prepare('UPDATE im_credentials SET expires_at=? WHERE credential_id=?').run(105, g.credentialId);
    g.setTime(105);
  }), code('INVALID_CREDENTIAL'));
  assert.equal(g.db.prepare('SELECT expires_at FROM im_credentials WHERE credential_id=?').get(g.credentialId).expires_at, null);
});

test('trusted finalCheck observes final time and result, without sampling after it', t => {
  let calls = 0, now = 103;
  const f = fixture(t, { construct: false });
  const clock = () => { calls++; return now; };
  const auth = createImV2Auth({ db: f.db, policy: f.policy, clock });
  const principal = auth.authenticate(f.credential);
  const value = Object.freeze({ identity: 'same result' });
  let checked = 0, seenTime;
  const result = auth.withWrite(principal, f.scope, () => {
    sentinel(f);
    now = 104;
    return value;
  }, actual => {
    checked++;
    assert.equal(actual, value);
    seenTime = calls;
    assert.equal(f.db.prepare('SELECT last_observed_at FROM im_clock').get().last_observed_at, 104);
    assert.equal(f.db.isTransaction, true);
    return false; // Only throwing signals failure; return values do not grant or deny authority.
  });
  assert.equal(result, value);
  assert.equal(checked, 1);
  assert.equal(calls, seenTime, 'no clock sampling after finalCheck');
  assert.equal(f.db.prepare('SELECT display_name FROM im_agents WHERE agent_id=?').get(f.a).display_name, 'business-sentinel');
});

test('trusted finalCheck rejects async prefix, thenables and thrown falsy failures atomically', t => {
  const f = fixture(t), principal = f.auth.authenticate(f.credential);
  const before = businessSnapshot(f.db);
  let main = 0, final = 0;
  assert.throws(() => f.auth.withWrite(principal, f.scope, () => { main++; sentinel(f); }, async () => { final++; }), code('INVALID_REQUEST'));
  assert.equal(main, 0); assert.equal(final, 0);
  assert.throws(() => f.auth.withWrite(principal, f.scope, () => { main++; sentinel(f); }, null), code('INVALID_REQUEST'));
  assert.equal(main, 0);
  assert.throws(() => f.auth.withWrite(principal, f.scope, () => { main++; sentinel(f); }, () => {
    final++; return { then() {} };
  }), code('INVALID_REQUEST'));
  assert.equal(final, 1);
  assert.deepEqual(businessSnapshot(f.db), before);
  for (const failure of [false, null, 0]) {
    let caught = Symbol('not thrown');
    try { f.auth.withWrite(principal, f.scope, () => { main++; sentinel(f); }, () => { throw failure; }); }
    catch (error) { caught = error; }
    assert.equal(caught, failure);
    assert.deepEqual(businessSnapshot(f.db), before);
  }
  assert.equal(f.db.isTransaction, false);
});

test('trusted finalCheck does not run when final identity or entry gates fail', t => {
  const f = fixture(t), principal = f.auth.authenticate(f.credential);
  const before = businessSnapshot(f.db);
  let final = 0;
  assert.throws(() => f.auth.withWrite(principal, f.scope, () => {
    sentinel(f);
    f.db.prepare('UPDATE im_credentials SET expires_at=104 WHERE credential_id=?').run(f.credentialId);
    f.setTime(104);
  }, () => { final++; }), code('INVALID_CREDENTIAL'));
  assert.equal(final, 0);
  assert.deepEqual(businessSnapshot(f.db), before);
  assert.equal(f.db.prepare('SELECT last_observed_at FROM im_clock').get().last_observed_at, 104);
  f.db.prepare("UPDATE im_settings SET write_mode='paused'").run();
  let main = 0;
  assert.throws(() => f.auth.withWrite(principal, f.scope, () => { main++; }, () => { final++; }), code('NEW_WRITES_DISABLED'));
  assert.equal(main, 0); assert.equal(final, 0);
});

test('trusted finalCheck expiry failure rolls back business but persists final clock floor', t => {
  const f = fixture(t), principal = f.auth.authenticate(f.credential);
  const before = businessSnapshot(f.db);
  let final = 0;
  assert.throws(() => f.auth.withWrite(principal, f.scope, () => {
    sentinel(f);
    f.setTime(105);
    return 'operation';
  }, result => {
    final++;
    assert.equal(result, 'operation');
    assert.equal(f.db.prepare('SELECT last_observed_at FROM im_clock').get().last_observed_at, 105);
    throw Object.assign(new Error('lease expired'), { code: 'LEASE_EXPIRED' });
  }), code('LEASE_EXPIRED'));
  assert.equal(final, 1);
  assert.deepEqual(businessSnapshot(f.db), before);
  assert.equal(f.db.prepare('SELECT last_observed_at FROM im_clock').get().last_observed_at, 105);
});

test('v4 lagging proven ACK cursor survives real-file reopen and fresh auth guard', t => {
  const f = fixture(t);
  f.db.exec('UPDATE im_deliveries SET acked_at=103 WHERE seq=1');
  assert.equal(f.db.prepare('SELECT acked_through FROM im_receive_state').get().acked_through, 0);
  assert.equal(assertImSchemaV4(f.db), true);
  const dir = mkdtempSync(join(tmpdir(), 'im-v2-ack-lag-'));
  const filename = join(dir, 'candidate.sqlite');
  f.db.exec(`VACUUM INTO '${filename.replaceAll("'", "''")}'`);
  const reopened = new DatabaseSync(filename);
  t.after(() => { reopened.close(); rmSync(dir, { recursive: true, force: true }); });
  reopened.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
  assert.equal(assertImSchemaV4(reopened), true);
  const auth = createImV2Auth({ db: reopened, policy: f.policy, clock: f.clock });
  const principal = auth.authenticate(f.credential);
  assert.equal(auth.withWrite(principal, f.scope, () => 'reopened'), 'reopened');
  assert.equal(reopened.prepare('SELECT acked_through FROM im_receive_state').get().acked_through, 0);
});

test('expired content only after ACL; missing live payload is storage failure', t => {
  const f = fixture(t);
  const principal = f.auth.authenticate(f.credential);
  f.db.prepare('DELETE FROM im_attachments WHERE attachment_id=?').run(f.attachmentId);
  assert.throws(() => f.acl.assertAttachmentAccess(principal, f.scope, f.attachmentId), code('STORAGE_UNAVAILABLE'));
  const bytes = Buffer.from('test-only attachment');
  f.db.prepare('INSERT INTO im_attachments(attachment_id,message_id,name,mime,size,sha256,data) VALUES(?,?,?,?,?,?,?)')
    .run(f.attachmentId, f.messageId, 'a.txt', 'text/plain', bytes.length,
      createHash('sha256').update(bytes).digest('hex'), bytes);
  const policyHash = f.db.prepare('SELECT policy_hash FROM im_content_state WHERE message_id=?').get(f.messageId).policy_hash;
  insert(f.db, 'im_maintenance_runs', { run_id: 'expiry-fixture', center_epoch: f.scope.centerEpoch,
    kind: 'expire', execution_policy_hash: policyHash, plan_hash: 'a'.repeat(64),
    approved_batch_hash: 'b'.repeat(64), approval_ref: 'test-approval', executor_id: 'test',
    status: 'completed', candidate_json: '[]', result_json: '{}', previewed_at: 7776000010,
    expires_at: 7776000011, completed_at: 7776000010, scan_rows: 1, scan_bytes: 1,
    changed_rows: 1, changed_bytes: 1 });
  f.db.prepare("UPDATE im_content_state SET state='expired',expired_at=7776000010,expiry_run_id='expiry-fixture' WHERE message_id=?")
    .run(f.messageId);
  assert.equal(f.acl.requireMessage(principal, f.scope, f.messageId).contentState, 'expired');
  assert.throws(() => f.acl.requireLiveMessage(principal, f.scope, f.messageId), code('CONTENT_EXPIRED'));
  assert.throws(() => f.acl.assertAttachmentAccess(principal, f.scope, f.attachmentId), code('CONTENT_EXPIRED'));
  f.db.prepare('UPDATE im_contacts SET allowed=0').run();
  assert.throws(() => f.acl.requireLiveMessage(principal, f.scope, f.messageId), code('RESOURCE_NOT_FOUND'));
  assert.throws(() => f.acl.assertAttachmentAccess(principal, f.scope, f.attachmentId), code('RESOURCE_NOT_FOUND'));
});

test('write gates reject paused DB and inconsistent final center/run state without committing business', t => {
  const f = fixture(t);
  const principal = f.auth.authenticate(f.credential);
  f.db.prepare("UPDATE im_settings SET write_mode='paused'").run();
  assert.throws(() => f.auth.withWrite(principal, f.scope, () => assert.fail('paused callback')), code('NEW_WRITES_DISABLED'));
  f.db.prepare("UPDATE im_settings SET write_mode='enabled'").run();
  const before = businessSnapshot(f.db);
  assert.throws(() => f.auth.withWrite(principal, f.scope, () => {
    sentinel(f);
    f.db.prepare("UPDATE im_center_state SET status='verified',activation_ref=NULL").run();
  }), code('STORAGE_UNAVAILABLE'));
  assert.deepEqual(businessSnapshot(f.db), before);
  assert.equal(f.db.prepare('SELECT status FROM im_center_state').get().status, 'active');
  assert.throws(() => f.auth.withWrite(principal, f.scope, () =>
    f.auth.withWrite(principal, f.scope, () => {})), code('INVALID_REQUEST'));
});

test('disabled configuration, future policy and revoked credential fail before business callback', t => {
  const disabled = fixture(t, { enabled: false, writeMode: 'paused' });
  const p = disabled.auth.authenticate(disabled.credential);
  assert.throws(() => disabled.auth.withRead(p, disabled.scope, () => assert.fail('disabled')),
    code('IM_DISABLED'));
  const future = fixture(t, { effectiveAt: 200 });
  const principal = future.auth.authenticate(future.credential);
  assert.throws(() => future.auth.withWrite(principal, future.scope, () => assert.fail('future')),
    code('POLICY_NOT_CONFIGURED'));
  future.db.prepare('UPDATE im_credentials SET revoked_at=100 WHERE credential_id=?').run(future.credentialId);
  assert.throws(() => future.auth.withRead(principal, future.scope, () => assert.fail('revoked')),
    code('INVALID_CREDENTIAL'));
});

for (const kind of ['fresh_bootstrap', 'v3_import', 'snapshot_recovery']) {
  test(`${kind}: legal active SQL candidate permits authenticated reads and writes`, t => {
    const f = fixture(t, { kind });
    const principal = f.auth.authenticate(f.credential);
    assert.equal(f.auth.me(f.credential).centerEpoch, f.scope.centerEpoch);
    assert.equal(f.auth.withRead(principal, f.scope, () => {
      assert.equal(f.db.isTransaction, true);
      return 'read';
    }), 'read');
    assert.equal(f.auth.withWrite(principal, f.scope, () => {
      assert.equal(f.db.isTransaction, true);
      sentinel(f);
      return 'write';
    }), 'write');
    assert.equal(f.db.isTransaction, false);
    assert.equal(f.db.prepare('SELECT display_name FROM im_agents WHERE agent_id=?').get(f.a).display_name,
      'business-sentinel');
    assert.equal(assertImSchemaV4(f.db), true);
  });
}

for (const method of ['withRead', 'withWrite']) {
  test(`${method}: active run rebound to a separate legal preparation rejects before callback`, t => {
    const f = fixture(t);
    const principal = f.auth.authenticate(f.credential);
    const ref = otherPreparation(f);
    f.db.prepare('UPDATE im_recovery_runs SET preparation_ref=? WHERE run_id=?').run(ref, 'run-fixture');
    assert.equal(f.db.prepare('SELECT 1 FROM pragma_foreign_key_check LIMIT 1').get(), undefined);
    assert.throws(() => assertImSchemaV4(f.db), code('IM_SCHEMA_MISMATCH'));
    const before = businessSnapshot(f.db);
    let callbacks = 0;
    assert.throws(() => f.auth[method](principal, f.scope, () => {
      callbacks++;
      sentinel(f);
    }), code('STORAGE_UNAVAILABLE'));
    assert.equal(callbacks, 0);
    assert.equal(f.db.isTransaction, false);
    assert.deepEqual(businessSnapshot(f.db), before);
  });
}

test('final write check rolls back preparation drift and every business change', t => {
  const f = fixture(t);
  const principal = f.auth.authenticate(f.credential);
  const ref = otherPreparation(f);
  const before = businessSnapshot(f.db);
  let callbacks = 0;
  assert.throws(() => f.auth.withWrite(principal, f.scope, () => {
    callbacks++;
    assert.equal(f.db.isTransaction, true);
    f.db.prepare('UPDATE im_recovery_runs SET preparation_ref=? WHERE run_id=?').run(ref, 'run-fixture');
    assert.equal(f.db.prepare('SELECT 1 FROM pragma_foreign_key_check LIMIT 1').get(), undefined);
    sentinel(f);
  }), code('STORAGE_UNAVAILABLE'));
  assert.equal(callbacks, 1);
  assert.equal(f.db.isTransaction, false);
  assert.deepEqual(businessSnapshot(f.db), before);
  assert.equal(assertImSchemaV4(f.db), true);
});

const runtimeDrifts = [
  ['fresh preparation referenced by an import run', 'fresh_bootstrap', f => {
    f.db.prepare(`UPDATE im_recovery_runs SET candidate_kind='v3_import',isolation_ack_ref='fixture-isolation',
      rpo_report_json=? WHERE run_id='run-fixture'`).run(JSON.stringify({ status: 'unknown' }));
    assert.throws(() => assertImSchemaV4(f.db), code('IM_SCHEMA_MISMATCH'));
  }],
  ['snapshot epoch has non-recovery origin', 'snapshot_recovery', f => {
    f.db.prepare("UPDATE im_center_epochs SET origin='fresh' WHERE center_epoch=?").run(f.scope.centerEpoch);
  }],
  ['snapshot counter does not exceed the old epoch', 'snapshot_recovery', f => {
    // Keep center and new-epoch counters mutually consistent, so the old/new relation is decisive.
    f.db.prepare('UPDATE im_center_epochs SET recovery_counter=0 WHERE center_epoch=?').run(f.scope.centerEpoch);
    f.db.prepare('UPDATE im_center_state SET recovery_counter=0').run();
  }],
];
for (const [label, kind, drift] of runtimeDrifts) {
  test(`runtime candidate relation: ${label}`, t => {
    const f = fixture(t, { kind });
    const principal = f.auth.authenticate(f.credential);
    assert.equal(f.auth.withRead(principal, f.scope, () => 'valid'), 'valid');
    drift(f); // Deliberately after canonical guard construction and principal issuance.
    assert.equal(f.db.prepare('SELECT 1 FROM pragma_foreign_key_check LIMIT 1').get(), undefined);
    const before = businessSnapshot(f.db);
    let callbacks = 0;
    for (const method of ['withRead', 'withWrite']) {
      assert.throws(() => f.auth[method](principal, f.scope, () => { callbacks++; sentinel(f); }),
        code('STORAGE_UNAVAILABLE'));
    }
    assert.equal(callbacks, 0);
    assert.equal(f.db.isTransaction, false);
    assert.deepEqual(businessSnapshot(f.db), before);
  });
}

test('snapshot counter may exceed the old counter by more than one', t => {
  const f = fixture(t, { kind: 'snapshot_recovery' });
  const principal = f.auth.authenticate(f.credential);
  f.db.prepare('UPDATE im_center_epochs SET recovery_counter=2 WHERE center_epoch=?').run(f.scope.centerEpoch);
  f.db.prepare('UPDATE im_center_state SET recovery_counter=2').run();
  assert.equal(assertImSchemaV4(f.db), true);
  assert.equal(f.auth.withRead(principal, f.scope, () => 'read'), 'read');
  assert.equal(f.auth.withWrite(principal, f.scope, () => 'write'), 'write');
  assert.equal(f.auth.me(f.credential).recoveryCounter, 2);
});

test('mutable caller scope cannot follow a complete legal A-to-B transition inside a write', t => {
  const f = fixture(t);
  const principal = f.auth.authenticate(f.credential);
  const original = f.scope.centerEpoch;
  const before = businessSnapshot(f.db);
  let next, callbacks = 0;
  assert.throws(() => f.auth.withWrite(principal, f.scope, () => {
    callbacks++;
    assert.equal(f.db.isTransaction, true);
    next = transitionEpoch(f.db);
    sentinel(f);
    assert.equal(assertImSchemaV4(f.db), true, 'business sentinel and new current progress are also legal');
    f.scope.centerEpoch = next;
    f.setTime(104);
  }), code('RECOVERY_RECONCILIATION_REQUIRED'));
  assert.equal(callbacks, 1);
  assert.notEqual(next, original);
  assert.equal(f.scope.centerEpoch, next, 'JS caller mutation survives SQL rollback');
  assert.equal(Object.isFrozen(f.scope), false);
  assert.equal(f.db.isTransaction, false);
  assert.deepEqual(businessSnapshot(f.db), before, 'epochs, run, center, progress and sentinel all roll back');
  assert.equal(assertImSchemaV4(f.db), true);
});

test('scope-only mutation does not replace the validated entry snapshot or freeze caller input', t => {
  const f = fixture(t);
  const principal = f.auth.authenticate(f.credential);
  const original = f.scope.centerEpoch, mutated = randomUUID();
  assert.equal(f.auth.withWrite(principal, f.scope, () => {
    f.scope.centerEpoch = mutated;
    f.scope.protocol = 'caller-only-change';
    sentinel(f);
    return 'original-scope-committed';
  }), 'original-scope-committed');
  assert.deepEqual(f.scope, { protocol: 'caller-only-change', centerEpoch: mutated });
  assert.equal(Object.isFrozen(f.scope), false);
  assert.equal(f.db.prepare('SELECT center_epoch FROM im_center_state').get().center_epoch, original);
  assert.equal(f.db.prepare('SELECT display_name FROM im_agents WHERE agent_id=?').get(f.a).display_name,
    'business-sentinel');
  assert.equal(f.db.isTransaction, false);
});

test('frozen valid scope is accepted and unknown scope fields reject on an otherwise valid baseline', t => {
  const f = fixture(t);
  const principal = f.auth.authenticate(f.credential);
  const frozen = Object.freeze({ ...f.scope });
  for (const method of ['withRead', 'withWrite']) {
    assert.equal(f.auth[method](principal, frozen, () => 'ok'), 'ok');
    let callbacks = 0;
    const before = businessSnapshot(f.db);
    assert.throws(() => f.auth[method](principal, { ...f.scope, extra: true }, () => { callbacks++; sentinel(f); }),
      code('INVALID_REQUEST'));
    assert.equal(callbacks, 0);
    assert.deepEqual(businessSnapshot(f.db), before);
  }
  assert.deepEqual(frozen, f.scope);
});

test('cross-DB ACL pairing rejects at construction, including inside two legitimate auth scopes', t => {
  let recording = false;
  const queries = [];
  const a = fixture(t);
  const b = fixture(t, { onStatement: event => { if (recording) queries.push(event); } });
  for (const [id, name] of [[a.a, 'Mirrored actor'], [a.b, 'Mirrored peer']])
    insert(b.db, 'im_agents', { agent_id: id, display_name: name, status: 'active', created_at: 0, revoked_at: null });
  insert(b.db, 'im_contacts', { agent_low: a.low, agent_high: a.high, allowed: 1, version: 1, updated_at: 0 });
  assert.equal(assertImSchemaV4(a.db), true);
  assert.equal(assertImSchemaV4(b.db), true);
  assert.notEqual(a.scope.centerEpoch, b.scope.centerEpoch);
  assert.notEqual(a.credentialId, b.credentialId);
  assert.equal(b.db.prepare('SELECT 1 FROM im_credentials WHERE credential_id=?').get(a.credentialId), undefined);
  const pa = a.auth.authenticate(a.credential), pb = b.auth.authenticate(b.credential);
  const rejected = () => {
    let constructed = 0;
    const start = queries.length;
    recording = true;
    try {
      assert.throws(() => {
        const wrong = createImV2Acl({ db: b.db, auth: a.auth, clock: b.clock });
        constructed++;
        wrong.requirePeer(pa, a.scope, a.b);
      }, code('INVALID_REQUEST'));
      assert.equal(constructed, 0, 'the mismatched facade must never be returned');
      assert.equal(queries.length, start, 'rejected construction performs no metadata queries');
    } finally { recording = false; }
  };
  const beforeA = businessSnapshot(a.db), beforeB = businessSnapshot(b.db);
  rejected();
  let nested = 0;
  a.auth.withRead(pa, a.scope, () => b.auth.withRead(pb, b.scope, () => {
    nested++;
    assert.equal(a.db.isTransaction, true);
    assert.equal(b.db.isTransaction, true);
    rejected();
  }));
  assert.equal(nested, 1, 'legitimate nested authB scope was actually entered');
  assert.deepEqual(businessSnapshot(a.db), beforeA);
  assert.deepEqual(businessSnapshot(b.db), beforeB);
  assert.equal(a.db.isTransaction, false);
  assert.equal(b.db.isTransaction, false);
});

test('ACL rejects forged or cloned auth facades and a different canonical DB guard', t => {
  const a = fixture(t), b = fixture(t);
  let callbacks = 0;
  const forged = { withRead(_principal, _scope, callback) { callbacks++; return callback(); }, assertActive() {} };
  for (const auth of [forged, { ...a.auth }, Object.freeze({ ...a.auth })]) {
    assert.throws(() => createImV2Acl({ db: a.db, auth, clock: a.clock }), code('INVALID_REQUEST'));
  }
  const guardB = createImV2ClockGuard({ db: b.db, clock: b.clock });
  assert.throws(() => createImV2Acl({ db: a.db, auth: a.auth, clock: a.clock, timeGuard: guardB }),
    code('INVALID_REQUEST'));
  assert.throws(() => createImV2Auth({ db: a.db, policy: a.policy, clock: a.clock, timeGuard: guardB }),
    code('INVALID_REQUEST'));
  assert.equal(callbacks, 0);
});

test('same-DB ACL nested in auth write reuses the current transaction and clock scope', t => {
  let recording = false;
  const events = [];
  const f = fixture(t, { onStatement: event => { if (recording) events.push(event); } });
  const principal = f.auth.authenticate(f.credential);
  const guard = createImV2ClockGuard({ db: f.db, clock: f.clock });
  assert.equal(f.auth.withWrite(principal, f.scope, () => {
    assert.equal(f.db.isTransaction, true);
    const now = guard.current();
    recording = true;
    try {
      assert.equal(f.acl.requirePeer(principal, f.scope, f.b).peerAgentId, f.b);
      assert.equal(f.acl.requireLiveMessage(principal, f.scope, f.messageId).messageId, f.messageId);
      assert.equal(f.acl.assertAttachmentAccess(principal, f.scope, f.attachmentId).attachmentId, f.attachmentId);
    } finally { recording = false; }
    assert.equal(guard.current(), now);
    assert.equal(f.db.isTransaction, true);
    sentinel(f);
    return 'nested-ok';
  }), 'nested-ok');
  assert.ok(events.length > 0, 'observer saw native metadata queries');
  assert.equal(events.some(({ sql }) => /\b(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b|UPDATE\s+im_clock/i.test(sql)), false,
    'nested ACL must not start a transaction, savepoint, or clock anchor');
  assert.equal(f.db.isTransaction, false);
  assert.equal(f.db.prepare('SELECT display_name FROM im_agents WHERE agent_id=?').get(f.a).display_name, 'business-sentinel');
});

test('authenticated third party sees 404 for real foreign message and attachment even if content is expired or corrupt', t => {
  const f = fixture(t);
  const owner = f.auth.authenticate(f.credential), outsider = thirdParty(f);
  assert.equal(outsider.agentId, f.stranger);
  assert.equal(assertImSchemaV4(f.db), true);
  const hidden = () => {
    for (const [method, id] of [['requireMessage', f.messageId], ['requireLiveMessage', f.messageId],
      ['assertAttachmentAccess', f.attachmentId]])
      assert.throws(() => f.acl[method](outsider, f.scope, id), code('RESOURCE_NOT_FOUND'));
  };
  hidden();
  assert.equal(f.acl.assertAttachmentAccess(owner, f.scope, f.attachmentId).attachmentId, f.attachmentId);
  expireContent(f);
  hidden();
  assert.throws(() => f.acl.requireLiveMessage(owner, f.scope, f.messageId), code('CONTENT_EXPIRED'));
  assert.throws(() => f.acl.assertAttachmentAccess(owner, f.scope, f.attachmentId), code('CONTENT_EXPIRED'));
  f.db.prepare('DELETE FROM im_content_state WHERE message_id=?').run(f.messageId);
  hidden();
  for (const [method, id] of [['requireMessage', f.messageId], ['requireLiveMessage', f.messageId],
    ['assertAttachmentAccess', f.attachmentId]])
    assert.throws(() => f.acl[method](owner, f.scope, id), code('STORAGE_UNAVAILABLE'));
});

test('foreign missing or corrupt live payload stays hidden while authorized access reports storage failure', t => {
  const f = fixture(t);
  const owner = f.auth.authenticate(f.credential), outsider = thirdParty(f);
  // Valid SQL, but intentionally inconsistent reservation/payload metadata after guard construction.
  f.db.prepare('UPDATE im_attachments SET sha256=? WHERE attachment_id=?').run('0'.repeat(64), f.attachmentId);
  assert.throws(() => f.acl.assertAttachmentAccess(outsider, f.scope, f.attachmentId), code('RESOURCE_NOT_FOUND'));
  assert.throws(() => f.acl.assertAttachmentAccess(owner, f.scope, f.attachmentId), code('STORAGE_UNAVAILABLE'));
  f.db.prepare('DELETE FROM im_attachments WHERE attachment_id=?').run(f.attachmentId);
  assert.throws(() => f.acl.assertAttachmentAccess(outsider, f.scope, f.attachmentId), code('RESOURCE_NOT_FOUND'));
  assert.throws(() => f.acl.assertAttachmentAccess(owner, f.scope, f.attachmentId), code('STORAGE_UNAVAILABLE'));
});

const invalidatePrincipal = [
  ['agent disabled', f => f.db.prepare("UPDATE im_agents SET status='disabled' WHERE agent_id=?").run(f.a)],
  ['agent revoked', f => f.db.prepare('UPDATE im_agents SET revoked_at=103 WHERE agent_id=?').run(f.a)],
  ['credential revoked', f => f.db.prepare('UPDATE im_credentials SET revoked_at=103 WHERE credential_id=?').run(f.credentialId)],
  ['credential secret rotated', f => f.db.prepare('UPDATE im_credentials SET secret_hash=? WHERE credential_id=?')
    .run(createHash('sha256').update(randomBytes(32)).digest('hex'), f.credentialId)],
];
for (const [label, invalidate] of invalidatePrincipal) {
  test(`${label} after issuance rejects at entry and final write check`, t => {
    const f = fixture(t);
    const principal = f.auth.authenticate(f.credential);
    const before = businessSnapshot(f.db);
    let callbacks = 0;
    assert.throws(() => f.auth.withWrite(principal, f.scope, () => {
      callbacks++;
      sentinel(f);
      invalidate(f);
    }), code('INVALID_CREDENTIAL'));
    assert.equal(callbacks, 1);
    assert.equal(f.db.isTransaction, false);
    assert.deepEqual(businessSnapshot(f.db), before);
    assert.equal(f.auth.withRead(principal, f.scope, () => 'still-valid-after-rollback'), 'still-valid-after-rollback');
    invalidate(f);
    const invalidated = businessSnapshot(f.db);
    callbacks = 0;
    for (const method of ['withRead', 'withWrite'])
      assert.throws(() => f.auth[method](principal, f.scope, () => { callbacks++; sentinel(f); }), code('INVALID_CREDENTIAL'));
    assert.throws(() => f.auth.authenticate(f.credential), code('INVALID_CREDENTIAL'));
    assert.equal(callbacks, 0);
    assert.deepEqual(businessSnapshot(f.db), invalidated);
  });
}

test('legal verified center is disabled and performs no business writes', t => {
  const f = fixture(t, { active: false });
  f.db.exec('BEGIN IMMEDIATE');
  try {
    f.db.prepare("UPDATE im_recovery_runs SET status='verified',verified_at=101 WHERE run_id='run-fixture'").run();
    f.db.prepare("UPDATE im_center_state SET status='verified',updated_at=101").run();
    assert.equal(assertImSchemaV4(f.db), true);
    f.db.exec('COMMIT');
  } finally { if (f.db.isTransaction) f.db.exec('ROLLBACK'); }
  const principal = f.auth.authenticate(f.credential);
  const before = businessSnapshot(f.db);
  let callbacks = 0;
  for (const method of ['withRead', 'withWrite'])
    assert.throws(() => f.auth[method](principal, f.scope, () => { callbacks++; sentinel(f); }), code('IM_DISABLED'));
  assert.throws(() => f.auth.me(f.credential), code('IM_DISABLED'));
  assert.equal(callbacks, 0);
  assert.deepEqual(businessSnapshot(f.db), before);
});

test('unauthenticated errors disclose neither current epoch nor resource existence', t => {
  const f = fixture(t);
  const principal = f.auth.authenticate(f.credential);
  const forged = { ...principal };
  const stale = { ...f.scope, centerEpoch: randomUUID() };
  let callbacks = 0;
  const hiddenError = action => assert.throws(action, error => {
    assert.equal(error.code, 'INVALID_CREDENTIAL');
    const visible = `${error.message} ${JSON.stringify(error)}`;
    for (const secret of [f.scope.centerEpoch, f.messageId, f.attachmentId]) assert.equal(visible.includes(secret), false);
    return true;
  });
  hiddenError(() => f.auth.withRead(forged, stale, () => { callbacks++; }));
  for (const scope of [f.scope, stale]) {
    for (const id of [f.messageId, randomUUID()]) hiddenError(() => f.acl.requireMessage(forged, scope, id));
    for (const id of [f.attachmentId, randomUUID()]) hiddenError(() => f.acl.assertAttachmentAccess(forged, scope, id));
  }
  assert.equal(callbacks, 0);
});

test('construction validates full schema once; auth and ACL hot paths use bounded metadata queries', t => {
  // Count only the distinctive full-manifest read during construction, not its entire statement trace.
  let validations = 0, recording = false;
  const events = [];
  const f = fixture(t, { onStatement: event => {
    if (/FROM\s+sqlite_master\b/i.test(event.sql)) validations++;
    if (recording) events.push(event);
  } });
  assert.equal(validations, 1, 'auth constructor fully validates; ACL reuses the canonical guard');
  createImV2Auth({ db: f.db, policy: f.policy, clock: f.clock });
  createImV2Acl({ db: f.db, auth: f.auth, clock: f.clock });
  assert.equal(validations, 1, 'repeated construction on the same connection reuses full validation');
  recording = true;
  try {
    const principal = f.auth.authenticate(f.credential);
    f.auth.me(f.credential);
    f.auth.withRead(principal, f.scope, () => 'read');
    f.auth.withWrite(principal, f.scope, () => 'write');
    f.acl.requirePeer(principal, f.scope, f.b);
    f.acl.requireConversation(principal, f.scope, f.conversationId);
    f.acl.requireMessage(principal, f.scope, f.messageId);
    f.acl.requireLiveMessage(principal, f.scope, f.messageId);
    f.acl.assertAttachmentAccess(principal, f.scope, f.attachmentId);
  } finally { recording = false; }
  assert.ok(events.length > 0);
  assert.equal(validations, 1);
  for (const { sql, method } of events) {
    assert.doesNotMatch(sql, /sqlite_(?:master|schema)|foreign_key_check|integrity_check|quick_check/i);
    assert.doesNotMatch(sql, /\b(?:data|text)\b|SELECT\s+\*/i, 'payload bytes/body never enter the auth/ACL hot path');
    if (/^\s*SELECT\b/i.test(sql)) {
      // The two-row schema marker is the sole bounded non-point read.
      const marker = /FROM\s+im_schema\s+LIMIT\s+2\s*$/i.test(sql);
      assert.ok(marker || /\bWHERE\b/i.test(sql), `unbounded metadata query: ${sql}`);
      assert.ok(marker || method === 'get', `point lookup must return at most one row: ${sql}`);
    }
  }
});
