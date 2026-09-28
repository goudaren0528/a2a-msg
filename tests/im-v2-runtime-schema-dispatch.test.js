import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImV2ClockGuard, resolveImV2TimeGuard } from '../src/im/v2/clock.js';
import { createImV2Auth } from '../src/im/v2/auth.js';
import { createImV2Center } from '../src/im/v2/server.js';
import { assertSupportedImV2Center } from '../src/im/v2/schema-dispatch.js';
import * as historical from '../src/im/v2/schema.js';
import { PROTOCOL, dataSchemas, fingerprintMessage, storageOperationKey } from '../src/im/v2/contracts.js';
import { checkMaintenanceTimeSession } from '../src/im/v2/maintenance-time-internal.js';
import { snapshot, observe, sha } from './fixtures/im-v2-schema/helpers.js';
import { anchor, head, GOLDEN, V4 } from './fixtures/im-v2-schema-v5/helpers.js';
import { setup, compose, request, transitionEpoch } from './fixtures/im-v2-runtime-schema-dispatch/helpers.js';

const error = code => ({ code });
const floor = db => db.prepare('SELECT last_observed_at FROM im_clock').get().last_observed_at;
const withoutClock = db => { const image = snapshot(db); delete image.rows.im_clock; return image; };
function rejectedBeforeWork(f) {
  const before = floor(f.native), observed = [];
  for (const method of ['runRead', 'runWriteFresh'])
    assert.throws(() => f.timeGuard[method](() => observed.push('callback')), e => {
      assert.equal(e.code, 'STORAGE_UNAVAILABLE'); assert.equal(e.message, 'Storage unavailable');
      assert.equal(e.cause, undefined); return true;
    });
  assert.deepEqual(observed, []);
  assert.equal(floor(f.native), before);
}

for (const version of [4, 5]) test(`exact schema ${version}: real auth/ACL/message/delivery, unchanged wire and storage identity`, t => {
  const f = compose(setup(t, { version }));
  assert.equal(PROTOCOL, 'a2a-msg.im.v2');
  assert.equal(resolveImV2TimeGuard(f.db, f.clock, f.timeGuard), f.timeGuard);
  assert.throws(() => createImV2Auth({ ...f, timeGuard: { ...f.timeGuard } }), error('INVALID_REQUEST'));
  const input = request(f), sent = f.messages.send(f.principals[0], f.scope, input);
  const key = storageOperationKey(f.centerEpoch, input.clientMessageId);
  assert.equal(key, `v2:${f.centerEpoch}:${input.clientMessageId}`);
  const expectedHash = sha(JSON.stringify([PROTOCOL, f.centerEpoch, f.conversationId, f.b, input.clientMessageId,
    null, input.text, null, null, null]));
  assert.equal(fingerprintMessage({ ...input, protocol: PROTOCOL, centerEpoch: f.centerEpoch,
    title: null, attachment: null, inReplyTo: null, correlation: null }), expectedHash);
  const accepted = f.messages.getSendResult(f.principals[0], f.scope, { originEpoch: input.originEpoch, clientMessageId: input.clientMessageId });
  assert.equal(accepted.sourceProtocol, PROTOCOL); assert.equal(accepted.payloadHash, expectedHash);
  assert.equal(f.db.prepare('SELECT client_message_id FROM im_messages WHERE message_id=?').get(sent.message.messageId).client_message_id, key);
  assert.equal(f.db.prepare('SELECT payload_hash FROM im_send_keys WHERE message_id=?').get(sent.message.messageId).payload_hash, expectedHash);
  assert.equal(f.messages.send(f.principals[0], f.scope, input).replayed, true);
  assert.throws(() => f.messages.getMessage(f.principals[2], f.scope, { messageId: sent.message.messageId }), error('RESOURCE_NOT_FOUND'));
  const lease = f.delivery.acquire(f.principals[1], f.scope, { instanceId: randomUUID(), requestId: randomUUID() });
  const fence = { instanceId: lease.instanceId, generation: lease.generation, streamEpoch: lease.streamEpoch };
  assert.deepEqual(dataSchemas.lease.parse(lease), lease);
  const sync = f.delivery.sync(f.principals[1], f.scope, { ...fence, after: 0, limit: 10 });
  assert.deepEqual(dataSchemas.sync.parse(sync), sync);
  assert.deepEqual(sync.items[0].message, sent.message);
  assert.throws(() => f.delivery.sync(f.principals[1], f.scope, { ...fence, generation: lease.generation + 1, after: 0, limit: 10 }), error('STALE_FENCE'));
  f.now++;
  const ack = f.delivery.ack(f.principals[1], f.scope, { ...fence, items: [{ seq: 1, messageId: sent.message.messageId }] });
  assert.equal(ack.ackedThrough, 1);
  assert.equal(f.messages.markRead(f.principals[1], f.scope, { messageId: sent.message.messageId }).changed, true);
  f.db.exec('UPDATE im_contacts SET allowed=0');
  assert.throws(() => f.messages.getMessage(f.principals[0], f.scope, { messageId: sent.message.messageId }), error('RESOURCE_NOT_FOUND'));
  f.db.prepare('UPDATE im_credentials SET revoked_at=? WHERE credential_id=?').run(f.now, f.principals[0].credentialId);
  assert.throws(() => f.auth.authenticate(f.credentials[0]), error('INVALID_CREDENTIAL'));
  assert.throws(() => f.auth.withRead(f.principals[0], f.scope, () => assert.fail()), error('INVALID_CREDENTIAL'));
  assert.equal(assertSupportedImV2Center(f.db).schemaVersion, version);
});

test('v5 retains imported v1 acceptance sourceProtocol, fingerprint and unnamespaced key', t => {
  const f = setup(t, { imported: true });
  const secret = Buffer.alloc(32, 7).toString('base64url');
  f.db.prepare('UPDATE im_credentials SET secret_hash=? WHERE credential_id=?').run(sha(secret), f.legacy.credential);
  compose(f);
  const principal = f.auth.authenticate(`${f.legacy.credential}.${secret}`);
  const operation = f.db.prepare("SELECT * FROM im_send_operation_keys WHERE source_protocol='a2a-msg.im.v1'").get();
  const before = f.db.prepare('SELECT * FROM im_send_keys WHERE message_id=?').get(operation.message_id);
  const result = f.messages.getSendResult(principal, f.scope, { originEpoch: operation.origin_epoch, clientMessageId: operation.client_message_id });
  assert.equal(result.sourceProtocol, 'a2a-msg.im.v1'); assert.equal(result.payloadHash, before.payload_hash);
  assert.equal(operation.storage_client_message_id, operation.client_message_id);
  assert.deepEqual(f.db.prepare('SELECT * FROM im_send_keys WHERE message_id=?').get(operation.message_id), before);
});

test('real v5 server composition constructs canonical business modules without a listener', t => {
  const f = setup(t), center = createImV2Center({ db: f.db, policy: f.policy, clock: f.clock });
  t.after(() => center.close());
  const principal = center.modules.auth.authenticate(f.credentials[0]);
  const sent = center.modules.messages.send(principal, f.scope, request(f));
  assert.equal(sent.message.text, 'runtime dispatch message');
  assert.equal(center.modules.auth.me(f.credentials[0]).centerEpoch, f.centerEpoch);
  assert.equal(assertSupportedImV2Center(f.db).schemaVersion, 5);
});

for (const history of ['empty', 'head', 'retained']) test(`v5 active/paused ${history}: clock-only updates preserve all inherited/time metadata`, t => {
  const f = setup(t, { mode: 'paused', history });
  const before = withoutClock(f.db);
  compose(f);
  const sessions = Object.keys(f.timeGuard).sort();
  assert.deepEqual(sessions, ['current', 'refreshCurrent', 'runRead', 'runWriteFresh']);
  f.now = 1000000000; // Business floor may advance beyond the approved anchor window.
  assert.equal(f.timeGuard.runRead(() => f.timeGuard.current()), f.now);
  assert.equal(f.timeGuard.runWriteFresh(() => f.timeGuard.refreshCurrent()), f.now);
  assert.throws(() => f.messages.send(f.principals[0], f.scope, request(f)), error('NEW_WRITES_DISABLED'));
  assert.throws(() => f.delivery.acquire(f.principals[1], f.scope, { instanceId: randomUUID(), requestId: randomUUID() }), error('NEW_WRITES_DISABLED'));
  assert.throws(() => checkMaintenanceTimeSession(f.timeGuard, {}, {}));
  assert.deepEqual(withoutClock(f.db), before);
  assert.equal(floor(f.db), f.now);
  assert.equal(assertSupportedImV2Center(f.db).schemaVersion, 5);
});

test('historical exports remain v4-only, exact checksums remain distinct', t => {
  assert.deepEqual(Object.keys(historical).sort(), ['IM_V2_SCHEMA_VERSION', 'SUPPORTED_IM_V2_SCHEMA_VERSIONS', 'assertImSchemaV4']);
  assert.equal(historical.IM_V2_SCHEMA_VERSION, 4); assert.deepEqual(historical.SUPPORTED_IM_V2_SCHEMA_VERSIONS, [4]);
  for (const version of [4, 5]) {
    const f = setup(t, { version });
    assert.deepEqual(assertSupportedImV2Center(f.db), { schemaVersion: version, schemaChecksum: version === 4 ? V4 : GOLDEN.checksum });
    if (version === 4) assert.equal(historical.assertImSchemaV4(f.db), true);
    else assert.throws(() => historical.assertImSchemaV4(f.db), error('IM_SCHEMA_MISMATCH'));
  }
});

for (const mutation of ['marker-only', 'mixed-schema', 'checksum', 'anchor-history', 'head-not-tip'])
  test(`admission performs full validation and sanitizes ${mutation}`, t => {
    const f = setup(t, { version: mutation === 'marker-only' ? 4 : 5 });
    if (mutation === 'marker-only') f.db.exec(`DROP TABLE im_schema; CREATE TABLE im_schema(version INTEGER PRIMARY KEY CHECK(version=5),migration_checksum TEXT); INSERT INTO im_schema VALUES(5,'${GOLDEN.checksum}')`);
    if (mutation === 'mixed-schema') f.db.exec('DROP TABLE im_maintenance_time_head');
    if (mutation === 'checksum') f.db.prepare('UPDATE im_schema SET migration_checksum=?').run(V4);
    if (mutation === 'anchor-history') f.db.exec("UPDATE im_maintenance_time_anchors SET approval_ref='tampered' WHERE generation=1");
    if (mutation === 'head-not-tip') { f.db.exec('DELETE FROM im_maintenance_time_head'); head(f.db, f.db.prepare('SELECT * FROM im_maintenance_time_anchors WHERE generation=1').get()); }
    const before = floor(f.db);
    assert.throws(() => createImV2ClockGuard(f), e => e.code === 'STORAGE_UNAVAILABLE' && e.message === 'Storage unavailable' && e.cause === undefined);
    assert.equal(floor(f.db), before); assert.equal(f.db.isTransaction, false);
  });

for (const version of [4, 5]) for (const mutation of ['version', 'checksum', 'cookie'])
  test(`pinned schema ${version} rejects hot ${mutation} before callback/sample/write`, t => {
    const f = setup(t, { version }); let samples = 0;
    f.clock = () => { samples++; return f.now; };
    f.timeGuard = createImV2ClockGuard(f);
    if (mutation === 'version') f.db.exec(`PRAGMA ignore_check_constraints=ON; UPDATE im_schema SET version=${version === 4 ? 5 : 4}; PRAGMA ignore_check_constraints=OFF`);
    if (mutation === 'checksum') f.db.prepare('UPDATE im_schema SET migration_checksum=?').run('0'.repeat(64));
    if (mutation === 'cookie') f.db.exec('CREATE TABLE non_im_cookie_probe(value)');
    assert.equal(createImV2ClockGuard(f), f.timeGuard, 'factory must not rebind cached guard');
    rejectedBeforeWork(f); assert.equal(samples, 0);
  });

test('legal schema after cookie drift requires a fresh connection, never automatic adoption', t => {
  const f = setup(t), dir = mkdtempSync(join(tmpdir(), 'r1-reopen-')), path = join(dir, 'center.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  f.db.prepare('VACUUM INTO ?').run(path);
  const db = new DatabaseSync(path); db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
  const clock = () => 3000, guard = createImV2ClockGuard({ db, clock });
  db.exec('CREATE TABLE non_im_cookie_probe(value)');
  assert.equal(assertSupportedImV2Center(db).schemaVersion, 5);
  rejectedBeforeWork({ native: db, timeGuard: guard });
  assert.equal(createImV2ClockGuard({ db, clock }), guard); db.close();
  const fresh = new DatabaseSync(path);
  try { fresh.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL'); assert.equal(createImV2ClockGuard({ db: fresh, clock }).runRead(() => 1), 1); }
  finally { fresh.close(); }
});

test('v5 admission pins validated snapshot despite a concurrent WAL marker/DDL writer', t => {
  for (const mutation of ['marker', 'cookie']) {
    const f = setup(t), dir = mkdtempSync(join(tmpdir(), 'r1-wal-')), path = join(dir, 'center.sqlite');
    f.db.prepare('VACUUM INTO ?').run(path);
    const db = new DatabaseSync(path), writer = new DatabaseSync(path);
    try {
      db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
      writer.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
      let injected = false, validations = 0;
      const tracked = observe(db, event => {
        if (event.method === 'get' && event.sql.includes('pragma_foreign_key_check')) {
          validations++;
          if (!injected) {
            injected = true;
            if (mutation === 'marker') writer.prepare('UPDATE im_schema SET migration_checksum=?').run('0'.repeat(64));
            else writer.exec('CREATE TABLE concurrent_cookie_probe(value)');
          }
        }
      });
      const guard = createImV2ClockGuard({ db: tracked, clock: () => 3000 });
      assert.equal(injected, true); assert.equal(validations, 1);
      rejectedBeforeWork({ native: db, timeGuard: guard });
      assert.equal(validations, 1, 'hot refusal does not rerun admission');
      assert.equal(db.isTransaction, false);
    } finally { writer.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
  }
});

test('v5 hot check compares actual current epoch and chain tip; retained history without head remains lawful', t => {
  for (const mutation of ['old-tip', 'appended-tip', 'stale-epoch']) {
    const f = setup(t); f.timeGuard = createImV2ClockGuard(f);
    if (mutation === 'old-tip') { f.db.exec('DELETE FROM im_maintenance_time_head'); head(f.db, f.db.prepare('SELECT * FROM im_maintenance_time_anchors WHERE generation=1').get()); }
    if (mutation === 'appended-tip') anchor(f.db);
    if (mutation === 'stale-epoch') transitionEpoch(f.db, { removeHead: false });
    rejectedBeforeWork(f);
  }
});

test('owned epoch transaction deletes head atomically and final refresh accepts lawful new epoch', t => {
  const f = setup(t); f.timeGuard = createImV2ClockGuard(f);
  const anchors = snapshot(f.db).rows.im_maintenance_time_anchors;
  f.now = 3000;
  const next = f.timeGuard.runWriteFresh(() => {
    const epoch = transitionEpoch(f.db);
    assert.equal(assertSupportedImV2Center(f.db).schemaVersion, 5, 'full new run/state/progress lineage is lawful');
    assert.equal(f.timeGuard.refreshCurrent(), f.now); return epoch;
  });
  assert.notEqual(next, f.centerEpoch); assert.equal(assertSupportedImV2Center(f.db).schemaVersion, 5);
  assert.deepEqual(snapshot(f.db).rows.im_maintenance_time_anchors, anchors);
  assert.equal(f.timeGuard.runRead(() => f.timeGuard.current()), f.now);
});

test('stale head in owned new-epoch transaction fails final refresh, latches and rolls back business only', t => {
  const f = setup(t); f.timeGuard = createImV2ClockGuard(f);
  const before = withoutClock(f.db); f.now = 3000;
  assert.throws(() => f.timeGuard.runWriteFresh(() => {
    transitionEpoch(f.db, { removeHead: false });
    assert.throws(() => f.timeGuard.refreshCurrent(), error('STORAGE_UNAVAILABLE'));
    assert.throws(() => f.timeGuard.current(), error('STORAGE_UNAVAILABLE'));
  }), error('STORAGE_UNAVAILABLE'));
  assert.deepEqual(withoutClock(f.db), before); assert.equal(floor(f.db), 3000);
  assert.equal(assertSupportedImV2Center(f.db).schemaVersion, 5);
});

test('v5 hot query work stays constant with 2/512 anchors; EXPLAIN uses rowid tip seek, no history validation', t => {
  const counts = [];
  for (const size of [2, 512]) {
    const f = setup(t, { history: 'retained' });
    for (let i = 2; i < size; i++) anchor(f.db);
    head(f.db, f.db.prepare('SELECT * FROM im_maintenance_time_anchors ORDER BY generation DESC LIMIT 1').get());
    const events = [];
    f.db = observe(f.native, event => events.push(event));
    const guard = createImV2ClockGuard(f); events.length = 0;
    guard.runRead(() => guard.current()); guard.runWriteFresh(() => guard.refreshCurrent());
    assert.ok(!events.some(e => /sqlite_master|foreign_key_check|im_messages|im_retention_policies|table_info/.test(e.sql)));
    const hot = events.filter(e => e.sql.includes('im_maintenance_time_anchors'));
    assert.ok(hot.length > 0); assert.ok(hot.every(e => e.method === 'get' && e.result.tip_generation === size));
    assert.ok(events.filter(e => e.method === 'all').every(e => e.sql === 'SELECT version,migration_checksum FROM im_schema LIMIT 2' && e.result.length === 1));
    const sql = hot[0].sql, plan = f.native.prepare(`EXPLAIN QUERY PLAN ${sql}`).all();
    const bytecode = f.native.prepare(`EXPLAIN ${sql}`).all();
    assert.ok(plan.some(r => /SEARCH t USING INTEGER PRIMARY KEY/.test(r.detail)));
    assert.ok(!plan.some(r => /TEMP B-TREE/.test(r.detail)));
    assert.ok(bytecode.some(r => r.opcode === 'Last'), 'reverse integer primary-key seek');
    assert.ok(bytecode.some(r => r.opcode === 'DecrJumpZero'), 'LIMIT stops after first tip row');
    counts.push({ size, statements: events.length, hotGets: hot.length, returnedRows: hot.length });
    t.diagnostic(JSON.stringify({ size, plan, bytecode: bytecode.map(r => [r.opcode, r.p1, r.p2, r.p3]) }));
  }
  assert.deepEqual({ ...counts[0], size: 512 }, counts[1]); t.diagnostic(JSON.stringify(counts));
});
