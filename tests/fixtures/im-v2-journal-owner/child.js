import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createImV2Journal } from '../../../src/im/v2/journal.js';
import { acquireImV2JournalOwner as acquire, registerImV2JournalBinding as register, openImV2JournalDatabase } from '../../../src/im/v2/journal-owner.js';

const path = process.argv[2];
const send = message => process.send(message);
let db, journal, owner;
const unavailable = error => error?.code === 'STORAGE_UNAVAILABLE';
function open() {
  const connection = openImV2JournalDatabase({ path });
  const facade = createImV2Journal({ db: connection });
  register(facade, connection);
  return { connection, facade };
}
function nativeProbe() {
  const probe = new DatabaseSync(`${path}.owner.sqlite`);
  try {
    probe.exec('PRAGMA busy_timeout=0');
    probe.exec('BEGIN IMMEDIATE');
    probe.exec('ROLLBACK');
    return 'available';
  } catch (error) {
    // SQLITE_BUSY is positive evidence; an arbitrary setup error is not BUSY.
    if (error.errcode !== 5) throw error;
    return 'busy';
  } finally { probe.close(); }
}
process.on('message', message => {
  try {
    if (message === 'go') {
      try { owner = acquire(journal); send({ type: 'locked' }); }
      catch (error) {
        if (!unavailable(error)) throw error;
        send({ type: 'unavailable' });
      }
    } else if (message === 'probe') {
      send({ type: 'probe', result: nativeProbe() });
    } else if (message === 'alternate') {
      assert.throws(() => acquire(journal), unavailable);
      const same = createImV2Journal({ db }); register(same, db);
      assert.throws(() => acquire(same), unavailable);
      const other = open();
      try { assert.throws(() => acquire(other.facade), unavailable); }
      finally { other.connection.close(); }
      owner.assertHeld(); send({ type: 'held' });
    } else if (message === 'assert') {
      owner.assertHeld(); send({ type: 'held' });
    } else if (message === 'close-uncertainty' || message === 'rollback-uncertainty') {
      // Isolated test-process native wrapper; no injection surface in production.
      const method = message === 'close-uncertainty' ? 'close' : 'exec';
      const original = DatabaseSync.prototype[method];
      let injected = false;
      DatabaseSync.prototype[method] = function (...args) {
        if (this !== db && !injected && (method === 'close' || args[0] === 'ROLLBACK')) {
          injected = true; throw new Error('isolated native wrapper failure');
        }
        return original.apply(this, args);
      };
      try {
        assert.throws(() => owner.release(), unavailable);
        assert.equal(injected, true);
        assert.throws(() => owner.assertHeld(), unavailable);
        if (method === 'close') assert.throws(() => acquire(journal), unavailable);
      } finally { DatabaseSync.prototype[method] = original; }
      owner.release(); owner.release();
      assert.equal(db.prepare('SELECT 1 AS n').get().n, 1);
      owner = acquire(journal); owner.assertHeld();
      send({ type: 'recovered' });
    } else if (message === 'release') {
      owner.release(); owner.release(); owner = undefined;
      assert.equal(db.prepare('SELECT 1 AS n').get().n, 1);
      send({ type: 'released' });
    } else if (message === 'stop') {
      owner?.release(); db.close(); process.disconnect();
    } else throw new Error('unexpected command');
  } catch (error) {
    send({ type: 'fatal', code: error.code, message: error.message });
    process.exitCode = 1;
    process.disconnect();
  }
});
try {
  ({ connection: db, facade: journal } = open());
  send({ type: 'ready' });
} catch (error) {
  send({ type: 'fatal', code: error.code, message: error.message });
  process.exitCode = 1; process.disconnect();
}
