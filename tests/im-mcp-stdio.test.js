import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import https from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { imMcpToolSchemas } from '../src/im/mcp-adapter.js';
import { readNanaConfigFile } from '../src/im/mcp-stdio.js';
import { createImAdmin } from '../src/im/admin.js';
import { createImAuth } from '../src/im/auth.js';
import { createImAcl } from '../src/im/acl.js';
import { createImMessages } from '../src/im/messages.js';
import { createImDelivery } from '../src/im/delivery.js';
import { createImHandler } from '../src/im/http.js';
import { migrateImSchema } from '../src/im/schema.js';
import { PROTOCOL } from '../src/im/contracts.js';

const SCRIPT = resolve('scripts/im-mcp.mjs');
const CERT_PATH = fileURLToPath(new URL('./fixtures/im-tls/localhost-test-only.crt', import.meta.url));
const cert = readFileSync(CERT_PATH);
const key = readFileSync(new URL('./fixtures/im-tls/localhost-test-only.key', import.meta.url));

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
  const requests = [];
  const server = https.createServer({ key, cert }, (req, res) => {
    requests.push({ method: req.method, path: req.url });
    handler.handle(req, res).catch(() => res.destroy());
  });
  server.maxHeadersCount = 64;
  await new Promise(done => server.listen(0, 'localhost', done));
  const center = `https://localhost:${server.address().port}`;
  return { center, a, b, admin, context, requests,
    close: async () => { handler.close(); await new Promise(done => server.close(done)); central.close(); } };
}

// `statePath`/`evidencePath` are part of the shared `nana.json` schema; the stdio entry
// validates but does not need them.
function writeHost(root, { center, agent, credentialMode = 0o600, overrides = {}, extra = {} }) {
  mkdirSync(join(root, 'host'), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, 'attachments'), { recursive: true, mode: 0o700 });
  const credentialFile = join(root, 'credential');
  writeFileSync(credentialFile, `${agent.credential}\n`, { mode: credentialMode });
  chmodSync(credentialFile, credentialMode);
  const config = { serverUrl: center, agentId: agent.agentId, credentialFile,
    journalPath: join(root, 'host', 'journal.sqlite'), attachmentDirectory: join(root, 'attachments'),
    statePath: join(root, 'host', 'session-state.json'), evidencePath: join(root, 'host', 'evidence.jsonl'),
    ...overrides };
  const configPath = join(root, 'nana.json');
  writeFileSync(configPath, JSON.stringify({ ...config, ...extra }), { mode: 0o600 });
  return { configPath, config };
}

async function launch(t, root, center, agent) {
  const { configPath, config } = writeHost(root, { center, agent });
  const transport = new StdioClientTransport({ command: process.execPath, args: [SCRIPT, '--config', configPath],
    env: { NODE_EXTRA_CA_CERTS: CERT_PATH }, stderr: 'pipe' });
  const sdk = new Client({ name: 'stdio-host', version: '1.0.0' });
  const stderr = [];
  transport.stderr.on('data', chunk => stderr.push(chunk.toString('utf8')));
  t.after(async () => { await sdk.close(); await transport.close(); });
  await sdk.connect(transport);
  const call = async (name, args = {}) => sdk.callTool({ name, arguments: args });
  return { sdk, call, config, stderr: () => stderr.join('') };
}

const decode = response => JSON.parse(response.content[0].text);

test('MCP stdio entry: real SDK StdioClientTransport lists and calls IM tools without background work', async t => {
  const center = await startCenter();
  const root = mkdtempSync(join(tmpdir(), 'im-mcp-stdio-'));
  const bRoot = join(root, 'b');
  t.after(async () => { await center.close(); rmSync(root, { recursive: true, force: true }); });
  const a = await launch(t, root, center.center, center.a);
  const b = await launch(t, bRoot, center.center, center.b);

  // Startup, initialize and discovery never contact the center and never poll.
  assert.equal(center.requests.length, 0, 'startup makes no HTTP request');
  const { tools } = await a.sdk.listTools();
  const names = tools.map(tool => tool.name);
  assert.deepEqual(names.toSorted(), Object.keys(imMcpToolSchemas).toSorted());
  assert.equal(names.length, 16);
  assert.ok(names.every(name => name.startsWith('im_v1_')));
  for (const tool of tools) {
    assert.notEqual(tool.inputSchema.additionalProperties, true, tool.name);
    const properties = Object.keys(tool.inputSchema.properties ?? {});
    assert.equal(properties.includes('credential'), false, `${tool.name} must not accept a credential`);
    assert.equal(properties.includes('serverUrl'), false, `${tool.name} must not accept a server URL`);
    assert.equal(properties.includes('config'), false, `${tool.name} must not accept a config`);
  }
  assert.equal(center.requests.length, 0, 'listTools makes no HTTP request');
  await delay(500);
  assert.equal(center.requests.length, 0, 'idle stdio server does not poll');

  const me = await a.call('im_v1_me');
  assert.notEqual(me.isError, true, me.content?.[0]?.text);
  assert.deepEqual(decode(me), { agentId: center.a.agentId });
  const contacts = await a.call('im_v1_contacts');
  assert.notEqual(contacts.isError, true, contacts.content?.[0]?.text);
  assert.ok(Array.isArray(decode(contacts).items), contacts.content[0].text);

  // Body-carrying POSTs work (the default adapter transport drops bodies): acquire a
  // lease, send a text from A to B, then receive it via sync on B.
  const lease = decode(await b.call('im_v1_acquire_lease', { instanceId: randomUUID(), requestId: randomUUID() }));
  assert.equal(lease.generation, 1);
  const conversation = decode(await a.call('im_v1_ensure_conversation', { peerAgentId: center.b.agentId }));
  assert.match(conversation.conversationId, /^[0-9a-f-]{36}$/);
  const sent = decode(await a.call('im_v1_send', { protocol: PROTOCOL, conversationId: conversation.conversationId,
    recipientAgentId: center.b.agentId, clientMessageId: randomUUID(), text: 'untrusted synthetic body' }));
  assert.match(sent.messageId, /^[0-9a-f-]{36}$/, JSON.stringify(sent));
  assert.equal(decode(await a.call('im_v1_get_send_result', { clientMessageId: sent.clientMessageId })).messageId, sent.messageId);

  const synced = decode(await b.call('im_v1_sync', { limit: 5 }));
  assert.equal(synced.items.length, 1, JSON.stringify(synced));
  assert.equal(synced.items[0].message.messageId, sent.messageId);
  assert.equal(synced.items[0].status, 'delivered');
  assert.equal(decode(await b.call('im_v1_release_lease', {})).released, true);
  assert.ok(existsSync(b.config.journalPath), 'durable journal is created under the configured path');

  // A revoked credential fails closed with a fixed code and never leaks the token.
  center.admin.revokeCredential({ credentialId: center.a.credentialId, reason: 'stdio test' }, center.context);
  const revoked = await a.call('im_v1_me');
  assert.equal(revoked.isError, true);
  assert.equal(decode(revoked).error.code, 'INVALID_CREDENTIAL');
  // A credential file removed while the host is running also fails closed locally.
  rmSync(a.config.credentialFile);
  const missing = await a.call('im_v1_me');
  assert.equal(missing.isError, true);
  assert.equal(decode(missing).error.code, 'AUTH_REQUIRED');
  const transcript = `${JSON.stringify(await Promise.all([me, contacts, synced, revoked, missing]))}${a.stderr()}${b.stderr()}`;
  assert.equal(transcript.includes(center.a.credential), false, 'credential never appears in results or stderr');
  assert.equal(transcript.includes(center.b.credential), false, 'credential never appears in results or stderr');
});

test('nana.json stays strict: unknown fields, relative paths and non-https origins are rejected', () => {
  const root = mkdtempSync(join(tmpdir(), 'im-mcp-config-'));
  try {
    const base = { serverUrl: 'https://localhost:8787', agentId: randomUUID(),
      credentialFile: join(root, 'credential'), journalPath: join(root, 'journal.sqlite'),
      attachmentDirectory: join(root, 'attachments'), statePath: join(root, 'state.json') };
    writeFileSync(base.credentialFile, 'abc.def\n', { mode: 0o600 });
    const parse = value => {
      const path = join(root, 'nana.json');
      writeFileSync(path, JSON.stringify(value));
      return readNanaConfigFile(path);
    };
    assert.deepEqual(parse(base), base);
    assert.throws(() => parse({ ...base, extra: true }), { code: 'INVALID_REQUEST' });
    assert.throws(() => parse({ ...base, serverUrl: 'http://localhost:8787' }), { code: 'INVALID_REQUEST' });
    assert.throws(() => parse({ ...base, journalPath: 'journal.sqlite' }), { code: 'INVALID_REQUEST' });
    assert.throws(() => parse({ ...base, credentialFile: 'credential' }), { code: 'INVALID_REQUEST' });
    assert.throws(() => parse({ ...base, agentId: 'not-a-uuid' }), { code: 'INVALID_REQUEST' });
    assert.throws(() => parse({ ...base, statePath: undefined }), { code: 'INVALID_REQUEST' });
    assert.throws(() => readNanaConfigFile(join(root, 'missing.json')), { code: 'INVALID_REQUEST' });
    assert.throws(() => readNanaConfigFile('nana.json'), { code: 'INVALID_REQUEST' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('credential file is the only credential source and insecure or missing files fail closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'im-mcp-credential-'));
  try {
    const base = { serverUrl: 'https://localhost:8787', agentId: randomUUID(),
      credentialFile: join(root, 'credential'), journalPath: join(root, 'journal.sqlite'),
      attachmentDirectory: join(root, 'attachments'), statePath: join(root, 'state.json') };
    mkdirSync(base.attachmentDirectory, { recursive: true });
    const start = config => {
      const path = join(root, 'nana.json');
      writeFileSync(path, JSON.stringify(config));
      return spawnSync(process.execPath, [SCRIPT, '--config', path],
        { encoding: 'utf8', timeout: 10000, env: { ...process.env, NODE_EXTRA_CA_CERTS: CERT_PATH } });
    };
    writeFileSync(base.credentialFile, 'abc.def\n', { mode: 0o600 });
    chmodSync(base.credentialFile, 0o600);

    // Missing credential file.
    rmSync(base.credentialFile);
    let run = start(base);
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '');
    assert.equal(JSON.parse(run.stderr).error.code, 'AUTH_REQUIRED');

    if (process.platform !== 'win32') {
      writeFileSync(base.credentialFile, 'abc.def\n');
      chmodSync(base.credentialFile, 0o644);
      run = start(base);
      assert.equal(run.status, 1);
      assert.equal(run.stdout, '');
      assert.equal(JSON.parse(run.stderr).error.code, 'AUTH_REQUIRED');

      // A symlink is never followed, even when its target is owner-only.
      rmSync(base.credentialFile);
      writeFileSync(join(root, 'target-credential'), 'abc.def\n', { mode: 0o600 });
      symlinkSync(join(root, 'target-credential'), base.credentialFile);
      run = start(base);
      assert.equal(run.status, 1);
      assert.equal(run.stdout, '');
      assert.equal(JSON.parse(run.stderr).error.code, 'AUTH_REQUIRED');
      rmSync(base.credentialFile);
    }

    // Credential-shaped text is never accepted from the config or as an extra flag.
    writeFileSync(base.credentialFile, 'secret\n', { mode: 0o600 });
    chmodSync(base.credentialFile, 0o600);
    const configPath = join(root, 'nana.json');
    writeFileSync(configPath, JSON.stringify({ ...base, credential: 'secret' }));
    run = spawnSync(process.execPath, [SCRIPT, '--config', configPath],
      { encoding: 'utf8', timeout: 10000 });
    assert.equal(run.status, 1);
    assert.equal(JSON.parse(run.stderr).error.code, 'INVALID_REQUEST');
    writeFileSync(configPath, JSON.stringify(base));
    run = spawnSync(process.execPath, [SCRIPT, '--config', configPath, '--credential', 'secret'],
      { encoding: 'utf8', timeout: 10000 });
    assert.equal(run.status, 1);
    assert.equal(JSON.parse(run.stderr).error.code, 'INVALID_REQUEST');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
