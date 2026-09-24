// TEST ONLY: isolated SQL activation/expiry proofs, never a P5/P6 executor.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeImSchemaV4 } from '../../../src/im/v2/migration.js';
import { assertImSchemaV4 } from '../../../src/im/v2/schema.js';
import { createImV2ClockGuard } from '../../../src/im/v2/clock.js';
import { createImV2Auth } from '../../../src/im/v2/auth.js';
import { createImV2Acl } from '../../../src/im/v2/acl.js';
import { createImV2Messages } from '../../../src/im/v2/messages.js';
import { DEFAULT_POLICY, DEFAULT_MAINTENANCE } from '../../../src/im/v2/config.js';
import { PROTOCOL } from '../../../src/im/v2/contracts.js';
import { freshOptions, insert, recoveryRow, bindRun, putPolicy } from '../im-v2-schema/helpers.js';

export const sha = value => createHash('sha256').update(value).digest('hex');

// One proxy identity per connection is passed to EVERY real core constructor.
// Observations happen after native execution; SQL, parameters and results are
// untouched. Tracing is opt-in, so 1,002 sends do not retain credentials/BLOBs.
function observe(native, after) {
  return new Proxy(native, { get(target, key) {
    if (key === 'exec') return sql => {
      const result = target.exec(sql);
      after({ sql, method: 'exec', args: [], result });
      return result;
    };
    if (key === 'prepare') return sql => {
      const statement = target.prepare(sql);
      return new Proxy(statement, { get(s, method) {
        if (method === 'iterate') return function* (...args) {
          for (const row of s.iterate(...args)) {
            after({ sql, method, args, result: row });
            yield row;
          }
          after({ sql, method: 'iterate:end', args });
        };
        if (['get', 'all', 'run'].includes(method)) return (...args) => {
          const result = s[method](...args);
          after({ sql, method, args, result });
          return result;
        };
        const value = Reflect.get(s, method, s);
        return typeof value === 'function' ? value.bind(s) : value;
      } });
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

export function assertCandidate(native) {
  // The full P1 validator and row snapshot see the same native read transaction.
  native.exec('BEGIN');
  try {
    const before = businessDigest(native, { full: true });
    assert.equal(assertImSchemaV4(native), true);
    assert.deepEqual(businessDigest(native, { full: true }), before, 'P1 validation is read-only');
    native.exec('COMMIT');
  } finally {
    if (native.isTransaction) native.exec('ROLLBACK');
  }
}

export function createCompositionFixture(t) {
  const preferredTemp = join(tmpdir(), 'opencode');
  const directory = mkdtempSync(join(existsSync(preferredTemp) ? preferredTemp : tmpdir(), 'im-v2-composition-'));
  const f = { directory, filename: join(directory, 'candidate.sqlite'), now: 103, trace: null };
  f.clock = () => f.now;
  f.close = () => {
    if (f.native) f.native.close();
    // No secondary connections, guard workers or timers exist. Drop ALL owners
    // of prepared statements before constructing a guard on the new connection.
    for (const key of ['native', 'db', 'timeGuard', 'auth', 'acl', 'messages', 'delivery', 'principals'])
      delete f[key];
  };
  t.after(() => {
    f.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const connect = () => {
    f.native = new DatabaseSync(f.filename);
    f.native.exec('PRAGMA foreign_keys=ON');
    f.native.exec('PRAGMA synchronous=FULL');
  };
  connect();
  initializeImSchemaV4(f.native, freshOptions());
  const retention = { ...DEFAULT_POLICY, effectiveAt: 1 };
  f.hash = putPolicy(f.native, retention);
  const active = recoveryRow(f.native, 'fresh_bootstrap', { status: 'active', verified_at: 101,
    activated_at: 102, activation_ref: 'test-activation', auth_review_ref: 'test-auth-review',
    activation_plan_hash: 'a'.repeat(64), activation_approval_ref: 'test-activation-approval' });
  bindRun(f.native, active);
  f.native.prepare("UPDATE im_settings SET write_mode='enabled'").run();
  f.centerEpoch = active.new_epoch;
  f.scope = { protocol: PROTOCOL, centerEpoch: f.centerEpoch };
  [f.a, f.b] = [randomUUID(), randomUUID()];
  f.credentials = [f.a, f.b].map((agent, index) => {
    insert(f.native, 'im_agents', { agent_id: agent, display_name: `Composition ${index}`,
      status: 'active', created_at: 0, revoked_at: null });
    const stream = randomUUID();
    insert(f.native, 'im_receive_state', { agent_id: agent, next_seq: 1, acked_through: 0,
      retained_floor: 1, stream_epoch: stream });
    insert(f.native, 'im_sync_progress', { recipient_id: agent, center_epoch: f.centerEpoch,
      stream_epoch: stream, handled_through: 0, updated_at: 0 });
    const id = randomUUID(), secret = randomBytes(32).toString('base64url');
    insert(f.native, 'im_credentials', { credential_id: id, agent_id: agent, secret_hash: sha(secret),
      created_at: 0, expires_at: null, revoked_at: null });
    return `${id}.${secret}`;
  });
  const [low, high] = [f.a, f.b].sort();
  insert(f.native, 'im_contacts', { agent_low: low, agent_high: high, allowed: 1, version: 1, updated_at: 0 });
  f.conversationId = randomUUID();
  insert(f.native, 'im_conversations', { conversation_id: f.conversationId, agent_low: low,
    agent_high: high, created_at: 0 });
  f.policy = { enabled: true, writeMode: 'enabled',
    transport: { mode: 'local-test', serverUrl: 'http://localhost/' },
    retention: { policy: retention, policyHash: f.hash }, lease: { ttlMs: 1000, renewalMs: 500 },
    limits: { maxAttachmentBytes: 10485760, maxBodyBytes: 65536, maxFileBodyBytes: 16777216,
      maxConnections: 10, maxRequestsPerMinute: 100 },
    maintenance: { ...DEFAULT_MAINTENANCE, maxKeyReservations: 2000 } };
  const bind = () => {
    assertCandidate(f.native);
    f.db = observe(f.native, event => { if (f.trace) f.trace.push(event); });
    f.timeGuard = createImV2ClockGuard({ db: f.db, clock: f.clock });
    f.auth = createImV2Auth(f);
    f.acl = createImV2Acl(f);
    f.messages = createImV2Messages(f);
    f.principals = f.credentials.map(credential => f.auth.authenticate(credential));
    assert.equal(createImV2ClockGuard({ db: f.db, clock: f.clock }), f.timeGuard);
  };
  f.reopen = () => { f.close(); connect(); bind(); };
  bind();
  return f;
}

// Digest every application table, including audits, payload bytes, credentials,
// proofs, keys and leases. Only clock observations and expected cursor/update
// fields are omitted; assertions never print synthetic credential material.
export function businessDigest(native, { full = false } = {}) {
  const tables = native.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'im_%' ORDER BY name").all();
  return Object.fromEntries(tables.filter(({ name }) => full || name !== 'im_clock').map(({ name }) => {
    const rows = native.prepare(`SELECT * FROM ${name}`).all().map(row => {
      if (!full && name === 'im_receive_state') delete row.acked_through;
      if (!full && name === 'im_sync_progress') { delete row.handled_through; delete row.updated_at; }
      return JSON.stringify(row, (_, value) => value instanceof Uint8Array ? [...value] : value);
    }).sort();
    return [name, sha(JSON.stringify(rows))];
  }));
}

export function cursors(f) {
  return f.native.prepare(`SELECT r.acked_through AS ackedThrough,p.handled_through AS handledThrough
    FROM im_receive_state r JOIN im_sync_progress p ON p.recipient_id=r.agent_id
      AND p.stream_epoch=r.stream_epoch AND p.center_epoch=? WHERE r.agent_id=?`).get(f.centerEpoch, f.b);
}

// Deliberately early TEST-ONLY expiry, with completed maintenance proof. This
// exercises P3 persisted-state composition without implementing/running P6 or
// jumping the shared clock past every live message and receive lease.
export function expireForComposition(f, message) {
  const id = `test-only-expire-${randomUUID()}`, expiredAt = message.expiresAt;
  insert(f.native, 'im_maintenance_runs', { run_id: id, center_epoch: f.centerEpoch, kind: 'expire',
    execution_policy_hash: f.hash, plan_hash: sha(id), approved_batch_hash: sha(`${id}:batch`),
    approval_ref: `test-only-${id}`, executor_id: 'composition-test-only', status: 'completed',
    candidate_json: JSON.stringify([{ messageId: message.messageId }]),
    result_json: JSON.stringify({ messageId: message.messageId, kind: 'expire' }),
    previewed_at: expiredAt, expires_at: expiredAt + 10, completed_at: expiredAt,
    scan_rows: 1, scan_bytes: 1, changed_rows: 1, changed_bytes: 1 });
  f.native.prepare("UPDATE im_content_state SET state='expired',expired_at=?,expiry_run_id=? WHERE message_id=?")
    .run(expiredAt, id, message.messageId);
  assertCandidate(f.native);
}

export function capture(f, operation) {
  assert.equal(f.trace, null, 'observations must not nest');
  const events = [];
  f.trace = events;
  try { return { value: operation(), events }; }
  finally { f.trace = null; }
}

export function assertOneWrite(events) {
  const sql = events.filter(event => event.method === 'exec').map(event => event.sql.trim().toUpperCase());
  assert.equal(sql.filter(value => value === 'BEGIN IMMEDIATE').length, 2,
    'one durable clock anchor plus one business transaction, no nested module write');
  assert.equal(sql.filter(value => value === 'COMMIT').length, 2);
  assert.equal(sql.filter(value => value === 'SAVEPOINT IM_V2_CLOCK_BUSINESS').length, 1);
  assert.equal(sql.filter(value => value === 'BEGIN').length, 0, 'ACL reads reuse the canonical guard');
}

export function assertPrefixBudget(events, before, after) {
  // Recognize actual native fact SQL by its participating tables, not a private
  // JS function name. ACK-batch validation is separate from prefix work.
  const facts = events.filter(event => /\bim_deliveries\b/i.test(event.sql) &&
    /\bim_expiry_receipts\b/i.test(event.sql) && /^\s*SELECT\b/i.test(event.sql));
  const sequences = facts.map(event => {
    assert.equal(event.method, 'get', 'prefix proof is a point read, never a history .all/iterate scan');
    const point = /\b(?:\w+\.)?seq\s*=\s*\?/i.exec(event.sql);
    assert.ok(point, 'prefix proof must bind one exact sequence');
    const index = (event.sql.slice(0, point.index).match(/\?/g) || []).length;
    const seq = event.args[index];
    assert.ok(Number.isSafeInteger(seq) && seq > 0);
    return seq;
  });
  const distinct = new Set(sequences);
  const advanced = new Set();
  for (const field of ['ackedThrough', 'handledThrough']) {
    assert.ok(after[field] >= before[field]);
    for (let seq = before[field] + 1; seq <= after[field]; seq++) advanced.add(seq);
  }
  assert.ok(advanced.size <= 1000, `shared cursor advancement budget: ${advanced.size}`);
  if (advanced.size > 0) assert.ok(facts.length > 0, 'oracle observed real prefix fact reads');
  for (const seq of advanced) assert.ok(distinct.has(seq), `advanced seq ${seq} has an observed fact`);
  // At most two next-point probes may be outside the 1,000-fact shared cache.
  const nextPoints = new Set([after.ackedThrough + 1, after.handledThrough + 1]);
  const core = new Set([...distinct].filter(seq => !nextPoints.has(seq)));
  assert.ok(core.size <= 1000, `distinct proof facts: ${core.size}`);
  assert.ok(distinct.size <= 1002, `proof facts plus next-point probes: ${distinct.size}`);
  assert.ok(sequences.length <= distinct.size + 2, 'both cursors share fact cache; at most two repeat probes');
  assert.ok(sequences.length <= 1002, `total native prefix point reads: ${sequences.length}`);
  for (const event of events.filter(event => /^\s*SELECT\b/i.test(event.sql) &&
      /\bim_(?:deliveries|expiry_receipts|messages|send_keys)\b/i.test(event.sql))) {
    assert.notEqual(event.method, 'all', 'ACK/receipt must not materialize history');
    assert.ok(!event.method.startsWith('iterate'), 'ACK/receipt must not iterate history');
  }
}
