import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createImV2Journal} from '../src/im/v2/journal.js';
import {ImV2Error} from '../src/im/v2/contracts.js';
import {identity, snapshot} from './fixtures/im-v2-journal/contract.js';
import {environment} from './fixtures/im-v2-journal/native.js';

const unavailable = e => e instanceof ImV2Error && e.code === 'STORAGE_UNAVAILABLE' && !/sqlite|pragma|transaction/i.test(e.message);
function openPeer(file) {
  const peer = new DatabaseSync(file);
  peer.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
  return peer;
}

test('stamp: actual file-backed connections, shared facade identity, local/public writes and foreign commits', t => {
  const env = environment(t), db = env.open();
  const journal = createImV2Journal({db});
  const otherFacade = createImV2Journal({db});
  const initial = journal.getChangeStamp();
  assert.deepEqual(Object.keys(initial), ['connectionId', 'localChanges', 'externalVersion']);
  assert.equal(Object.isFrozen(initial), true);
  assert.match(initial.connectionId, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  assert.equal(typeof initial.localChanges, 'bigint');
  assert.equal(typeof initial.externalVersion, 'bigint');
  assert.equal(otherFacade.getChangeStamp().connectionId, initial.connectionId);
  const before = snapshot(db);
  journal.listPendingOutgoing('0'.repeat(64));
  journal.listPendingBatches('0'.repeat(64));
  journal.getReceiver('0'.repeat(64), '00000000-0000-0000-0000-000000000009');
  assert.deepEqual(journal.getChangeStamp(), initial);
  assert.deepEqual(snapshot(db), before);
  assert.equal(db.isTransaction, false);

  const partition = journal.bindIdentity(identity());
  const publicWrite = journal.getChangeStamp();
  assert.equal(publicWrite.connectionId, initial.connectionId);
  assert.ok(publicWrite.localChanges > initial.localChanges);
  assert.equal(publicWrite.externalVersion, initial.externalVersion);
  const readRows = snapshot(db);
  assert.equal(journal.getReceivedFact(partition, {streamEpoch:'00000000-0000-0000-0000-000000000009', seq:1, kind:'message'}), null);
  assert.deepEqual(journal.listBatches(partition, {state:'pending'}).items, []);
  assert.deepEqual(journal.getChangeStamp(), publicWrite);
  assert.deepEqual(snapshot(db), readRows);
  db.prepare('UPDATE im_v2_client_partitions SET status=status WHERE partition_id=?').run(partition);
  const nativeWrite = journal.getChangeStamp();
  assert.ok(nativeWrite.localChanges > publicWrite.localChanges);
  assert.equal(nativeWrite.externalVersion, initial.externalVersion);
  db.exec('BEGIN');
  db.prepare('UPDATE im_v2_client_partitions SET status=status WHERE partition_id=?').run(partition);
  db.exec('ROLLBACK');
  const rolledBack = journal.getChangeStamp();
  assert.ok(rolledBack.localChanges > nativeWrite.localChanges, 'total_changes conservatively counts rollback writes');
  assert.equal(db.prepare('SELECT status FROM im_v2_client_partitions WHERE partition_id=?').get(partition).status, 'active');

  const peer = openPeer(env.file);
  const peerJournal = createImV2Journal({db:peer});
  assert.notEqual(peerJournal.getChangeStamp().connectionId, initial.connectionId);
  const old = journal.getChangeStamp();
  peer.prepare('UPDATE im_v2_client_partitions SET status=status WHERE partition_id=?').run(partition);
  const after = journal.getChangeStamp();
  assert.equal(after.connectionId, old.connectionId);
  assert.equal(after.localChanges, old.localChanges);
  assert.notEqual(after.externalVersion, old.externalVersion);
  const peerStamp = peerJournal.getChangeStamp();
  assert.ok(peerStamp.localChanges > 0n);

  peer.close();
  env.close();
  const reopened = env.open();
  const reopenJournal = createImV2Journal({db:reopened});
  assert.notEqual(reopenJournal.getChangeStamp().connectionId, initial.connectionId);
});

test('stamp: no transaction, disabled FK or weak synchronous accepted; rejected calls do not mutate rows', t => {
  const env = environment(t), db = env.open(), journal = createImV2Journal({db});
  const before = snapshot(db);
  for (const [setup, restore] of [
    [() => db.exec('BEGIN'), () => db.exec('ROLLBACK')],
    [() => db.exec('PRAGMA foreign_keys=OFF'), () => db.exec('PRAGMA foreign_keys=ON')],
    [() => db.exec('PRAGMA synchronous=NORMAL'), () => db.exec('PRAGMA synchronous=FULL')],
  ]) {
    setup();
    assert.throws(() => journal.getChangeStamp(), unavailable);
    restore();
    assert.deepEqual(snapshot(db), before);
  }
  assert.deepEqual(journal.getChangeStamp(), journal.getChangeStamp());
});

test('stamp: real foreign commit between version samples refuses mixed stamp; subsequent call succeeds', t => {
  const env = environment(t), native = env.open();
  const journal = createImV2Journal({db:native});
  const partition = journal.bindIdentity(identity());
  const peer = openPeer(env.file);
  const before = snapshot(native);
  let reads = 0, injected = false, armed = false;
  const observed = [];
  // Test-only identity is the wrapper object, deliberately not native: all facades
  // using this wrapper share its ID; production must key the actual supplied db.
  const wrapper = new Proxy(native, {get(target, key) {
    if (key === 'prepare') return sql => {
      if (sql === 'PRAGMA data_version' && armed && reads === 1) {
        peer.prepare('UPDATE im_v2_client_partitions SET status=status WHERE partition_id=?').run(partition);
        injected = true;
      }
      const stmt = target.prepare(sql);
      if (sql !== 'PRAGMA data_version') return stmt;
      return new Proxy(stmt, {get(s, method) {
        if (method !== 'all') return Reflect.get(s, method, s)?.bind?.(s) ?? Reflect.get(s, method, s);
        return () => {
          reads++;
          const result = s.all(); observed.push(result[0].data_version); return result;
        };
      }});
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  }});
  const wrappedJournal = createImV2Journal({db:wrapper});
  armed = true;
  assert.throws(() => wrappedJournal.getChangeStamp(), unavailable);
  assert.equal(injected, true);
  assert.deepEqual(snapshot(native), before);
  const valid = wrappedJournal.getChangeStamp();
  assert.equal(typeof valid.externalVersion, 'bigint');
  assert.equal(valid.externalVersion, journal.getChangeStamp().externalVersion);
  peer.close();
});

test('stamp: synthetic native BigInt > MAX_SAFE_INTEGER remains exact, never rounded', t => {
  const env = environment(t), native = env.open();
  const large = BigInt(Number.MAX_SAFE_INTEGER) + 19n;
  let intercepted = 0;
  // Only numeric precision is synthetic; construction and all other reads use real SQLite.
  const wrapper = new Proxy(native, {get(target, key) {
    if (key === 'prepare') return sql => {
      const stmt = target.prepare(sql);
      if (sql !== 'SELECT total_changes() AS local_changes') return stmt;
      return new Proxy(stmt, {get(s, method) {
        if (method === 'get') return () => {intercepted++; return {local_changes:large};};
        const value = Reflect.get(s, method, s);
        return typeof value === 'function' ? value.bind(s) : value;
      }});
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  }});
  const journal = createImV2Journal({db:wrapper});
  const stamp = journal.getChangeStamp();
  assert.equal(intercepted, 1);
  assert.equal(stamp.localChanges, large);
  assert.equal(typeof stamp.externalVersion, 'bigint');
});
