import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { migrateImSchemaV4 } from '../src/im/schema.js';
import { createImAdmin } from '../src/im/admin.js';
import { createImAuth } from '../src/im/auth.js';
import { createImAcl } from '../src/im/acl.js';
import { createImContacts } from '../src/im/contacts.js';
import { createImMessages } from '../src/im/messages.js';
import { PROTOCOL } from '../src/im/contracts.js';

const policyFor = requests => ({ enabled: true, writeMode: 'enabled',
  transport: { mode: 'local-test', serverUrl: 'http://localhost:8787' },
  retention: { policy: { messageRetentionMs: 100000, attachmentRetentionMs: 90000,
    idempotencyRetentionMs: 110000, safeRetryWindowMs: 1000 } }, lease: { ttlMs: 1000, renewalMs: 500 },
  contacts: { requests } });
const error = code => e => e.code === code;

function setup({ requests = 'enabled', people = 4, policy } = {}) {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); migrateImSchemaV4(db);
  let time = 10000; const clock = () => time;
  const context = {}; const admin = createImAdmin({ db, clock, authorizeAdmin: c => c === context });
  const auth = createImAuth({ db, clock }); const acl = createImAcl({ db, auth, clock });
  const agents = Array.from({ length: people }, (_, i) => {
    const agentId = admin.registerAgent({ displayName: `Agent ${i}` }, context).agentId;
    const issued = admin.issueCredential({ agentId, expiresAt: null }, context);
    return { agentId, credentialId: issued.credentialId, credential: issued.credential,
      principal: auth.authenticate(issued.credential) };
  });
  db.exec("UPDATE im_settings SET write_mode='enabled'");
  const used = policy ?? policyFor(requests);
  const contacts = createImContacts({ db, auth, clock, policy: used });
  const messages = createImMessages({ db, auth, acl, clock, policy: used });
  const request = (conversationId, recipientAgentId) => ({ protocol: PROTOCOL, conversationId,
    recipientAgentId, clientMessageId: randomUUID(), text: 'hello' });
  return { db, admin, auth, acl, clock, context, agents, contacts, messages, request,
    advance: n => { time += n; }, close: () => db.close() };
}

test('AC-4: request, pending visibility, accept, both contacts accepted, then send', () => {
  const f = setup(); try {
    const [a, b, outsider] = f.agents;
    const created = f.contacts.request(a.principal, { peerAgentId: b.agentId });
    assert.equal(created.status, 'pending');
    assert.equal(created.direction, 'outgoing');
    assert.equal(created.peerAgentId, b.agentId);
    assert.equal(created.peerDisplayName, 'Agent 1');
    assert.equal(created.version, 1);
    assert.equal(f.contacts.list(b.principal, { direction: 'incoming' }).items[0].requestId, created.requestId);
    assert.equal(f.contacts.list(b.principal, { direction: 'outgoing' }).items.length, 0);
    assert.equal(f.messages.listContacts(a.principal).items.length, 0);
    assert.throws(() => f.contacts.respond(outsider.principal, { requestId: created.requestId, action: 'accept' }),
      error('RESOURCE_NOT_FOUND'));
    assert.throws(() => f.messages.ensureConversation(a.principal, { peerAgentId: b.agentId }),
      error('RESOURCE_NOT_FOUND'));
    const accepted = f.contacts.respond(b.principal, { requestId: created.requestId, action: 'accept' });
    assert.equal(accepted.status, 'accepted');
    assert.equal(accepted.version, 2);
    assert.deepEqual(f.messages.listContacts(a.principal).items.map(x => x.peerAgentId), [b.agentId]);
    assert.deepEqual(f.messages.listContacts(b.principal).items.map(x => x.peerAgentId), [a.agentId]);
    // Re-asking after acceptance is an idempotent read of the accepted state.
    assert.equal(f.contacts.request(a.principal, { peerAgentId: b.agentId }).status, 'accepted');
    assert.equal(f.db.prepare('SELECT count(*) n FROM im_contact_requests').get().n, 1);
    const conversation = f.messages.ensureConversation(a.principal, { peerAgentId: b.agentId });
    assert.ok(f.messages.send(a.principal, f.request(conversation.conversationId, b.agentId)).messageId);
    assert.equal(f.contacts.list(a.principal, { direction: 'outgoing' }).items[0].status, 'accepted');
  } finally { f.close(); }
});

test('mutual requests accept immediately; one row per pair and version increases', () => {
  const f = setup(); try {
    const [a, b] = f.agents;
    const first = f.contacts.request(a.principal, { peerAgentId: b.agentId });
    assert.equal(first.status, 'pending');
    const mutual = f.contacts.request(b.principal, { peerAgentId: a.agentId });
    assert.equal(mutual.status, 'accepted');
    assert.equal(mutual.direction, 'incoming');
    assert.equal(mutual.version, 2);
    assert.equal(mutual.requestId, first.requestId);
    assert.equal(f.db.prepare('SELECT count(*) n FROM im_contact_requests').get().n, 1);
    assert.equal(f.messages.listContacts(a.principal).items.length, 1);
    assert.equal(f.messages.listContacts(b.principal).items.length, 1);
  } finally { f.close(); }
});

test('AC-5: reject blocks sending, re-request works, revoke hides new sends and old history', () => {
  const f = setup(); try {
    const [a, b] = f.agents;
    const request = f.contacts.request(a.principal, { peerAgentId: b.agentId });
    const rejected = f.contacts.respond(b.principal, { requestId: request.requestId, action: 'reject' });
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.version, 2);
    assert.throws(() => f.messages.ensureConversation(a.principal, { peerAgentId: b.agentId }),
      error('RESOURCE_NOT_FOUND'));
    assert.throws(() => f.contacts.respond(b.principal, { requestId: request.requestId, action: 'accept' }),
      error('CONTACT_REQUEST_CONFLICT'));
    const again = f.contacts.request(a.principal, { peerAgentId: b.agentId });
    assert.equal(again.requestId, request.requestId);
    assert.equal(again.status, 'pending');
    assert.equal(again.version, 3);
    f.contacts.respond(b.principal, { requestId: again.requestId, action: 'accept' });
    const conversation = f.messages.ensureConversation(a.principal, { peerAgentId: b.agentId });
    const sent = f.messages.send(a.principal, f.request(conversation.conversationId, b.agentId));
    f.db.prepare('UPDATE im_deliveries SET acked_at=? WHERE message_id=?').run(10000, sent.messageId);
    assert.equal(f.messages.markRead(b.principal, { messageId: sent.messageId }).changed, true);
    assert.equal(f.messages.getMessage(b.principal, { messageId: sent.messageId }).readAt, 10000);
    const revoked = f.contacts.revoke(b.principal, { requestId: again.requestId });
    assert.equal(revoked.status, 'revoked');
    assert.equal(revoked.version, 5);
    assert.equal(f.messages.listContacts(a.principal).items.length, 0);
    assert.equal(f.messages.listConversations(a.principal).items.length, 0);
    assert.throws(() => f.messages.send(a.principal, f.request(conversation.conversationId, b.agentId)),
      error('RESOURCE_NOT_FOUND'));
    assert.throws(() => f.messages.getMessage(b.principal, { messageId: sent.messageId }),
      error('RESOURCE_NOT_FOUND'));
    assert.throws(() => f.messages.getMessage(a.principal, { messageId: sent.messageId }),
      error('RESOURCE_NOT_FOUND'));
    assert.throws(() => f.messages.listHistory(a.principal, { conversationId: conversation.conversationId }),
      error('RESOURCE_NOT_FOUND'));
    assert.throws(() => f.messages.markRead(b.principal, { messageId: sent.messageId }),
      error('RESOURCE_NOT_FOUND'));
    assert.equal(f.contacts.request(a.principal, { peerAgentId: b.agentId }).status, 'pending');
  } finally { f.close(); }
});

test('pending cancel, target-only reject, idempotent revoke and hidden unauthorized rows', () => {
  const f = setup(); try {
    const [a, b, outsider] = f.agents;
    const request = f.contacts.request(a.principal, { peerAgentId: b.agentId });
    assert.throws(() => f.contacts.revoke(b.principal, { requestId: request.requestId }),
      error('CONTACT_REQUEST_CONFLICT'));
    assert.throws(() => f.contacts.respond(a.principal, { requestId: request.requestId, action: 'reject' }),
      error('RESOURCE_NOT_FOUND'));
    assert.throws(() => f.contacts.revoke(outsider.principal, { requestId: request.requestId }),
      error('RESOURCE_NOT_FOUND'));
    const cancelled = f.contacts.revoke(a.principal, { requestId: request.requestId });
    assert.equal(cancelled.status, 'revoked');
    assert.equal(f.contacts.revoke(a.principal, { requestId: request.requestId }).status, 'revoked');
    assert.throws(() => f.contacts.respond(b.principal, { requestId: request.requestId, action: 'accept' }),
      error('CONTACT_REQUEST_CONFLICT'));
    assert.throws(() => f.contacts.revoke(a.principal, { requestId: randomUUID() }), error('RESOURCE_NOT_FOUND'));
  } finally { f.close(); }
});

test('AC-6: sending requires accepted contacts, admin grant still materializes accepted state', () => {
  const f = setup(); try {
    const [a, b, c] = f.agents;
    assert.throws(() => f.messages.ensureConversation(a.principal, { peerAgentId: b.agentId }),
      error('RESOURCE_NOT_FOUND'));
    f.admin.setContact({ agentA: a.agentId, agentB: b.agentId, allowed: true, reason: 'admin' }, f.context);
    const conversation = f.messages.ensureConversation(a.principal, { peerAgentId: b.agentId });
    assert.ok(f.messages.send(a.principal, f.request(conversation.conversationId, b.agentId)).messageId);
    const materialized = f.contacts.request(a.principal, { peerAgentId: b.agentId });
    assert.equal(materialized.status, 'accepted');
    assert.equal(materialized.direction, 'outgoing');
    assert.throws(() => f.messages.ensureConversation(c.principal, { peerAgentId: b.agentId }),
      error('RESOURCE_NOT_FOUND'));
  } finally { f.close(); }
});

test('legacy policy ignores the request table and keeps administrator contact semantics', () => {
  const f = setup({ requests: 'legacy' }); try {
    const [a, b] = f.agents;
    assert.throws(() => f.contacts.request(a.principal, { peerAgentId: b.agentId }), error('POLICY_NOT_CONFIGURED'));
    assert.throws(() => f.contacts.list(a.principal), error('POLICY_NOT_CONFIGURED'));
    f.admin.setContact({ agentA: a.agentId, agentB: b.agentId, allowed: true, reason: 'legacy' }, f.context);
    const conversation = f.messages.ensureConversation(a.principal, { peerAgentId: b.agentId });
    assert.ok(f.messages.send(a.principal, f.request(conversation.conversationId, b.agentId)).messageId);
    assert.equal(f.db.prepare('SELECT count(*) n FROM im_contact_requests').get().n, 0);
  } finally { f.close(); }
});

test('strict input, active-peer hiding, pagination scope and audit without secrets', () => {
  const f = setup({ people: 5 }); try {
    const [a, b, c] = f.agents;
    assert.throws(() => f.contacts.request(a.principal, { peerAgentId: a.agentId }), error('INVALID_REQUEST'));
    assert.throws(() => f.contacts.request(a.principal, { peerAgentId: 'not-a-uuid' }), error('INVALID_REQUEST'));
    assert.throws(() => f.contacts.request(a.principal, { peerAgentId: b.agentId, extra: 1 }), error('INVALID_REQUEST'));
    assert.throws(() => f.contacts.request(a.principal, { peerAgentId: randomUUID() }), error('RESOURCE_NOT_FOUND'));
    f.admin.setAgentStatus({ agentId: c.agentId, status: 'disabled', reason: 'test' }, f.context);
    assert.throws(() => f.contacts.request(a.principal, { peerAgentId: c.agentId }), error('RESOURCE_NOT_FOUND'));
    assert.throws(() => f.contacts.list(a.principal, { direction: 'sideways' }), error('INVALID_REQUEST'));
    assert.throws(() => f.contacts.list(a.principal, { limit: 101 }), error('INVALID_REQUEST'));
    const ids = [b.agentId, f.agents[3].agentId, f.agents[4].agentId];
    for (const peerAgentId of ids) f.contacts.request(a.principal, { peerAgentId });
    const seen = []; let after;
    do {
      const page = f.contacts.list(a.principal, { direction: 'outgoing', limit: 1, ...(after ? { after } : {}) });
      seen.push(...page.items.map(item => item.requestId));
      if (page.nextCursor) {
        const other = f.contacts.list(b.principal, { direction: 'incoming', limit: 1 });
        assert.ok(other.nextCursor === null || other.nextCursor !== page.nextCursor);
        assert.throws(() => f.contacts.list(b.principal, { direction: 'outgoing', after: page.nextCursor }),
          error('INVALID_REQUEST'));
      }
      after = page.nextCursor;
    } while (after);
    assert.equal(seen.length, 3);
    assert.equal(new Set(seen).size, 3);
    const audit = f.db.prepare('SELECT action,target_ids_json,safe_details_json FROM im_audit ORDER BY id').all();
    assert.equal(audit.filter(row => row.action === 'contact_request_sent').length, 3);
    const serialized = JSON.stringify(audit);
    for (const person of f.agents) assert.equal(serialized.includes(person.credential), false);
    assert.doesNotMatch(serialized, /Agent \d/);
    for (const row of audit.filter(x => x.action === 'contact_request_sent')) {
      const details = JSON.parse(row.safe_details_json);
      assert.deepEqual(Object.keys(details).sort(), ['status', 'version']);
    }
  } finally { f.close(); }
});

test('write mode, disabled IM and contact state survive existing relationship snapshots', () => {
  const paused = setup({ policy: { ...policyFor('enabled'), writeMode: 'paused' } }); try {
    const [a, b] = paused.agents;
    assert.throws(() => paused.contacts.request(a.principal, { peerAgentId: b.agentId }),
      error('NEW_WRITES_DISABLED'));
    assert.deepEqual(paused.contacts.list(a.principal), { items: [], nextCursor: null });
  } finally { paused.close(); }
  const off = setup({ policy: { enabled: false } }); try {
    const [a, b] = off.agents;
    assert.throws(() => off.contacts.request(a.principal, { peerAgentId: b.agentId }), error('IM_DISABLED'));
    assert.throws(() => off.contacts.list(a.principal), error('IM_DISABLED'));
  } finally { off.close(); }
});
