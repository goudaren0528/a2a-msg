import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { ImError } from './contracts.js';
import { parseImConfig } from './config.js';
import { createImJournal } from './journal.js';
import { createImMcpAdapter } from './mcp-adapter.js';

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BEARER = /^Bearer ([A-Za-z0-9._-]{1,128})$/;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const MAX_HEADER_BYTES = 8192;
const SESSION_IDLE_MS = 30 * 60 * 1000;
const SESSION_MAX_MS = 8 * 60 * 60 * 1000;
const MAX_SESSIONS = 64;
const REQUEST_TIMEOUT_MS = 30000;

const fail = code => { throw new ImError(code); };
const base = req => {
  const index = typeof req.url === 'string' ? req.url.indexOf('?') : -1;
  return index === -1 ? req.url : req.url.slice(0, index);
};
const integer = (value, min = 0) => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) fail('INVALID_REQUEST');
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min) fail('INVALID_REQUEST');
  return number;
};
const jsonResponse = (res, status, value, extraHeaders = {}) => {
  if (res.destroyed || res.writableEnded) return;
  const body = Buffer.from(JSON.stringify(value));
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', body.length);
  res.setHeader('Cache-Control', 'no-store');
  for (const [name, value] of Object.entries(extraHeaders)) res.setHeader(name, value);
  res.end(body);
};
const fixedError = (res, error, requestId) => {
  const safe = error instanceof ImError ? error : new ImError('STORAGE_UNAVAILABLE');
  jsonResponse(res, safe.status, { error: { code: safe.code, message: safe.message, retryable: safe.retryable },
    requestId }, safe.code === 'RATE_LIMITED' ? { 'Retry-After': '60' } : {});
};

function headerMap(req) {
  const headers = new Map();
  let bytes = 0;
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    const name = String(req.rawHeaders[index]).toLowerCase();
    const value = String(req.rawHeaders[index + 1]);
    bytes += name.length + value.length + 4;
    if (bytes > MAX_HEADER_BYTES) fail('INVALID_REQUEST');
    if (headers.has(name) && ['authorization', 'content-length', 'content-type', 'mcp-session-id',
      'mcp-protocol-version', 'origin', 'transfer-encoding'].includes(name)) fail('INVALID_REQUEST');
    headers.set(name, value);
  }
  if (headers.has('transfer-encoding') && headers.has('content-length')) fail('INVALID_REQUEST');
  return headers;
}

function readBody(req, limit) {
  return (async () => {
    if (!req.complete && req.readableEnded) fail('INVALID_REQUEST');
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) fail('PAYLOAD_TOO_LARGE');
      chunks.push(chunk);
    }
    if (!req.complete) fail('INVALID_REQUEST');
    if (size === 0) fail('INVALID_REQUEST');
    try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
    catch { fail('INVALID_REQUEST'); }
  })();
}

function queryInput(url, allowed) {
  for (const [key] of url.searchParams) {
    if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) fail('INVALID_REQUEST');
  }
  return url.searchParams;
}

function pageInput(url) {
  const query = queryInput(url, ['after', 'limit']);
  return {
    ...(query.has('after') ? { after: query.get('after') } : {}),
    ...(query.has('limit') ? { limit: integer(query.get('limit'), 1) } : {}),
  };
}

// The remote adapter calls this in-process transport instead of making an HTTPS
// loopback request to the same center. The session principal is authenticated
// once at the HTTP boundary; every module call still re-checks it through
// `auth.assertActive`, so revocation takes effect without restarting a session.
function createInternalTransport({ auth, acl, messages, contacts, delivery, principal }) {
  const credentialId = principal.credentialId;
  const respond = (status, value) => ({ status, body: Buffer.from(JSON.stringify(value)) });
  const respondError = error => {
    const safe = error instanceof ImError ? error : new ImError('STORAGE_UNAVAILABLE');
    return respond(safe.status, { error: { code: safe.code, message: safe.message, retryable: safe.retryable } });
  };
  return async ({ method, path, credential, body, headers = {}, binary } = {}) => {
    try {
      if (credential !== credentialId) fail('INVALID_CREDENTIAL');
      if (typeof path !== 'string' || !path.startsWith('/api/v1/')) fail('INVALID_REQUEST');
      const url = new URL(path, 'http://internal');
      if (url.origin !== 'http://internal' || url.hash) fail('INVALID_REQUEST');
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] !== 'api' || parts[1] !== 'v1') fail('RESOURCE_NOT_FOUND');
      const header = name => {
        const lower = name.toLowerCase();
        for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === lower) return value;
        return undefined;
      };
      const parsedBody = () => {
        if (body === undefined) fail('INVALID_REQUEST');
        try { return JSON.parse(body); } catch { fail('INVALID_REQUEST'); }
      };
      if (method === 'GET' && url.pathname === '/api/v1/me') {
        queryInput(url, []);
        auth.assertActive(principal);
        return respond(200, { agentId: principal.agentId });
      }
      if (method === 'GET' && url.pathname === '/api/v1/contacts')
        return respond(200, messages.listContacts(principal, pageInput(url)));
      if (method === 'GET' && url.pathname === '/api/v1/conversations')
        return respond(200, messages.listConversations(principal, pageInput(url)));
      if (method === 'POST' && url.pathname === '/api/v1/conversations') {
        queryInput(url, []);
        return respond(200, messages.ensureConversation(principal, parsedBody()));
      }
      if (method === 'GET' && /^\/api\/v1\/conversations\/[0-9a-f-]+\/messages$/.test(url.pathname)) {
        const conversationId = parts[3];
        if (!UUID.test(conversationId)) fail('INVALID_REQUEST');
        return respond(200, messages.listHistory(principal, { conversationId, ...pageInput(url) }));
      }
      if (method === 'POST' && url.pathname === '/api/v1/contact-requests') {
        if (typeof contacts?.request !== 'function') fail('POLICY_NOT_CONFIGURED');
        queryInput(url, []);
        return respond(201, contacts.request(principal, parsedBody()));
      }
      if (method === 'GET' && url.pathname === '/api/v1/contact-requests') {
        if (typeof contacts?.list !== 'function') fail('POLICY_NOT_CONFIGURED');
        const query = queryInput(url, ['after', 'limit', 'direction']);
        return respond(200, contacts.list(principal, {
          ...(query.has('after') ? { after: query.get('after') } : {}),
          ...(query.has('limit') ? { limit: integer(query.get('limit'), 1) } : {}),
          ...(query.has('direction') ? { direction: query.get('direction') } : {}),
        }));
      }
      if (method === 'POST' && /^\/api\/v1\/contact-requests\/[0-9a-f-]+\/(?:accept|reject|revoke)$/.test(url.pathname)) {
        const requestId = parts[3], action = parts[4];
        if (!UUID.test(requestId)) fail('INVALID_REQUEST');
        if (action === 'revoke' ? typeof contacts?.revoke !== 'function' : typeof contacts?.respond !== 'function')
          fail('POLICY_NOT_CONFIGURED');
        queryInput(url, []);
        const input = parsedBody();
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 0)
          fail('INVALID_REQUEST');
        return respond(200, action === 'revoke' ? contacts.revoke(principal, { requestId })
          : contacts.respond(principal, { requestId, action }));
      }
      if (method === 'POST' && url.pathname === '/api/v1/messages') {
        queryInput(url, []);
        return respond(201, messages.send(principal, parsedBody()));
      }
      if (method === 'GET' && /^\/api\/v1\/sends\/[0-9a-f-]+$/.test(url.pathname)) {
        queryInput(url, []);
        return respond(200, messages.getSendResult(principal, { clientMessageId: parts[3] }));
      }
      if (method === 'GET' && /^\/api\/v1\/messages\/[0-9a-f-]+$/.test(url.pathname)) {
        queryInput(url, []);
        return respond(200, messages.getMessage(principal, { messageId: parts[3] }));
      }
      if (method === 'GET' && /^\/api\/v1\/attachments\/[0-9a-f-]+$/.test(url.pathname)) {
        queryInput(url, []);
        const attachment = messages.getAttachment(principal, { attachmentId: parts[3] });
        if (!Buffer.isBuffer(attachment.data)) fail('STORAGE_UNAVAILABLE');
        acl.assertAttachmentAccess(principal, parts[3]);
        if (!binary) fail('INVALID_REQUEST');
        return { status: 200, body: attachment.data };
      }
      if (method === 'POST' && /^\/api\/v1\/messages\/[0-9a-f-]+\/read$/.test(url.pathname)) {
        queryInput(url, []);
        const input = parsedBody();
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 0)
          fail('INVALID_REQUEST');
        return respond(200, messages.markRead(principal, { messageId: parts[3] }));
      }
      if (method === 'POST' && url.pathname === '/api/v1/receiver/lease') {
        queryInput(url, []);
        return respond(200, delivery.acquire(principal, parsedBody()));
      }
      if (method === 'POST' && url.pathname === '/api/v1/receiver/lease/renew') {
        queryInput(url, []);
        return respond(200, delivery.renew(principal, parsedBody()));
      }
      if (method === 'POST' && url.pathname === '/api/v1/receiver/lease/release') {
        queryInput(url, []);
        return respond(200, delivery.release(principal, parsedBody()));
      }
      if (method === 'GET' && url.pathname === '/api/v1/sync') {
        const query = queryInput(url, ['after', 'streamEpoch', 'limit']);
        const instanceId = header('x-a2a-instance-id');
        if (typeof instanceId !== 'string' || !UUID.test(instanceId)) fail('INVALID_REQUEST');
        const generation = header('x-a2a-generation');
        return respond(200, delivery.sync(principal, {
          instanceId, generation: integer(generation, 1),
          ...(query.has('after') ? { after: integer(query.get('after')) } : {}),
          ...(query.has('streamEpoch') ? { streamEpoch: query.get('streamEpoch') } : {}),
          ...(query.has('limit') ? { limit: integer(query.get('limit'), 1) } : {}),
        }));
      }
      if (method === 'POST' && url.pathname === '/api/v1/acks') {
        queryInput(url, []);
        return respond(200, delivery.ack(principal, parsedBody()));
      }
      fail('RESOURCE_NOT_FOUND');
    } catch (error) {
      return respondError(error);
    }
  };
}

function sessionDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'a2a-msg-mcp-'));
  chmodSync(directory, 0o700);
  return directory;
}

/**
 * Mount the IM v1 MCP adapter over MCP Streamable HTTP.
 *
 * Every session is bound to one authenticated Agent credential. The HTTP
 * credential is only used at this boundary; it is never stored in the session,
 * passed to a tool, or included in an MCP response.
 */
export function createImMcpHttp({ auth, acl, messages, contacts, delivery, policy } = {}) {
  const config = parseImConfig(policy);
  if (typeof auth?.authenticate !== 'function' || typeof auth?.assertActive !== 'function' ||
      !messages || !delivery || typeof acl?.assertAttachmentAccess !== 'function') {
    throw new ImError('POLICY_NOT_CONFIGURED');
  }
  let origin = null;
  try { origin = config.transport ? new URL(config.transport.serverUrl).origin : null; } catch { /* disabled policy */ }
  const limits = config.limits;
  const sessions = new Map();
  const buckets = new Map();
  const timers = [];
  let closed = false;

  function rate(address) {
    const now = Date.now();
    for (const [key, value] of buckets) if (value.until <= now) buckets.delete(key);
    const key = typeof address === 'string' && address.length <= 64 ? address : 'unknown';
    let slot = buckets.get(key);
    if (!slot) {
      if (buckets.size >= Math.max(1, Math.min(4096, limits.maxConnections * 4)))
        buckets.delete(buckets.keys().next().value);
      slot = { count: 0, until: now + 60000 };
      buckets.set(key, slot);
    }
    if (++slot.count > limits.maxRequestsPerMinute) fail('RATE_LIMITED');
  }

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const entry of sessions.values()) {
      if (entry.streaming > 0) continue;
      if (now - entry.lastUsed > SESSION_IDLE_MS || now - entry.createdAt > SESSION_MAX_MS) entry.close();
    }
  }, 60000);
  sweep.unref?.();
  timers.push(sweep);

  async function newSession(principal, requestId) {
    if (sessions.size >= MAX_SESSIONS) fail('RATE_LIMITED');
    const directory = sessionDirectory();
    let db, adapter, server, transport;
    const entry = {
      principal, createdAt: Date.now(), lastUsed: Date.now(), streaming: 0, closed: false,
      sessionId: undefined,
      close: async () => {
        if (entry.closed) return;
        entry.closed = true;
        if (entry.sessionId) sessions.delete(entry.sessionId);
        try { await server?.close(); } catch { /* already closed */ }
        try { await transport?.close(); } catch { /* already closed */ }
        try { adapter?.close(); } catch { /* already closed */ }
        try { db?.close(); } catch { /* already closed */ }
        try { rmSync(directory, { recursive: true, force: true }); } catch { /* best effort */ }
      },
    };
    try {
      db = new DatabaseSync(join(directory, 'journal.sqlite'));
      chmodSync(join(directory, 'journal.sqlite'), 0o600);
      db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
      adapter = createImMcpAdapter({
        serverUrl: origin,
        agentId: principal.agentId,
        getCredential: async () => principal.credentialId,
        journal: scope => createImJournal({ db, ...scope }),
        attachmentDirectory: directory,
        transport: createInternalTransport({ auth, acl, messages, contacts, delivery, principal }),
      });
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        keepAliveMs: 15000,
        onsessioninitialized: sessionId => {
          entry.sessionId = sessionId;
          sessions.set(sessionId, entry);
        },
        onsessionclosed: async () => { await entry.close(); },
      });
      transport.onclose = () => { void entry.close(); };
      entry.transport = transport;
      server = new McpServer({ name: 'a2a-msg-im-http', version: '0.1.0' });
      adapter.register(server);
      await server.connect(transport);
      entry.requestId = requestId;
      return entry;
    } catch (error) {
      await entry.close();
      throw error;
    }
  }

  async function handle(req, res) {
    if (typeof req.url !== 'string' || base(req) !== '/mcp') return false;
    const requestId = randomUUID();
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    let timer;
    try {
      if (closed) fail('IM_DISABLED');
      if (req.socket?.encrypted !== true) fail('TLS_REQUIRED');
      if (!config.enabled) fail('IM_DISABLED');
      if (config.transport?.mode !== 'direct-tls' || origin === null) fail('TLS_REQUIRED');
      rate(req.socket?.remoteAddress);
      const headers = headerMap(req);
      const url = new URL(req.url, 'http://internal');
      if (url.pathname !== '/mcp' || url.search !== '' || url.hash) fail('INVALID_REQUEST');
      if (headers.has('origin') && headers.get('origin') !== origin) fail('OPERATION_FORBIDDEN');
      const authorization = headers.get('authorization');
      if (!authorization) fail('AUTH_REQUIRED');
      const bearer = BEARER.exec(authorization);
      if (!bearer) fail('INVALID_CREDENTIAL');
      const principal = auth.authenticate(bearer[1]);
      auth.assertActive(principal);

      const method = req.method;
      if (!['POST', 'GET', 'DELETE'].includes(method)) {
        jsonResponse(res, 405, { error: { code: 'INVALID_REQUEST', message: 'Method not allowed',
          retryable: false }, requestId }, { Allow: 'POST, GET, DELETE' });
        return true;
      }
      const sessionHeader = headers.get('mcp-session-id');
      if (sessionHeader !== undefined && !SESSION_ID.test(sessionHeader)) fail('INVALID_REQUEST');
      let entry = sessionHeader === undefined ? undefined : sessions.get(sessionHeader);
      if (sessionHeader !== undefined && (!entry || entry.closed ||
          entry.principal.agentId !== principal.agentId ||
          entry.principal.credentialId !== principal.credentialId)) {
        fail('RESOURCE_NOT_FOUND');
      }

      if (method !== 'POST') {
        if (headers.has('content-length') && integer(headers.get('content-length')) !== 0) fail('INVALID_REQUEST');
        if (headers.has('transfer-encoding')) fail('INVALID_REQUEST');
        if (!entry) fail('INVALID_REQUEST');
        entry.lastUsed = Date.now();
        timer = setTimeout(() => { req.destroy(); res.destroy(); }, REQUEST_TIMEOUT_MS);
        timer.unref?.();
        if (method === 'GET') entry.streaming += 1;
        try { await entry.transport.handleRequest(req, res); }
        finally {
          if (method === 'GET') entry.streaming = Math.max(0, entry.streaming - 1);
          entry.lastUsed = Date.now();
          clearTimeout(timer);
        }
        return true;
      }

      if (headers.get('content-type') !== 'application/json') fail('INVALID_REQUEST');
      const max = limits.maxFileBodyBytes;
      if (headers.has('content-length') && integer(headers.get('content-length')) > max) fail('PAYLOAD_TOO_LARGE');
      timer = setTimeout(() => { req.destroy(); res.destroy(); }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
      const body = await readBody(req, max);
      clearTimeout(timer);
      if (entry) {
        entry.lastUsed = Date.now();
        await entry.transport.handleRequest(req, res, body);
        return true;
      }
      if (!isInitializeRequest(body)) fail('INVALID_REQUEST');
      entry = await newSession(principal, requestId);
      entry.lastUsed = Date.now();
      try { await entry.transport.handleRequest(req, res, body); }
      catch (error) { await entry.close(); throw error; }
      if (!entry.sessionId) await entry.close();
      return true;
    } catch (error) {
      clearTimeout(timer);
      if (res.headersSent) res.destroy();
      else fixedError(res, error, requestId);
      return true;
    }
  }

  async function close() {
    if (closed) return;
    closed = true;
    for (const timer of timers) clearInterval(timer);
    buckets.clear();
    const entries = [...new Set(sessions.values())];
    await Promise.all(entries.map(entry => entry.close().catch(() => {})));
    sessions.clear();
  }

  return Object.freeze({ handle, close, origin });
}
