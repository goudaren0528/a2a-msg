import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import https from 'node:https';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createImAdmin } from '../src/im/admin.js';
import { createImAuth } from '../src/im/auth.js';
import { createImAcl } from '../src/im/acl.js';
import { createImMessages } from '../src/im/messages.js';
import { createImDelivery } from '../src/im/delivery.js';
import { createImHandler } from '../src/im/http.js';
import { migrateImSchema } from '../src/im/schema.js';
import { MAX_ATTACHMENT_BYTES } from '../src/im/contracts.js';
import { readLocalFileForSend } from '../src/im/mcp-local-files.js';

const SCRIPT = resolve('scripts/im-mcp.mjs');
const CERT_PATH = fileURLToPath(new URL('./fixtures/im-tls/localhost-test-only.crt', import.meta.url));
const cert = readFileSync(CERT_PATH);
const key = readFileSync(new URL('./fixtures/im-tls/localhost-test-only.key', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

const decode = response => JSON.parse(response.content[0].text);
function ok(response) {
  assert.notEqual(response.isError, true, response.content?.[0]?.text);
  return decode(response);
}
function bad(response, code) {
  assert.equal(response.isError, true);
  const value = decode(response);
  assert.equal(value.error.code, code, value.error.message);
  return value.error;
}

// `saveAttachment` rejects a directory whose realpath differs from itself, so test
// roots must be canonical (macOS `tmpdir()` is a symlink into /private/var).
const testRoot = prefix => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

async function startCenter() {
  const central = new DatabaseSync(':memory:');
  central.exec('PRAGMA foreign_keys=ON');
  migrateImSchema(central);
  const context = {}, clock = () => 10000;
  const admin = createImAdmin({ db: central, clock, authorizeAdmin: x => x === context });
  const auth = createImAuth({ db: central, clock });
  const acl = createImAcl({ db: central, auth, clock });
  const register = displayName => {
    const agentId = admin.registerAgent({ displayName }, context).agentId;
    return { agentId, ...admin.issueCredential({ agentId, expiresAt: null }, context) };
  };
  const a = register('Host A'), b = register('Host B');
  admin.setContact({ agentA: a.agentId, agentB: b.agentId, allowed: true, reason: 'test' }, context);
  admin.setContact({ agentA: b.agentId, agentB: a.agentId, allowed: true, reason: 'test' }, context);
  central.exec("UPDATE im_settings SET write_mode='enabled'");
  const policy = { enabled: true, writeMode: 'enabled',
    transport: { mode: 'direct-tls', serverUrl: 'https://localhost:8787' },
    retention: { policy: { messageRetentionMs: 100000, attachmentRetentionMs: 90000, idempotencyRetentionMs: 110000,
      safeRetryWindowMs: 1000 } }, lease: { ttlMs: 90000, renewalMs: 30000 } };
  const messages = createImMessages({ db: central, auth, acl, clock, policy });
  const delivery = createImDelivery({ db: central, auth, acl, clock, policy });
  const handler = createImHandler({ auth, acl, messages, delivery, policy });
  const server = https.createServer({ key, cert }, (req, res) => handler.handle(req, res).catch(() => res.destroy()));
  server.maxHeadersCount = 64;
  await new Promise(done => server.listen(0, 'localhost', done));
  const center = `https://localhost:${server.address().port}`;
  return { center, a, b, central,
    close: async () => { handler.close(); await new Promise(done => server.close(done)); central.close(); } };
}

// `omitAttachment` exercises the npx-style config that relies on the default download
// directory. `home` is passed to the child process so `os.homedir()` is isolated.
function writeHost(root, { center, agent, omitAttachment = false, home, attachmentDirectory }) {
  const host = join(root, 'host');
  mkdirSync(host, { recursive: true, mode: 0o700 });
  const credentialFile = join(root, 'credential');
  writeFileSync(credentialFile, `${agent.credential}\n`, { mode: 0o600 });
  chmodSync(credentialFile, 0o600);
  const attachments = attachmentDirectory ?? join(root, 'attachments');
  if (!omitAttachment) mkdirSync(attachments, { recursive: true, mode: 0o700 });
  const config = { serverUrl: center, agentId: agent.agentId, credentialFile,
    journalPath: join(host, 'journal.sqlite'), statePath: join(host, 'session-state.json'),
    ...(omitAttachment ? {} : { attachmentDirectory: attachments }) };
  const configPath = join(root, 'nana.json');
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  return { configPath, config, attachments, home };
}

async function launch(t, root, options, extraArgs = []) {
  const host = writeHost(root, options);
  const env = { NODE_EXTRA_CA_CERTS: CERT_PATH, ...(options.home ? { HOME: options.home, USERPROFILE: options.home } : {}) };
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [SCRIPT, '--config', host.configPath, ...extraArgs], env, stderr: 'pipe' });
  const sdk = new Client({ name: 'local-files-host', version: '1.0.0' });
  const stderr = [];
  transport.stderr.on('data', chunk => stderr.push(chunk.toString('utf8')));
  t.after(async () => { await sdk.close(); await transport.close(); });
  await sdk.connect(transport);
  return { sdk, call: (name, args = {}) => sdk.callTool({ name, arguments: args }),
    config: host.config, attachments: host.attachments, stderr: () => stderr.join('') };
}

async function sendBytes(a, center, bytes, { file, name, text, dir } = {}) {
  const conversation = ok(await a.call('im_v1_ensure_conversation', { peerAgentId: center.b.agentId }));
  const clientMessageId = randomUUID();
  const source = file ?? join(dir, `payload-${clientMessageId}.bin`);
  if (!file) writeFileSync(source, bytes, { mode: 0o600 });
  const sent = ok(await a.call('im_v1_send_file', { conversationId: conversation.conversationId,
    recipientAgentId: center.b.agentId, clientMessageId, path: source,
    ...(name === undefined ? {} : { name }), ...(text === undefined ? {} : { text }) }));
  return sent;
}

test('im_v1_send_file reads a local file and the receiver saves verified bytes', async t => {
  const center = await startCenter();
  const root = testRoot('im-local-files-e2e-');
  t.after(async () => { await center.close(); rmSync(root, { recursive: true, force: true }); });
  const aRoot = join(root, 'a'), bRoot = join(root, 'b');
  mkdirSync(aRoot); mkdirSync(bRoot);
  const a = await launch(t, aRoot, { center: center.center, agent: center.a });
  const b = await launch(t, bRoot, { center: center.center, agent: center.b });

  const bytes = randomBytes(65536);
  const file = join(aRoot, 'report.bin');
  writeFileSync(file, bytes, { mode: 0o600 });
  const conversation = ok(await a.call('im_v1_ensure_conversation', { peerAgentId: center.b.agentId }));
  const clientMessageId = randomUUID();
  const sent = ok(await a.call('im_v1_send_file', { conversationId: conversation.conversationId,
    recipientAgentId: center.b.agentId, clientMessageId, path: file, title: 'report', text: 'see attachment' }));
  assert.match(sent.messageId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(sent.attachment, { name: 'report.bin', mime: null, size: bytes.length, sha256: sha256(bytes) });

  ok(await b.call('im_v1_acquire_lease', { instanceId: randomUUID(), requestId: randomUUID() }));
  const synced = ok(await b.call('im_v1_sync', { limit: 10 }));
  assert.equal(synced.items.length, 1, JSON.stringify(synced));
  const item = synced.items[0];
  assert.equal(item.message.messageId, sent.messageId);
  assert.equal(item.status, 'delivered');
  assert.deepEqual(readFileSync(item.attachmentReceipt.path), bytes);
  assert.equal(item.attachmentReceipt.sha256, sha256(bytes));
  assert.equal(item.attachmentReceipt.size, bytes.length);
  assert.equal(item.attachmentReceipt.path.startsWith(join(b.attachments, '')), true);
  assert.equal(readdirSync(b.attachments).length, 1, 'no staging artifacts remain');

  // The explicit save tool resolves to the same verified file and never ACKs.
  const saved = ok(await b.call('im_v1_attachment', { messageId: sent.messageId,
    attachmentId: item.message.attachment.attachmentId }));
  assert.deepEqual(saved.receipt, item.attachmentReceipt);
  assert.deepEqual(readFileSync(saved.receipt.path), bytes);

  // Same key and same bytes is an idempotent retry: same message, no second delivery.
  const again = ok(await a.call('im_v1_send_file', { conversationId: conversation.conversationId,
    recipientAgentId: center.b.agentId, clientMessageId, path: file, title: 'report', text: 'see attachment' }));
  assert.equal(again.messageId, sent.messageId);
  assert.equal(ok(await b.call('im_v1_sync', { limit: 10 })).items.length, 0);
  assert.equal(center.central.prepare('SELECT COUNT(*) AS n FROM im_messages').get().n, 1);

  // Same key with different bytes is a conflict, never a second message.
  writeFileSync(file, randomBytes(32), { mode: 0o600 });
  bad(await a.call('im_v1_send_file', { conversationId: conversation.conversationId,
    recipientAgentId: center.b.agentId, clientMessageId, path: file, title: 'report', text: 'see attachment' }),
  'IDEMPOTENCY_CONFLICT');
  assert.equal(center.central.prepare('SELECT COUNT(*) AS n FROM im_messages').get().n, 1);

  ok(await b.call('im_v1_release_lease', {}));
  const transcript = `${JSON.stringify([sent, synced, again])}${a.stderr()}${b.stderr()}`;
  assert.equal(transcript.includes(center.a.credential), false);
  assert.equal(transcript.includes(center.b.credential), false);
  assert.equal(transcript.includes(bytes.toString('base64')), false, 'raw attachment bytes never appear in results');
});

test('received files use ~/Downloads/a2a-msg/<center-host> by default, or --download-dir', async t => {
  const center = await startCenter();
  const port = new URL(center.center).port;
  const root = testRoot('im-local-files-dir-');
  t.after(async () => { await center.close(); rmSync(root, { recursive: true, force: true }); });
  const aRoot = join(root, 'a'), bRoot = join(root, 'b'), home = join(bRoot, 'home');
  mkdirSync(aRoot); mkdirSync(bRoot); mkdirSync(home);
  const homeReal = realpathSync(home);
  const a = await launch(t, aRoot, { center: center.center, agent: center.a });
  const b = await launch(t, bRoot, { center: center.center, agent: center.b, omitAttachment: true, home: homeReal });

  const expected = join(homeReal, 'Downloads', 'a2a-msg', `localhost_${port}`);
  assert.equal(existsSync(expected), true, 'the default download directory is created on demand');
  assert.equal(expected.includes('_npx'), false);
  assert.equal(expected.includes('node_modules'), false);

  const bytes = randomBytes(1024);
  await sendBytes(a, center, bytes, { dir: aRoot });
  ok(await b.call('im_v1_acquire_lease', { instanceId: randomUUID(), requestId: randomUUID() }));
  const synced = ok(await b.call('im_v1_sync', { limit: 10 }));
  assert.equal(synced.items.length, 1, JSON.stringify(synced));
  const path = synced.items[0].attachmentReceipt.path;
  assert.equal(path.startsWith(join(expected, '')), true, path);
  assert.deepEqual(readFileSync(path), bytes);
});

test('an explicit --download-dir overrides nana.json attachmentDirectory', async t => {
  const center = await startCenter();
  const root = testRoot('im-local-files-override-');
  t.after(async () => { await center.close(); rmSync(root, { recursive: true, force: true }); });
  const aRoot = join(root, 'a'), bRoot = join(root, 'b');
  const configured = join(bRoot, 'configured'), override = join(bRoot, 'override');
  mkdirSync(aRoot); mkdirSync(bRoot); mkdirSync(configured); mkdirSync(override);
  const a = await launch(t, aRoot, { center: center.center, agent: center.a });
  const b = await launch(t, bRoot, { center: center.center, agent: center.b,
    attachmentDirectory: configured }, ['--download-dir', override]);

  const bytes = randomBytes(512);
  await sendBytes(a, center, bytes, { dir: aRoot });
  ok(await b.call('im_v1_acquire_lease', { instanceId: randomUUID(), requestId: randomUUID() }));
  const synced = ok(await b.call('im_v1_sync', { limit: 10 }));
  assert.equal(synced.items.length, 1, JSON.stringify(synced));
  assert.equal(synced.items[0].attachmentReceipt.path.startsWith(join(override, '')), true);
  assert.deepEqual(readdirSync(configured), [], 'the configured directory is not used when overridden');
  assert.equal(readdirSync(override).length, 1);
});

test('explicit download directories must exist; missing, unwritable or corrupt data never ACK', async t => {
  const center = await startCenter();
  const root = testRoot('im-local-files-fail-');
  t.after(async () => { await center.close(); rmSync(root, { recursive: true, force: true }); });
  const aRoot = join(root, 'a'), bRoot = join(root, 'b');
  mkdirSync(aRoot); mkdirSync(bRoot);

  // Missing explicit --download-dir fails closed at startup.
  const missing = join(root, 'missing');
  const { configPath } = writeHost(aRoot, { center: center.center, agent: center.a });
  const run = spawnSync(process.execPath, [SCRIPT, '--config', configPath, '--download-dir', missing],
    { encoding: 'utf8', timeout: 10000, env: { ...process.env, NODE_EXTRA_CA_CERTS: CERT_PATH } });
  assert.equal(run.status, 1);
  assert.equal(run.stdout, '');
  assert.equal(JSON.parse(run.stderr).error.code, 'INVALID_REQUEST');

  const a = await launch(t, aRoot, { center: center.center, agent: center.a });
  const b = await launch(t, bRoot, { center: center.center, agent: center.b });
  const bytes = randomBytes(2048);
  const sent = await sendBytes(a, center, bytes, { dir: aRoot });
  ok(await b.call('im_v1_acquire_lease', { instanceId: randomUUID(), requestId: randomUUID() }));

  // Directory removed after startup: sync fails closed, nothing is ACKed or journaled.
  rmSync(b.attachments, { recursive: true, force: true });
  bad(await b.call('im_v1_sync', { limit: 10 }), 'INVALID_ATTACHMENT');
  const unacked = ok(await b.call('im_v1_message', { messageId: sent.messageId }));
  assert.equal(unacked.deliveredAt, null, 'a failed save must not mark the message delivered');

  // Unwritable directory (skipped for root, which bypasses permission bits).
  if (process.getuid?.() !== 0 && process.platform !== 'win32') {
    mkdirSync(b.attachments, { recursive: true, mode: 0o700 });
    chmodSync(b.attachments, 0o500);
    try {
      bad(await b.call('im_v1_sync', { limit: 10 }), 'INVALID_ATTACHMENT');
      assert.equal(ok(await b.call('im_v1_message', { messageId: sent.messageId })).deliveredAt, null);
    } finally { chmodSync(b.attachments, 0o700); }
  } else {
    mkdirSync(b.attachments, { recursive: true, mode: 0o700 });
  }

  // Retrying after the directory is usable delivers exactly once.
  const delivered = ok(await b.call('im_v1_sync', { limit: 10 }));
  assert.equal(delivered.items.length, 1, JSON.stringify(delivered));
  assert.deepEqual(readFileSync(delivered.items[0].attachmentReceipt.path), bytes);
  assert.equal(ok(await b.call('im_v1_sync', { limit: 10 })).items.length, 0);
  assert.equal(center.central.prepare('SELECT COUNT(*) AS n FROM im_messages').get().n, 1);
  assert.equal(readdirSync(b.attachments).length, 1);
});

test('corrupt attachment bytes fail closed, stay unacknowledged, and retry cleanly', async t => {
  const center = await startCenter();
  const root = testRoot('im-local-files-corrupt-');
  t.after(async () => { await center.close(); rmSync(root, { recursive: true, force: true }); });
  const aRoot = join(root, 'a'), bRoot = join(root, 'b');
  mkdirSync(aRoot); mkdirSync(bRoot);
  const a = await launch(t, aRoot, { center: center.center, agent: center.a });
  const b = await launch(t, bRoot, { center: center.center, agent: center.b });
  const bytes = randomBytes(4096);
  const sent = await sendBytes(a, center, bytes, { dir: aRoot });
  ok(await b.call('im_v1_acquire_lease', { instanceId: randomUUID(), requestId: randomUUID() }));

  const attachment = center.central.prepare('SELECT attachment_id,data FROM im_attachments WHERE message_id=?')
    .get(sent.messageId);
  const corrupted = Buffer.from(bytes); corrupted[0] ^= 0xff;
  center.central.prepare('UPDATE im_attachments SET data=? WHERE attachment_id=?').run(corrupted, attachment.attachment_id);
  // The center detects the digest mismatch before serving bytes (fixed code); either
  // way the receive path fails closed and never ACKs or journals the message.
  bad(await b.call('im_v1_sync', { limit: 10 }), 'STORAGE_UNAVAILABLE');
  assert.equal(ok(await b.call('im_v1_message', { messageId: sent.messageId })).deliveredAt, null);
  assert.deepEqual(readdirSync(b.attachments), [], 'a corrupt download leaves no file behind');

  center.central.prepare('UPDATE im_attachments SET data=? WHERE attachment_id=?').run(attachment.data, attachment.attachment_id);
  const delivered = ok(await b.call('im_v1_sync', { limit: 10 }));
  assert.equal(delivered.items.length, 1);
  assert.deepEqual(readFileSync(delivered.items[0].attachmentReceipt.path), bytes);
  assert.equal(ok(await b.call('im_v1_sync', { limit: 10 })).items.length, 0);
});

test('local file reading enforces absolute regular files, size bounds and names', async t => {
  const root = testRoot('im-local-files-unit-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const good = join(root, 'good.bin');
  const bytes = randomBytes(2048);
  writeFileSync(good, bytes, { mode: 0o600 });
  const read = input => readLocalFileForSend(input);
  const rejects = (input, code) => assert.rejects(read(input), error => error.code === code);

  assert.deepEqual(await read({ path: good }), { name: 'good.bin', mime: null, sha256: sha256(bytes),
    size: bytes.length, dataBase64: bytes.toString('base64') });
  assert.equal((await read({ path: good, name: 'renamed.txt', mime: 'text/plain' })).name, 'renamed.txt');
  assert.equal((await read({ path: good, mime: 'text/plain' })).mime, 'text/plain');

  await rejects({ path: 'relative.bin' }, 'INVALID_REQUEST');
  await rejects({ path: join(root, 'missing.bin') }, 'INVALID_ATTACHMENT');
  await rejects({ path: root }, 'INVALID_ATTACHMENT');
  await rejects({ path: good, name: '../escape' }, 'INVALID_ATTACHMENT');
  const empty = join(root, 'empty.bin');
  writeFileSync(empty, Buffer.alloc(0));
  await rejects({ path: empty }, 'INVALID_ATTACHMENT');
  const huge = join(root, 'huge.bin');
  writeFileSync(huge, Buffer.alloc(MAX_ATTACHMENT_BYTES + 1));
  await rejects({ path: huge }, 'PAYLOAD_TOO_LARGE');
  if (process.platform !== 'win32') {
    const link = join(root, 'link.bin');
    symlinkSync(good, link);
    await rejects({ path: link }, 'INVALID_ATTACHMENT');
    assert.equal(lstatSync(link).isSymbolicLink(), true);
  }
});
