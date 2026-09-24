import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import dns from 'node:dns';
import { createImV2Client } from '../../../src/im/v2/client.js';
import { createImV2Journal } from '../../../src/im/v2/journal.js';
import { createImV2AttachmentStore } from '../../../src/im/v2/client-files.js';
import { openImV2JournalDatabase, registerImV2JournalBinding, acquireImV2JournalOwner } from '../../../src/im/v2/journal-owner.js';

const nativeExec = DatabaseSync.prototype.exec, nativeClose = DatabaseSync.prototype.close;
const control = new SharedArrayBuffer(4), state = new Int32Array(control);
const worker = new Worker(new URL('./barrier.js', import.meta.url), { workerData: { state: control } });
worker.on('error', () => process.exit(91));
assert.equal((await once(worker, 'message'))[0], 'ready');
let sequence = 0;
function pause(phase, evidence = {}) {
  const n = ++sequence;
  process.send({ type: 'phase', phase, sequence: n, evidence });
  const deadline = Date.now() + 20000;
  while (Atomics.load(state, 0) < n) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw Error('TEST barrier deadline');
    Atomics.wait(state, 0, n - 1, remaining);
  }
  assert.equal(Atomics.load(state, 0), n);
}
function receive(type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(Error('TEST IPC deadline')), 20000);
    const disconnected = () => done(Error('TEST parent disconnected'));
    const message = m => m?.type === type ? done(null, m) : done(Error('TEST unexpected IPC type'));
    function done(error, value) {
      clearTimeout(timer); process.off('message', message); process.off('disconnect', disconnected);
      if (error) reject(error); else resolve(value);
    }
    process.once('message', message); process.once('disconnect', disconnected);
  });
}
function send(m) { return new Promise((resolve, reject) => process.send(m, e => e ? reject(e) : resolve())); }
function rows(db) {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'im_v2_client_%' ORDER BY name").all();
  return names.map(({ name }) => [name, db.prepare(`SELECT * FROM ${name}`).all()]);
}
const input = receive('job'); await send({ type: 'ready', pid: process.pid });
let db, c, side;
try {
  const { job } = await input;
  db = openImV2JournalDatabase({ path: job.storage.path });
  const nativeJournal = createImV2Journal({ db });
  const journal = Object.freeze(Object.fromEntries(Object.entries(nativeJournal).map(([name, fn]) => [name, (...args) => {
    const result = fn(...args);
    if (job.phase === name) {
      assert.equal(db.isTransaction, false, 'native journal transaction committed');
      pause(`${name}-committed`, { inTransaction: db.isTransaction });
    }
    return result;
  }])));
  registerImV2JournalBinding(journal, db);
  const nativeFiles = createImV2AttachmentStore({ directory: job.storage.files });
  let savedResolve, resumeFile;
  const saved = new Promise(resolve => { savedResolve = resolve; });
  const fileGate = new Promise(resolve => { resumeFile = resolve; });
  const attachments = Object.freeze({ ...nativeFiles, async save(args) {
    const receipt = await nativeFiles.save(args);
    if (job.phase === 'file') pause('file-published-durable', { receipt });
    if (job.operation === 'close-file') { savedResolve(receipt); await fileGate; }
    return receipt;
  } });
  if (job.operation === 'hostname') {
    // Only DNS resolution is controlled. Real default HTTPS still receives the
    // wrong hostname/SNI and performs chain + checkServerIdentity itself.
    const lookup = dns.lookup;
    dns.lookup = function (hostname, options, callback) {
      if (hostname !== 'wrong-name.test') return lookup.call(this, hostname, options, callback);
      if (typeof options === 'function') { callback = options; options = {}; }
      queueMicrotask(() => options?.all ? callback(null, [{ address: '127.0.0.1', family: 4 }]) : callback(null, '127.0.0.1', 4));
    };
  }
  c = createImV2Client({ serverUrl: job.serverUrl, agentId: job.agentId,
    getCredential: () => job.credential, journal, attachments,
    ca: readFileSync(new URL('../im-tls/localhost-test-only.crt', import.meta.url)) });
  process.on('message', message => {
    if (message?.type === 'server-commit-observed') pause('server-response-withheld');
  });
  if (job.operation === 'hostname') {
    await assert.rejects(c.connect(), { code: 'STORAGE_UNAVAILABLE' });
    await send({ type: 'result', refused: true });
  } else if (job.operation === 'release-fault') {
    await c.connect();
    const before = rows(db), hits = [];
    const isSide = candidate => candidate !== db && candidate.isOpen &&
      candidate.prepare('PRAGMA database_list').all().find(r => r.name === 'main')?.file === `${job.storage.path}.owner.sqlite`;
    DatabaseSync.prototype.exec = function (sql) {
      if (sql === 'ROLLBACK' && isSide(this)) {
        side = this; hits.push('sidecar-rollback');
        if (job.fault === 'both-before') throw Error('TEST sidecar ROLLBACK fault');
        const value = nativeExec.call(this, sql);
        if (job.fault === 'rollback-after') throw Error('TEST uncertain ROLLBACK result');
        return value;
      }
      return nativeExec.call(this, sql);
    };
    DatabaseSync.prototype.close = function () {
      if (isSide(this)) {
        side = this; hits.push('sidecar-close');
        if (job.fault !== 'rollback-after') throw Error('TEST sidecar close fault');
      }
      return nativeClose.call(this);
    };
    const closing = c.close();
    await assert.rejects(closing, { code: 'STORAGE_UNAVAILABLE' });
    assert.equal(c.close(), closing, 'frozen closePromise stays rejected');
    await assert.rejects(c.connect(), { code: 'IM_DISABLED' });
    assert.deepEqual(rows(db), before, 'no data compensation/deletion');
    assert.deepEqual(hits, ['sidecar-rollback', 'sidecar-close']);
    if (job.fault !== 'rollback-after') assert.throws(() => acquireImV2JournalOwner(journal), { code: 'STORAGE_UNAVAILABLE' });
    pause('uncertain-release', { hits, dataIntact: true, sideOpen: side.isOpen,
      sideTransaction: side.isOpen ? side.isTransaction : false, memoizedRejectedClose: true });
    DatabaseSync.prototype.exec = nativeExec; DatabaseSync.prototype.close = nativeClose;
    // Explicit caller cleanup of only the captured TEST sidecar. This does not
    // erase the owner's in-process uncertain reservation or repair closePromise.
    if (side.isOpen) { if (side.isTransaction) nativeExec.call(side, 'ROLLBACK'); nativeClose.call(side); }
    assert.deepEqual(rows(db), before);
    if (job.fault !== 'rollback-after') assert.throws(() => acquireImV2JournalOwner(journal), { code: 'STORAGE_UNAVAILABLE' });
    await assert.rejects(c.close(), { code: 'STORAGE_UNAVAILABLE' });
    pause('fault-restored-cleanup', { dataIntact: true, sideOpen: side.isOpen,
      residualReservation: job.fault !== 'rollback-after' });
    c = null;
  } else if (job.operation === 'send') {
    await c.send(job.input); await send({ type: 'result' });
  } else if (job.operation === 'connect') {
    await c.connect(); await send({ type: 'result' });
  } else {
    const lease = await c.acquire(job.acquire);
    await send({ type: 'leased', lease });
    if (job.operation === 'close-file') {
      const operation = c.receiveOnce();
      const rejected = assert.rejects(operation, { code: 'IM_DISABLED' });
      const receipt = await saved;
      let closed = false;
      const closing = c.close().then(() => { closed = true; });
      await Promise.resolve(); assert.equal(closed, false);
      const release = receive('release-file');
      await send({ type: 'file-close-wait', receipt, closed });
      await release; resumeFile(); await rejected; await closing;
      await send({ type: 'result', closed });
    } else {
      const result = job.operation === 'ack' ? await c.ackPending() : await c.receiveOnce();
      await send({ type: 'result', result });
    }
  }
} catch (error) {
  // Do not reflect job, credentials, HTTP headers, or arbitrary exception text.
  await send({ type: 'failure', code: error.code ?? 'TEST_HARNESS_FAILURE', assertion: error.operator ?? null });
  process.exitCode = 1;
} finally {
  DatabaseSync.prototype.exec = nativeExec; DatabaseSync.prototype.close = nativeClose;
  if (c) try { await c.close(); } catch { /* explicit uncertain-close evidence above */ }
  if (side?.isOpen) { if (side.isTransaction) nativeExec.call(side, 'ROLLBACK'); nativeClose.call(side); }
  if (db?.isOpen) db.close();
  await worker.terminate(); process.disconnect();
}
