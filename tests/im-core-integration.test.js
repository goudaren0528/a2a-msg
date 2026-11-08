import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateImSchema, migrateImSchemaV4 } from '../src/im/schema.js';
import { createImClockGuard } from '../src/im/clock-guard.js';
import { createImAdmin } from '../src/im/admin.js';
import { createImAuth } from '../src/im/auth.js';
import { createImAcl } from '../src/im/acl.js';
import { createImMessages } from '../src/im/messages.js';
import { createImContacts } from '../src/im/contacts.js';
import { createImDelivery } from '../src/im/delivery.js';
import { createImMigration } from '../src/im/migration.js';
import { PROTOCOL } from '../src/im/contracts.js';

const policy = { enabled: true, writeMode: 'enabled', transport: { mode: 'local-test', serverUrl: 'http://localhost:8787' },
  retention: { policy: { messageRetentionMs: 100000, attachmentRetentionMs: 90000,
    idempotencyRetentionMs: 110000, safeRetryWindowMs: 10000 } }, lease: { ttlMs: 5000, renewalMs: 1000 } };
const error = code => e => e.code === code;

test('shared clock guard joins migration, admin, auth, ACL, messages, delivery and file reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'im-core-'));
  const file = join(dir, 'core.sqlite');
  let db;
  let now = 1000;
  const clock = () => now;
  const context = Object.freeze({});
  function open() {
    db = new DatabaseSync(file);
    db.exec('PRAGMA foreign_keys=ON');
    migrateImSchema(db);
    const timeGuard = createImClockGuard({ db, clock });
    const migration = createImMigration({ db, clock, timeGuard, authorizeAdmin: c => c === context ? 'operator' : null });
    const admin = createImAdmin({ db, clock, timeGuard, authorizeAdmin: c => c === context });
    const auth = createImAuth({ db, clock, timeGuard });
    const acl = createImAcl({ db, clock, timeGuard, auth });
    const messages = createImMessages({ db, clock, timeGuard, auth, acl, policy });
    const delivery = createImDelivery({ db, clock, timeGuard, auth, acl, policy });
    return { timeGuard, migration, admin, auth, acl, messages, delivery };
  }
  try {
    let { migration, admin, auth, acl, messages, delivery } = open();
    const people = ['A', 'B', 'C'].map(displayName => {
      const agentId = admin.registerAgent({ displayName }, context).agentId;
      const credential = admin.issueCredential({ agentId, expiresAt: null }, context);
      return { agentId, credential, principal: auth.authenticate(credential.credential) };
    });
    const [a, b, c] = people;
    admin.setContact({ agentA: a.agentId, agentB: b.agentId, allowed: true, reason: 'approved' }, context);
    migration.setImWriteMode({ mode: 'enabled', reason: 'test', policy }, context);
    const conversationId = messages.ensureConversation(a.principal, { peerAgentId: b.agentId }).conversationId;
    const data = Buffer.from('core integration attachment');
    const request = { protocol: PROTOCOL, conversationId, recipientAgentId: b.agentId,
      clientMessageId: randomUUID(), text: 'hello', attachment: { name: 'proof.txt',
        sha256: createHash('sha256').update(data).digest('hex'), dataBase64: data.toString('base64') } };
    const sent = messages.send(a.principal, request);
    assert.deepEqual(messages.getAttachment(a.principal, { attachmentId: sent.attachment.attachmentId }).data, data);
    assert.equal(messages.send(a.principal, request).messageId, sent.messageId);
    assert.throws(() => acl.requireConversation(c.principal, conversationId), error('RESOURCE_NOT_FOUND'));
    const fence = { instanceId: randomUUID() };
    const lease = delivery.acquire(b.principal, { ...fence, requestId: randomUUID() });
    const args = { instanceId: fence.instanceId, generation: lease.generation };
    const first = delivery.sync(b.principal, args);
    assert.deepEqual(first.items.map(i => i.message.messageId), [sent.messageId]);
    assert.equal(first.ackedThrough, 0);
    assert.equal(messages.getMessage(b.principal, { messageId: sent.messageId }).readAt, null);
    assert.throws(() => messages.markRead(b.principal, { messageId: sent.messageId }), error('DELIVERY_REQUIRED'));
    assert.equal(delivery.ack(b.principal, { ...args, messageIds: [sent.messageId] }).ackedThrough, 1);
    assert.equal(messages.markRead(b.principal, { messageId: sent.messageId }).changed, true);
    assert.ok(messages.getMessage(a.principal, { messageId: sent.messageId }).deliveredAt);
    assert.ok(messages.getMessage(a.principal, { messageId: sent.messageId }).readAt);
    db.close(); db = null;
    ({ migration, admin, auth, acl, messages, delivery } = open());
    const bPrincipal = auth.authenticate(b.credential.credential);
    assert.equal(messages.getMessage(bPrincipal, { messageId: sent.messageId }).messageId, sent.messageId);
    assert.equal(delivery.sync(bPrincipal, args).ackedThrough, 1);
    assert.equal(delivery.sync(bPrincipal, args).items.length, 0);
    assert.throws(() => delivery.acquire(bPrincipal, { ...fence, requestId: randomUUID() }), error('LEASE_CONFLICT'));
    assert.equal(delivery.renew(bPrincipal, args).generation, lease.generation);
    const aPrincipal = auth.authenticate(a.credential.credential);
    migration.setImWriteMode({ mode: 'paused', reason: 'incident' }, context);
    assert.throws(() => messages.send(aPrincipal, { ...request, clientMessageId: randomUUID() }), error('NEW_WRITES_DISABLED'));
    migration.setImWriteMode({ mode: 'enabled', reason: 'resumed', policy }, context);
    admin.setContact({ agentA: a.agentId, agentB: b.agentId, allowed: false, reason: 'withdrawn' }, context);
    assert.throws(() => messages.getMessage(bPrincipal, { messageId: sent.messageId }), error('RESOURCE_NOT_FOUND'));
    assert.throws(() => delivery.sync(bPrincipal, { ...args, after: 0 }), error('SYNC_BLOCKED'));
    admin.issueCredential({ agentId: c.agentId, expiresAt: 1100 }, context);
    const expiring = admin.issueCredential({ agentId: b.agentId, expiresAt: 1100 }, context);
    const beforeAudit = db.prepare('SELECT count(*) n FROM im_audit').get().n;
    now = 1100;
    assert.throws(() => auth.authenticate(expiring.credential), error('INVALID_CREDENTIAL'));
    db.exec("CREATE TEMP TRIGGER fail_core_audit BEFORE INSERT ON im_audit BEGIN SELECT RAISE(ABORT,'audit failure'); END");
    assert.throws(() => admin.setAgentStatus({ agentId: b.agentId, status: 'disabled', reason: 'failure' }, context));
    db.exec('DROP TRIGGER fail_core_audit');
    assert.equal(db.prepare('SELECT status FROM im_agents WHERE agent_id=?').get(b.agentId).status, 'active');
    assert.equal(db.prepare('SELECT count(*) n FROM im_audit').get().n, beforeAudit);
    assert.equal(db.prepare('SELECT last_observed_at FROM im_clock').get().last_observed_at, 1100);
    now = 900;
    assert.throws(() => auth.assertActive(bPrincipal), error('CLOCK_UNSAFE'));
    assert.throws(() => messages.send(aPrincipal, { ...request, clientMessageId: randomUUID() }), error('CLOCK_UNSAFE'));
    db.close(); db = null;
    ({ auth } = open());
    assert.throws(() => auth.authenticate(expiring.credential), error('CLOCK_UNSAFE'));
  } finally { db?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('friend request state machine wires through core and revocation hides history and sync', () => {
  const dir = mkdtempSync(join(tmpdir(), 'im-core-contacts-'));
  const db = new DatabaseSync(join(dir, 'contacts.sqlite'));
  db.exec('PRAGMA foreign_keys=ON');
  let now = 1000; const clock = () => now;
  const context = {};
  try {
    migrateImSchemaV4(db);
    const timeGuard = createImClockGuard({ db, clock });
    const admin = createImAdmin({ db, clock, timeGuard, authorizeAdmin: c => c === context });
    const auth = createImAuth({ db, clock, timeGuard });
    const acl = createImAcl({ db, clock, timeGuard, auth });
    const policy = { enabled: true, writeMode: 'enabled',
      transport: { mode: 'local-test', serverUrl: 'http://localhost:8787' },
      retention: { policy: { messageRetentionMs: 100000, attachmentRetentionMs: 90000,
        idempotencyRetentionMs: 110000, safeRetryWindowMs: 10000 } },
      lease: { ttlMs: 5000, renewalMs: 1000 }, contacts: { requests: 'enabled' } };
    const contacts = createImContacts({ db, clock, timeGuard, auth, policy });
    const messages = createImMessages({ db, clock, timeGuard, auth, acl, policy });
    const delivery = createImDelivery({ db, clock, timeGuard, auth, acl, policy });
    const [a, b] = ['A', 'B'].map(displayName => {
      const agentId = admin.registerAgent({ displayName }, context).agentId;
      const credential = admin.issueCredential({ agentId, expiresAt: null }, context);
      return { agentId, principal: auth.authenticate(credential.credential) };
    });
    db.exec("UPDATE im_settings SET write_mode='enabled'");
    assert.throws(() => messages.ensureConversation(a.principal, { peerAgentId: b.agentId }),
      e => e.code === 'RESOURCE_NOT_FOUND');
    const request = contacts.request(a.principal, { peerAgentId: b.agentId });
    assert.equal(contacts.list(b.principal, { direction: 'incoming' }).items[0].status, 'pending');
    assert.equal(contacts.respond(b.principal, { requestId: request.requestId, action: 'accept' }).status, 'accepted');
    const conversationId = messages.ensureConversation(a.principal, { peerAgentId: b.agentId }).conversationId;
    const sent = messages.send(a.principal, { protocol: PROTOCOL, conversationId, recipientAgentId: b.agentId,
      clientMessageId: randomUUID(), text: 'secret body before revoke' });
    const fence = { instanceId: randomUUID() };
    const lease = delivery.acquire(b.principal, { ...fence, requestId: randomUUID() });
    const args = { instanceId: fence.instanceId, generation: lease.generation };
    assert.equal(delivery.sync(b.principal, args).items[0].message.messageId, sent.messageId);
    delivery.ack(b.principal, { ...args, messageIds: [sent.messageId] });
    assert.equal(messages.markRead(b.principal, { messageId: sent.messageId }).changed, true);
    assert.equal(contacts.revoke(b.principal, { requestId: request.requestId }).status, 'revoked');
    assert.deepEqual(messages.listContacts(b.principal).items, []);
    assert.throws(() => messages.getMessage(b.principal, { messageId: sent.messageId }),
      e => e.code === 'RESOURCE_NOT_FOUND');
    assert.throws(() => messages.listHistory(b.principal, { conversationId }),
      e => e.code === 'RESOURCE_NOT_FOUND');
    assert.throws(() => messages.send(a.principal, { protocol: PROTOCOL, conversationId,
      recipientAgentId: b.agentId, clientMessageId: randomUUID(), text: 'after revoke' }),
    e => e.code === 'RESOURCE_NOT_FOUND');
    assert.throws(() => delivery.sync(b.principal, { ...args, after: 0 }), e => e.code === 'SYNC_BLOCKED');
    const contact = db.prepare('SELECT allowed,version FROM im_contacts').get();
    assert.deepEqual([contact.allowed, contact.version], [0, 2]);
    now = 2000;
    const again = contacts.request(b.principal, { peerAgentId: a.agentId });
    assert.equal(again.status, 'pending');
    assert.equal(contacts.respond(a.principal, { requestId: again.requestId, action: 'accept' }).status, 'accepted');
    assert.equal(messages.getMessage(b.principal, { messageId: sent.messageId }).messageId, sent.messageId);
    assert.equal(delivery.sync(b.principal, { ...args, after: 0 }).items.length, 1);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
