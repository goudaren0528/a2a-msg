import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createImV2Journal} from '../src/im/v2/journal.js';
import {ImV2Error, messageSchema} from '../src/im/v2/contracts.js';
import {createImJournal} from '../src/im/journal.js';
import {PROTOCOL, MAX, U, H, bytes, identity, partitionId, request, message, tombstone, operation, fingerprint, accepted, progress, lease, TABLES, PRIMARY_KEYS, INDEXES, DEFAULTS, charge, META_CHARGE, PARTITION_MAX_CHARGE, reserveCount, databaseCharge, snapshot} from './fixtures/im-v2-journal/contract.js';
import {environment, observeDatabase} from './fixtures/im-v2-journal/native.js';

const S = U(9);
const error = code => e => e instanceof ImV2Error && e.code === code;
const nativeConstraint = e => e.code === 'ERR_SQLITE_ERROR' && /constraint|NOT NULL|datatype mismatch/i.test(e.message);
function setup(t, options = {}) {
  const env = environment(t), db = env.open(), observer = observeDatabase(db);
  const journal = createImV2Journal({db:observer.db, clock:() => 1000, ...options});
  const p = journal.bindIdentity(identity());
  return {env, db, observer, journal, p};
}
function record(j, p, seq, kind = 'ack', streamEpoch = S, overrides = {}) {
  const m = message(seq, overrides);
  if (kind === 'ack') j.recordMessage(p, {streamEpoch, seq, message:m, receipt:null});
  else j.recordExpiry(p, {streamEpoch, seq, tombstone:tombstone(m)});
  return {seq, messageId:m.messageId};
}
const batch = (j, p, items, kind = 'ack', streamEpoch = S) => j.prepareBatch(p, {streamEpoch, kind, items});
const cursors = (j,p,s = S) => { const r = j.getReceiver(p,s); return [r.handled_cursor,r.acked_cursor]; };
function unchanged(db, fn, code) { const before = snapshot(db); assert.throws(fn,error(code)); assert.deepEqual(snapshot(db),before); }
function factRows(db) { return db.prepare('SELECT seq,kind,message_id,server_confirmed FROM im_v2_client_received ORDER BY seq,kind').all().map(r => ({...r})); }
function confirmGroups(j,p,items,kind = 'ack',response = progress(S)) {
  let last;
  for (let start = 0; start < items.length; start += 100) {
    last = batch(j,p,items.slice(start,start + 100),kind);
    j.confirmBatch(last.batch_id,response);
  }
  return last;
}

test('J1 exact ACK request succeeds with seq-1 gap and zero server watermarks', t => {
  const {db,journal:j,p} = setup(t);
  const two = record(j,p,2), three = record(j,p,3);
  const b = batch(j,p,[two]);
  const result = j.confirmBatch(b.batch_id,progress(S));
  assert.deepEqual(cursors(j,p),[0,0]);
  assert.equal(result.progressPending,false);
  assert.deepEqual(factRows(db),[
    {seq:2,kind:'message',message_id:two.messageId,server_confirmed:1},
    {seq:3,kind:'message',message_id:three.messageId,server_confirmed:0},
  ]);
});

test('J1 expiry-1 and ACK-2 are separate facts; server handled=2 ACK=0 confirms ACK-2', t => {
  const {db,journal:j,p} = setup(t);
  const one = record(j,p,1,'expiry'), two = record(j,p,2);
  j.confirmBatch(batch(j,p,[one],'expiry').batch_id,progress(S,1,0));
  const result = j.confirmBatch(batch(j,p,[two]).batch_id,progress(S,2,0));
  assert.deepEqual(cursors(j,p),[2,0]);
  assert.equal(result.serverAcked,0);
  assert.equal(result.progressPending,false);
  assert.deepEqual(factRows(db).map(r => [r.seq,r.kind,r.server_confirmed]),[[1,'content_expired',1],[2,'message',1]]);
  assert.equal(db.prepare("SELECT count(*) AS n FROM im_v2_client_received WHERE seq=1 AND kind='message'").get().n,0);
});

test('J1 bounded/stale server responses are observations, never proof for unrequested facts', t => {
  const {db,journal:j,p} = setup(t);
  const one = record(j,p,1), two = record(j,p,2), three = record(j,p,3);
  const pendingResponse = progress(S,0,0); pendingResponse.data.progressPending = true;
  const b = batch(j,p,[two]);
  j.confirmBatch(b.batch_id,pendingResponse);
  j.confirmBatch(b.batch_id,progress(S,5000,4000));
  const result = j.confirmBatch(b.batch_id,progress(S,0,0));
  assert.deepEqual(cursors(j,p),[0,0]);
  assert.deepEqual([result.serverHandled,result.serverAcked],[5000,4000]);
  assert.deepEqual(factRows(db).map(r => r.server_confirmed),[0,1,0]);
  j.confirmBatch(batch(j,p,[one]).batch_id,progress(S));
  assert.deepEqual(cursors(j,p),[2,2]);
  assert.equal(j.listPendingBatches(p).length,0);
  assert.equal(three.seq,3);
});

test('J1 wrong epoch, stream, strict DTO, and ACK>handled reject atomically', t => {
  const {db,journal:j,p} = setup(t), b = batch(j,p,[record(j,p,1)]);
  const responses = [progress(S,1,1,{centerEpoch:U(33)}),progress(U(99),1,1),progress(S,0,1),progress(S,1,1,{protocol:'a2a-msg.im.v1'}),
    {...progress(S),extra:true},progress(S,0,0,{data:{streamEpoch:S,handledThrough:0,ackedThrough:0}}),
    progress(S,0,0,{data:{streamEpoch:S,handledThrough:0,ackedThrough:0,progressPending:false,extra:1}}), progress(S,MAX + 1,0)];
  for (const response of responses) unchanged(db,() => j.confirmBatch(b.batch_id,response),'INVALID_REQUEST');
});

for (const kind of ['ack','expiry']) test(`J1 ${kind} response loss survives reopen and current lease; confirmed timestamp is immutable`, t => {
  const {env,db,journal:j,p} = setup(t);
  j.setLease(p,lease(S));
  const items = [record(j,p,1,kind),record(j,p,2,kind)], b = batch(j,p,items,kind);
  const original = {...db.prepare('SELECT * FROM im_v2_client_batches WHERE batch_id=?').get(b.batch_id)};
  env.close(); const nextDb = env.open();
  let now = 2000;
  const reopened = createImV2Journal({db:nextDb,clock:() => now});
  reopened.setLease(p,lease(S,{instanceId:U(91),generation:2,expiresAt:20000}));
  const pending = reopened.listPendingBatches(p);
  assert.equal(pending.length,1); assert.equal(pending[0].kind,kind); assert.deepEqual(pending[0].items,items);
  assert.equal(pending[0].items_hash,original.items_hash);
  reopened.confirmBatch(b.batch_id,progress(S));
  assert.deepEqual(cursors(reopened,p),[2,kind === 'ack' ? 2 : 0]);
  const confirmedAt = nextDb.prepare('SELECT confirmed_at FROM im_v2_client_batches').get().confirmed_at;
  now = 3000;
  reopened.confirmBatch(b.batch_id,progress(S,MAX,MAX));
  const saved = nextDb.prepare('SELECT confirmed_at,last_response_json FROM im_v2_client_batches').get();
  assert.equal(saved.confirmed_at,confirmedAt); assert.equal(confirmedAt,2000);
  assert.equal(JSON.parse(saved.last_response_json).handledThrough,MAX);
  assert.ok(bytes(saved.last_response_json) <= 4096);
  assert.equal(reopened.getReceiver(p,S).instance_id,U(91));
});

const corruptions = {
  'batch JSON': (db,b) => db.prepare('UPDATE im_v2_client_batches SET items_json=? WHERE batch_id=?').run(JSON.stringify([{seq:2,messageId:message(2).messageId}]),b.batch_id),
  'batch hash': (db,b) => db.prepare('UPDATE im_v2_client_batches SET items_hash=? WHERE batch_id=?').run('b'.repeat(64),b.batch_id),
  'batch kind': (db,b) => db.prepare("UPDATE im_v2_client_batches SET kind='expiry' WHERE batch_id=?").run(b.batch_id),
  'fact JSON': db => db.prepare('UPDATE im_v2_client_received SET fact_json=? WHERE seq=1').run(JSON.stringify({...message(1),text:'altered'})),
  'fact hash': db => db.prepare('UPDATE im_v2_client_received SET fact_hash=? WHERE seq=1').run('c'.repeat(64)),
  'fact receipt': db => db.prepare('UPDATE im_v2_client_received SET attachment_receipt_json=? WHERE seq=1').run(JSON.stringify({relativeName:'forged.bin',sha256:'a'.repeat(64),size:1,durability:'durable'})),
  'fact message': db => db.prepare('UPDATE im_v2_client_received SET message_id=? WHERE seq=1').run(U(333)),
  'fact kind': db => db.prepare("UPDATE im_v2_client_received SET kind='content_expired' WHERE seq=1").run(),
  'missing fact': db => db.prepare('DELETE FROM im_v2_client_received WHERE seq=1').run(),
};
for (const [name,tamper] of Object.entries(corruptions)) test(`J1 native persisted ${name} tamper rejects confirmation atomically`, t => {
  const {db,journal:j,p} = setup(t), b = batch(j,p,[record(j,p,1)]);
  assert.equal(tamper(db,b).changes,1,'tamper must actually succeed in native SQLite');
  unchanged(db,() => j.confirmBatch(b.batch_id,progress(S,1,1)),'STORAGE_UNAVAILABLE');
});

test('J1 successful native fact UPDATE with inaccurate changes count is rejected and rolled back', t => {
  const {db,observer,journal:j,p} = setup(t), b = batch(j,p,[record(j,p,1)]);
  let injected = 0;
  observer.after(call => {
    if (/^UPDATE\s+im_v2_client_received\b/i.test(call.sql)) { injected++; assert.equal(call.result.changes,1); return {...call.result,changes:0}; }
  });
  unchanged(db,() => j.confirmBatch(b.batch_id,progress(S,1,1)),'STORAGE_UNAVAILABLE');
  assert.equal(injected,1);
});

test('J2 independent shared 1000-seq budget sees ACK pending after handled reaches the 2000 tail', t => {
  let now = 1000;
  const {db,observer,journal:j,p} = setup(t,{clock:() => now});
  const acknowledgements = Array.from({length:2000},(_,i) => record(j,p,i + 1));
  const expiries = Array.from({length:1000},(_,i) => record(j,p,i + 1,'expiry'));
  confirmGroups(j,p,expiries,'expiry');
  assert.deepEqual(cursors(j,p),[1000,0]);
  confirmGroups(j,p,acknowledgements.slice(1,1000));
  confirmGroups(j,p,acknowledgements.slice(1001));
  assert.deepEqual(cursors(j,p),[1000,0]);
  const b = batch(j,p,[acknowledgements[0],acknowledgements[1000]]);
  function assertPhase(previous,current,calls) {
    assertPrefixReadsBounded(calls);
    const reads = calls.filter(call => /^SELECT\b/i.test(call.sql.trim()) && /\bFROM\s+im_v2_client_received\b/i.test(call.sql) && !/\bmessage_id\s*=\s*\?/i.test(call.sql));
    const charged = new Set(), all = new Set(), probes = [];
    for (const call of reads) {
      assert.match(call.sql,/\bseq\s*=\s*\?/i);
      const beforeSeq = call.sql.slice(0,call.sql.search(/\bseq\s*=\s*\?/i));
      const seq = call.args[(beforeSeq.match(/\?/g) ?? []).length];
      assert.ok(Number.isSafeInteger(seq)); all.add(seq);
      // LIMIT 2 reads validate/cache both kinds, including unfiltered cursor
      // boundaries. LIMIT 1 reads answer the two final pending questions.
      if (/\bLIMIT\s+1\s*$/i.test(call.sql)) probes.push(seq);
      else { assert.match(call.sql,/\bLIMIT\s+2\s*$/i); charged.add(seq); }
    }
    for (const cursor of previous.filter(cursor => cursor > 0)) assert.ok(charged.has(cursor),`boundary ${cursor} is checked and charged`);
    assert.ok(charged.size <= 1000,`boundary + forward reads used ${charged.size} distinct seqs`);
    assert.ok(probes.length <= 2,'at most two pending probes');
    assert.deepEqual(probes,[current.handledCursor + 1,current.ackedCursor + 1],'both pending questions are answered');
    assert.ok(all.size <= 1002,`including boundaries and pending probes: ${all.size} distinct seqs`);
    for (const [index,cursor,kind] of [[0,current.handledCursor,null],[1,current.ackedCursor,'message']]) {
      assert.ok(cursor >= previous[index] && cursor <= 2000);
      const proven = db.prepare(`SELECT count(DISTINCT seq) AS n FROM im_v2_client_received WHERE partition_id=? AND stream_epoch=? AND seq>? AND seq<=? AND server_confirmed=1 ${kind ? "AND kind='message'" : ''}`)
        .get(p,S,previous[index],cursor).n;
      assert.equal(proven,cursor - previous[index],'every crossed sequence has the appropriate confirmed fact');
    }
    assert.ok(current.ackedCursor <= current.handledCursor);
    assert.equal(current.progressPending,current.handledCursor < 2000 || current.ackedCursor < 2000,'complete confirmed suffixes independently determine pending');
    t.diagnostic(JSON.stringify({from:previous,to:[current.handledCursor,current.ackedCursor],pending:current.progressPending,charged:charged.size,probes,distinct:all.size}));
  }
  now = 2000;
  observer.reset();
  const result = j.confirmBatch(b.batch_id,progress(S,2000,2000));
  const chargedInitialBoundaries = new Set([1000,0].filter(cursor => cursor > 0)).size;
  assert.equal(result.handledCursor,1000 + (1000 - chargedInitialBoundaries),'the existing handled boundary consumes one shared budget slot');
  assert.equal(result.ackedCursor,0);
  assert.equal(result.progressPending,true,'ACK next proof must also be probed after shared budget exhaustion');
  assertPhase([1000,0],result,observer.calls);
  const firstConfirmed = snapshot(db);
  assert.equal(firstConfirmed.im_v2_client_batches.find(row => row.batch_id === b.batch_id).confirmed_at,2000);
  assert.ok(firstConfirmed.im_v2_client_received.every(row => row.server_confirmed === 1));
  let current = result, rounds = 0, sawAckOnlyPending = false;
  while (current.progressPending && rounds < 10) {
    const previous = [current.handledCursor,current.ackedCursor];
    now += 1000;
    observer.reset(); current = j.confirmBatch(b.batch_id,progress(S,2000,2000));
    assertPhase(previous,current,observer.calls); rounds++;
    if (current.handledCursor === 2000 && current.ackedCursor < 2000) {
      sawAckOnlyPending = true;
      assert.equal(current.progressPending,true,'handled is complete but ACK still has confirmed continuation');
    }
    const expected = structuredClone(firstConfirmed);
    const receiver = expected.im_v2_client_receiver.find(row => row.partition_id === p && row.stream_epoch === S);
    receiver.handled_cursor = current.handledCursor; receiver.acked_cursor = current.ackedCursor;
    assert.deepEqual(snapshot(db),expected,'continuation only advances local cursors: facts, batch identity, first confirmation time, responses and observations are unchanged');
  }
  assert.equal(sawAckOnlyPending,true,'retain the original ACK-only pending coverage after handled reaches the tail');
  assert.ok(rounds > 0 && rounds < 10);
  assert.deepEqual(cursors(j,p),[2000,2000]); assert.equal(current.progressPending,false);
  assert.equal(db.prepare('SELECT count(*) AS n FROM im_v2_client_received').get().n,3000);
});

function assertPrefixReadsBounded(calls) {
  // Count actual point-probe bound values, not wall time or implementation
  // function names. Batch integrity lookups do not filter confirmed proofs.
  const proofReads = calls.filter(c => /^SELECT\b/i.test(c.sql.trim()) && /\bFROM\s+im_v2_client_received\b/i.test(c.sql) && /\bserver_confirmed\s*=\s*(?:1|\?)/i.test(c.sql));
  assert.ok(proofReads.length > 0,'observe actual native prefix SQL');
  const seqs = [];
  for (const call of proofReads) {
    assert.match(call.sql,/\bseq\s*=\s*\?/i,'prefix reads must point-probe, not scan historical facts');
    assert.match(call.sql,/\bLIMIT\s+(?:[12]|\?)/i);
    const beforeSeq = call.sql.slice(0,call.sql.search(/\bseq\s*=\s*\?/i));
    const index = (beforeSeq.match(/\?/g) ?? []).length;
    assert.ok(Number.isSafeInteger(call.args[index])); seqs.push(call.args[index]);
  }
  assert.ok(new Set(seqs).size <= 1002,`distinct proof seqs ${new Set(seqs).size} exceed 1000 + two pending probes`);
  assert.ok(proofReads.length <= 1002,`shared cache should not reread each cursor: ${proofReads.length} reads`);
}

test('J2 expired-first is a permanent ACK barrier; replay handles >1000 proofs without inventing delivery', t => {
  const {observer,journal:j,p} = setup(t);
  const first = record(j,p,1,'expiry');
  const items = Array.from({length:1100},(_,i) => record(j,p,i + 2));
  confirmGroups(j,p,items);
  assert.deepEqual(cursors(j,p),[0,0]);
  const b = batch(j,p,[first],'expiry'); observer.reset();
  const result = j.confirmBatch(b.batch_id,progress(S,1101,0));
  assert.deepEqual(cursors(j,p),[1000,0]); assert.equal(result.progressPending,true); assertPrefixReadsBounded(observer.calls);
  const second = j.confirmBatch(b.batch_id,progress(S,1101,0));
  assert.deepEqual(cursors(j,p),[1101,0]); assert.equal(second.progressPending,false);
});

test('J2 same seq kinds coexist only for the same message; missing and unconfirmed facts block both cursors', t => {
  const {db,journal:j,p} = setup(t);
  const one = record(j,p,1), two = record(j,p,2), four = record(j,p,4);
  record(j,p,2,'expiry');
  unchanged(db,() => record(j,p,2,'expiry',S,{messageId:U(987)}),'IDEMPOTENCY_CONFLICT');
  unchanged(db,() => record(j,p,3,'expiry',S,{messageId:two.messageId}),'IDEMPOTENCY_CONFLICT');
  j.confirmBatch(batch(j,p,[two,four]).batch_id,progress(S,4,4));
  assert.deepEqual(cursors(j,p),[0,0]);
  j.confirmBatch(batch(j,p,[one]).batch_id,progress(S,4,4));
  assert.deepEqual(cursors(j,p),[2,2]);
  const before = snapshot(db); record(j,p,2,'expiry'); assert.deepEqual(snapshot(db),before);
});

test('J3 six-table structural manifest, four explicit indexes, NOT NULL PKs and scoped non-cascading FKs', t => {
  const {db} = setup(t);
  const objects = db.prepare("SELECT name,type,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
  assert.deepEqual(objects.map(r => r.name),[...Object.keys(TABLES),...Object.keys(INDEXES)].sort());
  for (const [table,columns] of Object.entries(TABLES)) {
    const actual = db.prepare(`PRAGMA table_info(${table})`).all();
    assert.deepEqual(actual.map(r => r.name),Object.keys(columns),`${table}: every contract column, no omitted billing fields`);
    assert.deepEqual(actual.filter(r => r.pk).sort((a,b) => a.pk - b.pk).map(r => r.name),PRIMARY_KEYS[table]);
    for (const column of actual) {
      assert.equal(column.type,/^(N|B)/.test(columns[column.name].type) ? 'INTEGER' : 'TEXT');
      assert.equal(column.notnull,columns[column.name].nullable ? 0 : 1,`${table}.${column.name} explicit nullability`);
    }
    const master = objects.find(r => r.name === table);
    assert.equal(master.type,'table'); assert.match(master.sql,new RegExp(`^CREATE TABLE ${table}\\b`));
    assert.doesNotMatch(master.sql,/ON\s+DELETE\s+CASCADE/i);
    for (const fk of db.prepare(`PRAGMA foreign_key_list(${table})`).all()) {
      assert.equal(fk.on_delete,'NO ACTION'); assert.equal(fk.on_update,'NO ACTION');
    }
  }
  for (const [name,spec] of Object.entries(INDEXES)) {
    const index = db.prepare(`PRAGMA index_list(${spec.table})`).all().find(r => r.name === name);
    assert.ok(index); assert.equal(index.unique,spec.unique); assert.equal(index.partial,spec.partial);
    assert.deepEqual(db.prepare(`PRAGMA index_info(${name})`).all().map(r => r.name),spec.columns);
    const master = objects.find(r => r.name === name);
    assert.equal(master.type,'index');
    if (spec.partial) assert.match(master.sql,/WHERE\s+status\s*=\s*'active'\s*$/i);
  }
  function hasFk(table,target,from,to) {
    const groups = Map.groupBy(db.prepare(`PRAGMA foreign_key_list(${table})`).all(),r => r.id);
    assert.ok([...groups.values()].some(rows => rows[0].table === target &&
      JSON.stringify(rows.sort((a,b) => a.seq - b.seq).map(r => r.from)) === JSON.stringify(from) &&
      JSON.stringify(rows.map(r => r.to)) === JSON.stringify(to)),`${table} scoped FK to ${target}`);
  }
  hasFk('im_v2_client_outgoing','im_v2_client_partitions',['partition_id'],['partition_id']);
  hasFk('im_v2_client_receiver','im_v2_client_partitions',['partition_id'],['partition_id']);
  hasFk('im_v2_client_partitions','im_v2_client_partitions',['predecessor_id'],['partition_id']);
  for (const table of ['im_v2_client_received','im_v2_client_batches']) hasFk(table,'im_v2_client_receiver',['partition_id','stream_epoch'],['partition_id','stream_epoch']);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.deepEqual({...db.prepare('SELECT singleton,version FROM im_v2_client_meta').get()},{singleton:1,version:2});
  assert.match(db.prepare('SELECT checksum FROM im_v2_client_meta').get().checksum,/^[0-9a-f]{64}$/);
});

function seedAll(j,p) {
  const r = request(); j.stageOutgoing(p,r); j.markAccepted(p,operation(r),accepted(r));
  j.setLease(p,lease(S)); const b = batch(j,p,[record(j,p,1)]); j.confirmBatch(b.batch_id,progress(S,1,1));
  return b;
}
function isolatedUpdate(db,table,column,value,shouldPass = false) {
  db.exec('SAVEPOINT contract_column');
  try {
    const run = () => db.prepare(`UPDATE ${table} SET ${column}=?`).run(value);
    if (shouldPass) assert.ok(run().changes > 0);
    else assert.throws(run,nativeConstraint,`${table}.${column} rejects ${typeof value}`);
  } finally { db.exec('ROLLBACK TO contract_column; RELEASE contract_column'); }
}

test('J3 native column CHECKs enforce U/H/N/B and nullable non-null types, not just facade validation', t => {
  const {db,journal:j,p} = setup(t); seedAll(j,p);
  // Isolate CHECK/type enforcement from FK failures that could mask a weak
  // UUID/hash CHECK (for example a 64-byte BLOB accepted by length/GLOB).
  db.exec('PRAGMA foreign_keys=OFF');
  try {
  for (const [table,columns] of Object.entries(TABLES)) for (const [column,spec] of Object.entries(columns)) {
    if (spec.type === 'U') for (const value of [U(0xabcdef).toUpperCase(),'x'.repeat(36),U(1).replace('-','_'),Buffer.from(U(1))]) isolatedUpdate(db,table,column,value);
    if (spec.type === 'H') for (const value of ['A'.repeat(64),'g'.repeat(64),'a'.repeat(63),Buffer.from('a'.repeat(64))]) isolatedUpdate(db,table,column,value);
    if (/^N/.test(spec.type)) for (const value of [-1,0.5,MAX + 1,Buffer.from('1')]) isolatedUpdate(db,table,column,value);
    if (spec.type === 'N+') isolatedUpdate(db,table,column,0);
    if (spec.type === 'B') for (const value of [-1,2,0.5,Buffer.from('1')]) isolatedUpdate(db,table,column,value);
    if (spec.type === 'R') for (const value of ['', 'a'.repeat(256),Buffer.from('decision')]) isolatedUpdate(db,table,column,value);
    if (spec.type === 'O') for (const value of [Buffer.from('https://example.test'),'x'.repeat(2049)]) isolatedUpdate(db,table,column,value);
    if (spec.type.startsWith('J')) for (const value of ['not-json',Buffer.from('{}')]) isolatedUpdate(db,table,column,value);
    if (spec.type === 'E') for (const value of ['unrecognized',Buffer.from('active')]) isolatedUpdate(db,table,column,value);
    if (!spec.nullable) isolatedUpdate(db,table,column,null);
  }
  // Full nullable integer capacity is reserved; legal maximal times remain SQL legal.
  isolatedUpdate(db,'im_v2_client_outgoing','accepted_at',MAX,true);
  isolatedUpdate(db,'im_v2_client_receiver','expires_at',MAX,true);
  isolatedUpdate(db,'im_v2_client_batches','confirmed_at',MAX,true);
  isolatedUpdate(db,'im_v2_client_received','server_confirmed',0,true);
  } finally { db.exec('PRAGMA foreign_keys=ON'); }
});

test('J3 JSON bounds count UTF-8 bytes at native SQLite boundaries', t => {
  const {db,journal:j,p} = setup(t); seedAll(j,p);
  for (const [table,column,max] of [
    ['im_v2_client_outgoing','payload_json',16777216], ['im_v2_client_received','fact_json',262144],
    ['im_v2_client_received','attachment_receipt_json',4096], ['im_v2_client_batches','items_json',16384], ['im_v2_client_batches','last_response_json',4096],
  ]) {
    const contentBytes = max - 2, text = '界'.repeat(Math.floor(contentBytes / 3)) + 'x'.repeat(contentBytes % 3);
    const exact = JSON.stringify(text); assert.equal(bytes(exact),max);
    isolatedUpdate(db,table,column,exact,true);
    isolatedUpdate(db,table,column,JSON.stringify(text + 'x'));
  }
});

test('J3 identity hashes all four fields; origins and decision refs are canonical API inputs', t => {
  const {db,journal:j,p} = setup(t);
  assert.equal(p,partitionId(identity()));
  for (const centerOrigin of ['https://EXAMPLE.test','https://example.test/','http://example.test','https://user@example.test','https://example.test?q=1','https://example.test/#x'])
    unchanged(db,() => j.bindIdentity(identity({centerOrigin})),'INVALID_REQUEST');
  assert.throws(() => j.bindIdentity(identity({stableInstanceId:U(123)})),error('RECOVERY_RECONCILIATION_REQUIRED'));
  for (const decisionRef of ['', 'x'.repeat(256),'line\nfeed','nul\0value','del\x7fvalue'])
    unchanged(db,() => j.reconcilePartition({oldPartitionId:p,newIdentity:identity({stableInstanceId:U(123)}),decisionRef}),'INVALID_REQUEST');
  const next = j.reconcilePartition({oldPartitionId:p,newIdentity:identity({stableInstanceId:U(123)}),decisionRef:'界'.repeat(255)});
  assert.equal(next,partitionId(identity({stableInstanceId:U(123)})));
  assert.notEqual(next,p);
  const independent = j.bindIdentity(identity({centerOrigin:'https://other.test',agentId:U(222)}));
  assert.equal(independent,partitionId(identity({centerOrigin:'https://other.test',agentId:U(222)})));
});

test('J3 outgoing payload/hash operation binding and detached public values are independent', t => {
  const {db,journal:j,p} = setup(t), r = request({text:'跨界🙂'});
  const staged = j.stageOutgoing(p,r);
  assert.equal(staged.fingerprint,fingerprint(r));
  staged.request.text = 'caller mutation';
  assert.equal(j.getOutgoing(p,operation(r)).request.text,r.text);
  unchanged(db,() => j.stageOutgoing(p,{...r,text:'different'}),'IDEMPOTENCY_CONFLICT');
  assert.equal(db.prepare('SELECT source_protocol FROM im_v2_client_outgoing').get().source_protocol,PROTOCOL);
  const stored = db.prepare('SELECT payload_json FROM im_v2_client_outgoing').get().payload_json;
  assert.equal(JSON.parse(stored).clientMessageId,r.clientMessageId);
});

const semanticCorruptions = {
  'partition hash': db => { db.exec('PRAGMA foreign_keys=OFF'); db.prepare('UPDATE im_v2_client_partitions SET partition_id=?').run('d'.repeat(64)); db.exec('PRAGMA foreign_keys=ON'); },
  'noncanonical origin': db => db.prepare('UPDATE im_v2_client_partitions SET center_origin=?').run('https://EXAMPLE.test/'),
  'fingerprint': db => db.prepare('UPDATE im_v2_client_outgoing SET fingerprint=?').run('d'.repeat(64)),
  'operation binding': db => db.prepare('UPDATE im_v2_client_outgoing SET client_message_id=?').run(U(234)),
  'payload shape': db => db.prepare("UPDATE im_v2_client_outgoing SET payload_json='{}'").run(),
  'fact shape': db => db.prepare("UPDATE im_v2_client_received SET fact_json='{}'").run(),
  'fact hash': db => db.prepare('UPDATE im_v2_client_received SET fact_hash=?').run('d'.repeat(64)),
  'batch shape': db => db.prepare("UPDATE im_v2_client_batches SET items_json='{}'").run(),
  'batch hash': db => db.prepare('UPDATE im_v2_client_batches SET items_hash=?').run('d'.repeat(64)),
  'missing FK parent': db => { db.exec('PRAGMA foreign_keys=OFF'); db.prepare('DELETE FROM im_v2_client_partitions').run(); db.exec('PRAGMA foreign_keys=ON'); },
  'cursor crossing missing proof': db => db.prepare('UPDATE im_v2_client_receiver SET handled_cursor=2,acked_cursor=2').run(),
  'cursor crossing unconfirmed proof': db => db.prepare('UPDATE im_v2_client_received SET server_confirmed=0').run(),
};
for (const [name,corrupt] of Object.entries(semanticCorruptions)) test(`J3 constructor rejects persisted ${name} without repair`, t => {
  const {env,db,journal:j,p} = setup(t); seedAll(j,p); corrupt(db);
  const before = snapshot(db); env.close();
  const fileHash = H(readFileSync(env.file)), reopened = env.open();
  assert.throws(() => createImV2Journal({db:reopened}),error('STORAGE_UNAVAILABLE'));
  assert.deepEqual(snapshot(reopened),before); env.close(); assert.equal(H(readFileSync(env.file)),fileHash);
});

test('J3 valid lagging cursors survive reopen; ACK cursor cannot use expiry proof', t => {
  const {env,db,journal:j,p} = setup(t);
  const expiry = record(j,p,1,'expiry'); j.confirmBatch(batch(j,p,[expiry],'expiry').batch_id,progress(S,1,0));
  db.prepare('UPDATE im_v2_client_receiver SET handled_cursor=0').run();
  env.close(); let reopened = createImV2Journal({db:env.open()});
  assert.deepEqual(cursors(reopened,p),[0,0]);
  env.db.prepare('UPDATE im_v2_client_receiver SET handled_cursor=1,acked_cursor=1').run();
  env.close();
  assert.throws(() => createImV2Journal({db:env.open()}),error('STORAGE_UNAVAILABLE'));
});

for (const [name,ddl] of Object.entries({
  'center schema':'CREATE TABLE im_schema(version INTEGER NOT NULL PRIMARY KEY,migration_checksum TEXT NOT NULL)',
  'partial journal':'CREATE TABLE im_v2_client_meta(singleton INTEGER NOT NULL PRIMARY KEY,version INTEGER,checksum TEXT)',
  'unknown schema':'CREATE TABLE unrelated(value TEXT)',
})) test(`J3 constructor refuses ${name} and leaves file bytes unchanged`, t => {
  const env = environment(t); env.open().exec(ddl); env.close();
  const before = H(readFileSync(env.file));
  assert.throws(() => createImV2Journal({db:env.open()}),error('STORAGE_UNAVAILABLE'));
  env.close(); assert.equal(H(readFileSync(env.file)),before);
});

test('J3 real old-v1 journal is not imported or altered, and unknown view/trigger/index are refused', t => {
  const env = environment(t); createImJournal({db:env.open(),centerId:'https://example.test',agentId:U(2)}); env.close();
  const before = H(readFileSync(env.file));
  assert.throws(() => createImV2Journal({db:env.open()}),error('STORAGE_UNAVAILABLE'));
  env.close(); assert.equal(H(readFileSync(env.file)),before);
  for (const ddl of ['CREATE VIEW stray AS SELECT 1', 'CREATE INDEX stray ON im_v2_client_partitions(status)',
    'CREATE TRIGGER stray AFTER INSERT ON im_v2_client_outgoing BEGIN SELECT 1; END']) {
    const other = environment(t), db = other.open(); createImV2Journal({db}); db.exec(ddl);
    assert.throws(() => createImV2Journal({db}),error('STORAGE_UNAVAILABLE'));
  }
});

test('J3 constructor requires file/FK ON/FULL or EXTRA; initialization and mutations own their transaction', t => {
  const memory = new DatabaseSync(':memory:'); t.after(() => memory.close());
  memory.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
  assert.throws(() => createImV2Journal({db:memory}),error('STORAGE_UNAVAILABLE'));
  for (const pragma of ['PRAGMA foreign_keys=OFF','PRAGMA synchronous=NORMAL']) {
    const env = environment(t), db = env.open(); db.exec(pragma);
    assert.throws(() => createImV2Journal({db}),error('STORAGE_UNAVAILABLE'));
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'im_v2_%'").get().n,0);
  }
  const env = environment(t), db = env.open(); db.exec('BEGIN IMMEDIATE');
  assert.throws(() => createImV2Journal({db}),error('STORAGE_UNAVAILABLE'));
  assert.equal(db.isTransaction,true); db.exec('ROLLBACK');
  assert.equal(db.prepare('SELECT count(*) AS n FROM sqlite_master').get().n,0);
  db.exec('PRAGMA synchronous=EXTRA'); const j = createImV2Journal({db}), p = j.bindIdentity(identity());
  db.exec('BEGIN IMMEDIATE');
  assert.throws(() => j.stageOutgoing(p,request()),error('STORAGE_UNAVAILABLE'));
  assert.equal(db.isTransaction,true); db.exec('ROLLBACK'); assert.equal(j.listPendingOutgoing(p).length,0);
});

test('J3 clock callback must synchronously return a safe integer and failures leave no partial operation', t => {
  const {db,p} = setup(t);
  for (const clock of [() => Promise.resolve(1000),() => -1,() => MAX + 1,() => { throw new Error('synthetic clock fault'); }]) {
    const j = createImV2Journal({db,clock});
    unchanged(db,() => j.stageOutgoing(p,request()),'CLOCK_UNSAFE');
  }
});

test('J4 oracle covers every column with independent fixed/variable reserved charges', () => {
  assert.equal(META_CHARGE,144); assert.equal(PARTITION_MAX_CHARGE,3399);
  assert.equal(charge('im_v2_client_meta',{}),META_CHARGE);
  assert.equal(charge('im_v2_client_partitions',{center_origin:'x'.repeat(2048)}),PARTITION_MAX_CHARGE);
  assert.equal(charge('im_v2_client_receiver',{}),248);
  assert.equal(charge('im_v2_client_outgoing',{payload_json:null}),351);
  assert.equal(charge('im_v2_client_received',{fact_json:'界',attachment_receipt_json:null}),306);
  assert.equal(charge('im_v2_client_batches',{items_json:'[]',last_response_json:null}),4421);
  assert.equal(reserveCount(32,DEFAULTS.maxLogicalBytes),4);
  assert.equal(reserveCount(1,DEFAULTS.maxLogicalBytes),0);
  assert.equal(reserveCount(2,META_CHARGE + 2 * PARTITION_MAX_CHARGE),1);
  assert.equal(reserveCount(2,META_CHARGE + 2 * PARTITION_MAX_CHARGE - 1),0);
});

test('J4 defaults are maxima and options only lower positive safe-integer bounds', t => {
  for (const [key,max] of Object.entries(DEFAULTS)) for (const value of [max + 1,0,-1,1.5,Infinity,'1']) {
    const env = environment(t), db = env.open();
    assert.throws(() => createImV2Journal({db,limits:{[key]:value}}),error('INVALID_REQUEST'));
    assert.equal(db.prepare('SELECT count(*) AS n FROM sqlite_master').get().n,0);
  }
  const env = environment(t), db = env.open();
  assert.throws(() => createImV2Journal({db,limits:{unknownLimit:1}}),error('INVALID_REQUEST'));
});

test('J4 tiny byte ceilings reject initialization atomically with no IM objects', t => {
  for (const maxLogicalBytes of [1,META_CHARGE - 1]) {
    const env = environment(t), db = env.open();
    assert.throws(() => createImV2Journal({db,limits:{maxPartitions:1,maxLogicalBytes}}),error('CAPACITY_EXHAUSTED'));
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'im_v2_%'").get().n,0);
  }
});

// Boundaries are computed by the independent billing oracle over real, coherent
// seed records. They never call private accounting or use an implementation hash.
for (const kind of ['ack','expiry']) test(`J4 exact B accepts combined receiver + ${kind} fact; B-1 rejects both atomically`, t => {
  const probe = setup(t,{limits:{maxPartitions:1}});
  record(probe.journal,probe.p,1,kind,S,{text:'界🙂界'});
  const ceiling = databaseCharge(probe.db), expected = snapshot(probe.db);
  for (const delta of [0,-1]) {
    const {db,journal:j,p} = setup(t,{limits:{maxPartitions:1,maxLogicalBytes:ceiling + delta}});
    assert.equal(j.getReceiver(p,S),null);
    if (delta === 0) {
      record(j,p,1,kind,S,{text:'界🙂界'});
      assert.deepEqual(snapshot(db),expected); assert.equal(databaseCharge(db),ceiling);
      const before = snapshot(db); record(j,p,1,kind,S,{text:'界🙂界'}); assert.deepEqual(snapshot(db),before);
    } else {
      unchanged(db,() => record(j,p,1,kind,S,{text:'界🙂界'}),'CAPACITY_EXHAUSTED');
      assert.equal(j.getReceiver(p,S),null);
    }
  }
});

test('J4 exact B batch reservation includes full nullable response; B-1 fails without overshoot', t => {
  const probe = setup(t,{limits:{maxPartitions:1}});
  const item = record(probe.journal,probe.p,1); batch(probe.journal,probe.p,[item]);
  const ceiling = databaseCharge(probe.db);
  for (const delta of [0,-1]) {
    const {db,journal:j,p} = setup(t,{limits:{maxPartitions:1,maxLogicalBytes:ceiling + delta}});
    const ref = record(j,p,1);
    if (delta === 0) {
      const b = batch(j,p,[ref]); assert.equal(databaseCharge(db),ceiling);
      const before = snapshot(db); assert.equal(batch(j,p,[ref]).batch_id,b.batch_id); assert.deepEqual(snapshot(db),before);
      j.confirmBatch(b.batch_id,progress(S,MAX,MAX));
      assert.equal(databaseCharge(db),ceiling); assert.deepEqual(cursors(j,p),[1,1]);
    } else unchanged(db,() => batch(j,p,[ref]),'CAPACITY_EXHAUSTED');
  }
});

test('J4 exact B outgoing uses UTF-8 payload bytes rather than JS string length', t => {
  const r = request({text:'界🙂'.repeat(17)}), probe = setup(t,{limits:{maxPartitions:1}});
  probe.journal.stageOutgoing(probe.p,r); const ceiling = databaseCharge(probe.db);
  const stored = probe.db.prepare('SELECT payload_json FROM im_v2_client_outgoing').get().payload_json;
  assert.ok(bytes(stored) > stored.length);
  for (const delta of [0,-1]) {
    const {db,journal:j,p} = setup(t,{limits:{maxPartitions:1,maxLogicalBytes:ceiling + delta}});
    if (delta === 0) {
      j.stageOutgoing(p,r); assert.equal(databaseCharge(db),ceiling);
      const before = snapshot(db); j.stageOutgoing(p,r); assert.deepEqual(snapshot(db),before);
    } else unchanged(db,() => j.stageOutgoing(p,r),'CAPACITY_EXHAUSTED');
  }
});

test('J4 all six tables billed: full quota still permits prepaid evidence, lease, freeze and confirmation', t => {
  const r = request(), probe = setup(t,{limits:{maxPartitions:1}});
  probe.journal.stageOutgoing(probe.p,r); const item = record(probe.journal,probe.p,1); batch(probe.journal,probe.p,[item]);
  const ceiling = databaseCharge(probe.db);
  const {db,journal:j,p} = setup(t,{limits:{maxPartitions:1,maxLogicalBytes:ceiling}});
  j.stageOutgoing(p,r); const b = batch(j,p,[record(j,p,1)]);
  assert.equal(databaseCharge(db),ceiling);
  j.setLease(p,lease(S,{generation:MAX,expiresAt:MAX})); assert.equal(databaseCharge(db),ceiling);
  j.markAccepted(p,operation(r),accepted(r,{acceptedAt:MAX})); assert.equal(databaseCharge(db),ceiling);
  j.markRemoteUnknown(p,operation(r)); assert.equal(databaseCharge(db),ceiling);
  j.confirmBatch(b.batch_id,progress(S)); assert.equal(databaseCharge(db),ceiling);
  j.confirmBatch(b.batch_id,progress(S,MAX,MAX)); assert.equal(databaseCharge(db),ceiling);
  unchanged(db,() => j.stageOutgoing(p,request({clientMessageId:U(88)})),'CAPACITY_EXHAUSTED');
  j.markReconciliationRequired(p); assert.equal(databaseCharge(db),ceiling);
  assert.equal(j.markAccepted(p,operation(r),accepted(r,{acceptedAt:MAX})).acceptance_state,'accepted');
  assert.equal(databaseCharge(db),ceiling);
});

test('J4 outgoing/fact/batch/receiver row limits are independent and exact repeats do not charge', t => {
  const {db,journal:j,p} = setup(t,{limits:{maxPartitions:1,maxOutgoing:1,maxReceivedFacts:2,maxBatches:1}});
  const r = request(); j.stageOutgoing(p,r); j.stageOutgoing(p,r);
  unchanged(db,() => j.stageOutgoing(p,request({clientMessageId:U(88)})),'CAPACITY_EXHAUSTED');
  const one = record(j,p,1); record(j,p,1,'expiry');
  const b = batch(j,p,[one]); assert.equal(batch(j,p,[one]).batch_id,b.batch_id);
  unchanged(db,() => batch(j,p,[one],'expiry'),'CAPACITY_EXHAUSTED');
  unchanged(db,() => record(j,p,2),'CAPACITY_EXHAUSTED');
  j.setLease(p,lease(U(10))); // Two receiver rows independently allowed with two facts.
  unchanged(db,() => j.setLease(p,lease(U(11))),'CAPACITY_EXHAUSTED');
  j.setLease(p,lease(U(10),{generation:2}));
  assert.equal(db.prepare('SELECT count(*) AS n FROM im_v2_client_receiver').get().n,2);
  assert.equal(db.prepare('SELECT count(*) AS n FROM im_v2_client_received').get().n,2);
});

test('J4 receiver limit is enforced even when there are zero facts', t => {
  const {db,journal:j,p} = setup(t,{limits:{maxReceivedFacts:1}});
  j.setLease(p,lease(S));
  unchanged(db,() => j.setLease(p,lease(U(10))),'CAPACITY_EXHAUSTED');
  assert.equal(db.prepare('SELECT count(*) AS n FROM im_v2_client_received').get().n,0);
});

test('J4 default four control slots cannot be consumed by ordinary primary partitions', t => {
  const {db,journal:j,p} = setup(t);
  for (let i = 1; i < 28; i++) j.bindIdentity(identity({agentId:U(500 + i)}));
  assert.equal(db.prepare('SELECT count(*) AS n FROM im_v2_client_partitions').get().n,28);
  unchanged(db,() => j.bindIdentity(identity({agentId:U(999)})),'CAPACITY_EXHAUSTED');
  let old = p;
  for (let i = 0; i < 4; i++) {
    const nextIdentity = identity({centerEpoch:U(40 + i)});
    assert.throws(() => j.bindIdentity(nextIdentity),error('RECOVERY_RECONCILIATION_REQUIRED'));
    const decision = {oldPartitionId:old,newIdentity:nextIdentity,decisionRef:`manual-${i}`};
    old = j.reconcilePartition(decision);
    const before = snapshot(db), billed = databaseCharge(db);
    assert.equal(j.reconcilePartition(decision),old); assert.deepEqual(snapshot(db),before); assert.equal(databaseCharge(db),billed);
    unchanged(db,() => j.reconcilePartition({...decision,decisionRef:'different-decision'}),'RECOVERY_RECONCILIATION_REQUIRED');
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM im_v2_client_partitions').get().n,32);
  assert.throws(() => j.bindIdentity(identity({centerEpoch:U(50)})),error('RECOVERY_RECONCILIATION_REQUIRED'));
  assert.equal(db.prepare('SELECT status FROM im_v2_client_partitions WHERE partition_id=?').get(old).status,'reconciliation_required');
  unchanged(db,() => j.reconcilePartition({oldPartitionId:old,newIdentity:identity({centerEpoch:U(50)}),decisionRef:'fifth-control'}),'CAPACITY_EXHAUSTED');
  assert.equal(db.prepare('SELECT count(*) AS n FROM im_v2_client_partitions WHERE predecessor_id IS NULL').get().n,28);
  assert.equal(db.prepare('SELECT count(*) AS n FROM im_v2_client_partitions WHERE predecessor_id IS NOT NULL').get().n,4);
});

test('J4 P=1 has C=0: primary works, mismatch stop persists, reconciliation cannot reclaim old slot', t => {
  const {env,db,journal:j,p} = setup(t,{limits:{maxPartitions:1}}), r = request();
  j.stageOutgoing(p,r);
  assert.throws(() => j.bindIdentity(identity({centerEpoch:U(88)})),error('RECOVERY_RECONCILIATION_REQUIRED'));
  unchanged(db,() => j.reconcilePartition({oldPartitionId:p,newIdentity:identity({centerEpoch:U(88)}),decisionRef:'manual'}),'CAPACITY_EXHAUSTED');
  assert.equal(j.markRemoteUnknown(p,operation(r)).reconciliation_state,'remote_unknown');
  assert.equal(j.markAccepted(p,operation(r),accepted(r)).acceptance_state,'accepted');
  env.close(); const reopened = createImV2Journal({db:env.open(),limits:{maxPartitions:1}});
  assert.throws(() => reopened.requireActivePartition(p),error('RECOVERY_RECONCILIATION_REQUIRED'));
  assert.equal(reopened.getOutgoing(p,operation(r)).acceptance_state,'accepted');
  assert.equal(reopened.getOutgoing(p,operation(r)).reconciliation_state,'remote_unknown');
  assert.equal(env.db.prepare('SELECT count(*) AS n FROM im_v2_client_partitions').get().n,1);
});

test('J4 reserve slots derive from P and B, including one byte below the C=1 threshold', t => {
  const threshold = META_CHARGE + 2 * PARTITION_MAX_CHARGE;
  for (const ceiling of [threshold - 1,threshold]) {
    const {db,journal:j,p} = setup(t,{limits:{maxPartitions:2,maxLogicalBytes:ceiling}});
    const C = reserveCount(2,ceiling); assert.equal(C,ceiling === threshold ? 1 : 0);
    if (C === 0) {
      j.bindIdentity(identity({agentId:U(80)}));
      assert.equal(db.prepare('SELECT count(*) AS n FROM im_v2_client_partitions').get().n,2);
    } else {
      unchanged(db,() => j.bindIdentity(identity({agentId:U(80)})),'CAPACITY_EXHAUSTED');
      assert.throws(() => j.bindIdentity(identity({centerEpoch:U(80)})),error('RECOVERY_RECONCILIATION_REQUIRED'));
      j.reconcilePartition({oldPartitionId:p,newIdentity:identity({centerEpoch:U(80)}),decisionRef:'manual'});
    }
    assert.ok(databaseCharge(db) <= ceiling);
  }
});

test('J4 ordinary byte growth cannot consume an unfilled control reserve; reconcile spends exactly one reserve', t => {
  const ceiling = META_CHARGE + 2 * PARTITION_MAX_CHARGE;
  const {db,journal:j,p} = setup(t,{limits:{maxPartitions:2,maxLogicalBytes:ceiling}});
  const base = databaseCharge(db), empty = request({text:'x'});
  // Determine serialized payload size using a coherent independently billed probe.
  const probe = setup(t,{limits:{maxPartitions:1}}); probe.journal.stageOutgoing(probe.p,empty);
  const overhead = charge('im_v2_client_outgoing',probe.db.prepare('SELECT * FROM im_v2_client_outgoing').get()) - 1;
  const textLength = ceiling - PARTITION_MAX_CHARGE - base - overhead;
  assert.ok(textLength > 0 && textLength < 32000);
  const exact = request({text:'x'.repeat(textLength)});
  unchanged(db,() => j.stageOutgoing(p,{...exact,text:exact.text + 'x'}),'CAPACITY_EXHAUSTED');
  j.stageOutgoing(p,exact);
  assert.equal(databaseCharge(db) + PARTITION_MAX_CHARGE,ceiling);
  assert.throws(() => j.bindIdentity(identity({centerEpoch:U(80)})),error('RECOVERY_RECONCILIATION_REQUIRED'));
  const decision = {oldPartitionId:p,newIdentity:identity({centerEpoch:U(80)}),decisionRef:'🙂'.repeat(127)};
  const next = j.reconcilePartition(decision); assert.ok(databaseCharge(db) <= ceiling);
  const before = snapshot(db); assert.equal(j.reconcilePartition(decision),next); assert.deepEqual(snapshot(db),before);
});

test('historical accepted evidence is strict, monotonic, and independent from required/remote_unknown', t => {
  const {db,journal:j,p} = setup(t), r = request(); j.stageOutgoing(p,r);
  assert.throws(() => j.bindIdentity(identity({centerEpoch:U(80)})),error('RECOVERY_RECONCILIATION_REQUIRED'));
  // The two reconciliation markers are valid independent durable evidence states.
  db.prepare("UPDATE im_v2_client_outgoing SET reconciliation_state='required'").run();
  for (const evidence of [accepted(r,{sourceProtocol:'a2a-msg.im.v1'}),accepted(r,{payloadHash:'d'.repeat(64)}),accepted(r,{clientMessageId:U(88)}),
    {...accepted(r),extra:1}, {...accepted(r),retryUntil:undefined}])
    unchanged(db,() => j.markAccepted(p,operation(r),evidence),'INVALID_REQUEST');
  const first = j.markAccepted(p,operation(r),accepted(r));
  assert.equal(first.acceptance_state,'accepted'); assert.equal(first.reconciliation_state,'required');
  const before = snapshot(db); j.markAccepted(p,operation(r),accepted(r)); assert.deepEqual(snapshot(db),before);
  unchanged(db,() => j.markAccepted(p,operation(r),accepted(r,{messageId:U(88)})),'IDEMPOTENCY_CONFLICT');
  unchanged(db,() => j.markAccepted(p,operation(r),accepted(r,{acceptedAt:501})),'IDEMPOTENCY_CONFLICT');
  j.markRemoteUnknown(p,operation(r)); j.markAccepted(p,operation(r),accepted(r));
  assert.equal(j.getOutgoing(p,operation(r)).reconciliation_state,'remote_unknown');
  const next = j.reconcilePartition({oldPartitionId:p,newIdentity:identity({centerEpoch:U(80)}),decisionRef:'manual'});
  j.markAccepted(p,operation(r),accepted(r));
  assert.equal(j.getOutgoing(next,operation(r)),null);
  assert.equal(db.prepare('SELECT status FROM im_v2_client_partitions WHERE partition_id=?').get(p).status,'archived');
  unchanged(db,() => j.markAccepted(p,{originEpoch:U(3),clientMessageId:U(99)},accepted(r)),'INVALID_REQUEST');
});

test('inactive partition blocks all new network-work journal mutations while retaining accepted evidence', t => {
  const {db,journal:j,p} = setup(t), r = request(); j.stageOutgoing(p,r);
  const one = record(j,p,1), b = batch(j,p,[one]); j.markReconciliationRequired(p);
  for (const fn of [() => j.stageOutgoing(p,r),() => j.setLease(p,lease(S)),() => record(j,p,2),() => record(j,p,1,'expiry'),
    () => batch(j,p,[one]),() => j.confirmBatch(b.batch_id,progress(S,1,1))]) unchanged(db,fn,'RECOVERY_RECONCILIATION_REQUIRED');
  j.markAccepted(p,operation(r),accepted(r)); j.markRemoteUnknown(p,operation(r));
  assert.equal(j.getOutgoing(p,operation(r)).acceptance_state,'accepted');
});

test('lease evidence is a full nonhistorical DTO; receiver tuples remain explicit', t => {
  const {db,journal:j,p} = setup(t);
  for (const evidence of [lease(S,{historical:true}),lease(S,{generation:0}),lease(S,{extra:1}),
    {centerEpoch:U(3),instanceId:U(90),generation:1,expiresAt:10000,streamEpoch:S}])
    unchanged(db,() => j.setLease(p,evidence),'INVALID_REQUEST');
  unchanged(db,() => j.setLease(p,lease(S,{centerEpoch:U(30)})),'RECOVERY_RECONCILIATION_REQUIRED');
  j.setLease(p,lease(S));
  j.setLease(p,lease(S,{expiresAt:20000}));
  const saved = j.getReceiver(p,S); assert.equal(saved.instance_id,U(90)); assert.equal(saved.generation,1); assert.equal(saved.expires_at,20000);
});

test('attachment message needs exact durable receipt before becoming an ACK fact', t => {
  const {db,journal:j,p} = setup(t), m = message(1,{attachment:{attachmentId:U(77),name:'safe.bin',mime:null,size:2,sha256:'a'.repeat(64)}});
  const proof = {relativeName:`${p}-${m.messageId}-${U(77)}.bin`,sha256:'a'.repeat(64),size:2,durability:'durable'};
  unchanged(db,() => j.recordMessage(p,{streamEpoch:S,seq:1,message:m,receipt:null}),'INVALID_REQUEST');
  for (const receipt of [{...proof,relativeName:'elsewhere.bin'},{...proof,sha256:'b'.repeat(64)},{...proof,size:3},{...proof,durability:'temporary'}])
    unchanged(db,() => j.recordMessage(p,{streamEpoch:S,seq:1,message:m,receipt}),'INVALID_ATTACHMENT');
  j.recordMessage(p,{streamEpoch:S,seq:1,message:m,receipt:proof});
  j.recordExpiry(p,{streamEpoch:S,seq:1,tombstone:tombstone(m)});
  j.confirmBatch(batch(j,p,[{seq:1,messageId:m.messageId}],'expiry').batch_id,progress(S,1,0));
  const stored = db.prepare("SELECT attachment_receipt_json,server_confirmed FROM im_v2_client_received WHERE kind='message'").get();
  assert.deepEqual(JSON.parse(stored.attachment_receipt_json),proof); assert.equal(stored.server_confirmed,0);
});

for (const target of ['receiver insert','fact insert']) test(`native post-statement ${target} fault rolls back complete record transaction`, t => {
  const {db,observer,journal:j,p} = setup(t); let injected = 0;
  const pattern = target === 'receiver insert' ? /^INSERT\s+INTO\s+im_v2_client_receiver\b/i : /^INSERT\s+INTO\s+im_v2_client_received\b/i;
  observer.after(call => { if (pattern.test(call.sql)) { injected++; assert.equal(call.result.changes,1); throw new Error('synthetic post-native fault'); } });
  unchanged(db,() => record(j,p,1),'STORAGE_UNAVAILABLE'); assert.equal(injected,1);
  assert.equal(j.getReceiver(p,S),null);
});

test('native fault after second confirmed fact rolls back batch, both facts, cursors and high-water observations', t => {
  const {db,observer,journal:j,p} = setup(t), b = batch(j,p,[record(j,p,1),record(j,p,2)]); let injected = 0;
  observer.after(call => {
    if (/^UPDATE\s+im_v2_client_received\b/i.test(call.sql) && db.prepare('SELECT count(*) AS n FROM im_v2_client_received WHERE server_confirmed=1').get().n === 2) {
      injected++; assert.ok(call.result.changes > 0); throw new Error('synthetic post-native confirm fault');
    }
  });
  unchanged(db,() => j.confirmBatch(b.batch_id,progress(S,2000,2000)),'STORAGE_UNAVAILABLE'); assert.equal(injected,1);
});

test('native partition freeze fault rolls back, but successful epoch mismatch durably commits stop before throwing', t => {
  const {env,db,observer,journal:j,p} = setup(t); let injected = 0;
  observer.after(call => {
    if (/^UPDATE\s+im_v2_client_partitions\b/i.test(call.sql)) { injected++; assert.equal(call.result.changes,1); throw new Error('synthetic post-native freeze fault'); }
  });
  unchanged(db,() => j.bindIdentity(identity({centerEpoch:U(80)})),'STORAGE_UNAVAILABLE'); assert.equal(injected,1);
  observer.after(undefined);
  const before = snapshot(db);
  assert.throws(() => j.bindIdentity(identity({centerEpoch:U(80)})),error('RECOVERY_RECONCILIATION_REQUIRED'));
  assert.equal(db.prepare('SELECT status FROM im_v2_client_partitions WHERE partition_id=?').get(p).status,'reconciliation_required');
  assert.equal(snapshot(db).im_v2_client_partitions.length,before.im_v2_client_partitions.length);
  env.close(); const reopened = createImV2Journal({db:env.open()});
  assert.throws(() => reopened.requireActivePartition(p),error('RECOVERY_RECONCILIATION_REQUIRED'));
});

test('native reconcile insert fault rolls back archive and successor without deleting existing evidence', t => {
  const {db,observer,journal:j,p} = setup(t); j.stageOutgoing(p,request()); j.markReconciliationRequired(p); let injected = 0;
  observer.after(call => {
    if (/^INSERT\s+INTO\s+im_v2_client_partitions\b/i.test(call.sql)) { injected++; assert.equal(call.result.changes,1); throw new Error('synthetic post-native reconcile fault'); }
  });
  unchanged(db,() => j.reconcilePartition({oldPartitionId:p,newIdentity:identity({centerEpoch:U(80)}),decisionRef:'manual'}),'STORAGE_UNAVAILABLE');
  assert.equal(injected,1);
});

test('J1 coherently rehashed tampered batch still cannot impersonate original exact request', t => {
  const {db,journal:j,p} = setup(t), one = record(j,p,1), two = record(j,p,2), b = batch(j,p,[one]);
  const forged = JSON.stringify([two]);
  assert.equal(db.prepare('UPDATE im_v2_client_batches SET items_json=?,items_hash=? WHERE batch_id=?').run(forged,H(forged),b.batch_id).changes,1);
  unchanged(db,() => j.confirmBatch(b.batch_id,progress(S,2,2)),'STORAGE_UNAVAILABLE');
});

test('J1 coherently rehashed fact still must match the referenced tuple and strict message shape', t => {
  const {db,journal:j,p} = setup(t), b = batch(j,p,[record(j,p,1)]);
  const forged = JSON.stringify({...message(1),messageId:U(876)});
  assert.equal(db.prepare('UPDATE im_v2_client_received SET fact_json=?,fact_hash=? WHERE seq=1').run(forged,H(forged)).changes,1);
  unchanged(db,() => j.confirmBatch(b.batch_id,progress(S,1,1)),'STORAGE_UNAVAILABLE');
});

test('J3 same message/seq in another stream or reconciled epoch remains independent evidence', t => {
  const {db,journal:j,p} = setup(t);
  const one = record(j,p,1); record(j,p,1,'ack',U(10));
  const oldBatch = batch(j,p,[one]); j.confirmBatch(oldBatch.batch_id,progress(S,1,1));
  j.markReconciliationRequired(p);
  const next = j.reconcilePartition({oldPartitionId:p,newIdentity:identity({centerEpoch:U(80)}),decisionRef:'new-epoch'});
  record(j,next,1); assert.deepEqual(cursors(j,next),[0,0]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM im_v2_client_received').get().n,3);
  assert.equal(db.prepare('SELECT server_confirmed FROM im_v2_client_received WHERE partition_id=? AND stream_epoch=?').get(next,S).server_confirmed,0);
  assert.equal(j.getReceiver(p,U(10)).acked_cursor,0);
});

test('J4 complete receiver + fact growth including receipt and multibyte message is billed once', t => {
  const probe = setup(t,{limits:{maxPartitions:1}});
  const m = message(1,{text:'界🙂',attachment:{attachmentId:U(77),name:'测试.bin',mime:null,size:2,sha256:'a'.repeat(64)}});
  const receiptFor = p => ({relativeName:`${p}-${m.messageId}-${U(77)}.bin`,sha256:'a'.repeat(64),size:2,durability:'durable'});
  probe.journal.recordMessage(probe.p,{streamEpoch:S,seq:1,message:m,receipt:receiptFor(probe.p)});
  const ceiling = databaseCharge(probe.db);
  for (const delta of [0,-1]) {
    const {db,journal:j,p} = setup(t,{limits:{maxPartitions:1,maxLogicalBytes:ceiling + delta}});
    const write = () => j.recordMessage(p,{streamEpoch:S,seq:1,message:m,receipt:receiptFor(p)});
    if (delta === 0) { write(); assert.equal(databaseCharge(db),ceiling); const before = snapshot(db); write(); assert.deepEqual(snapshot(db),before); }
    else unchanged(db,write,'CAPACITY_EXHAUSTED');
  }
});

test('J4 constructor rejects lower reopened quotas atomically rather than silently accepting existing overshoot', t => {
  const {env,db,journal:j,p} = setup(t,{limits:{maxPartitions:1}});
  j.stageOutgoing(p,request()); record(j,p,1);
  const ceiling = databaseCharge(db), before = snapshot(db); env.close();
  const reopened = env.open();
  assert.throws(() => createImV2Journal({db:reopened,limits:{maxPartitions:1,maxLogicalBytes:ceiling - 1}}),error('CAPACITY_EXHAUSTED'));
  assert.deepEqual(snapshot(reopened),before);
});

test('J3 nullable decision reference enforces text on an otherwise valid predecessor pair', t => {
  const {db,journal:j,p} = setup(t); j.markReconciliationRequired(p);
  const next = j.reconcilePartition({oldPartitionId:p,newIdentity:identity({centerEpoch:U(80)}),decisionRef:'manual'});
  const before = snapshot(db);
  assert.throws(() => db.prepare('UPDATE im_v2_client_partitions SET decision_ref=? WHERE partition_id=?').run(Buffer.from('manual'),next),nativeConstraint);
  assert.deepEqual(snapshot(db),before);
});

// Subject corruption must reach the partition binding check, not accidentally
// fail an unrelated JSON, hash, message-id, receipt, or batch integrity check.
function poisonRecipient(db,p,item) {
  const authority = db.prepare('SELECT agent_id FROM im_v2_client_partitions WHERE partition_id=?').get(p);
  assert.ok(authority);
  const select = db.prepare("SELECT * FROM im_v2_client_received WHERE partition_id=? AND stream_epoch=? AND seq=? AND kind='message'");
  const before = {...select.get(p,S,item.seq)}, original = JSON.parse(before.fact_json);
  assert.equal(original.recipientAgentId,authority.agent_id);
  assert.equal(original.messageId,item.messageId);
  assert.equal(before.fact_hash,H(before.fact_json));
  assert.equal(JSON.stringify(original),before.fact_json,'retain the valid persisted encoding and property order');
  const recipientAgentId = U(777);
  assert.notEqual(recipientAgentId,authority.agent_id);
  assert.notEqual(recipientAgentId,original.senderAgentId,'isolate recipient binding from self-sender rejection');
  const forged = {...original,recipientAgentId};
  const dto = {...forged,deliveredAt:null,readAt:null};
  assert.deepEqual(messageSchema.parse(dto),dto,'poison remains a strict valid message DTO after restoring nonpersisted read/delivery observations');
  const factJson = JSON.stringify(forged), factHash = H(factJson);
  assert.equal(db.prepare("UPDATE im_v2_client_received SET fact_json=?,fact_hash=? WHERE partition_id=? AND stream_epoch=? AND seq=? AND kind='message'")
    .run(factJson,factHash,p,S,item.seq).changes,1,'native subject tamper actually succeeds');
  const after = {...select.get(p,S,item.seq)};
  assert.deepEqual(after,{...before,fact_json:factJson,fact_hash:factHash},'only recipient JSON and its correct hash change');
  assert.equal(after.fact_hash,H(after.fact_json));
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
}

for (const phase of ['prepare','pending confirm','confirmed replay']) test(`J1 recipient binding: coherently rehashed foreign recipient rejects ${phase} without repair`, t => {
  let now = 1000;
  const {db,journal:j,p} = setup(t,{clock:() => now});
  // A gap keeps local cursors at zero, so confirmed replay must validate the
  // batch's fact rather than relying on a cursor-crossing corruption check.
  const item = record(j,p,2);
  const b = phase === 'prepare' ? null : batch(j,p,[item]);
  if (phase === 'confirmed replay') j.confirmBatch(b.batch_id,progress(S,10,9));
  assert.deepEqual(cursors(j,p),[0,0]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM im_v2_client_batches').get().n,b ? 1 : 0);
  poisonRecipient(db,p,item);
  now = 2000;
  unchanged(db,() => phase === 'prepare' ? batch(j,p,[item]) : j.confirmBatch(b.batch_id,progress(S,20,19)),'STORAGE_UNAVAILABLE');
});

for (const route of ['prefix progression','budget-exhausted pending probe']) test(`J2 recipient binding: poisoned fact outside current batch rejects ${route} atomically`, t => {
  const {db,journal:j,p} = setup(t);
  const end = route === 'prefix progression' ? 2 : 1001;
  const head = record(j,p,1);
  const tail = Array.from({length:end - 1},(_,i) => record(j,p,i + 2));
  confirmGroups(j,p,tail);
  assert.deepEqual(cursors(j,p),[0,0],'unconfirmed head blocks the valid tail');
  const b = batch(j,p,[head]), poison = tail.at(-1);
  assert.deepEqual(JSON.parse(db.prepare('SELECT items_json FROM im_v2_client_batches WHERE batch_id=?').get(b.batch_id).items_json),[head]);
  assert.equal(db.prepare('SELECT server_confirmed FROM im_v2_client_received WHERE partition_id=? AND seq=?').get(p,poison.seq).server_confirmed,1);
  poisonRecipient(db,p,poison);
  // seq 1001 is just beyond the shared 1000-step prefix budget. It must still
  // be validated when determining progressPending; it is not in b.items.
  unchanged(db,() => j.confirmBatch(b.batch_id,progress(S,end,end)),'STORAGE_UNAVAILABLE');
});

test('J1 self-sender ingestion is INVALID_REQUEST before receiver/fact insertion and remains reopenable', t => {
  const {env,db,observer,journal:j,p} = setup(t);
  const agentId = db.prepare('SELECT agent_id FROM im_v2_client_partitions WHERE partition_id=?').get(p).agent_id;
  const self = message(1,{senderAgentId:agentId,recipientAgentId:agentId});
  assert.deepEqual(messageSchema.parse(self),self,'all DTO fields are valid; only the sender/recipient relationship is invalid');
  assert.equal(self.attachment,null);
  assert.equal(j.getReceiver(p,S),null);
  observer.reset();
  unchanged(db,() => j.recordMessage(p,{streamEpoch:S,seq:1,message:self,receipt:null}),'INVALID_REQUEST');
  assert.equal(observer.calls.filter(call => /^INSERT\s+INTO\s+im_v2_client_(?:receiver|received)\b/i.test(call.sql.trim())).length,0,
    'invalid input must not insert then roll back receiver/fact rows');
  assert.equal(j.getReceiver(p,S),null);
  const beforeReopen = snapshot(db);
  env.close();
  const reopenedDb = env.open(), reopened = createImV2Journal({db:reopenedDb,clock:() => 2000});
  assert.deepEqual(snapshot(reopenedDb),beforeReopen);
  const legitimate = message(1,{recipientAgentId:agentId});
  assert.notEqual(legitimate.senderAgentId,agentId);
  reopened.recordMessage(p,{streamEpoch:S,seq:1,message:legitimate,receipt:null});
  assert.equal(reopenedDb.prepare('SELECT count(*) AS n FROM im_v2_client_received').get().n,1);
  assert.deepEqual(cursors(reopened,p),[0,0]);
});

for (const count of [1,3]) test(`J1 confirmed batch proof: ${count}-item replay rejects a cleared final fact flag without restoring evidence`, t => {
  let now = 1000;
  const {db,journal:j,p} = setup(t,{clock:() => now});
  const items = Array.from({length:count},(_,i) => record(j,p,i + 2));
  const b = batch(j,p,items);
  assert.deepEqual(factRows(db).map(row => row.server_confirmed),Array(count).fill(0),'pending facts legitimately start unconfirmed');
  now = 2000;
  j.confirmBatch(b.batch_id,progress(S,10,9));
  assert.deepEqual(factRows(db).map(row => row.server_confirmed),Array(count).fill(1));
  assert.deepEqual(cursors(j,p),[0,0],'gap isolates batch proof from cursor validation');
  const saved = {...db.prepare('SELECT * FROM im_v2_client_batches WHERE batch_id=?').get(b.batch_id)};
  assert.equal(saved.state,'confirmed'); assert.equal(saved.confirmed_at,2000);
  const last = items.at(-1);
  assert.equal(db.prepare("UPDATE im_v2_client_received SET server_confirmed=0 WHERE partition_id=? AND stream_epoch=? AND seq=? AND kind='message' AND server_confirmed=1")
    .run(p,S,last.seq).changes,1,'native clearing of referenced proof actually succeeds');
  assert.deepEqual(factRows(db).map(row => row.server_confirmed),[...Array(count - 1).fill(1),0]);
  assert.deepEqual({...db.prepare('SELECT * FROM im_v2_client_batches WHERE batch_id=?').get(b.batch_id)},saved);
  now = 3000;
  unchanged(db,() => j.confirmBatch(b.batch_id,progress(S,20,19)),'STORAGE_UNAVAILABLE');
});

for (const kind of ['ack','expiry']) test(`J1 partition subject positive control: ${kind} uses persisted nondefault receiver and prepaid exact replay`, t => {
  let now = 1000;
  const {db,journal:j} = setup(t,{clock:() => now});
  const p = j.bindIdentity(identity({agentId:U(888)}));
  const agentId = db.prepare('SELECT agent_id FROM im_v2_client_partitions WHERE partition_id=?').get(p).agent_id;
  const item = record(j,p,1,kind,S,{recipientAgentId:agentId}), b = batch(j,p,[item],kind);
  const billed = databaseCharge(db);
  assert.equal(factRows(db)[0].server_confirmed,0);
  now = 2000;
  j.confirmBatch(b.batch_id,progress(S,1,kind === 'ack' ? 1 : 0));
  assert.equal(factRows(db)[0].server_confirmed,1);
  assert.deepEqual(cursors(j,p),[1,kind === 'ack' ? 1 : 0]);
  now = 3000;
  j.confirmBatch(b.batch_id,progress(S,MAX,MAX));
  const saved = db.prepare('SELECT confirmed_at,last_response_json FROM im_v2_client_batches WHERE batch_id=?').get(b.batch_id);
  assert.equal(saved.confirmed_at,2000);
  assert.deepEqual(JSON.parse(saved.last_response_json),progress(S,MAX,MAX).data);
  assert.equal(databaseCharge(db),billed,'confirmed response replacement stays inside its prepaid reservation');
  assert.equal(j.listPendingBatches(p).length,0);
});

test('J3 fact and batch composite foreign keys reject a real partition with the wrong stream', t => {
  const {db,journal:j,p} = setup(t), b = batch(j,p,[record(j,p,1)]);
  for (const table of ['im_v2_client_received','im_v2_client_batches']) {
    const before = snapshot(db);
    assert.throws(() => db.prepare(`UPDATE ${table} SET stream_epoch=?`).run(U(989)),nativeConstraint);
    assert.deepEqual(snapshot(db),before);
  }
  assert.equal(j.listPendingBatches(p)[0].batch_id,b.batch_id);
});

test('J3 constructor rejects cross-kind message mismatch even when each JSON/hash is individually coherent', t => {
  const {env,db,journal:j,p} = setup(t);
  record(j,p,1); record(j,p,1,'expiry');
  const altered = tombstone(message(1,{messageId:U(999)})), text = JSON.stringify(altered);
  assert.equal(db.prepare("UPDATE im_v2_client_received SET message_id=?,fact_json=?,fact_hash=? WHERE kind='content_expired'").run(altered.messageId,text,H(text)).changes,1);
  const before = snapshot(db); env.close(); const reopened = env.open();
  assert.throws(() => createImV2Journal({db:reopened}),error('STORAGE_UNAVAILABLE'));
  assert.deepEqual(snapshot(reopened),before);
});

test('J4 exact fresh partition need is accepted; one byte less leaves no partial partition', t => {
  const need = META_CHARGE + charge('im_v2_client_partitions',{center_origin:identity().centerOrigin});
  for (const delta of [0,-1]) {
    const env = environment(t), db = env.open();
    const j = createImV2Journal({db,limits:{maxPartitions:1,maxLogicalBytes:need + delta}});
    if (delta === 0) { j.bindIdentity(identity()); assert.equal(databaseCharge(db),need); }
    else unchanged(db,() => j.bindIdentity(identity()),'CAPACITY_EXHAUSTED');
  }
});

test('J1 batch canonical request id is independent of caller order and never includes lease tuple', t => {
  const {db,journal:j,p} = setup(t), one = record(j,p,1), two = record(j,p,2);
  j.setLease(p,lease(S)); const b = batch(j,p,[two,one]);
  assert.equal(b.batch_id,H(JSON.stringify([p,S,'ack',[one,two]])));
  assert.equal(b.items_hash,H(JSON.stringify([one,two])));
  assert.deepEqual(b.items,[one,two]);
  j.setLease(p,lease(S,{instanceId:U(91),generation:2}));
  const before = snapshot(db); assert.equal(batch(j,p,[one,two]).batch_id,b.batch_id); assert.deepEqual(snapshot(db),before);
  unchanged(db,() => batch(j,p,[one,one]),'INVALID_REQUEST');
  unchanged(db,() => batch(j,p,[one,{seq:2,messageId:one.messageId}]),'INVALID_REQUEST');
});

test('J2 distinct distant cursor boundaries share the 1000+2 fact-read budget and both pending probes', t => {
  const {db,observer,journal:j,p} = setup(t);
  const end = 3003, initialHandled = 1502, initialAcked = 1;
  assert.ok(initialHandled - initialAcked > 1000);
  assert.ok(end - initialHandled > 1000 && end - initialAcked > 1000);
  const items = Array.from({length:end},(_,i) => record(j,p,i + 1));
  confirmGroups(j,p,items);
  // All facts were confirmed through public APIs, including both long suffixes.
  assert.equal(db.prepare('SELECT count(DISTINCT seq) AS n FROM im_v2_client_received WHERE partition_id=? AND stream_epoch=? AND server_confirmed=1').get(p,S).n,end);
  // Coherent lagging cursors are legal; only their positions are changed.
  assert.equal(db.prepare('UPDATE im_v2_client_receiver SET handled_cursor=?,acked_cursor=? WHERE partition_id=? AND stream_epoch=?')
    .run(initialHandled,initialAcked,p,S).changes,1);
  assert.deepEqual(cursors(j,p),[initialHandled,initialAcked]);
  let previous = {handledCursor:initialHandled,ackedCursor:initialAcked}, sawAckOnlyPending = false, complete = false;
  for (let round = 0; round < 10; round++) {
    // Referencing this round's ACK boundary lets us count every confirmation
    // fact read without an unrelated batch-item sequence outside the budget.
    const b = batch(j,p,[items[previous.ackedCursor - 1]]);
    observer.reset();
    const result = j.confirmBatch(b.batch_id,progress(S,end,end));
    const reads = observer.calls.filter(call => /^SELECT\b/i.test(call.sql.trim()) && /\bFROM\s+im_v2_client_received\b/i.test(call.sql));
    const seqs = new Set();
    assert.ok(reads.length > 0);
    for (const call of reads) {
      // Includes unfiltered boundary validation and exact batch fact lookups,
      // not just SQL containing server_confirmed=1. Empty probes count too.
      assert.match(call.sql,/\bseq\s*=\s*\?/i,'all confirmation fact reads must be bounded point probes');
      const beforeSeq = call.sql.slice(0,call.sql.search(/\bseq\s*=\s*\?/i));
      const seq = call.args[(beforeSeq.match(/\?/g) ?? []).length];
      assert.ok(Number.isSafeInteger(seq)); seqs.add(seq);
    }
    for (const cursor of [previous.handledCursor,previous.ackedCursor]) assert.ok(seqs.has(cursor),`boundary ${cursor} must still be validated`);
    assert.ok(result.handledCursor >= previous.handledCursor && result.handledCursor <= end);
    assert.ok(result.ackedCursor >= previous.ackedCursor && result.ackedCursor <= result.handledCursor);
    const handledPending = result.handledCursor < end, ackPending = result.ackedCursor < end;
    assert.equal(result.progressPending,handledPending || ackPending,'known complete confirmed suffix independently determines pending');
    assert.ok(seqs.has(result.handledCursor + 1),'handled pending proof is inspected');
    assert.ok(seqs.has(result.ackedCursor + 1),'ACK pending proof is inspected even when handled is pending');
    if (!handledPending && ackPending) sawAckOnlyPending = true;
    assert.ok(seqs.size <= 1002,`round ${round}: all fact reads including boundaries visited ${seqs.size} distinct seqs; maximum is 1000+2`);
    previous = result;
    if (!result.progressPending) { complete = true; break; }
  }
  assert.equal(sawAckOnlyPending,true,'ACK continuation remains visible after handled reaches the tail');
  assert.equal(complete,true,'bounded explicit replays complete both confirmed prefixes');
  assert.deepEqual(cursors(j,p),[end,end]);
});
