import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import https from 'node:https';
import { DatabaseSync } from 'node:sqlite';
import { createImAdmin } from '../src/im/admin.js';
import { createImMcpHttp } from '../src/im/mcp-http.js';
import { imMcpToolSchemas } from '../src/im/mcp-adapter.js';
import { createImCenter } from '../src/im/server.js';
import { migrateImSchemaV5 } from '../src/im/schema.js';
import { PROTOCOL } from '../src/im/contracts.js';

const TLS_KEY = readFileSync(new URL('./fixtures/im-tls/localhost-test-only.key', import.meta.url));
const TLS_CERT = readFileSync(new URL('./fixtures/im-tls/localhost-test-only.crt', import.meta.url));
const CENTER = 'https://localhost:8787';
const PROTOCOL_VERSION = '2025-11-25';
const policy = {
  enabled: true,
  writeMode: 'enabled',
  // The listener address is deliberately different from the advertised origin:
  // remote MCP must keep using `serverUrl` for journals, attachments and output.
  transport: { mode: 'direct-tls', serverUrl: CENTER, bindUrl: 'https://127.0.0.1:4443' },
  retention: { policy: { messageRetentionMs: 100000, attachmentRetentionMs: 90000,
    idempotencyRetentionMs: 110000, safeRetryWindowMs: 1000 } },
  lease: { ttlMs: 90000, renewalMs: 30000 },
  contacts: { requests: 'enabled' },
};

async function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
  migrateImSchemaV5(db);
  const context = {};
  const clock = () => 10000;
  const admin = createImAdmin({ db, clock, authorizeAdmin: value => value === context });
  const agents = Array.from({ length: 2 }, (_, index) => {
    const agentId = admin.registerAgent({ displayName: `Remote ${index}` }, context).agentId;
    const credential = admin.issueCredential({ agentId, expiresAt: null }, context);
    return { agentId, ...credential };
  });
  admin.setContact({ agentA: agents[0].agentId, agentB: agents[1].agentId, allowed: true, reason: 'test' }, context);
  db.exec("UPDATE im_settings SET write_mode='enabled'");
  const center = createImCenter({ db, policy, clock });
  const mcp = createImMcpHttp({ ...center.modules, policy });
  const server = https.createServer({ key: TLS_KEY, cert: TLS_CERT }, async (req, res) => {
    try {
      if (await mcp.handle(req, res)) return;
      if (await center.handler.handle(req, res)) return;
      res.statusCode = 404;
      res.end();
    } catch {
      if (!res.headersSent) { res.statusCode = 503; res.end(); } else res.destroy();
    }
  });
  await new Promise(resolve => server.listen(0, 'localhost', resolve));
  const port = server.address().port;

  function request(path, { method = 'GET', body, credential, headers = {}, headersOnly = false } = {}) {
    return new Promise((resolve, reject) => {
      const req = https.request({ host: 'localhost', port, path, method, ca: TLS_CERT,
        rejectUnauthorized: true, headers: {
          ...(credential == null ? {} : { Authorization: `Bearer ${credential}` }),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...headers,
        } }, res => {
        if (headersOnly) {
          const value = { status: res.statusCode, headers: res.headers, json: null, raw: Buffer.alloc(0) };
          res.destroy();
          resolve(value);
          return;
        }
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          let json = null;
          if ((res.headers['content-type'] ?? '').startsWith('application/json')) {
            try { json = JSON.parse(raw.toString('utf8')); } catch { /* assertion reports status */ }
          }
          resolve({ status: res.statusCode, headers: res.headers, json, raw });
        });
      });
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }

  async function rpc(sessionId, message, { credential = agents[0].credential, extra = {} } = {}) {
    return request('/mcp', { method: 'POST', credential, body: message,
      headers: {
        Accept: 'application/json, text/event-stream',
        ...(sessionId === undefined ? {} : { 'Mcp-Session-Id': sessionId }),
        ...(sessionId === undefined ? {} : { 'MCP-Protocol-Version': PROTOCOL_VERSION }),
        ...extra,
      } });
  }

  async function initialize(credential = agents[0].credential) {
    const response = await rpc(undefined, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'p9-test', version: '1' } },
    }, { credential });
    assert.equal(response.status, 200, response.raw.toString());
    const sessionId = response.headers['mcp-session-id'];
    assert.match(sessionId ?? '', /^[0-9a-f-]{36}$/);
    const initialized = await rpc(sessionId, { jsonrpc: '2.0', method: 'notifications/initialized' }, { credential });
    assert.equal([200, 202].includes(initialized.status), true, initialized.raw.toString());
    return sessionId;
  }

  return { db, agents, center, mcp, server, port, request, rpc, initialize,
    close: async () => {
      await mcp.close();
      center.close();
      await new Promise(resolve => server.close(resolve));
      db.close();
    } };
}

const resultData = response => {
  assert.equal(response.status, 200, response.raw.toString());
  assert.equal(response.json?.error, undefined, JSON.stringify(response.json));
  assert.notEqual(response.json?.result?.isError, true, JSON.stringify(response.json?.result));
  const text = response.json?.result?.content?.[0]?.text;
  assert.equal(typeof text, 'string', JSON.stringify(response.json));
  return JSON.parse(text);
};

test('remote MCP: Bearer auth, exact tools, me, lease/sync/ACK and REST delivery', async () => {
  const f = await fixture();
  try {
    const noToken = await f.rpc(undefined, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { credential: null });
    assert.equal(noToken.status, 401);
    assert.equal(noToken.json.error.code, 'AUTH_REQUIRED');
    const badToken = await f.rpc(undefined, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { credential: 'not-a-credential' });
    assert.equal(badToken.status, 401);
    assert.equal(badToken.json.error.code, 'INVALID_CREDENTIAL');

    const sessionId = await f.initialize(f.agents[0].credential);
    const listed = await f.rpc(sessionId, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.equal(listed.status, 200, listed.raw.toString());
    const names = listed.json.result.tools.map(tool => tool.name);
    assert.deepEqual(names.sort(), Object.keys(imMcpToolSchemas).sort());
    assert.equal(names.length, 20);
    assert.equal(names.every(name => name.startsWith('im_v1_')), true);
    assert.equal(names.includes('im_v1_send_file'), false);
    assert.equal(names.includes('im_v1_attachment'), true);

    const me = resultData(await f.rpc(sessionId, { jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'im_v1_me', arguments: {} } }));
    assert.deepEqual(me, { agentId: f.agents[0].agentId });

    const instanceId = randomUUID();
    const lease = resultData(await f.rpc(sessionId, { jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'im_v1_acquire_lease', arguments: { instanceId, requestId: randomUUID() } } }));
    assert.equal(lease.instanceId, instanceId);
    assert.equal(lease.generation, 1);

    const conversation = await f.request('/api/v1/conversations', { method: 'POST',
      credential: f.agents[1].credential, body: { peerAgentId: f.agents[0].agentId } });
    assert.equal(conversation.status, 200, conversation.raw.toString());
    const sent = await f.request('/api/v1/messages', { method: 'POST', credential: f.agents[1].credential,
      body: { protocol: PROTOCOL, conversationId: conversation.json.conversationId,
        recipientAgentId: f.agents[0].agentId, clientMessageId: randomUUID(), text: 'REST to remote MCP' } });
    assert.equal(sent.status, 201, sent.raw.toString());

    const sync = resultData(await f.rpc(sessionId, { jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'im_v1_sync', arguments: { limit: 20 } } }));
    assert.equal(sync.items.length, 1);
    assert.equal(sync.items[0].message.messageId, sent.json.messageId);
    assert.equal(sync.items[0].message.text, 'REST to remote MCP');
    assert.notEqual(f.db.prepare('SELECT acked_at FROM im_deliveries WHERE message_id=?')
      .get(sent.json.messageId).acked_at, null);

    const released = resultData(await f.rpc(sessionId, { jsonrpc: '2.0', id: 6, method: 'tools/call',
      params: { name: 'im_v1_release_lease', arguments: {} } }));
    assert.equal(released.released, true);

    const wrongAgent = await f.rpc(sessionId, { jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: { name: 'im_v1_me', arguments: {} } }, { credential: f.agents[1].credential });
    assert.equal(wrongAgent.status, 404);

    const get = await f.request('/mcp', { method: 'GET', credential: f.agents[0].credential,
      headers: { 'Mcp-Session-Id': sessionId, 'MCP-Protocol-Version': PROTOCOL_VERSION,
        Accept: 'text/event-stream' }, headersOnly: true });
    assert.equal(get.status, 200, JSON.stringify(get.headers));
    assert.match(get.headers['content-type'] ?? '', /^text\/event-stream/);

    const unsupported = await f.request('/mcp', { method: 'PUT', credential: f.agents[0].credential });
    assert.equal(unsupported.status, 405);
    assert.equal(unsupported.headers.allow, 'POST, GET, DELETE');

    const deleted = await f.request('/mcp', { method: 'DELETE', credential: f.agents[0].credential,
      headers: { 'Mcp-Session-Id': sessionId, 'MCP-Protocol-Version': PROTOCOL_VERSION } });
    assert.equal(deleted.status, 200, deleted.raw.toString());
    const gone = await f.rpc(sessionId, { jsonrpc: '2.0', id: 8, method: 'tools/list' });
    assert.equal(gone.status, 404);
    assert.equal(gone.json.error.code, 'RESOURCE_NOT_FOUND');

    const outside = await f.request('/mcp-extra', { credential: f.agents[0].credential });
    assert.equal(outside.status, 404);
  } finally { await f.close(); }
});
