import { randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import ipaddr from 'ipaddr.js';
import { ImError } from './contracts.js';
import { parseImConfig } from './config.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fail = code => { throw new ImError(code); };
const integer = (s, min = 0) => {
  if (typeof s !== 'string' || !/^(0|[1-9][0-9]*)$/.test(s)) fail('INVALID_REQUEST');
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < min) fail('INVALID_REQUEST');
  return n;
};
const object = (value, required, optional = []) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      required.some(k => !Object.hasOwn(value, k)) ||
      Object.keys(value).some(k => ![...required, ...optional].includes(k))) fail('INVALID_REQUEST');
  return value;
};
const id = value => { if (!UUID.test(value ?? '')) fail('INVALID_REQUEST'); return value; };
const loopback = address => {
  try { return ipaddr.process(address).range() === 'loopback'; } catch { return false; }
};
const filename = name => encodeURIComponent(name).replace(/['()*]/g,
  char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
const utf8 = new TextDecoder('utf-8', { fatal: true });

// This is a handler, not a server: the caller must set server.maxHeadersCount,
// headersTimeout, requestTimeout and maxHeaderSize before accepting connections.
export function createImHandler({ auth, acl, messages, delivery, policy, trustedTimers } = {}) {
  const timers = trustedTimers === undefined ? { setTimeout, clearTimeout } : trustedTimers;
  if (typeof timers?.setTimeout !== 'function' || typeof timers?.clearTimeout !== 'function')
    throw new ImError('POLICY_NOT_CONFIGURED');
  let config;
  try { config = structuredClone(parseImConfig(policy)); }
  catch { config = { enabled: false }; }
  // A missing or invalid explicit policy never enables this adapter.
  if (policy === undefined) config = { enabled: false };
  const limits = config.limits ?? { maxBodyBytes: 65536, maxFileBodyBytes: 16777216,
    maxConnections: 100, maxRequestsPerMinute: 600 };
  const buckets = new Map();
  const active = new Map();
  let closed = false;
  function rate(address) {
    const now = Date.now();
    for (const [key, value] of buckets) if (value.until <= now) buckets.delete(key);
    const key = typeof address === 'string' && address.length <= 64 ? address : 'unknown';
    let slot = buckets.get(key);
    if (!slot) {
      if (buckets.size >= Math.max(1, Math.min(4096, limits.maxConnections * 4))) buckets.delete(buckets.keys().next().value);
      slot = { count: 0, until: now + 60000 }; buckets.set(key, slot);
    }
    if (++slot.count > limits.maxRequestsPerMinute) fail('RATE_LIMITED');
  }
  async function handle(req, res) {
    // Do not consume or respond to any legacy or adjacent prefix.
    if (typeof req.url !== 'string' || !/^\/api\/v1(?:[/?]|$)/.test(req.url)) return false;
    const requestId = randomUUID();
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Request-Id', requestId);
    const send = (status, value) => {
      if (res.destroyed || res.writableEnded) return;
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(value));
    };
    try {
      if (closed || !config.enabled) fail('IM_DISABLED');
      if (!auth?.authenticate || !auth?.assertActive || !messages || !delivery || !acl?.assertAttachmentAccess) fail('POLICY_NOT_CONFIGURED');
      if (active.size >= limits.maxConnections) fail('RATE_LIMITED');
      let timer;
      const cleanup = () => {
        if (!active.has(res)) return;
        active.delete(res);
        timers.clearTimeout(timer);
        res.off('finish', cleanup);
        res.off('close', cleanup);
        req.off('close', requestClosed);
      };
      const requestClosed = () => { if (!req.complete && !res.writableFinished) res.destroy(); };
      active.set(res, req);
      res.once('finish', cleanup);
      res.once('close', cleanup);
      req.once('close', requestClosed);
      timer = timers.setTimeout(() => { req.destroy(); res.destroy(); }, 30000);
      timer.unref?.();
      const headers = new Map();
      let headerBytes = 0;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i].toLowerCase(), value = req.rawHeaders[i + 1];
        headerBytes += name.length + value.length + 4;
        if (headerBytes > 8192 || headers.has(name) && ['authorization', 'content-length', 'content-type',
          'x-a2a-instance-id', 'x-a2a-generation', 'transfer-encoding'].includes(name)) fail('INVALID_REQUEST');
        headers.set(name, value);
      }
      if (headers.has('transfer-encoding') && headers.has('content-length')) fail('INVALID_REQUEST');
      if (headers.has('content-length')) integer(headers.get('content-length'));
      const secure = req.socket?.encrypted === true;
      if (config.transport?.mode === 'direct-tls' ? !secure :
          config.transport?.mode === 'local-test' ?
            !(loopback(req.socket?.localAddress) && loopback(req.socket?.remoteAddress)) : true) fail('TLS_REQUIRED');
      rate(req.socket?.remoteAddress);
      const credential = headers.get('authorization');
      if (!credential) fail('AUTH_REQUIRED');
      if (!/^Bearer [A-Za-z0-9._-]{1,128}$/.test(credential)) fail('INVALID_CREDENTIAL');
      const principal = auth.authenticate(credential.slice(7));
      if (req.url.split('?', 1)[0].includes('%') || req.url.startsWith('//')) fail('INVALID_REQUEST');
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.includes('%') || url.pathname.includes('//') || url.pathname.endsWith('/') && url.pathname !== '/api/v1/') fail('INVALID_REQUEST');
      const query = (...keys) => {
        for (const [key] of url.searchParams) if (!keys.includes(key) || url.searchParams.getAll(key).length !== 1) fail('INVALID_REQUEST');
        return url.searchParams;
      };
      const page = (extra = {}) => {
        const q = query('after', 'limit');
        return { ...extra, ...(q.has('after') ? { after: q.get('after') } : {}),
          ...(q.has('limit') ? { limit: integer(q.get('limit'), 1) } : {}) };
      };
      const body = async (file = false) => {
        if (headers.get('content-type') !== 'application/json') fail('INVALID_REQUEST');
        const max = file ? limits.maxFileBodyBytes : limits.maxBodyBytes;
        if (headers.has('content-length') && integer(headers.get('content-length')) > max) fail('PAYLOAD_TOO_LARGE');
        let size = 0;
        const chunks = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > max) fail('PAYLOAD_TOO_LARGE');
          chunks.push(chunk);
        }
        if (!req.complete) fail('INVALID_REQUEST');
        let parsed;
        try { parsed = JSON.parse(utf8.decode(Buffer.concat(chunks, size))); }
        catch { fail('INVALID_REQUEST'); }
        if (file && !parsed?.attachment && size > limits.maxBodyBytes) fail('PAYLOAD_TOO_LARGE');
        return parsed;
      };
      const noBody = () => {
        if (headers.has('transfer-encoding') || headers.has('content-length') && integer(headers.get('content-length')) !== 0) fail('INVALID_REQUEST');
      };
      const path = url.pathname, method = req.method;
      if (config.writeMode !== 'enabled' && method === 'POST' &&
          (path === '/api/v1/messages' || path === '/api/v1/conversations' ||
           path === '/api/v1/acks' || path.startsWith('/api/v1/receiver/lease') ||
           /^\/api\/v1\/messages\/[^/]+\/read$/.test(path))) fail('NEW_WRITES_DISABLED');
      let result, status = 200;
      if (method === 'GET' && path === '/api/v1/me') {
        query(); noBody(); auth.assertActive(principal); result = { agentId: principal.agentId };
      } else if (method === 'GET' && path === '/api/v1/contacts') { noBody(); result = messages.listContacts(principal, page()); }
      else if (method === 'GET' && path === '/api/v1/conversations') { noBody(); result = messages.listConversations(principal, page()); }
      else if (method === 'POST' && path === '/api/v1/conversations') {
        query(); result = messages.ensureConversation(principal, object(await body(), ['peerAgentId']));
      } else if (method === 'GET' && /^\/api\/v1\/conversations\/[^/]+\/messages$/.test(path)) {
        noBody(); result = messages.listHistory(principal, page({ conversationId: id(path.split('/')[4]) }));
      } else if (method === 'POST' && path === '/api/v1/messages') {
        query(); result = messages.send(principal, await body(true)); status = result.replayed ? 200 : 201;
      } else if (method === 'GET' && /^\/api\/v1\/sends\/[^/]+$/.test(path)) {
        query(); noBody(); result = messages.getSendResult(principal, { clientMessageId: id(path.split('/')[4]) });
      } else if (method === 'GET' && /^\/api\/v1\/messages\/[^/]+$/.test(path)) {
        query(); noBody(); result = messages.getMessage(principal, { messageId: id(path.split('/')[4]) });
      } else if (method === 'GET' && /^\/api\/v1\/attachments\/[^/]+$/.test(path)) {
        query(); noBody();
        const attachmentId = id(path.split('/')[4]);
        const attachment = messages.getAttachment(principal, { attachmentId });
        if (!Buffer.isBuffer(attachment.data) || attachment.data.length > 10 * 1024 * 1024) fail('STORAGE_UNAVAILABLE');
        acl.assertAttachmentAccess(principal, attachmentId);
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Length', attachment.data.length);
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename(attachment.name)}`);
        for (let offset = 0; offset < attachment.data.length && !res.destroyed; offset += 65536) {
          acl.assertAttachmentAccess(principal, attachmentId);
          if (!res.write(attachment.data.subarray(offset, offset + 65536))) {
            await new Promise(resolve => {
              const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
              res.once('drain', done); res.once('close', done);
            });
          }
        }
        if (!res.destroyed) res.end();
        return true;
      } else if (method === 'POST' && /^\/api\/v1\/messages\/[^/]+\/read$/.test(path)) {
        query(); object(await body(), []); result = messages.markRead(principal, { messageId: id(path.split('/')[4]) });
      } else if (method === 'POST' && path === '/api/v1/receiver/lease') {
        query(); result = delivery.acquire(principal, object(await body(), ['instanceId', 'requestId']));
      } else if (method === 'POST' && path === '/api/v1/receiver/lease/renew') {
        query(); result = delivery.renew(principal, object(await body(), ['instanceId', 'generation']));
      } else if (method === 'POST' && path === '/api/v1/receiver/lease/release') {
        query(); result = delivery.release(principal, object(await body(), ['instanceId', 'generation']));
      } else if (method === 'GET' && path === '/api/v1/sync') {
        noBody(); const q = query('after', 'streamEpoch', 'limit');
        result = delivery.sync(principal, { instanceId: id(headers.get('x-a2a-instance-id')),
          generation: integer(headers.get('x-a2a-generation'), 1),
          ...(q.has('after') ? { after: integer(q.get('after')) } : {}),
          ...(q.has('streamEpoch') ? { streamEpoch: id(q.get('streamEpoch')) } : {}),
          ...(q.has('limit') ? { limit: integer(q.get('limit'), 1) } : {}) });
      } else if (method === 'POST' && path === '/api/v1/acks') {
        query(); result = delivery.ack(principal, object(await body(), ['instanceId', 'generation', 'messageIds']));
      } else { query(); noBody(); fail('RESOURCE_NOT_FOUND'); }
      send(status, result);
    } catch (error) {
      const safe = error instanceof ImError ? error : new ImError('STORAGE_UNAVAILABLE');
      if (res.headersSent) res.destroy();
      else {
        if (safe.code === 'RATE_LIMITED') res.setHeader('Retry-After', '60');
        send(safe.status, { error: { code: safe.code, message: safe.message, retryable: safe.retryable }, requestId });
      }
    }
    return true;
  }
  function close() {
    closed = true;
    buckets.clear();
    // Only responses currently owned by this handler; never destroy caller's server/listener.
    for (const [response, request] of active) { request.destroy(); response.destroy(); }
    active.clear();
  }
  return Object.freeze({ handle, close });
}
