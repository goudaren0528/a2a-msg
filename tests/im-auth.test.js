import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { migrateImSchema } from '../src/im/schema.js';
import { createImAuth } from '../src/im/auth.js';
import { createImAdmin } from '../src/im/admin.js';
import { createImAcl } from '../src/im/acl.js';
import { observeImClock, readImClock } from '../src/im/clock.js';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  migrateImSchema(db);
  let now = 1000;
  const clock = () => now;
  const trusted = Object.freeze({ capability: Symbol('trusted') });
  const admin = createImAdmin({ db, clock, authorizeAdmin: (ctx) => ctx === trusted });
  const auth = createImAuth({ db, clock });
  const acl = createImAcl({ db, auth, clock });
  return { db, admin, auth, acl, trusted, setNow: (time) => { now = time; }, clock };
}
function agent(f) {
  const registered = f.admin.registerAgent({ displayName: 'Agent' }, f.trusted);
  return { ...registered, ...f.admin.issueCredential({ agentId: registered.agentId, expiresAt: null }, f.trusted) };
}
function code(expected) { return (err) => err.code === expected; }

test('admin authorization is fail closed; registration works while paused and receives independent state', () => {
  const f = fixture();
  assert.throws(() => createImAdmin({ db: f.db, clock: f.clock }), code('POLICY_NOT_CONFIGURED'));
  assert.throws(() => f.admin.registerAgent({ displayName: 'x' }, { admin: true }), code('OPERATION_FORBIDDEN'));
  const a = agent(f);
  assert.equal(f.db.prepare('SELECT write_mode FROM im_settings').get().write_mode, 'paused');
  assert.deepEqual({ ...f.db.prepare('SELECT next_seq,acked_through,retained_floor,stream_epoch FROM im_receive_state WHERE agent_id=?').get(a.agentId) },
    { next_seq: 1, acked_through: 0, retained_floor: 1, stream_epoch: a.streamEpoch });
  assert.throws(() => f.admin.registerAgent({ displayName: 'x', agentId: a.agentId }, f.trusted), code('INVALID_REQUEST'));
  f.db.close();
});

test('credential protection rejects async factory callback and thenable result before activation', async () => {
  const f = fixture();
  const a = f.admin.registerAgent({ displayName: 'Agent' }, f.trusted);
  const create = protectCredential => createImAdmin({ db: f.db, clock: f.clock,
    authorizeAdmin: ctx => ctx === f.trusted, protectCredential });
  assert.throws(() => create(async () => () => {}), code('POLICY_NOT_CONFIGURED'));
  assert.throws(() => create(false), code('POLICY_NOT_CONFIGURED'));
  const failing = create(() => Promise.reject(new Error('secret must not escape')));
  assert.throws(() => failing.issueCredential({ agentId: a.agentId, expiresAt: null }, f.trusted),
    error => error.code === 'POLICY_NOT_CONFIGURED' && !error.stack.includes('secret must not escape'));
  await Promise.resolve();
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM im_credentials').get().n, 0);
  f.db.close();
});

test('async cleanup and thenable cleanup cannot count as successful rollback', async () => {
  const f = fixture();
  const a = f.admin.registerAgent({ displayName: 'Agent' }, f.trusted);
  const create = protectCredential => createImAdmin({ db: f.db, clock: f.clock,
    authorizeAdmin: ctx => ctx === f.trusted, protectCredential });
  const asyncCleanup = create(() => async () => { throw new Error('private secret'); });
  assert.throws(() => asyncCleanup.issueCredential({ agentId: a.agentId, expiresAt: null }, f.trusted), error =>
    error.code === 'STORAGE_UNAVAILABLE' && typeof error.credentialId === 'string' && !error.stack.includes('private secret'));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM im_credentials').get().n, 0);
  // Force a failure after a synchronous-looking cleanup callback has been installed.
  const thenableCleanup = create(() => () => Promise.reject(new Error('private secret')));
  f.db.exec(`CREATE TRIGGER fail_issue_async_cleanup BEFORE INSERT ON im_credentials BEGIN SELECT RAISE(ABORT,'blocked'); END`);
  assert.throws(() => thenableCleanup.issueCredential({ agentId: a.agentId, expiresAt: null }, f.trusted), error =>
    error.code === 'STORAGE_UNAVAILABLE' && typeof error.credentialId === 'string' && !error.stack.includes('private secret'));
  await Promise.resolve();
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM im_credentials').get().n, 0);
  f.db.close();
});

test('credential isolation, hashing, expiry, revocation, principal branding and fresh revalidation', () => {
  const f = fixture();
  const a = agent(f), b = agent(f);
  const principal = f.auth.authenticate(a.credential);
  assert.deepEqual(principal, { agentId: a.agentId, credentialId: a.credentialId });
  assert.ok(Object.isFrozen(principal));
  assert.throws(() => f.auth.assertActive({ ...principal }), code('INVALID_CREDENTIAL'));
  assert.throws(() => f.auth.assertActive(JSON.parse(JSON.stringify(principal))), code('INVALID_CREDENTIAL'));
  assert.throws(() => f.auth.authenticate(`${a.credentialId}.${b.credential.split('.')[1]}`), code('INVALID_CREDENTIAL'));
  assert.throws(() => f.auth.authenticate('bad'), code('INVALID_CREDENTIAL'));
  assert.throws(() => f.auth.authenticate(`${randomUUID()}.${a.credential.split('.')[1]}`), code('INVALID_CREDENTIAL'));
  const stored = f.db.prepare('SELECT secret_hash FROM im_credentials WHERE credential_id=?').get(a.credentialId).secret_hash;
  assert.equal(stored, createHash('sha256').update(a.credential.split('.')[1]).digest('hex'));
  assert.ok(!stored.includes(a.credential.split('.')[1]));
  const exp = f.admin.issueCredential({ agentId: b.agentId, expiresAt: 1001 }, f.trusted);
  f.setNow(1001);
  assert.throws(() => f.auth.authenticate(exp.credential), code('INVALID_CREDENTIAL'));
  f.admin.revokeCredential({ credentialId: a.credentialId, reason: 'rotate' }, f.trusted);
  assert.throws(() => f.auth.assertActive(principal), code('INVALID_CREDENTIAL'));
  assert.throws(() => f.auth.authenticate(a.credential), code('INVALID_CREDENTIAL'));
  f.admin.setAgentStatus({ agentId: b.agentId, status: 'disabled', reason: 'suspend' }, f.trusted);
  assert.throws(() => f.auth.authenticate(b.credential), code('INVALID_CREDENTIAL'));
  f.db.close();
});

test('symmetric contact ACL for conversations, messages, attachments; revocation hides old resources', () => {
  const f = fixture();
  const a = agent(f), b = agent(f), c = agent(f);
  const pa = f.auth.authenticate(a.credential), pb = f.auth.authenticate(b.credential), pc = f.auth.authenticate(c.credential);
  assert.throws(() => f.acl.requirePeer(pa, b.agentId), code('RESOURCE_NOT_FOUND'));
  const contact = f.admin.setContact({ agentA: b.agentId, agentB: a.agentId, allowed: true, reason: 'approved' }, f.trusted);
  assert.deepEqual(f.acl.requirePeer(pb, a.agentId), { agentLow: contact.agentLow, agentHigh: contact.agentHigh, peerAgentId: a.agentId });
  const conversationId = randomUUID(), messageId = randomUUID(), attachmentId = randomUUID();
  f.db.prepare('INSERT INTO im_conversations(conversation_id,agent_low,agent_high,created_at) VALUES (?,?,?,?)')
    .run(conversationId, contact.agentLow, contact.agentHigh, 1000);
  f.db.prepare('INSERT INTO im_messages(message_id,conversation_id,sender_id,recipient_id,client_message_id,text,accepted_at) VALUES (?,?,?,?,?,?,?)')
    .run(messageId, conversationId, a.agentId, b.agentId, randomUUID(), 'hello', 1000);
  const data = Buffer.from('a');
  f.db.prepare('INSERT INTO im_attachments(attachment_id,message_id,name,size,sha256,data) VALUES (?,?,?,?,?,?)')
    .run(attachmentId, messageId, 'file', data.length, createHash('sha256').update(data).digest('hex'), data);
  for (const p of [pa, pb]) {
    assert.equal(f.acl.requireConversation(p, conversationId).conversation_id, conversationId);
    assert.equal(f.acl.requireMessage(p, messageId).message_id, messageId);
    assert.equal(f.acl.requireAttachment(p, attachmentId).attachment_id, attachmentId);
    const metadata = f.acl.assertAttachmentAccess(p, attachmentId);
    assert.equal(metadata.message_id, messageId);
    assert.equal(metadata.size, data.length);
    assert.equal(Object.hasOwn(metadata, 'data'), false);
    assert.ok(Object.isFrozen(metadata));
  }
  for (const fn of [() => f.acl.requireConversation(pc, conversationId), () => f.acl.requireMessage(pc, messageId),
    () => f.acl.requireAttachment(pc, attachmentId), () => f.acl.requireAttachment(pa, randomUUID()),
    () => f.acl.assertAttachmentAccess(pc, attachmentId), () => f.acl.assertAttachmentAccess(pa, randomUUID())]) {
    assert.throws(fn, code('RESOURCE_NOT_FOUND'));
  }
  const mismatched = randomUUID();
  f.db.prepare('INSERT INTO im_messages(message_id,conversation_id,sender_id,recipient_id,client_message_id,text,accepted_at) VALUES (?,?,?,?,?,?,?)')
    .run(mismatched, conversationId, a.agentId, c.agentId, randomUUID(), 'bad fixture', 1000);
  assert.throws(() => f.acl.requireMessage(pa, mismatched), code('RESOURCE_NOT_FOUND'));
  const blocked = f.admin.setContact({ agentA: a.agentId, agentB: b.agentId, allowed: false, reason: 'withdrawn' }, f.trusted);
  assert.equal(blocked.version, 2);
  assert.throws(() => f.acl.requireAttachment(pa, attachmentId), code('RESOURCE_NOT_FOUND'));
  assert.throws(() => f.acl.assertAttachmentAccess(pa, attachmentId), code('RESOURCE_NOT_FOUND'));
  assert.throws(() => f.acl.requireMessage(pb, messageId), code('RESOURCE_NOT_FOUND'));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM im_messages').get().n, 2);
  f.db.close();
});

test('attachment BLOB lookup happens only after owner authorization, hidden for unauthorized caller', () => {
  const f = fixture();
  const a = agent(f), b = agent(f), outsider = agent(f);
  const contact = f.admin.setContact({ agentA: a.agentId, agentB: b.agentId, allowed: true, reason: 'approved' }, f.trusted);
  const conversationId = randomUUID(), messageId = randomUUID(), attachmentId = randomUUID();
  f.db.prepare('INSERT INTO im_conversations(conversation_id,agent_low,agent_high,created_at) VALUES (?,?,?,?)')
    .run(conversationId, contact.agentLow, contact.agentHigh, 1000);
  f.db.prepare('INSERT INTO im_messages(message_id,conversation_id,sender_id,recipient_id,client_message_id,text,accepted_at) VALUES (?,?,?,?,?,?,?)')
    .run(messageId, conversationId, a.agentId, b.agentId, randomUUID(), 'hello', 1000);
  const data = Buffer.alloc(1024, 0x61);
  f.db.prepare('INSERT INTO im_attachments(attachment_id,message_id,name,size,sha256,data) VALUES (?,?,?,?,?,?)')
    .run(attachmentId, messageId, 'file', data.length, createHash('sha256').update(data).digest('hex'), data);
  const queries = [];
  const instrumented = new Proxy(f.db, { get(target, key) {
    if (key === 'prepare') return sql => {
      if (/\bim_attachments\b/i.test(sql)) return { get: (...args) => {
        queries.push(sql);
         if (/SELECT\s+\*\s+FROM\s+im_attachments/i.test(sql)) queries.push('BLOB_READ');
        return target.prepare(sql).get(...args);
      } };
      return target.prepare(sql);
    };
    const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
  } });
  // The proxy is a distinct guard identity; bind auth and ACL to the same proxy.
  const proxyAuth = createImAuth({ db: instrumented, clock: f.clock });
  const acl = createImAcl({ db: instrumented, auth: proxyAuth, clock: f.clock });
  queries.length = 0;
  assert.throws(() => acl.requireAttachment(proxyAuth.authenticate(outsider.credential), attachmentId), code('RESOURCE_NOT_FOUND'));
  assert.equal(queries.includes('BLOB_READ'), false);
  assert.match(queries[0], /SELECT attachment_id,message_id,name,mime,size,sha256 FROM im_attachments/);
  queries.length = 0;
  assert.throws(() => acl.assertAttachmentAccess(proxyAuth.authenticate(outsider.credential), attachmentId), code('RESOURCE_NOT_FOUND'));
  assert.equal(queries.includes('BLOB_READ'), false);
  queries.length = 0;
  assert.equal(acl.assertAttachmentAccess(proxyAuth.authenticate(a.credential), attachmentId).size, data.length);
  assert.equal(queries.includes('BLOB_READ'), false);
  queries.length = 0;
  assert.deepEqual(Buffer.from(acl.requireAttachment(proxyAuth.authenticate(a.credential), attachmentId).data), data);
  assert.match(queries[0], /SELECT attachment_id,message_id,name,mime,size,sha256 FROM im_attachments/);
  assert.match(queries[1], /SELECT \* FROM im_attachments/);
  assert.equal(queries[2], 'BLOB_READ');
  f.db.close();
});

test('disabled endpoint may have contact explicitly revoked; re-enable does not restore access', () => {
  const f = fixture();
  const a = agent(f), b = agent(f);
  const principal = f.auth.authenticate(a.credential);
  f.admin.setContact({ agentA: a.agentId, agentB: b.agentId, allowed: true, reason: 'approved' }, f.trusted);
  f.admin.setAgentStatus({ agentId: b.agentId, status: 'disabled', reason: 'suspended' }, f.trusted);
  assert.equal(f.admin.setContact({ agentA: a.agentId, agentB: b.agentId, allowed: false, reason: 'withdrawn' }, f.trusted).version, 2);
  assert.throws(() => f.admin.setContact({ agentA: a.agentId, agentB: b.agentId, allowed: true, reason: 'premature' }, f.trusted), code('RESOURCE_NOT_FOUND'));
  f.admin.setAgentStatus({ agentId: b.agentId, status: 'active', reason: 'restored' }, f.trusted);
  assert.throws(() => f.acl.requirePeer(principal, b.agentId), code('RESOURCE_NOT_FOUND'));
  assert.equal(f.db.prepare('SELECT allowed FROM im_contacts').get().allowed, 0);
  f.db.close();
});

test('clock rollback rejects read/write; audit failure rolls back mutation; lease takeover fences only active leases', () => {
  const f = fixture();
  const a = agent(f);
  const p = f.auth.authenticate(a.credential);
  f.setNow(900);
  assert.throws(() => f.auth.assertActive(p), code('CLOCK_UNSAFE'));
  assert.throws(() => f.admin.setAgentStatus({ agentId: a.agentId, status: 'disabled', reason: 'test' }, f.trusted), code('CLOCK_UNSAFE'));
  assert.equal(f.db.prepare('SELECT status FROM im_agents WHERE agent_id=?').get(a.agentId).status, 'active');
  f.setNow(1000);
  const noLease = f.admin.takeoverReceiver({ agentId: a.agentId, reason: 'reset' }, f.trusted);
  assert.deepEqual(noLease, { agentId: a.agentId, changed: false, generation: null });
  f.db.prepare('INSERT INTO im_receiver_leases(agent_id,instance_id,generation,expires_at,credential_id) VALUES (?,?,?,?,?)')
    .run(a.agentId, randomUUID(), 2, 2000, a.credentialId);
  assert.deepEqual(f.admin.takeoverReceiver({ agentId: a.agentId, reason: 'fence' }, f.trusted),
    { agentId: a.agentId, changed: true, generation: 3 });
  assert.equal(f.db.prepare('SELECT generation,expires_at FROM im_receiver_leases').get().generation, 3);
  f.db.exec(`CREATE TRIGGER fail_audit BEFORE INSERT ON im_audit BEGIN SELECT RAISE(ABORT,'audit rejected'); END`);
  assert.throws(() => f.admin.setAgentStatus({ agentId: a.agentId, status: 'disabled', reason: 'test' }, f.trusted));
  assert.equal(f.db.prepare('SELECT status FROM im_agents WHERE agent_id=?').get(a.agentId).status, 'active');
  f.db.exec('DROP TRIGGER fail_audit');
  assert.throws(() => readImClock(f.db, f.clock), code('CLOCK_UNSAFE'));
  assert.throws(() => observeImClock(f.db, f.clock), code('CLOCK_UNSAFE'));
  assert.equal(f.admin.takeoverReceiver({ agentId: a.agentId, reason: 'still safe' }, f.trusted).changed, false);
  f.db.close();
});
