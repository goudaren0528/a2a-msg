import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync, mkdtempSync, chmodSync, rmSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {createImV2Journal} from '../src/im/v2/journal.js';
import {createImV2AttachmentStore} from '../src/im/v2/client-files.js';
import {createImV2Delivery} from '../src/im/v2/delivery.js';
import {ImV2Error} from '../src/im/v2/contracts.js';
import {JOURNAL_CHECKSUM} from '../src/im/v2/journal-schema.js';
import {U, H, identity, request, message, tombstone, operation, accepted, progress, lease, snapshot} from './fixtures/im-v2-journal/contract.js';
import {environment, observeDatabase} from './fixtures/im-v2-journal/native.js';
import {expireFixtureContent} from './fixtures/im-v2-core/helpers.js';
import {createCompositionFixture} from './fixtures/im-v2-composition/helpers.js';

// Independent public-storage contract tests. No client loop, fake wire authority,
// network listener, activation executor, or P6 expiry executor is implemented.
const S = U(9);
const error = code => e => e instanceof ImV2Error && e.code === code;
const encode = tuple => Buffer.from(JSON.stringify(tuple)).toString('base64url');
const ref = (m, seq) => ({seq, messageId:m.messageId});
const lookup = (seq, kind = 'message', streamEpoch = S) => ({streamEpoch, seq, kind});

function setup(t, {scope = identity(), limits = {}, clock = () => 1000} = {}) {
  const env = environment(t);
  let db, observer, journal;
  const open = () => {
    db = env.open(); observer = observeDatabase(db);
    journal = createImV2Journal({db:observer.db, limits, clock});
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.equal(db.prepare('PRAGMA synchronous').get().synchronous, 2);
  };
  open();
  const p = journal.bindIdentity(scope);
  return {env, p, scope, get db() { return db; }, get j() { return journal; },
    get observer() { return observer; }, reopen() { env.close(); open(); }};
}
function record(f, seq, {streamEpoch = S, overrides = {}, expiry = false} = {}) {
  const m = message(seq, {recipientAgentId:f.scope.agentId, ...overrides});
  if (expiry) f.j.recordExpiry(f.p, {streamEpoch, seq, tombstone:tombstone(m)});
  else f.j.recordMessage(f.p, {streamEpoch, seq, message:m, receipt:null});
  return ref(m, seq);
}
const prepare = (f, items, kind = 'ack', streamEpoch = S) => f.j.prepareBatch(f.p, {streamEpoch, kind, items});
function unchanged(f, fn, code) {
  const before = snapshot(f.db);
  assert.throws(fn, error(code));
  assert.deepEqual(snapshot(f.db), before, 'failed call must not repair or otherwise mutate storage');
  assert.equal(f.db.isTransaction, false);
}
function frozen(value) {
  if (value === null || typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) frozen(child);
}
function pageAll(f, state, limit = 2) {
  const items = [], seen = new Set();
  let after;
  do {
    const page = f.j.listBatches(f.p, {state, limit, ...(after === undefined ? {} : {after})});
    assert.ok(page.items.length <= limit);
    items.push(...page.items);
    after = page.nextCursor;
    if (after !== null) { assert.equal(seen.has(after), false); seen.add(after); }
    assert.ok(seen.size <= 30, 'test must terminate under a fixed page budget');
  } while (after !== null);
  return items;
}
function publicBatch(b, disposition, lastResponse = null, confirmedAt = null) {
  return {batchId:b.batch_id, partitionId:b.partition_id, streamEpoch:b.stream_epoch,
    kind:b.kind, state:confirmedAt === null ? 'pending' : 'confirmed', items:b.items,
    itemsHash:b.items_hash, createdAt:b.created_at, confirmedAt, lastResponse, ackDisposition:disposition};
}
const liveDisposition = items => ({replayAllowed:true, liveItems:items, expiryRequired:[], expiryConfirmed:[]});

test('client API: detached immutable message/expiry facts retain receipt metadata across prepare and reopen', t => {
  const f = setup(t), bytes = Buffer.from([0, 255, 128, 13, 10, 0, 195, 40]);
  const m = message(1, {attachment:{attachmentId:U(77), name:'bytes.bin', mime:'application/octet-stream', size:bytes.length, sha256:H(bytes)}});
  // Contract receipt fixture, not a claim that the Windows attachment store can
  // establish POSIX durability. The separate Unix test obtains a real receipt.
  const receipt = {relativeName:`${f.p}-${m.messageId}-${m.attachment.attachmentId}.bin`, sha256:H(bytes), size:bytes.length, durability:'durable'};
  f.j.recordMessage(f.p, {streamEpoch:S, seq:1, message:m, receipt});
  f.j.recordExpiry(f.p, {streamEpoch:S, seq:1, tombstone:tombstone(m)});
  prepare(f, [ref(m, 1)]); prepare(f, [ref(m, 1)], 'expiry');
  const {deliveredAt, readAt, ...fact} = m;
  assert.equal(deliveredAt, null); assert.equal(readAt, null);
  const expected = {partitionId:f.p, streamEpoch:S, seq:1, messageId:m.messageId, kind:'message',
    fact, factHash:H(JSON.stringify(fact)), attachmentReceipt:receipt, recordedAt:1000, serverConfirmed:false};
  const before = snapshot(f.db);
  f.reopen();
  const actual = f.j.getReceivedFact(f.p, lookup(1));
  assert.deepEqual(actual, expected); frozen(actual);
  assert.notEqual(actual, f.j.getReceivedFact(f.p, lookup(1)));
  assert.notEqual(actual.fact, f.j.getReceivedFact(f.p, lookup(1)).fact);
  assert.throws(() => { actual.fact.attachment.size++; }, TypeError);
  assert.throws(() => { actual.attachmentReceipt.relativeName = 'caller-change'; }, TypeError);
  assert.deepEqual(snapshot(f.db), before);
  const expiry = f.j.getReceivedFact(f.p, lookup(1, 'content_expired'));
  assert.deepEqual(expiry, {partitionId:f.p, streamEpoch:S, seq:1, messageId:m.messageId,
    kind:'content_expired', fact:tombstone(m), factHash:H(JSON.stringify(tombstone(m))),
    attachmentReceipt:null, recordedAt:1000, serverConfirmed:false});
  frozen(expiry);
  assert.equal(Object.hasOwn(actual.fact, 'deliveredAt'), false);
  assert.equal(Object.hasOwn(actual.fact, 'readAt'), false);
  assert.equal(f.j.getReceivedFact(f.p, lookup(2)), null);
  assert.equal(f.j.getReceivedFact(f.p, lookup(1, 'message', U(88))), null);
  unchanged(f, () => f.j.getReceivedFact('f'.repeat(64), lookup(1)), 'INVALID_REQUEST');
  f.j.markReconciliationRequired(f.p);
  assert.deepEqual(f.j.getReceivedFact(f.p, lookup(1)), expected, 'inactive reads remain available');
});

test('client API: real durable attachment-store receipt and exact binary survive journal reopen', {
  skip:process.platform === 'win32' ? 'production strict attachment-store durability requires native Unix' : false,
}, async t => {
  const f = setup(t), directory = mkdtempSync(join(homedir(), 'journal-api-attachment-'));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, {recursive:true, force:true}));
  const bytes = Buffer.from([0, 255, 128, 13, 10, 0, 195, 40, 254]);
  const m = message(1, {attachment:{attachmentId:U(77), name:'binary.dat', mime:null, size:bytes.length, sha256:H(bytes)}});
  const store = createImV2AttachmentStore({directory});
  const receipt = await store.save({partition:f.scope, messageId:m.messageId, attachment:m.attachment, download:async () => bytes});
  assert.deepEqual(receipt, {relativeName:`${f.p}-${m.messageId}-${U(77)}.bin`, sha256:H(bytes), size:bytes.length, durability:'durable'});
  f.j.recordMessage(f.p, {streamEpoch:S, seq:1, message:m, receipt});
  prepare(f, [ref(m, 1)]); f.reopen();
  const actual = f.j.getReceivedFact(f.p, lookup(1));
  assert.deepEqual(actual.attachmentReceipt, receipt);
  assert.deepEqual(actual.fact.attachment, m.attachment);
  assert.deepEqual(readFileSync(join(directory, actual.attachmentReceipt.relativeName)), bytes);
  rmSync(join(directory, receipt.relativeName));
  assert.deepEqual(f.j.getReceivedFact(f.p, lookup(1)), actual, 'reader reports durable recorded evidence, not current filesystem verification');
});

test('client API: batch keyset pages use equal-time ID ordering, limit+1 SQL and the existing composite index', t => {
  const f = setup(t), batches = [];
  for (let seq = 1; seq <= 5; seq++) batches.push(prepare(f, [record(f, seq)]));
  const expected = batches.toSorted((a,b) => a.batch_id.localeCompare(b.batch_id));
  const before = snapshot(f.db); f.observer.reset();
  f.observer.after(call => {
    if (/^SELECT\b/i.test(call.sql.trim()) && /FROM im_v2_client_batches/i.test(call.sql))
      assert.equal(f.db.isTransaction, true, 'page materialization holds one short native snapshot');
  });
  const first = f.j.listBatches(f.p, {state:'pending', limit:2});
  assert.deepEqual(first.items, expected.slice(0,2).map(b => publicBatch(b, liveDisposition(b.items))));
  // Either immutable or mutable-detached pages are safe; neither may alter DB.
  if (Object.isFrozen(first.items[0].items[0]))
    assert.throws(() => { first.items[0].items[0].seq = 999; }, TypeError);
  else first.items[0].items[0].seq = 999;
  assert.equal(first.nextCursor, encode([2,'batches',f.p,'pending',1000,expected[1].batch_id]));
  const second = f.j.listBatches(f.p, {state:'pending', limit:2, after:first.nextCursor});
  assert.deepEqual(second.items.map(x => x.batchId), expected.slice(2,4).map(x => x.batch_id));
  const third = f.j.listBatches(f.p, {state:'pending', limit:2, after:second.nextCursor});
  assert.deepEqual(third.items.map(x => x.batchId), [expected[4].batch_id]);
  assert.equal(third.nextCursor, null);
  const reads = f.observer.calls.filter(c => /^SELECT\b/i.test(c.sql.trim()) && /\bFROM\s+im_v2_client_batches\b/i.test(c.sql));
  assert.equal(reads.length, 3, 'one bounded production page query, never list-all then filter');
  for (const [index, call] of reads.entries()) {
    assert.match(call.sql, /partition_id\s*=\s*\?/i); assert.match(call.sql, /state\s*=\s*\?/i);
    assert.match(call.sql, /ORDER\s+BY\s+created_at\s*,\s*batch_id/i);
    assert.match(call.sql, /LIMIT\s+\?/i); assert.equal(call.args.at(-1), 3);
    assert.doesNotMatch(call.sql, /\bOFFSET\b/i);
    if (index > 0) assert.match(call.sql, /\(\s*created_at\s*,\s*batch_id\s*\)\s*>\s*\(\s*\?\s*,\s*\?\s*\)/i);
    const plan = f.db.prepare(`EXPLAIN QUERY PLAN ${call.sql}`).all(...call.args).map(r => r.detail).join('\n');
    assert.match(plan, /SEARCH .*im_v2_client_batches_pending/i);
    assert.doesNotMatch(plan, /SCAN im_v2_client_batches|TEMP B-TREE/i);
  }
  f.observer.after(undefined);
  assert.equal(f.db.isTransaction, false); assert.deepEqual(snapshot(f.db), before);
  assert.deepEqual(f.j.listPendingBatches(f.p), expected, 'old pending facade retains its original shape');
  assert.equal(JOURNAL_CHECKSUM, '301df7fed057182c71e5262d127208752acfb034bc122311469db082c8903469');
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name LIKE 'im_v2_client_%'").get().n, 6);
});

test('client API: default batch page is 20 and explicit maximum 100 is accepted', t => {
  const f = setup(t);
  for (let seq = 1; seq <= 21; seq++) prepare(f, [record(f, seq)]);
  const first = f.j.listBatches(f.p, {state:'pending'});
  assert.equal(first.items.length,20); assert.equal(typeof first.nextCursor,'string');
  const second = f.j.listBatches(f.p, {state:'pending',after:first.nextCursor});
  assert.equal(second.items.length,1); assert.equal(second.nextCursor,null);
  const all = f.j.listBatches(f.p, {state:'pending',limit:100});
  assert.equal(all.items.length,21); assert.equal(all.nextCursor,null);
  assert.deepEqual([...first.items,...second.items],all.items);
});

test('client API: batch cursor rejects wrong scope, type, noncanonical encoding and oversized input', t => {
  const f = setup(t); prepare(f, [record(f, 1)]); prepare(f, [record(f, 2)]);
  const valid = f.j.listBatches(f.p, {state:'pending', limit:1}).nextCursor;
  const tuple = JSON.parse(Buffer.from(valid, 'base64url'));
  const other = f.j.bindIdentity(identity({agentId:U(80)}));
  unchanged(f, () => f.j.listBatches(other, {state:'pending', after:valid}), 'INVALID_REQUEST');
  unchanged(f, () => f.j.listBatches(f.p, {state:'confirmed', after:valid}), 'INVALID_REQUEST');
  const malformed = ['', `${valid}=`, ` ${valid}`, `${valid}\n`, '+/', 'a'.repeat(513),
    Buffer.from('not JSON').toString('base64url'), Buffer.from(JSON.stringify(tuple, null, 1)).toString('base64url'),
    encode({...tuple}), encode(tuple.slice(0,5)), encode([...tuple,0]), encode([3,...tuple.slice(1)]),
    encode([2,'other',...tuple.slice(2)]), encode([...tuple.slice(0,4),'1000',tuple[5]]),
    encode([...tuple.slice(0,4),-1,tuple[5]]), encode([...tuple.slice(0,4),1000,'A'.repeat(64)]), null, 42];
  for (const after of malformed) unchanged(f, () => f.j.listBatches(f.p, {state:'pending', after}), 'INVALID_REQUEST');
  for (const opts of [{}, {state:'all'}, {state:'pending', limit:0}, {state:'pending', limit:101},
    {state:'pending', limit:1.5}, {state:'pending', limit:'2'}, {state:'pending', extra:true}])
    unchanged(f, () => f.j.listBatches(f.p, opts), 'INVALID_REQUEST');
  unchanged(f, () => f.j.listBatches('e'.repeat(64), {state:'pending'}), 'INVALID_REQUEST');
});

test('client API: confirmed server-progress response remains discoverable after restart', t => {
  const f = setup(t), b = prepare(f, [record(f, 1)]), response = progress(S, 1, 1);
  response.data.progressPending = true;
  f.j.confirmBatch(b.batch_id, response); f.reopen();
  assert.deepEqual(f.j.listBatches(f.p, {state:'pending'}), {items:[], nextCursor:null});
  const confirmed = f.j.listBatches(f.p, {state:'confirmed'});
  assert.deepEqual(confirmed, {items:[publicBatch(b, liveDisposition(b.items), response.data, 1000)], nextCursor:null});
  assert.equal(confirmed.items[0].lastResponse.progressPending, true);
  const beforeFacts = snapshot(f.db).im_v2_client_received;
  const result = f.j.confirmBatch(confirmed.items[0].batchId, progress(S, 1, 1));
  assert.equal(result.progressPending, false);
  assert.deepEqual(snapshot(f.db).im_v2_client_received, beforeFacts);
  f.j.markReconciliationRequired(f.p);
  assert.equal(f.j.listBatches(f.p, {state:'confirmed'}).items[0].batchId,b.batch_id);
});

test('client API: confirmed local-progress batch can resume bounded proofs after restart without duplicate facts', t => {
  const f = setup(t), items = Array.from({length:1002}, (_, i) => record(f, i + 1));
  for (let start = 1; start < items.length; start += 100)
    f.j.confirmBatch(prepare(f, items.slice(start, start + 100)).batch_id, progress(S));
  const head = prepare(f, [items[0]]), response = progress(S, 1002, 1002);
  const initial = f.j.confirmBatch(head.batch_id, response);
  assert.equal(initial.progressPending, true); assert.equal(initial.handledCursor, 1000);
  assert.equal(initial.ackedCursor, 1000);
  const facts = snapshot(f.db).im_v2_client_received;
  f.reopen();
  assert.deepEqual(f.j.listBatches(f.p, {state:'pending'}).items, []);
  const found = pageAll(f, 'confirmed', 2).find(b => b.batchId === head.batch_id);
  assert.ok(found, 'confirmed pages retain continuation evidence even without pending batches');
  assert.deepEqual(found.items, head.items); assert.equal(found.itemsHash, head.items_hash);
  f.observer.reset();
  const done = f.j.confirmBatch(found.batchId, response);
  assert.deepEqual([done.handledCursor, done.ackedCursor, done.progressPending], [1002,1002,false]);
  const reads = f.observer.calls.filter(c => /^SELECT\b/i.test(c.sql.trim()) && /FROM im_v2_client_received/i.test(c.sql) && /server_confirmed\s*=\s*1/i.test(c.sql));
  assert.ok(reads.length > 0 && reads.length <= 1002);
  for (const call of reads) { assert.match(call.sql, /seq\s*=\s*\?/i); assert.match(call.sql, /LIMIT\s+[12]/i); }
  assert.deepEqual(snapshot(f.db).im_v2_client_received, facts);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM im_v2_client_received').get().n, 1002);
  assert.equal(f.j.listBatches(f.p, {state:'confirmed', limit:100}).items.find(b => b.batchId === head.batch_id).confirmedAt, 1000);
});

test('client API: obsolete ACK pages do not starve later live work and expiry disposition is exact-stream scoped', t => {
  let now = 1000;
  const f = setup(t, {clock:() => now}), obsolete = [];
  for (let seq = 1; seq <= 5; seq++) {
    const item = record(f, seq); obsolete.push(prepare(f, [item]));
    record(f, seq, {expiry:true}); now++;
  }
  const last = record(f, 6), live = prepare(f, [last]);
  record(f, 6, {expiry:true, streamEpoch:U(10)});
  const otherPartition = f.j.bindIdentity(identity({centerOrigin:'https://other.test'}));
  f.j.recordExpiry(otherPartition, {streamEpoch:S, seq:6, tombstone:tombstone(message(6))});
  const listed = pageAll(f, 'pending', 2);
  assert.equal(listed.length, 6); assert.equal(listed.at(-1).batchId, live.batch_id);
  assert.deepEqual(listed.at(-1).ackDisposition, liveDisposition([last]));
  for (const b of obsolete) {
    const actual = listed.find(x => x.batchId === b.batch_id);
    assert.deepEqual(actual.ackDisposition, {replayAllowed:false, liveItems:[], expiryRequired:b.items, expiryConfirmed:[]});
  }
  const first = obsolete[0];
  const expiry = prepare(f, first.items, 'expiry');
  f.j.confirmBatch(expiry.batch_id, progress(S, 1, 0));
  const updated = pageAll(f, 'pending').find(x => x.batchId === first.batch_id);
  assert.deepEqual(updated.ackDisposition, {replayAllowed:false, liveItems:[], expiryRequired:[], expiryConfirmed:first.items});
  assert.equal(f.j.listBatches(f.p, {state:'confirmed'}).items[0].ackDisposition, null);
  assert.deepEqual(f.j.listPendingBatches(f.p).find(x => x.batch_id === first.batch_id), first);
});

test('client API/P3 composition: expired mixed ACK, real server receipt response loss and exact replay', t => {
  const core = createCompositionFixture(t), messages = core.messages, delivery = createImV2Delivery(core);
  assert.equal(core.native.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.equal(core.native.prepare('PRAGMA synchronous').get().synchronous, 2);
  assert.ok(core.native.prepare('PRAGMA database_list').all().some(r => r.name === 'main' && r.file));
  const sent = Array.from({length:3}, (_, i) => messages.send(core.principals[0], core.scope, {
    originEpoch:core.centerEpoch, clientMessageId:randomUUID(), conversationId:core.conversationId,
    recipientAgentId:core.b, text:`journal scheduling ${i + 1}`,
  }).message);
  const acquired = delivery.acquire(core.principals[1], core.scope, {instanceId:randomUUID(), requestId:randomUUID()});
  const base = {streamEpoch:acquired.streamEpoch, instanceId:acquired.instanceId, generation:acquired.generation};
  const f = setup(t, {scope:identity({agentId:core.b, centerEpoch:core.centerEpoch})});
  f.j.setLease(f.p, acquired);
  const initial = delivery.sync(core.principals[1], core.scope, {...base, after:0, limit:3});
  assert.deepEqual(initial.items.map(x => x.kind), ['message','message','message']);
  for (const item of initial.items) f.j.recordMessage(f.p, {streamEpoch:base.streamEpoch, seq:item.seq, message:item.message, receipt:null});
  const refs = sent.map((m, i) => ref(m, i + 1));
  const original = prepare(f, refs, 'ack', base.streamEpoch);
  // Lawful committed TEST-ONLY expiry fixture supplies maintenance proof. This
  // composes real P3 behavior, and is explicitly not a P6 executor or clock proof.
  expireFixtureContent(core, sent[1]);
  assert.throws(() => delivery.ack(core.principals[1], core.scope, {...base, items:refs}), error('EXPIRY_RECEIPT_REQUIRED'));
  assert.equal(core.native.prepare('SELECT count(*) AS n FROM im_deliveries WHERE acked_at IS NOT NULL').get().n, 0);
  const changed = delivery.sync(core.principals[1], core.scope, {...base, after:0, limit:3});
  assert.deepEqual(changed.items.map(x => x.kind), ['message','content_expired','message']);
  f.j.recordExpiry(f.p, {streamEpoch:base.streamEpoch, seq:2, tombstone:changed.items[1].tombstone});
  const disposition = {replayAllowed:false, liveItems:[refs[0],refs[2]], expiryRequired:[refs[1]], expiryConfirmed:[]};
  assert.deepEqual(f.j.listBatches(f.p, {state:'pending'}).items[0].ackDisposition, disposition);
  const expiry = prepare(f, [refs[1]], 'expiry', base.streamEpoch);
  const live = prepare(f, [refs[2],refs[0]], 'ack', base.streamEpoch);
  assert.deepEqual(live.items, [refs[0],refs[2]], 'replacement is a separate canonical sorted batch');
  assert.notEqual(live.batch_id, original.batch_id); assert.notEqual(expiry.batch_id, original.batch_id);
  const receiptArgs = {...base, items:expiry.items};
  const lost = delivery.recordExpiryReceipts(core.principals[1], core.scope, receiptArgs);
  assert.equal(lost.ackedThrough, 0);
  const serverReceipt = {...core.native.prepare('SELECT * FROM im_expiry_receipts WHERE recipient_id=? AND seq=2').get(core.b)};
  assert.ok(serverReceipt.message_id === refs[1].messageId);
  // Real server commit has happened; deliberately omit journal confirmation.
  f.reopen();
  let originalRead = pageAll(f, 'pending').find(x => x.batchId === original.batch_id);
  assert.deepEqual(originalRead.ackDisposition, disposition, 'local unconfirmed expiry still forbids obsolete ACK replay');
  assert.deepEqual(f.j.listPendingBatches(f.p).find(x => x.batch_id === original.batch_id), original);
  const exactReplay = delivery.recordExpiryReceipts(core.principals[1], core.scope, receiptArgs);
  assert.deepEqual(exactReplay, lost);
  assert.deepEqual({...core.native.prepare('SELECT * FROM im_expiry_receipts WHERE recipient_id=? AND seq=2').get(core.b)}, serverReceipt);
  f.j.confirmBatch(expiry.batch_id, {...core.scope, data:exactReplay});
  const ackResponse = delivery.ack(core.principals[1], core.scope, {...base, items:live.items});
  f.j.confirmBatch(live.batch_id, {...core.scope, data:ackResponse});
  originalRead = pageAll(f, 'pending').find(x => x.batchId === original.batch_id);
  assert.deepEqual(originalRead.ackDisposition, {...disposition, expiryRequired:[], expiryConfirmed:[refs[1]]});
  assert.deepEqual(f.j.listPendingBatches(f.p).find(x => x.batch_id === original.batch_id), original);
  assert.equal(f.j.getReceivedFact(f.p, lookup(2, 'message', base.streamEpoch)).serverConfirmed, false);
  assert.equal(f.j.getReceivedFact(f.p, lookup(2, 'content_expired', base.streamEpoch)).serverConfirmed, true);
  const state = f.j.getReceiver(f.p, base.streamEpoch);
  assert.deepEqual([state.handled_cursor,state.acked_cursor], [3,1]);
  assert.deepEqual({...core.native.prepare('SELECT acked_at,read_at FROM im_deliveries WHERE recipient_id=? AND seq=2').get(core.b)}, {acked_at:null,read_at:null});
  assert.equal(core.native.prepare('SELECT count(*) AS n FROM im_expiry_receipts').get().n, 1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM im_v2_client_received').get().n, 4);
});

test('client API: clearLease compares exact tuple, clears only three fields and never clears a newer fence', t => {
  const f = setup(t), tuple = {streamEpoch:S, instanceId:U(90), generation:1};
  unchanged(f, () => f.j.clearLease('f'.repeat(64), tuple), 'INVALID_REQUEST');
  unchanged(f, () => f.j.clearLease(f.p, tuple), 'INVALID_REQUEST');
  const b = prepare(f, [record(f, 1)]);
  f.j.confirmBatch(b.batch_id, progress(S, 7, 6));
  let before = snapshot(f.db);
  assert.deepEqual(f.j.clearLease(f.p, tuple), {cleared:false});
  assert.deepEqual(snapshot(f.db), before, 'all-null is absence, not a release-history assertion');
  f.j.setLease(f.p, lease(S));
  unchanged(f, () => f.j.clearLease(f.p, {...tuple, instanceId:U(91)}), 'STALE_FENCE');
  unchanged(f, () => f.j.clearLease(f.p, {...tuple, generation:2}), 'STALE_FENCE');
  before = snapshot(f.db);
  assert.deepEqual(f.j.clearLease(f.p, tuple), {cleared:true});
  const expected = structuredClone(before);
  Object.assign(expected.im_v2_client_receiver[0], {instance_id:null, generation:null, expires_at:null});
  assert.deepEqual(snapshot(f.db), expected);
  assert.deepEqual(f.j.clearLease(f.p, tuple), {cleared:false});
  f.j.setLease(f.p, lease(S, {instanceId:U(91), generation:2}));
  unchanged(f, () => f.j.clearLease(f.p, tuple), 'STALE_FENCE');
  f.j.markReconciliationRequired(f.p);
  unchanged(f, () => f.j.clearLease(f.p, {...tuple, instanceId:U(91), generation:2}), 'RECOVERY_RECONCILIATION_REQUIRED');
});

test('client API: clearLease post-native failure rolls back matching lease atomically', t => {
  const f = setup(t); record(f, 1); f.j.setLease(f.p, lease(S));
  let hit = 0;
  f.observer.after(call => {
    if (/^UPDATE\s+im_v2_client_receiver\b/i.test(call.sql)) { hit++; assert.equal(call.result.changes, 1); throw new Error('test-only post-clear fault'); }
  });
  unchanged(f, () => f.j.clearLease(f.p, {streamEpoch:S, instanceId:U(90), generation:1}), 'STORAGE_UNAVAILABLE');
  assert.equal(hit, 1);
});

for (const change of [{stableInstanceId:U(80)}, {centerEpoch:U(80)}, {stableInstanceId:U(80), centerEpoch:U(81)}])
  test(`client API: findOutgoing retains accepted evidence after ${Object.keys(change).join('+')} reconciliation/restart`, t => {
    const f = setup(t), r = request(), op = operation(r);
    f.j.stageOutgoing(f.p, r); f.j.markAccepted(f.p, op, accepted(r));
    assert.throws(() => f.j.bindIdentity(identity(change)), error('RECOVERY_RECONCILIATION_REQUIRED'));
    const query = {centerOrigin:f.scope.centerOrigin, agentId:f.scope.agentId, ...op};
    assert.equal(f.j.findOutgoing(query).partition.status, 'reconciliation_required');
    const next = f.j.reconcilePartition({oldPartitionId:f.p, newIdentity:identity(change), decisionRef:'independent-test-approved'});
    f.reopen();
    const found = f.j.findOutgoing(query);
    assert.deepEqual(found, {partition:{partitionId:f.p, ...f.scope, status:'archived'}, outgoing:f.j.getOutgoing(f.p, op)});
    frozen(found); assert.throws(() => { found.outgoing.request.text = 'changed'; }, TypeError);
    const before = snapshot(f.db);
    f.j.markAccepted(f.p, op, accepted(r)); assert.deepEqual(snapshot(f.db), before);
    f.j.markRemoteUnknown(f.p, op); f.j.markAccepted(f.p, op, accepted(r));
    const final = f.j.findOutgoing(query);
    assert.equal(final.outgoing.acceptance_state, 'accepted'); assert.equal(final.outgoing.reconciliation_state, 'remote_unknown');
    assert.equal(final.partition.status, 'archived'); assert.equal(f.j.getOutgoing(next, op), null);
    unchanged(f, () => f.j.markAccepted(f.p, op, accepted(r, {messageId:U(999)})), 'IDEMPOTENCY_CONFLICT');
    unchanged(f, () => f.j.stageOutgoing(f.p, r), 'RECOVERY_RECONCILIATION_REQUIRED');
    assert.equal(f.j.findOutgoing({...query, clientMessageId:U(999)}), null);
  });

test('client API: findOutgoing refuses two scoped matches and never searches other origins/agents', t => {
  const f = setup(t, {limits:{maxPartitions:8}}), r = request(), query = {centerOrigin:f.scope.centerOrigin, agentId:f.scope.agentId, ...operation(r)};
  const crossOrigin = f.j.bindIdentity(identity({centerOrigin:'https://elsewhere.test'}));
  const crossAgent = f.j.bindIdentity(identity({agentId:U(81)}));
  for (const p of [crossOrigin,crossAgent]) f.j.stageOutgoing(p, r);
  assert.equal(f.j.findOutgoing(query), null, 'same operation in another origin/agent is not evidence');
  f.j.stageOutgoing(f.p, r);
  assert.throws(() => f.j.bindIdentity(identity({stableInstanceId:U(80)})), error('RECOVERY_RECONCILIATION_REQUIRED'));
  const next = f.j.reconcilePartition({oldPartitionId:f.p, newIdentity:identity({stableInstanceId:U(80)}), decisionRef:'test-stable-change'});
  f.j.stageOutgoing(next, r);
  f.reopen(); f.observer.reset();
  unchanged(f, () => f.j.findOutgoing(query), 'IDEMPOTENCY_CONFLICT');
  const partitionReads = f.observer.calls.filter(c => /^SELECT\b/i.test(c.sql.trim()) && /FROM im_v2_client_partitions/i.test(c.sql));
  const searches = partitionReads.filter(c => /center_origin\s*=\s*\?/i.test(c.sql));
  assert.equal(searches.length, 1);
  const search = searches[0];
  assert.match(search.sql, /agent_id\s*=\s*\?/i); assert.match(search.sql, /LIMIT\s+\?/i);
  assert.ok(search.args.includes(9), 'maxPartitions + 1 bounds native candidate enumeration');
  const plan = f.db.prepare(`EXPLAIN QUERY PLAN ${search.sql}`).all(...search.args).map(r => r.detail).join('\n');
  assert.match(plan, /SEARCH .*im_v2_client_partitions.*INDEX/i); assert.doesNotMatch(plan, /SCAN im_v2_client_partitions/i);
  for (const c of partitionReads) assert.match(c.sql, /WHERE\s+(?:partition_id|center_origin)\s*=\s*\?/i);
  const outgoingReads = f.observer.calls.filter(c => /^SELECT\b/i.test(c.sql.trim()) && /FROM im_v2_client_outgoing/i.test(c.sql));
  assert.equal(outgoingReads.length, 2);
  for (const c of outgoingReads) {
    assert.match(c.sql, /partition_id\s*=\s*\?.*origin_epoch\s*=\s*\?.*client_message_id\s*=\s*\?/i);
    assert.ok([f.p,next].includes(c.args[0]));
    const pointPlan = f.db.prepare(`EXPLAIN QUERY PLAN ${c.sql}`).all(...c.args).map(row => row.detail).join('\n');
    assert.match(pointPlan, /SEARCH .*INDEX.*partition_id=\?.*origin_epoch=\?.*client_message_id=\?/i);
  }
});

test('client API: operation lookup accepts only canonical HTTPS origin and canonical UUIDs', t => {
  const f = setup(t), query = {centerOrigin:f.scope.centerOrigin, agentId:f.scope.agentId, ...operation(request())};
  assert.equal(f.j.findOutgoing(query), null);
  for (const centerOrigin of ['http://example.test','https://EXAMPLE.test','https://example.test/','https://user@example.test','https://example.test?q=1','https://example.test#x'])
    unchanged(f, () => f.j.findOutgoing({...query, centerOrigin}), 'INVALID_REQUEST');
  for (const key of ['agentId','originEpoch','clientMessageId']) {
    unchanged(f, () => f.j.findOutgoing({...query, [key]:U(0xabcdef).toUpperCase()}), 'INVALID_REQUEST');
    const missing = {...query}; delete missing[key];
    unchanged(f, () => f.j.findOutgoing(missing), 'INVALID_REQUEST');
  }
  unchanged(f, () => f.j.findOutgoing({...query, stableInstanceId:U(1)}), 'INVALID_REQUEST');
});

test('client API: historical pending operation can acquire exact accepted evidence after restart without reactivation', t => {
  const f = setup(t), r = request(), op = operation(r);
  f.j.stageOutgoing(f.p,r); f.j.markReconciliationRequired(f.p); f.reopen();
  const query = {centerOrigin:f.scope.centerOrigin,agentId:f.scope.agentId,...op};
  const found = f.j.findOutgoing(query);
  assert.equal(found.outgoing.acceptance_state,'pending');
  f.j.markRemoteUnknown(found.partition.partitionId,op);
  f.j.markAccepted(found.partition.partitionId,op,accepted(r));
  f.reopen();
  const final = f.j.findOutgoing(query);
  assert.equal(final.outgoing.acceptance_state,'accepted');
  assert.equal(final.outgoing.reconciliation_state,'remote_unknown');
  assert.equal(final.partition.status,'reconciliation_required');
  unchanged(f, () => f.j.requireActivePartition(final.partition.partitionId), 'RECOVERY_RECONCILIATION_REQUIRED');
  unchanged(f, () => f.j.markAccepted(f.p,op,accepted(r,{acceptedAt:501})), 'IDEMPOTENCY_CONFLICT');
});

test('client API: fact and clear-lease inputs reject malformed exact tuples before mutation', t => {
  const f = setup(t); record(f,1); f.j.setLease(f.p,lease(S));
  assert.ok(f.j.getReceivedFact(f.p,lookup(1)));
  for (const args of [{streamEpoch:S,seq:0,kind:'message'}, {streamEpoch:S,seq:1.5,kind:'message'},
    {streamEpoch:S,seq:1,kind:'ack'}, {streamEpoch:S,seq:1}, {...lookup(1),extra:1}, lookup(1,'message','invalid')])
    unchanged(f, () => f.j.getReceivedFact(f.p,args), 'INVALID_REQUEST');
  const tuple = {streamEpoch:S,instanceId:U(90),generation:1};
  for (const args of [{...tuple,generation:0}, {...tuple,generation:1.5}, {...tuple,instanceId:'invalid'},
    {...tuple,extra:1}, {streamEpoch:S,instanceId:U(90)}])
    unchanged(f, () => f.j.clearLease(f.p,args), 'INVALID_REQUEST');
});

const corruptions = {
  'items hash': f => f.db.prepare('UPDATE im_v2_client_batches SET items_hash=?').run('b'.repeat(64)),
  'coherent items but wrong batch identity': f => {
    const text = JSON.stringify([{seq:2,messageId:message(2).messageId}]);
    return f.db.prepare('UPDATE im_v2_client_batches SET items_json=?,items_hash=?').run(text,H(text));
  },
  'fact hash': f => f.db.prepare('UPDATE im_v2_client_received SET fact_hash=? WHERE seq=1').run('c'.repeat(64)),
  'coherent fact invalid JSON shape': f => f.db.prepare('UPDATE im_v2_client_received SET fact_json=?,fact_hash=? WHERE seq=1').run('{}',H('{}')),
  'coherent fact wrong recipient': f => {
    const row = f.db.prepare('SELECT fact_json FROM im_v2_client_received WHERE seq=1').get();
    const text = JSON.stringify({...JSON.parse(row.fact_json), recipientAgentId:U(777)});
    return f.db.prepare('UPDATE im_v2_client_received SET fact_json=?,fact_hash=? WHERE seq=1').run(text,H(text));
  },
  'coherent fact wrong message subject': f => {
    const row = f.db.prepare('SELECT fact_json FROM im_v2_client_received WHERE seq=1').get();
    const text = JSON.stringify({...JSON.parse(row.fact_json), messageId:U(777)});
    return f.db.prepare('UPDATE im_v2_client_received SET fact_json=?,fact_hash=? WHERE seq=1').run(text,H(text));
  },
  'receipt not permitted for attachment-free message': f => f.db.prepare('UPDATE im_v2_client_received SET attachment_receipt_json=? WHERE seq=1')
    .run(JSON.stringify({relativeName:'forged.bin',sha256:'a'.repeat(64),size:1,durability:'durable'})),
  'confirmed batch with unconfirmed fact': f => f.db.prepare('UPDATE im_v2_client_received SET server_confirmed=0 WHERE seq=1').run(),
  'response wrong stream': f => f.db.prepare('UPDATE im_v2_client_batches SET last_response_json=?').run(JSON.stringify(progress(U(88)).data)),
  'response malformed DTO': f => f.db.prepare('UPDATE im_v2_client_batches SET last_response_json=?').run(JSON.stringify({streamEpoch:S,handledThrough:1})),
  'response ACK above handled': f => f.db.prepare('UPDATE im_v2_client_batches SET last_response_json=?').run(JSON.stringify(progress(S,0,1).data)),
  'partition coherent type but wrong hash identity': f => f.db.prepare('UPDATE im_v2_client_partitions SET stable_instance_id=? WHERE partition_id=?').run(U(333),f.p),
};
for (const [name, corrupt] of Object.entries(corruptions)) test(`client API: already-open batch reader rejects ${name} without mutation`, t => {
  const f = setup(t), b = prepare(f, [record(f, 1)]); record(f, 2);
  f.j.confirmBatch(b.batch_id, progress(S,1,1));
  assert.equal(f.j.listBatches(f.p, {state:'confirmed'}).items.length, 1, 'prove lawful fixture before corruption');
  assert.equal(corrupt(f).changes, 1, 'native corruption must actually affect the intended row');
  unchanged(f, () => f.j.listBatches(f.p, {state:'confirmed'}), 'STORAGE_UNAVAILABLE');
  if (/^fact hash|^coherent fact|^receipt|^partition/.test(name))
    unchanged(f, () => f.j.getReceivedFact(f.p, lookup(1)), 'STORAGE_UNAVAILABLE');
});

test('client API: disposition rejects coherent-hash expiry subject mismatch instead of suppressing or authorizing ACK', t => {
  const f = setup(t), item = record(f, 1); record(f, 1, {expiry:true}); prepare(f, [item]);
  assert.equal(f.j.listBatches(f.p, {state:'pending'}).items[0].ackDisposition.replayAllowed, false);
  const text = JSON.stringify({...tombstone(message(1)), messageId:U(777)});
  assert.equal(f.db.prepare("UPDATE im_v2_client_received SET message_id=?,fact_json=?,fact_hash=? WHERE kind='content_expired'").run(U(777),text,H(text)).changes, 1);
  unchanged(f, () => f.j.listBatches(f.p, {state:'pending'}), 'STORAGE_UNAVAILABLE');
});

for (const corrupt of ['partition','outgoing']) test(`client API: findOutgoing validates ${corrupt} after construction`, t => {
  const f = setup(t), r = request(); f.j.stageOutgoing(f.p,r);
  const query = {centerOrigin:f.scope.centerOrigin,agentId:f.scope.agentId,...operation(r)};
  assert.ok(f.j.findOutgoing(query));
  const mutation = corrupt === 'partition'
    ? f.db.prepare('UPDATE im_v2_client_partitions SET stable_instance_id=?').run(U(77))
    : f.db.prepare('UPDATE im_v2_client_outgoing SET fingerprint=?').run('d'.repeat(64));
  assert.equal(mutation.changes,1);
  unchanged(f, () => f.j.findOutgoing(query), 'STORAGE_UNAVAILABLE');
});

test('client API: received attachment reader validates recorded receipt binding after construction', t => {
  const f = setup(t), m = message(1,{attachment:{attachmentId:U(77),name:'test.bin',mime:null,size:2,sha256:H(Buffer.from([0,255]))}});
  const receipt = {relativeName:`${f.p}-${m.messageId}-${U(77)}.bin`,sha256:m.attachment.sha256,size:2,durability:'durable'};
  f.j.recordMessage(f.p,{streamEpoch:S,seq:1,message:m,receipt});
  assert.deepEqual(f.j.getReceivedFact(f.p,lookup(1)).attachmentReceipt,receipt);
  const changed = f.db.prepare('UPDATE im_v2_client_received SET attachment_receipt_json=?').run(JSON.stringify({...receipt,size:3}));
  assert.equal(changed.changes,1);
  unchanged(f, () => f.j.getReceivedFact(f.p,lookup(1)), 'STORAGE_UNAVAILABLE');
});
