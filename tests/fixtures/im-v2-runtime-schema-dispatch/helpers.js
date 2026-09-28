// Test-owned synthetic active centers; no operational activation/conversion seam.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { initializeImSchemaV4 } from '../../../src/im/v2/migration.js';
import { assertSupportedImV2Center } from '../../../src/im/v2/schema-dispatch.js';
import { createImV2ClockGuard } from '../../../src/im/v2/clock.js';
import { createImV2Auth } from '../../../src/im/v2/auth.js';
import { createImV2Acl } from '../../../src/im/v2/acl.js';
import { createImV2Messages } from '../../../src/im/v2/messages.js';
import { createImV2Delivery } from '../../../src/im/v2/delivery.js';
import { DEFAULT_MAINTENANCE, DEFAULT_POLICY } from '../../../src/im/v2/config.js';
import { PROTOCOL } from '../../../src/im/v2/contracts.js';
import { database, freshOptions, insert, recoveryRow, bindRun, putPolicy } from '../im-v2-schema/helpers.js';
import { fixture, anchor, head } from '../im-v2-schema-v5/helpers.js';

export const sha = value => createHash('sha256').update(value).digest('hex');
export function setup(t, { version = 5, mode = 'enabled', history = 'head', imported = false } = {}) {
  let legacy, db;
  if (version === 5) { legacy = fixture(t, { business: imported }); db = legacy.db; }
  else { db = database(t); initializeImSchemaV4(db, freshOptions()); }
  db.exec('PRAGMA synchronous=FULL');
  bindRun(db, recoveryRow(db, imported ? 'v3_import' : 'fresh_bootstrap', {
    status: 'active', verified_at: 101, activated_at: 102, activation_ref: 'runtime-test-activation',
    auth_review_ref: 'runtime-test-review', activation_plan_hash: sha('activation'),
    activation_approval_ref: 'runtime-test-approval' }));
  db.prepare('UPDATE im_settings SET write_mode=?').run(mode);
  const centerEpoch = db.prepare('SELECT center_epoch FROM im_center_state').get().center_epoch;
  const agents = [randomUUID(), randomUUID(), randomUUID()];
  const credentials = agents.map(agent => {
    insert(db, 'im_agents', { agent_id: agent, display_name: 'runtime fixture', status: 'active', created_at: 0 });
    const stream = randomUUID();
    insert(db, 'im_receive_state', { agent_id: agent, next_seq: 1, acked_through: 0, retained_floor: 1, stream_epoch: stream });
    insert(db, 'im_sync_progress', { recipient_id: agent, center_epoch: centerEpoch, stream_epoch: stream, handled_through: 0, updated_at: 0 });
    const id = randomUUID(), secret = randomBytes(32).toString('base64url');
    insert(db, 'im_credentials', { credential_id: id, agent_id: agent, secret_hash: sha(secret), created_at: 0 });
    return `${id}.${secret}`;
  });
  const [a, b, outsider] = agents, [low, high] = [a, b].sort(), conversationId = randomUUID();
  insert(db, 'im_contacts', { agent_low: low, agent_high: high, allowed: 1, version: 1, updated_at: 0 });
  insert(db, 'im_conversations', { conversation_id: conversationId, agent_low: low, agent_high: high, created_at: 0 });
  if (version === 5 && history !== 'empty') {
    anchor(db); const tip = anchor(db);
    if (history === 'head') head(db, tip);
  }
  const currentPolicy = { ...DEFAULT_POLICY, effectiveAt: 1 };
  const policyHash = putPolicy(db, currentPolicy);
  const policy = { enabled: true, writeMode: 'enabled', transport: { mode: 'local-test', serverUrl: 'http://localhost/' },
    retention: { policy: currentPolicy, policyHash },
    lease: { ttlMs: 1000, renewalMs: 500 },
    limits: { maxAttachmentBytes: 10485760, maxBodyBytes: 65536, maxFileBodyBytes: 16777216, maxConnections: 10, maxRequestsPerMinute: 100 },
    maintenance: { ...DEFAULT_MAINTENANCE, maxKeyReservations: 1000 } };
  assert.equal(assertSupportedImV2Center(db).schemaVersion, version);
  const f = { db, native: db, version, policy, a, b, outsider, conversationId, centerEpoch,
    scope: { protocol: PROTOCOL, centerEpoch }, credentials, now: 2000, legacy };
  f.clock = () => f.now;
  return f;
}
export function compose(f) {
  f.timeGuard = createImV2ClockGuard(f);
  f.auth = createImV2Auth(f);
  f.acl = createImV2Acl(f);
  f.messages = createImV2Messages(f);
  f.delivery = createImV2Delivery(f);
  f.principals = f.credentials.map(value => f.auth.authenticate(value));
  return f;
}
export function request(f, patch = {}) {
  return { originEpoch: f.centerEpoch, clientMessageId: randomUUID(), conversationId: f.conversationId,
    recipientAgentId: f.b, text: 'runtime dispatch message', ...patch };
}
export function transitionEpoch(db, { removeHead = true } = {}) {
  const old = db.prepare('SELECT * FROM im_center_state').get(), next = randomUUID();
  insert(db, 'im_center_epochs', { center_epoch: next, created_at: 2000, origin: 'recovery', recovery_counter: old.recovery_counter + 1 });
  const run = recoveryRow(db, 'snapshot_recovery', { run_id: randomUUID(), preparation_ref: null,
    old_epoch: old.center_epoch, new_epoch: next, backup_id: randomUUID(), backup_file_hash: sha('backup'),
    manifest_hash: sha('manifest'), candidate_base_hash: sha('backup'), created_at: 2000,
    status: 'active', verified_at: 2001, activated_at: 2002, activation_ref: 'runtime-next-activation',
    auth_review_ref: 'runtime-next-review', activation_plan_hash: sha('next-activation'), activation_approval_ref: 'runtime-next-approval' });
  db.prepare('UPDATE im_center_state SET center_epoch=?,recovery_counter=?,updated_at=2002').run(next, old.recovery_counter + 1);
  bindRun(db, run);
  db.prepare(`INSERT INTO im_sync_progress(recipient_id,center_epoch,stream_epoch,handled_through,updated_at)
    SELECT recipient_id,?,stream_epoch,handled_through,updated_at FROM im_sync_progress WHERE center_epoch=?`).run(next, old.center_epoch);
  if (removeHead) db.exec('DELETE FROM im_maintenance_time_head');
  return next;
}
