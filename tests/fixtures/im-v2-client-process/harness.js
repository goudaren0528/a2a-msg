// TEST ONLY: disk-backed genuine P3, ephemeral loopback TLS, private POSIX
// journal/files. Never opens a live center, configuration or user directory.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:https';
import { DatabaseSync, backup } from 'node:sqlite';
import { createCoreFixture, expireFixtureContent } from '../im-v2-core/helpers.js';
import { createImV2Center } from '../../../src/im/v2/server.js';
import { createImV2Client } from '../../../src/im/v2/client.js';
import { createImV2Journal } from '../../../src/im/v2/journal.js';
import { createImV2AttachmentStore } from '../../../src/im/v2/client-files.js';
import { openImV2JournalDatabase, registerImV2JournalBinding } from '../../../src/im/v2/journal-owner.js';
export { attachment, acquireArgs } from '../im-v2-client/harness.js';
export { expireFixtureContent };
export const native = { timeout: 120000, skip: process.platform === 'win32'
  ? 'Strict native owner unsupported on Windows; no platform/ownership override' : false };
export const cert = readFileSync(new URL('../im-tls/localhost-test-only.crt', import.meta.url));
const key = readFileSync(new URL('../im-tls/localhost-test-only.key', import.meta.url));
export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export function bounded(promise, label, ms = 20000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error(`TEST timeout: ${label}`)), ms);
  })]).finally(() => clearTimeout(timer));
}
function trackedFork() {
  const child = fork(new URL('./child.js', import.meta.url), [], {
    execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc', 'pipe'],
  });
  const x = { child, errors: [], messages: [], pending: null, exited: false, closed: false, stderr: '', stdout: '' };
  // Error is independent of exit and close; listeners are installed immediately.
  child.on('error', error => { x.errors.push(error); x.pending?.reject(error); });
  x.exit = new Promise(resolve => child.once('exit', (code, signal) => { x.exited = true; resolve({ code, signal }); }));
  x.close = new Promise(resolve => child.once('close', (code, signal) => {
    x.closed = true; resolve({ code, signal }); x.pending?.reject(Error(`TEST child closed: ${x.stderr}`));
  }));
  child.stdout.on('data', b => { x.stdout = (x.stdout + b).slice(-16384); });
  child.stderr.on('data', b => { x.stderr = (x.stderr + b).slice(-16384); });
  child.stdio[4].on('error', error => { x.errors.push(error); x.pending?.reject(error); });
  child.on('message', m => x.pending ? x.pending.resolve(m) : x.messages.push(m));
  x.next = async type => {
    let m;
    if (x.messages.length) m = x.messages.shift();
    else {
      assert.equal(x.pending, null); assert.equal(x.closed, false, x.stderr);
      try { m = await bounded(new Promise((resolve, reject) => { x.pending = { resolve, reject }; }), `${type} IPC`); }
      finally { x.pending = null; }
    }
    assert.equal(m?.type, type, `unexpected IPC ${JSON.stringify(m)}; ${x.stderr}`);
    return m;
  };
  x.send = m => bounded(new Promise((resolve, reject) => child.send(m, e => e ? reject(e) : resolve())), 'IPC send');
  x.go = phase => bounded(new Promise((resolve, reject) => child.stdio[4].write(`go:${phase.sequence}\n`, e => e ? reject(e) : resolve())), 'barrier GO');
  x.finish = async () => {
    const close = await bounded(x.close, 'child close'), exit = await bounded(x.exit, 'child exit');
    assert.deepEqual(exit, { code: 0, signal: null }, x.stderr); assert.deepEqual(close, exit);
    assert.deepEqual(x.errors, []); assert.deepEqual(x.messages, []);
  };
  return x;
}
async function stop(x) {
  if (!x.closed && !x.exited) x.child.kill('SIGTERM');
  try { await bounded(x.close, 'TERM close', 2000); }
  catch { if (!x.closed) x.child.kill('SIGKILL'); await bounded(x.close, 'KILL close', 5000); }
  if (x.child.pid) await bounded(x.exit, 'owned exit', 5000);
}
export async function kill(x) {
  assert.equal(x.child.kill('SIGKILL'), true);
  const exit = await bounded(x.exit, 'SIGKILL exit'), close = await bounded(x.close, 'SIGKILL close');
  assert.deepEqual(exit, { code: null, signal: 'SIGKILL' }); assert.deepEqual(close, exit);
  assert.deepEqual(x.errors, []); assert.deepEqual(x.messages, [], 'no operation response before kill');
}
export function lockHeld(storage) {
  const db = new DatabaseSync(`${storage.path}.owner.sqlite`, { timeout: 0 });
  try { assert.throws(() => db.exec('BEGIN IMMEDIATE'), /locked/); }
  finally { db.close(); }
}
export function journalRows(db) {
  return Object.fromEntries(['im_v2_client_partitions', 'im_v2_client_outgoing', 'im_v2_client_received',
    'im_v2_client_batches', 'im_v2_client_receiver'].map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()]));
}
export function inspectJournal(storage, fn) {
  const db = new DatabaseSync(storage.path, { readOnly: true });
  try { return fn(db); } finally { db.close(); }
}
export async function fixture(t) {
  const root = mkdtempSync(join(homedir(), 'im-v2-process-')); chmodSync(root, 0o700);
  const children = [], clients = [], databases = [], cleanSeed = [], holds = [], requests = [];
  let server, center, db;
  t.after(async () => {
    const stopped = await Promise.allSettled(children.map(stop));
    if (stopped.some(x => x.status === 'rejected') || children.some(x => !x.closed))
      throw Error(`TEST unconfirmed child close; evidence retained at ${root}`);
    for (const c of clients) await c.close();
    for (const h of holds) h.response?.destroy();
    center?.close();
    if (server) { server.closeAllConnections(); await bounded(new Promise(resolve => server.close(resolve)), 'server close'); }
    for (const d of databases) if (d.isOpen) d.close();
    if (db?.isOpen) db.close();
    for (const fn of cleanSeed) fn();
    rmSync(root, { recursive: true, force: true });
  });
  const seed = createCoreFixture({ after: fn => cleanSeed.push(fn) });
  const centerPath = join(root, 'center.sqlite'); await backup(seed.native, centerPath); chmodSync(centerPath, 0o600);
  db = new DatabaseSync(centerPath); db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
  const policy = { ...seed.policy, transport: { mode: 'direct-tls', serverUrl: 'https://localhost' },
    limits: { ...seed.policy.limits, maxRequestsPerMinute: 100000 } };
  // The backup is opened as a NEW native connection, with no cached guard.
  // Supply one clock function to the center's initial guard/module construction;
  // advancing the test variable never replaces that function or edits SQL time.
  let now = 103;
  const clock = () => now;
  const advanceClock = next => {
    assert.ok(Number.isSafeInteger(next) && next > now, 'TEST clock must advance strictly forward');
    now = next;
  };
  center = createImV2Center({ db, policy, clock });
  server = createServer({ key, cert }, (req, res) => {
    const entry = { method: req.method, path: req.url, body: null }; requests.push(entry);
    const chunks = []; req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => { if (chunks.length) entry.body = JSON.parse(Buffer.concat(chunks)); });
    const hold = holds.find(h => !h.used && h.path === req.url);
    if (hold) {
      hold.used = true; hold.response = res;
      // P3 has committed BEFORE it calls end. Retain the real response bytes,
      // never deliver them to the waiting child. Independent disk read below
      // proves durable business state, not a mocked acceptance flag.
      res.end = function (body) {
        hold.entered.resolve({ status: res.statusCode, body: JSON.parse(Buffer.from(body)),
          socketBytesWritten: res.socket.bytesWritten, writableEnded: res.writableEnded });
        return this;
      };
    }
    Promise.resolve(center.handler.handle(req, res)).catch(() => res.destroy());
  });
  await bounded(new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }), 'listen');
  const origin = `https://localhost:${server.address().port}`;
  const f = { ...seed, clock, advanceClock, native: db, db, root, centerPath, center, server, origin, requests, children,
    count: path => requests.filter(r => r.method === 'POST' && r.path === `/api/v2${path}`).length,
    hold(path) { const h = { path: `/api/v2${path}`, entered: deferred(), used: false }; holds.push(h); return h; },
    inspect(fn) { const reader = new DatabaseSync(centerPath, { readOnly: true }); try { return fn(reader); } finally { reader.close(); } },
    provision() {
      const directory = join(root, randomUUID()); mkdirSync(directory, { mode: 0o700 });
      const files = join(directory, 'files'); mkdirSync(files, { mode: 0o700 });
      return { directory, path: join(directory, 'journal.sqlite'), files };
    },
    open(storage) {
      const db = openImV2JournalDatabase({ path: storage.path }); databases.push(db);
      const journal = createImV2Journal({ db }); registerImV2JournalBinding(journal, db);
      return { ...storage, db, journal, attachments: createImV2AttachmentStore({ directory: storage.files }) };
    },
    client(storage, index = 1, extra = {}) {
      const x = f.open(storage), c = createImV2Client({ serverUrl: origin, agentId: [seed.a, seed.b][index],
        getCredential: () => seed.credentials[index], ca: cert, journal: x.journal, attachments: x.attachments, ...extra });
      clients.push(c); return { ...x, c };
    },
    directSend(extra = {}) {
      return center.modules.messages.send(center.modules.auth.authenticate(seed.credentials[0]), seed.scope,
        { originEpoch: seed.centerEpoch, clientMessageId: randomUUID(), conversationId: seed.conversationId,
          recipientAgentId: seed.b, text: 'TEST independent process', ...extra }).message;
    },
    async start(storage, job = {}, index = 1) {
      const x = trackedFork(); children.push(x);
      assert.equal((await x.next('ready')).pid, x.child.pid);
      await x.send({ type: 'job', job: { storage, serverUrl: origin, agentId: [seed.a, seed.b][index],
        credential: seed.credentials[index], ...job } });
      return x;
    },
  };
  return f;
}
