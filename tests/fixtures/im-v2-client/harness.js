// TEST ONLY: real v4 center, native owner, private journal and TLS loopback.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createServer, request } from 'node:https';
import { DatabaseSync, backup } from 'node:sqlite';
import { createCoreFixture, expireFixtureContent } from '../im-v2-core/helpers.js';
import { insert, recoveryRow, observe } from '../im-v2-schema/helpers.js';
import { createImV2Center } from '../../../src/im/v2/server.js';
import { createImV2Client } from '../../../src/im/v2/client.js';
import { createImV2Journal } from '../../../src/im/v2/journal.js';
import { createImV2AttachmentStore } from '../../../src/im/v2/client-files.js';
import { openImV2JournalDatabase, registerImV2JournalBinding } from '../../../src/im/v2/journal-owner.js';
import { PROTOCOL } from '../../../src/im/v2/contracts.js';
export { expireFixtureContent };
export const supported = process.platform !== 'win32';
export const native = { skip: supported ? false : 'Strict owner unsupported on native Windows; no bypass', timeout: 30000 };
export const cert = readFileSync(new URL('../im-tls/localhost-test-only.crt', import.meta.url));
const key = readFileSync(new URL('../im-tls/localhost-test-only.key', import.meta.url));
export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export function wireTransport(origin) {
  return input => new Promise((resolve, reject) => {
    const req = request(new URL(input.path, origin), { method: input.method, ca: cert,
      rejectUnauthorized: true, agent: false, signal: input.signal,
      headers: { ...input.headers, authorization: `Bearer ${input.credential}` } }, res => {
      const chunks = []; let size = 0;
      res.on('error', reject);
      res.on('data', chunk => { size += chunk.length; if (size > 16777216) res.destroy(); else chunks.push(chunk); });
      res.on('end', () => {
        if (!res.complete) reject(new Error('TEST incomplete transport'));
        else resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
      });
    });
    req.on('error', reject); req.end(input.body);
  });
}
export async function fixture(t, { handler: override, clock } = {}) {
  const f = createCoreFixture(t);
  const policy = { ...f.policy, transport: { mode: 'direct-tls', serverUrl: 'https://localhost' },
    limits: { ...f.policy.limits, maxRequestsPerMinute: 100000 },
    maintenance: { ...f.policy.maintenance, maxKeyReservations: 100000 } };
  let center = createImV2Center({ db: clock ? observe(f.native, () => {}) : f.db, policy, clock: clock ?? f.clock });
  const requests = [];
  const server = createServer({ key, cert }, (req, res) => {
    requests.push({ method: req.method, path: req.url });
    const work = override ? override(req, res, center.handler) : center.handler.handle(req, res);
    Promise.resolve(work).catch(() => res.destroy());
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `https://localhost:${server.address().port}`;
  const root = mkdtempSync(join(homedir(), 'im-v2-client-'));
  chmodSync(root, 0o700);
  const clients = new Set(), databases = new Set();
  t.after(async () => {
    for (const c of clients) await c.close();
    center.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    for (const db of databases) if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  function provision(name = randomUUID()) {
    const directory = join(root, name); mkdirSync(directory, { mode: 0o700 });
    const files = join(directory, 'files'); mkdirSync(files, { mode: 0o700 });
    return { directory, path: join(directory, 'journal.sqlite'), files };
  }
  function open(storage, journalOptions = {}) {
    const db = openImV2JournalDatabase({ path: storage.path }); databases.add(db);
    const journal = createImV2Journal({ db, ...journalOptions }); registerImV2JournalBinding(journal, db);
    return { ...storage, db, journal, attachments: createImV2AttachmentStore({ directory: storage.files }) };
  }
  function client(index = 0, settings = {}, opened = open(provision())) {
    const options = { serverUrl: origin, agentId: [f.a, f.b, f.outsider][index],
      getCredential: () => f.credentials[index], journal: opened.journal, attachments: opened.attachments, ca: cert, ...settings };
    const c = createImV2Client(options); clients.add(c);
    return { ...opened, c, options };
  }
  function sendArgs(extra = {}) {
    return { clientMessageId: randomUUID(), conversationId: f.conversationId, recipientAgentId: f.b, text: 'client test', ...extra };
  }
  function directSend(extra = {}) {
    return center.modules.messages.send(center.modules.auth.authenticate(f.credentials[0]), f.scope,
      { originEpoch: f.centerEpoch, ...sendArgs(extra) }).message;
  }
  async function snapshot() {
    const path = join(root, `center-snapshot-${randomUUID()}.sqlite`);
    await backup(f.native, path); return path;
  }
  function restore(path) {
    const db = new DatabaseSync(path); databases.add(db);
    db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
    const epoch = changeEpoch({ native: db });
    center.close(); center = createImV2Center({ db, policy, clock: clock ?? f.clock });
    return epoch;
  }
  return { ...f, center, server, origin, root, requests, provision, open, client, clients, sendArgs, directSend, snapshot, restore,
    forward: wireTransport(origin) };
}
export const acquireArgs = () => ({ instanceId: randomUUID(), requestId: randomUUID() });
export function attachment(bytes = Buffer.from('durable test attachment')) {
  return { name: 'test.bin', mime: 'application/octet-stream', sha256: createHash('sha256').update(bytes).digest('hex'), dataBase64: bytes.toString('base64') };
}
export function changeEpoch(f) {
  // TEST ONLY lawful activation state, not an operational recovery path.
  const db = f.native, old = db.prepare('SELECT * FROM im_center_state').get();
  const next = randomUUID(), counter = old.recovery_counter + 1;
  const row = recoveryRow(db, 'snapshot_recovery', { run_id: `client-test-${next}`, preparation_ref: null,
    old_epoch: old.center_epoch, new_epoch: next, backup_id: randomUUID(), backup_file_hash: 'b'.repeat(64),
    manifest_hash: 'c'.repeat(64), candidate_base_hash: 'b'.repeat(64), status: 'active', verified_at: 101,
    activated_at: 102, activation_ref: `client-test-activation-${next}`, auth_review_ref: 'test-only-review',
    activation_plan_hash: 'd'.repeat(64), activation_approval_ref: 'test-only-approval' });
  db.exec('BEGIN IMMEDIATE');
  try {
    insert(db, 'im_center_epochs', { center_epoch: next, created_at: 100, origin: 'recovery', recovery_counter: counter });
    insert(db, 'im_recovery_runs', row);
    db.prepare(`UPDATE im_center_state SET center_epoch=?,recovery_counter=?,recovery_run_id=?,activation_ref=? WHERE singleton=1`)
      .run(next, counter, row.run_id, row.activation_ref);
    db.prepare(`INSERT INTO im_sync_progress(recipient_id,center_epoch,stream_epoch,handled_through,updated_at)
      SELECT agent_id,?,stream_epoch,acked_through,102 FROM im_receive_state`).run(next);
    db.prepare('UPDATE im_receiver_leases SET expires_at=0').run();
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return next;
}
export function parsedResponse(response) { return JSON.parse(response.body.toString('utf8')); }
export function mutateResponse(response, fn) {
  const body = parsedResponse(response); fn(body);
  const bytes = Buffer.from(JSON.stringify(body));
  return { ...response, body: bytes, headers: { ...response.headers, 'content-length': String(bytes.length) } };
}
export function count(f, path) { return f.requests.filter(x => x.method === 'POST' && x.path === `/api/v2${path}`).length; }
export function journalPartition(db) { return db.prepare("SELECT * FROM im_v2_client_partitions WHERE status='active'").get(); }
export const protocol = PROTOCOL;

// TEST ONLY: gate a real, authenticated /me response after the P3 server has
// produced it. Callers can mutate their inputs without faking authentication.
export function authenticatedMeGate(f, alter = response => response) {
  let armed = null;
  return {
    arm() {
      assert.equal(armed, null);
      const entered = deferred(), release = deferred();
      armed = { entered, release };
      return { entered: entered.promise, release: () => release.resolve() };
    },
    async transport(input) {
      let response = await f.forward(input);
      if (input.path === '/api/v2/me') {
        response = alter(response);
        const gate = armed; armed = null;
        if (gate) { gate.entered.resolve(); await gate.release.promise; }
      }
      return response;
    },
  };
}

// Every public journal method forwards to the native validated facade. The
// wrapper is registered to the same real strict owner DB; no fake owner/storage.
export function observeJournal(opened, hooks = {}) {
  const calls = [];
  const journal = Object.freeze(Object.fromEntries(Object.entries(opened.journal).map(([name, method]) =>
    [name, (...args) => {
      calls.push({ name, args: structuredClone(args) });
      hooks.before?.(name, args);
      const value = method(...args);
      hooks.after?.(name, args, value);
      return value;
    }])));
  registerImV2JournalBinding(journal, opened.db);
  return { ...opened, journal, journalCalls: calls };
}

export async function syncPage(f, lease, after = 0, limit = 100) {
  const response = await f.forward({ method: 'GET',
    path: `/api/v2/sync?streamEpoch=${lease.streamEpoch}&after=${after}&limit=${limit}`,
    credential: f.credentials[1], headers: { 'x-a2a-protocol': PROTOCOL,
      'x-a2a-center-epoch': f.centerEpoch, 'x-a2a-instance-id': lease.instanceId,
      'x-a2a-generation': String(lease.generation) } });
  assert.equal(response.status, 200);
  return parsedResponse(response).data;
}

export async function postBatch(f, lease, items, kind = 'ack') {
  const response = await f.forward({ method: 'POST',
    path: kind === 'ack' ? '/api/v2/acks' : '/api/v2/expiry-receipts',
    credential: f.credentials[1], headers: { 'x-a2a-protocol': PROTOCOL,
      'x-a2a-center-epoch': f.centerEpoch, 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ protocol: PROTOCOL, centerEpoch: f.centerEpoch,
      instanceId: lease.instanceId, generation: lease.generation, streamEpoch: lease.streamEpoch, items })) });
  assert.equal(response.status, 200);
  const { protocol, centerEpoch, data } = parsedResponse(response);
  return { protocol, centerEpoch, data };
}

export function recordMessages(x, partitionId, streamEpoch, items, { batches = true } = {}) {
  for (const item of items) {
    assert.equal(item.kind, 'message');
    x.journal.recordMessage(partitionId, { streamEpoch, seq: item.seq, message: item.message, receipt: null });
    if (batches) x.journal.prepareBatch(partitionId, { streamEpoch, kind: 'ack',
      items: [{ seq: item.seq, messageId: item.message.messageId }] });
  }
}

// Counts only the enclosed public operation, including cursor validation page
// calls. Assertions/readback outside this boundary do not consume its budget.
export async function boundedAck(f, x, options) {
  const journalStart = x.journalCalls.length, requestStart = f.requests.length;
  let result, pages, mutations;
  try { result = await x.c.ackPending(options); }
  finally {
    pages = x.journalCalls.slice(journalStart).filter(call => call.name === 'listBatches');
    mutations = f.requests.slice(requestStart).filter(request => request.method === 'POST' &&
      ['/api/v2/acks', '/api/v2/expiry-receipts'].includes(request.path));
    assert.ok(pages.length <= 10, `TOTAL listBatches budget, including validation: ${pages.length}`);
    assert.ok(mutations.length <= 10, `ACK/expiry mutation budget: ${mutations.length}`);
  }
  const stampReads = x.journalCalls.slice(journalStart).filter(call => call.name === 'getChangeStamp').length;
  return { result, pages, mutations, stampReads, requests: f.requests.slice(requestStart) };
}
