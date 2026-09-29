import assert from 'node:assert/strict';
import https from 'node:https';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createImCenter } from '../src/im/server.js';
import { createImAdmin } from '../src/im/admin.js';
import { migrateImSchemaV3, initInstanceIdentity } from '../src/im/schema.js';
import { attachmentPath } from '../src/im/client-files.js';

const repo = fileURLToPath(new URL('../', import.meta.url));
const cert = join(repo, 'tests/fixtures/im-tls/localhost-test-only.crt');
const key = join(repo, 'tests/fixtures/im-tls/localhost-test-only.key');
const receiverFile = join(repo, 'examples/im-local-demo/receiver.mjs');
const senderFile = join(repo, 'examples/im-local-demo/sender.py');
const payload = Buffer.from([0, 255, 128, 13, 10, 1, 2, 3, 0, 222, 173, 190, 239]);
const sha256 = createHash('sha256').update(payload).digest('hex');
const limit = (promise, label, ms = 15000) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error(`timeout: ${label}`)), ms);
  })]).finally(() => clearTimeout(timer));
};
function environment(dir) {
  mkdirSync(dir, { mode: 0o700 });
  const env = { HOME: dir, USERPROFILE: dir, APPDATA: dir, LOCALAPPDATA: dir,
    XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, XDG_DATA_HOME: dir,
    TEMP: dir, TMP: dir, TMPDIR: dir };
  for (const name of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return env;
}
function privateRoot(target) {
  if (!isAbsolute(target) || existsSync(target)) throw Error('root must be an absolute, nonexistent path');
  const parent = dirname(target);
  if (!existsSync(parent)) throw Error('root parent must exist');
  let current = parse(parent).root;
  for (const part of parent.slice(current.length).split(/[\\/]+/).filter(Boolean)) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw Error('root parent contains a symlink');
  }
  mkdirSync(target, { mode: 0o700 });
  chmodSync(target, 0o700);
  return target;
}
function pythonExecutable(root) {
  for (const command of ['python', 'python3']) {
    const probe = spawnSync(command, ['-I', '-S', '-B', '-c',
      'import sys; print(sys.executable); sys.exit(0 if sys.version_info >= (3, 8) else 2)'],
    { cwd: root, env: { ...environment(join(root, `probe-${command}`)), PATH: process.env.PATH ?? '' },
      encoding: 'utf8', timeout: 5000, maxBuffer: 4096 });
    if (probe.status === 0 && probe.stdout.trim()) return probe.stdout.trim();
  }
  throw Error('Python 3.8+ not found (python/python3)');
}
function childProcess(command, args, options, children) {
  const child = spawn(command, args, { ...options, windowsHide: true, shell: false });
  const state = { child, closed: false, exited: false, errors: [], frames: [], waiting: null };
  children.push(state);
  state.exit = new Promise(done => child.once('exit', (code, signal) => { state.exited = true; done({ code, signal }); }));
  state.close = new Promise(done => child.once('close', (code, signal) => {
    state.closed = true; done({ code, signal });
    state.waiting?.reject(Error('child closed before response'));
  }));
  const error = () => { state.errors.push('child stream error'); state.waiting?.reject(Error('child stream error')); };
  child.on('error', error);
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.on('error', error);
  child.stderr.on('data', () => {}); // Never display credentials/remote data.
  state.push = frame => {
    if (state.waiting) { const waiter = state.waiting; state.waiting = null; waiter.resolve(frame); }
    else if (state.frames.length < 4) state.frames.push(frame);
    else error();
  };
  state.next = async label => {
    if (state.frames.length) return state.frames.shift();
    assert.equal(state.closed, false);
    return limit(new Promise((resolve, reject) => { state.waiting = { resolve, reject }; }), label)
      .finally(() => { state.waiting = null; });
  };
  state.finish = async () => {
    assert.deepEqual(await limit(state.close, 'child close'), { code: 0, signal: null });
    assert.equal(state.exited, true);
    assert.deepEqual(state.errors, []);
  };
  return state;
}
async function stop(state) {
  if (state.closed) return;
  if (!state.exited) state.child.kill('SIGTERM');
  try { await limit(state.close, 'child TERM close', 2000); }
  catch {
    if (!state.closed) state.child.kill('SIGKILL');
    await limit(state.close, 'child KILL close', 3000);
  }
}
async function run() {
  if (process.argv.length > 4 || process.argv[2] === '--help' && process.argv.length !== 3 ||
      process.argv.length > 2 && !['--help', '--root'].includes(process.argv[2]) ||
      process.argv[2] === '--root' && process.argv.length !== 4) throw Error('usage: node examples/im-local-demo.mjs [--root ABSOLUTE_NONEXISTENT_PATH]');
  if (process.argv[2] === '--help') {
    console.log('Usage: node examples/im-local-demo.mjs [--root ABSOLUTE_NONEXISTENT_PATH]');
    return;
  }
  const root = process.argv[2] === '--root' ? privateRoot(process.argv[3]) : mkdtempSync(join(tmpdir(), 'im-local-demo-'));
  chmodSync(root, 0o700);
  console.log(`Demo directory (retained): ${root}`);
  const children = [];
  let db, center, server;
  try {
    const python = pythonExecutable(root);
    db = new DatabaseSync(join(root, 'center-v3.sqlite'));
    db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
    migrateImSchemaV3(db);
    initInstanceIdentity(db, { clock: Date.now });
    assert.equal(db.prepare('SELECT version FROM im_schema').get().version, 3);
    const trusted = {};
    const admin = createImAdmin({ db, clock: Date.now, authorizeAdmin: value => value === trusted });
    const agents = ['Python sender', 'MCP receiver'].map(displayName => {
      const agentId = admin.registerAgent({ displayName }, trusted).agentId;
      return { agentId, credential: admin.issueCredential({ agentId, expiresAt: null }, trusted).credential };
    });
    admin.setContact({ agentA: agents[0].agentId, agentB: agents[1].agentId,
      allowed: true, reason: 'isolated demo contact' }, trusted);
    db.exec("UPDATE im_settings SET write_mode='enabled' WHERE singleton=1");
    center = createImCenter({ db, policy: { enabled: true, writeMode: 'enabled',
      transport: { mode: 'direct-tls', serverUrl: 'https://localhost:8787' },
      retention: { policy: { messageRetentionMs: 86400000, attachmentRetentionMs: 86400000,
        idempotencyRetentionMs: 172800000, safeRetryWindowMs: 60000 } },
      lease: { ttlMs: 60000, renewalMs: 10000 } } });
    server = https.createServer({ cert: readFileSync(cert), key: readFileSync(key), maxHeaderSize: 8192 }, async (req, res) => {
      try { if (!await center.handler.handle(req, res)) { res.statusCode = 404; res.end(); } }
      catch { res.destroy(); }
    });
    server.maxHeadersCount = 50;
    server.headersTimeout = 10000;
    server.requestTimeout = 20000;
    await limit(new Promise((done, reject) => {
      server.once('error', reject); server.listen(0, '127.0.0.1', done);
    }), 'TLS listen');
    const serverUrl = `https://127.0.0.1:${server.address().port}`;
    const storage = join(root, 'receiver-storage');
    const attachments = join(storage, 'attachments');
    mkdirSync(attachments, { recursive: true, mode: 0o700 });
    chmodSync(storage, 0o700);
    const journal = join(storage, 'journal.sqlite');
    const senderConfig = { serverUrl, ca: cert, module: join(repo, 'examples/python/client.py'),
      ...agents[0], peerId: agents[1].agentId };
    const receiverConfig = { serverUrl, ca: cert, journal, attachments, ...agents[1] };
    let sequence = 0;
    async function send(clientMessageId, text, data) {
      const dir = join(root, `sender-${++sequence}`);
      const state = childProcess(python, ['-I', '-S', '-B', senderFile],
        { cwd: dir, env: environment(dir), stdio: ['pipe', 'pipe', 'pipe'] }, children);
      let pending = Buffer.alloc(0);
      state.child.stdout.on('data', chunk => {
        pending = Buffer.concat([pending, chunk]);
        if (pending.length > 65536) { state.errors.push('sender output limit'); state.child.kill(); return; }
        const newline = pending.indexOf(10);
        if (newline !== -1) {
          try { state.push(JSON.parse(pending.subarray(0, newline).toString())); }
          catch { state.errors.push('invalid sender output'); state.child.kill(); }
          pending = pending.subarray(newline + 1);
        }
      });
      const config = { ...senderConfig, clientMessageId, text,
        ...(data ? { bytes: data.toString('base64') } : {}) };
      state.child.stdin.end(`${JSON.stringify(config)}\n`);
      const response = await state.next('Python send');
      await state.finish();
      assert.equal(pending.length, 0);
      return response;
    }
    async function receiver() {
      const dir = join(root, `receiver-${++sequence}`);
      const state = childProcess(process.execPath, [receiverFile],
        { cwd: dir, env: environment(dir), stdio: ['pipe', 'pipe', 'pipe', 'ipc'] }, children);
      state.child.on('message', state.push);
      const ready = await state.next('MCP ready');
      assert.equal(ready.phase, 'ready');
      assert.equal(ready.clean, true);
      await limit(new Promise((done, reject) => state.child.send(receiverConfig, error => error ? reject(Error('MCP IPC failed')) : done())), 'MCP config');
      assert.equal((await state.next('MCP configured')).phase, 'configured');
      const transport = new StdioServerTransport(state.child.stdout, state.child.stdin, { maxBufferSize: 262144 });
      const client = new Client({ name: 'isolated-demo-parent', version: '1.0.0' });
      await limit(client.connect(transport), 'MCP initialize');
      assert.equal((await limit(client.listTools(), 'MCP tools/list')).tools.length, 16);
      state.call = async (name, args = {}) => {
        const result = await limit(client.callTool({ name, arguments: args }), `MCP ${name}`);
        assert.equal(result.isError, undefined, `MCP ${name} failed`);
        return JSON.parse(result.content[0].text);
      };
      state.graceful = async () => {
        await limit(client.close(), 'MCP close');
        state.child.stdin.end();
        await state.finish();
      };
      return state;
    }
    const delivery = id => db.prepare('SELECT acked_at,read_at FROM im_deliveries WHERE message_id=?').get(id);
    const rows = () => {
      const local = new DatabaseSync(journal, { readOnly: true });
      try { return local.prepare('SELECT seq,message_id,acked,receipt_json FROM im_client_received ORDER BY seq').all(); }
      finally { local.close(); }
    };
    console.log('1/3: receiver offline; Python sends text and binary attachment');
    const clientMessageId = randomUUID();
    const first = await send(clientMessageId, 'isolated local IM text + binary', payload);
    const duplicate = await send(clientMessageId, 'isolated local IM text + binary', payload);
    assert.equal(duplicate.messageId, first.messageId);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM im_messages').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM im_send_keys').get().n, 1);
    assert.equal(delivery(first.messageId).acked_at, null);
    console.log('2/3: MCP receiver starts; CA-verified HTTPS sync and durable receipt');
    let active = await receiver();
    assert.equal((await active.call('im_v1_me')).agentId, agents[1].agentId);
    const firstLease = await active.call('im_v1_acquire_lease', { instanceId: randomUUID(), requestId: randomUUID() });
    assert.deepEqual((await active.call('im_v1_sync')).items.map(item => item.message.messageId), [first.messageId]);
    let received = rows();
    assert.equal(received.length, 1);
    assert.equal(received[0].acked, 1);
    const receipt = JSON.parse(received[0].receipt_json);
    const attachmentId = db.prepare('SELECT attachment_id FROM im_attachments WHERE message_id=?').get(first.messageId).attachment_id;
    assert.equal(receipt.path, attachmentPath(attachments, serverUrl, agents[1].agentId, first.messageId, attachmentId));
    assert.equal(receipt.sha256, sha256);
    assert.equal(receipt.size, payload.length);
    assert.deepEqual(readFileSync(receipt.path), payload);
    assert.ok(delivery(first.messageId).acked_at !== null);
    assert.equal(delivery(first.messageId).read_at, null);
    await active.call('im_v1_release_lease');
    await active.graceful();
    console.log('3/3: offline second send; new receiver process resumes same journal');
    const second = await send(randomUUID(), 'queued while receiver was offline');
    assert.equal(delivery(second.messageId).acked_at, null);
    const previousPid = active.child.pid;
    active = await receiver();
    assert.notEqual(active.child.pid, previousPid);
    const lease = await active.call('im_v1_acquire_lease', { instanceId: randomUUID(), requestId: randomUUID() });
    assert.equal(lease.cursor, 1);
    assert.ok(lease.generation > firstLease.generation);
    assert.deepEqual((await active.call('im_v1_ack_pending')).acked, []);
    assert.deepEqual((await active.call('im_v1_sync')).items.map(item => item.message.messageId), [second.messageId]);
    assert.deepEqual((await active.call('im_v1_sync')).items, []);
    received = rows();
    assert.deepEqual(received.map(row => row.message_id), [first.messageId, second.messageId]);
    assert.deepEqual(received.map(row => row.acked), [1, 1]);
    assert.equal(readdirSync(attachments).length, 1);
    assert.ok(delivery(second.messageId).acked_at !== null);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM im_messages').get().n, 2);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM im_audit WHERE action='ack_delivery' AND actor_id=?").get(agents[1].agentId).n, 2);
    await active.call('im_v1_release_lease');
    await active.graceful();
    const summary = { pass: true, runtime: { node: process.version, platform: process.platform, python: '3.8+' },
      protocol: 'a2a-msg.im.v1', schema: 3, root, port: server.address().port,
      senderAgentId: agents[0].agentId, receiverAgentId: agents[1].agentId,
      messageIds: [first.messageId, second.messageId], accepted: 2, delivered: 2,
      sendKeys: 2, attachmentCount: 1, attachmentBytes: payload.length, attachmentSha256: sha256,
      receiverProcessRestarts: 1, receiverJournalRows: received.length };
    writeFileSync(join(root, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    console.log('PASS: 2 accepted, 2 delivered/ACKed; one binary attachment; restart cursor continued. No execution of received text claimed.');
  } finally {
    const stopped = await Promise.allSettled(children.map(stop));
    center?.close();
    server?.closeAllConnections();
    if (server?.listening) await limit(new Promise(done => server.close(done)), 'center close');
    db?.close();
    if (stopped.some(item => item.status === 'rejected') || children.some(item => !item.closed || !item.exited))
      throw Error('owned child close unconfirmed; inspect retained demo directory');
  }
}
run().catch(error => { console.error(`Demo failed: ${error.message}`); process.exitCode = 1; });
