import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { migrateImSchemaV3, initInstanceIdentity, getInstanceIdentity } from '../../../src/im/schema.js';
import { createImAdmin } from '../../../src/im/admin.js';
import { createImAuth } from '../../../src/im/auth.js';
import { createImAcl } from '../../../src/im/acl.js';
import { createImMessages } from '../../../src/im/messages.js';
import { createImDelivery } from '../../../src/im/delivery.js';
import { createImMigration } from '../../../src/im/migration.js';
import { PROTOCOL } from '../../../src/im/contracts.js';

export const time = 1000;
export const policy = { enabled: true, writeMode: 'enabled',
  transport: { mode: 'local-test', serverUrl: 'http://localhost:8787' },
  retention: { policy: { messageRetentionMs: 100000, attachmentRetentionMs: 90000,
    idempotencyRetentionMs: 110000, safeRetryWindowMs: 10000 } },
  lease: { ttlMs: 5000, renewalMs: 1000 } };
export const tables = ['messages', 'im_messages', 'im_send_keys', 'im_deliveries',
  'im_receive_state', 'im_credentials', 'im_receiver_leases', 'im_lease_requests',
  'im_settings', 'im_agents', 'im_contacts', 'im_conversations', 'im_audit'];
export function open(root) {
  const db = new DatabaseSync(join(root, 'live.sqlite'));
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0; PRAGMA synchronous=FULL');
  return db;
}
export function snapshot(db) {
  return Object.fromEntries(tables.map(table => [table,
    // Canonical row ordering without depending on any query planner's scan order.
    db.prepare(`SELECT * FROM ${table}${table === 'im_audit' ? " WHERE action!='legacy_bindings_committed'" : ''}`)
      .all().map(row => JSON.stringify(row)).sort()]));
}
export function migrationState(db) {
  return JSON.parse(JSON.stringify({
    bindings: db.prepare('SELECT * FROM im_legacy_bindings ORDER BY legacy_member').all(),
    runs: db.prepare('SELECT * FROM im_migration_runs ORDER BY run_id').all(),
    audits: db.prepare("SELECT * FROM im_audit WHERE action='legacy_bindings_committed' ORDER BY id").all(),
  }));
}
export function seed(root, caseId) {
  const db = open(root), clock = () => time;
  try {
    db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE members(name TEXT PRIMARY KEY, revoked_at TEXT);
      CREATE TABLE messages(id INTEGER PRIMARY KEY,from_name TEXT,to_name TEXT,text TEXT,read_at TEXT);
      INSERT INTO members VALUES ('old-a',NULL),('old-b',NULL);
      INSERT INTO messages VALUES (1,'old-a','old-b','unread legacy',NULL),
        (2,'old-b','old-a','already read legacy','2026-01-01T00:00:00Z');`);
    migrateImSchemaV3(db); initInstanceIdentity(db, { clock: () => 1 });
    const context = { caseId, operation: 'seed' };
    const authorizeAdmin = candidate => candidate === context;
    const admin = createImAdmin({ db, clock, authorizeAdmin });
    const auth = createImAuth({ db, clock });
    const acl = createImAcl({ db, clock, auth });
    const messages = createImMessages({ db, clock, auth, acl, policy });
    const delivery = createImDelivery({ db, clock, auth, acl, policy });
    const agents = ['sender', 'recipient'].map(displayName => admin.registerAgent({ displayName }, context).agentId);
    // Credentials are freshly generated for this isolated DB and held only in test
    // memory/IPC. No real credential, access.json, .env, or network is consulted.
    const credentials = agents.map(agentId => admin.issueCredential({ agentId, expiresAt: null }, context).credential);
    const principals = credentials.map(value => auth.authenticate(value));
    admin.setContact({ agentA: agents[0], agentB: agents[1], allowed: true, reason: 'isolated process test' }, context);
    createImMigration({ db, clock, authorizeAdmin: candidate => candidate === context ? 'seed-operator' : null })
      .setImWriteMode({ mode: 'enabled', reason: 'isolated process test', policy }, context);
    const conversationId = messages.ensureConversation(principals[0], { peerAgentId: agents[1] }).conversationId;
    const clientMessageId = randomUUID();
    const sent = messages.send(principals[0], { protocol: PROTOCOL, conversationId,
      recipientAgentId: agents[1], clientMessageId, text: 'accepted baseline' });
    const instanceId = randomUUID();
    const lease = delivery.acquire(principals[1], { instanceId, requestId: randomUUID() });
    const synced = delivery.sync(principals[1], { instanceId, generation: lease.generation });
    assert.equal(synced.items[0].message.messageId, sent.messageId);
    assert.equal(delivery.ack(principals[1], { instanceId, generation: lease.generation,
      messageIds: [sent.messageId] }).ackedThrough, 1);
    assert.equal(sent.replayed, false);
    assert.equal(db.prepare('SELECT acked_at FROM im_deliveries WHERE message_id=?').get(sent.messageId).acked_at, time);
    assert.equal(db.prepare('SELECT acked_through FROM im_receive_state WHERE agent_id=?').get(agents[1]).acked_through, 1);
    const baseline = snapshot(db);
    for (const table of tables) assert.ok(baseline[table].length > 0, `populated ${table}`);
    return { baseline, identity: getInstanceIdentity(db),
      bindings: agents.map((agentId, i) => ({ legacyMember: `old-${i ? 'b' : 'a'}`, agentId })),
      traffic: { credential: credentials[0], conversationId, recipientAgentId: agents[1],
        baselineMessageId: sent.messageId, baselineKey: clientMessageId } };
  } finally { db.close(); }
}
export function sendNormal(db, clock, traffic, clientMessageId) {
  const auth = createImAuth({ db, clock });
  const acl = createImAcl({ db, clock, auth });
  const messages = createImMessages({ db, clock, auth, acl, policy });
  return messages.send(auth.authenticate(traffic.credential), { protocol: PROTOCOL,
    conversationId: traffic.conversationId, recipientAgentId: traffic.recipientAgentId,
    clientMessageId, text: 'independent writer during physical verification' });
}
