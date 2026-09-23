import https from 'node:https';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ImError, normalizeMessageRequest, fingerprintMessage, MAX_ATTACHMENT_BYTES } from './contracts.js';
import { saveAttachment, verifyAttachment, attachmentPath } from './client-files.js';

const fail = code => { throw new ImError(code); };
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const id = v => { if (typeof v !== 'string' || !UUID.test(v)) fail('INVALID_REQUEST'); return v; };
const integer = (v, min = 0) => Number.isSafeInteger(v) && v >= min;
const MAX_JSON = 16 * 1024 * 1024;
const MAX_BINARY = MAX_ATTACHMENT_BYTES;
const REQUEST_DEADLINE_MS = 30000;
const MESSAGE_FIELDS = ['messageId','conversationId','senderAgentId','recipientAgentId','clientMessageId','title','text','inReplyTo','correlation','acceptedAt','attachment'];
const ATTACHMENT_FIELDS = ['attachmentId','name','mime','size','sha256'];
const sameFields = (a, b, fields) => obj(a) && obj(b) && fields.every(k => a[k] === b[k]);
const sameMessage = (a, b) => sameFields(a, b, MESSAGE_FIELDS.filter(k => k !== 'attachment')) &&
  (a.attachment === null && b.attachment === null || sameFields(a.attachment, b.attachment, ATTACHMENT_FIELDS));
function origin(input) {
  if (typeof input !== 'string' || input.length > 2048) fail('INVALID_REQUEST');
  let u;
  try { u = new URL(input); } catch { fail('INVALID_REQUEST'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.pathname !== '/' ||
      input !== u.origin && input !== `${u.origin}/`) fail('INVALID_REQUEST');
  return u.origin;
}
const pathId = id => encodeURIComponent(id);
const obj = v => v && typeof v === 'object' && !Array.isArray(v);
function safeError(e) { return e instanceof ImError ? e : new ImError('STORAGE_UNAVAILABLE'); }
function jsonResult(response) {
  if (!obj(response) || !integer(response.status, 100) || response.status > 599 || !Buffer.isBuffer(response.body) || response.body.length > MAX_JSON) fail('STORAGE_UNAVAILABLE');
  let data;
  try { data = JSON.parse(response.body.toString('utf8')); } catch { fail('STORAGE_UNAVAILABLE'); }
  if (response.status >= 300 && response.status < 400) fail('STORAGE_UNAVAILABLE');
  if (response.status >= 400) {
    const allowed = new Set(['INVALID_REQUEST','UNSUPPORTED_VERSION','INVALID_ATTACHMENT','AUTH_REQUIRED','INVALID_CREDENTIAL','TLS_REQUIRED','OPERATION_FORBIDDEN','RESOURCE_NOT_FOUND','IDEMPOTENCY_CONFLICT','LEASE_CONFLICT','STALE_FENCE','LEASE_EXPIRED','DELIVERY_REQUIRED','SYNC_BLOCKED','CURSOR_RESET_REQUIRED','IDEMPOTENCY_WINDOW_EXPIRED','PAYLOAD_TOO_LARGE','RATE_LIMITED','IM_DISABLED','NEW_WRITES_DISABLED','POLICY_NOT_CONFIGURED','STORAGE_UNAVAILABLE','CLOCK_UNSAFE']);
    const code = data?.error?.code;
    if (typeof code === 'string' && allowed.has(code)) fail(code);
    fail('STORAGE_UNAVAILABLE');
  }
  if (response.status < 200 || response.status > 299 || !obj(data)) fail('STORAGE_UNAVAILABLE');
  return data;
}

function httpsTransport(origin, active) {
  return ({ method, path, credential, body, headers = {}, binary }) => new Promise((resolve, reject) => {
    let settled = false, chunks = [];
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(deadline); active.delete(req);
      if (error) { chunks.length = 0; if (!req.destroyed) req.destroy(); reject(error); } else resolve(value);
    };
    const req = https.request(new URL(path, origin), { method, rejectUnauthorized: true, timeout: 30000,
      headers: { Authorization: `Bearer ${credential}`, ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) } }, res => {
      let size = 0;
      res.on('data', chunk => {
        if (settled) return;
        size += chunk.length;
        if (size > (binary ? MAX_BINARY : MAX_JSON)) finish(new ImError('PAYLOAD_TOO_LARGE'));
        else chunks.push(chunk);
      });
      res.on('end', () => {
        if (settled) return;
        if (res.complete) finish(null, { status: res.statusCode, body: Buffer.concat(chunks, size) });
        else finish(new ImError('STORAGE_UNAVAILABLE'));
      });
      res.on('aborted', () => finish(new ImError('STORAGE_UNAVAILABLE')));
      res.on('close', () => { if (!res.complete) finish(new ImError('STORAGE_UNAVAILABLE')); });
      res.on('error', () => finish(new ImError('STORAGE_UNAVAILABLE')));
    });
    const deadline = setTimeout(() => finish(new ImError('STORAGE_UNAVAILABLE')), REQUEST_DEADLINE_MS);
    active.add(req);
    req.on('close', () => finish(new ImError('STORAGE_UNAVAILABLE')));
    req.on('timeout', () => finish(new ImError('STORAGE_UNAVAILABLE')));
    req.on('error', () => finish(new ImError('STORAGE_UNAVAILABLE')));
    req.end(body);
  });
}

export function createImClient({ serverUrl, agentId, getCredential, journal, attachmentDirectory, transport } = {}) {
  const center = origin(serverUrl), agent = id(agentId);
  if (typeof getCredential !== 'function' || typeof journal !== 'function' ||
      typeof attachmentDirectory !== 'string' || typeof transport !== 'undefined' && typeof transport !== 'function') fail('INVALID_REQUEST');
  // Journal must be instantiated by the trusted installer with these supplied scope values.
  const store = journal({ centerId: center, agentId: agent });
  for (const name of ['stageOutgoing','getOutgoing','markAccepted','recordReceived','getReceived','listPendingAcks','markAcked','setLease','getLease'])
    if (typeof store?.[name] !== 'function') fail('INVALID_REQUEST');
  const active = new Set();
  const network = transport ?? httpsTransport(center, active);
  const credentials = new AsyncLocalStorage();
  let closed = false, leaseVerified = false;
  async function call(method, path, body, { binary = false, headers = {} } = {}) {
    if (closed) fail('STORAGE_UNAVAILABLE');
    let credential;
    try { credential = credentials.getStore() ?? await getCredential(); } catch { fail('AUTH_REQUIRED'); }
    if (typeof credential !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(credential)) fail('AUTH_REQUIRED');
    let response;
    try {
      response = await network({ method, path: `/api/v1${path}`, credential, headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), binary });
    } catch (e) { throw safeError(e); }
    if (closed) fail('STORAGE_UNAVAILABLE');
    if (binary) {
      if (!obj(response) || !Buffer.isBuffer(response.body) || response.body.length > MAX_BINARY) fail('INVALID_ATTACHMENT');
      if (response.status !== 200) { jsonResult(response); fail('STORAGE_UNAVAILABLE'); }
      return response.body;
    }
    return jsonResult(response);
  }
  async function identity() { const me = await call('GET', '/me'); if (me.agentId !== agent) fail('OPERATION_FORBIDDEN'); }
  function checkResult(dto, staged) {
    if (!obj(dto) || !id(dto.messageId) || dto.senderAgentId !== agent || dto.recipientAgentId !== staged.request.recipientAgentId ||
        dto.conversationId !== staged.request.conversationId || dto.clientMessageId !== staged.clientMessageId || !integer(dto.acceptedAt) ||
        typeof dto.text !== 'string' || !Object.hasOwn(dto, 'attachment')) fail('STORAGE_UNAVAILABLE');
    const a = dto.attachment, req = staged.request;
    if (dto.title !== req.title || dto.text !== req.text || dto.inReplyTo !== req.inReplyTo || dto.correlation !== req.correlation ||
        Boolean(a) !== Boolean(req.attachment) || a && (a.name !== req.attachment.name || a.mime !== req.attachment.mime ||
          a.sha256 !== req.attachment.sha256 || a.size !== Buffer.from(req.attachment.dataBase64, 'base64').length)) fail('IDEMPOTENCY_CONFLICT');
    if (fingerprintMessage(normalizeMessageRequest(req)) !== staged.fingerprint) fail('IDEMPOTENCY_CONFLICT');
  }
  async function confirm(dto, staged) {
    checkResult(dto, staged);
    const actual = await call('GET', `/messages/${pathId(id(dto.messageId))}`);
    checkResult(actual, staged);
    if (actual.messageId !== dto.messageId || actual.acceptedAt !== dto.acceptedAt) fail('IDEMPOTENCY_CONFLICT');
    return store.markAccepted(staged.clientMessageId, { messageId: actual.messageId, acceptedAt: actual.acceptedAt });
  }
  async function recover(clientMessageId, retry, verified = false) {
    if (!verified) await identity();
    const staged = store.getOutgoing(id(clientMessageId));
    if (!staged) fail('RESOURCE_NOT_FOUND');
    if (staged.messageId) return confirm(await call('GET', `/messages/${pathId(id(staged.messageId))}`), staged);
    try { return await confirm(await call('GET', `/sends/${pathId(staged.clientMessageId)}`), staged); }
    catch (e) { if (e.code !== 'RESOURCE_NOT_FOUND') throw safeError(e); }
    if (!retry) return { clientMessageId: staged.clientMessageId, status: 'pending' };
    const result = await call('POST', '/messages', staged.request);
    return confirm(result, staged);
  }
  async function send(rawRequest) {
    await identity();
    const existed = store.getOutgoing(id(rawRequest?.clientMessageId));
    const staged = store.stageOutgoing(rawRequest);
    // Existing unconfirmed sends are never blindly POSTed; explicit recoverSend may retry once.
    return existed ? recover(staged.clientMessageId, false, true) : confirm(await call('POST', '/messages', staged.request), staged);
  }
  const recoverSend = clientMessageId => recover(clientMessageId, true);
  async function renewLease() {
    await identity();
    const lease = store.getLease();
    if (!lease) fail('STALE_FENCE');
    leaseVerified = false;
    const result = await call('POST', '/receiver/lease/renew', { instanceId: lease.instanceId, generation: lease.generation });
    if (result.instanceId !== lease.instanceId || result.generation !== lease.generation || !integer(result.expiresAt)) fail('STALE_FENCE');
    const saved = store.setLease(result);
    leaseVerified = true;
    return saved;
  }
  async function acquire({ instanceId, requestId }) {
    await identity();
    const result = await call('POST', '/receiver/lease', { instanceId: id(instanceId), requestId: id(requestId) });
    if (result.instanceId !== instanceId || !integer(result.generation, 1) || !integer(result.expiresAt) || typeof result.historical !== 'boolean') fail('STALE_FENCE');
    leaseVerified = false;
    if (result.historical) {
      // Historical acquire cannot be trusted even if it matches a cached lease.
      const validated = await call('POST', '/receiver/lease/renew', { instanceId, generation: result.generation });
      if (validated.instanceId !== instanceId || validated.generation !== result.generation || !integer(validated.expiresAt)) fail('STALE_FENCE');
      store.setLease(validated);
    } else store.setLease({ instanceId, generation: result.generation, expiresAt: result.expiresAt });
    leaseVerified = true;
    return store.getLease();
  }
  async function release() {
    await identity();
    const lease = store.getLease();
    if (!lease || !leaseVerified) fail('STALE_FENCE');
    const result = await call('POST', '/receiver/lease/release', { instanceId: lease.instanceId, generation: lease.generation });
    leaseVerified = false;
    if (result.instanceId !== lease.instanceId || result.generation !== lease.generation || result.released !== true) fail('STALE_FENCE');
    return result;
  }
  async function fence() {
    // Fresh server-side renew ensures cached leases and credential rotations cannot authorize ACK.
    return renewLease();
  }
  function checkMessage(m) {
    if (!obj(m) || Object.keys(m).sort().join() !== ['acceptedAt','attachment','clientMessageId','conversationId','correlation','inReplyTo','messageId','recipientAgentId','senderAgentId','text','title'].sort().join()) fail('INVALID_REQUEST');
    for (const k of ['messageId','conversationId','senderAgentId','recipientAgentId','clientMessageId']) id(m[k]);
    if (m.recipientAgentId !== agent || m.senderAgentId === agent || !integer(m.acceptedAt) ||
      !(m.title === null || typeof m.title === 'string' && m.title.length <= 100) ||
      typeof m.text !== 'string' || m.text.length > 32000 || !m.text && !m.attachment ||
      !(m.inReplyTo === null || UUID.test(m.inReplyTo)) || !(m.correlation === null || typeof m.correlation === 'string' && m.correlation.length <= 200)) fail('INVALID_REQUEST');
    if (m.attachment) {
      const a = m.attachment;
      if (!obj(a) || Object.keys(a).sort().join() !== ['attachmentId','name','mime','size','sha256'].sort().join() ||
        !UUID.test(a.attachmentId) || !integer(a.size, 1) || a.size > MAX_BINARY || !/^[0-9a-f]{64}$/.test(a.sha256) ||
        typeof a.name !== 'string' || !a.name.length || a.name.length > 200 || a.name.includes('..') || /[\\/\x00-\x1f\x7f]/.test(a.name) ||
        !(a.mime === null || typeof a.mime === 'string' && a.mime.length > 0 && a.mime.length <= 100)) fail('INVALID_ATTACHMENT');
    } else if (m.attachment !== null) fail('INVALID_REQUEST');
  }
  async function ackRecords(records, epoch, watermark, syncWatermark, localCursor) {
    if (!records.length) return null;
    await fence();
    for (const rec of records) {
      if (rec.streamEpoch !== epoch || rec.message.recipientAgentId !== agent || rec.seq > watermark) fail('CURSOR_RESET_REQUIRED');
      if (rec.message.attachment) {
        const expected = attachmentPath(attachmentDirectory, center, agent, rec.message.messageId, rec.message.attachment.attachmentId);
        if (rec.attachmentReceipt?.path !== expected) fail('INVALID_ATTACHMENT');
        await verifyAttachment(expected, rec.message.attachment, attachmentDirectory);
      }
      const m = await call('GET', `/messages/${pathId(rec.message.messageId)}`);
      const { deliveredAt, readAt, replayed, ...remote } = m;
      if (!sameMessage(remote, rec.message)) fail('SYNC_BLOCKED');
    }
    const messageIds = records.map(r => r.message.messageId);
    const lease = store.getLease();
    const result = await call('POST', '/acks', { instanceId: lease.instanceId, generation: lease.generation, messageIds });
    if (!obj(result) || Object.keys(result).length !== 1 || !integer(result.ackedThrough)) fail('STORAGE_UNAVAILABLE');
    store.markAcked({ messageIds, ackedThrough: result.ackedThrough, streamEpoch: epoch,
      syncAckedThrough: syncWatermark, localCursor: localCursor, seqs: records.map(r => r.seq) });
    return result;
  }
  async function syncPage(limit) {
    const lease = await fence();
    const query = new URLSearchParams({ after: String(lease.cursor), limit: String(limit) });
    if (lease.streamEpoch) query.set('streamEpoch', lease.streamEpoch);
    const result = await call('GET', `/sync?${query}`, undefined, { headers: { 'X-A2A-Instance-Id': lease.instanceId, 'X-A2A-Generation': String(lease.generation) } });
    if (!UUID.test(result.streamEpoch) || !integer(result.ackedThrough) || !integer(result.pageAfter) || typeof result.hasMore !== 'boolean' ||
        !Array.isArray(result.items) || result.items.length > limit || lease.streamEpoch && result.streamEpoch !== lease.streamEpoch ||
        result.ackedThrough < lease.cursor || result.pageAfter < lease.cursor) fail('CURSOR_RESET_REQUIRED');
    let previous = lease.cursor;
    for (const item of result.items) {
      if (!obj(item) || !integer(item.seq, 1) || item.seq !== ++previous) fail('CURSOR_RESET_REQUIRED');
      checkMessage(item.message);
    }
    if (result.pageAfter !== previous) fail('CURSOR_RESET_REQUIRED');
    store.setLease({ instanceId: lease.instanceId, generation: lease.generation, expiresAt: lease.expiresAt, streamEpoch: result.streamEpoch });
    return result;
  }
  async function receiveOnce({ limit = 20 } = {}) {
    if (!integer(limit, 1) || limit > 100) fail('INVALID_REQUEST');
    await identity();
    const page = await syncPage(limit);
    const records = [];
    for (const { seq, message } of page.items) {
      const receipt = message.attachment ? await saveAttachment({ directory: attachmentDirectory, center, agent,
        messageId: message.messageId, attachment: message.attachment,
        download: () => call('GET', `/attachments/${pathId(message.attachment.attachmentId)}`, undefined, { binary: true }) }) : null;
      records.push(store.recordReceived({ streamEpoch: page.streamEpoch, seq, message, ...(receipt ? { attachmentReceipt: receipt } : {}) }));
    }
    // All records are durable before ACK. A lost response leaves records pending for explicit ackPending.
    if (records.length) await ackRecords(records, page.streamEpoch, page.pageAfter, page.ackedThrough, store.getLease().cursor);
    return { items: records.map(r => ({ ...r, status: 'delivered' })), hasMore: page.hasMore };
  }
  async function ackPending({ limit = 20 } = {}) {
    if (!integer(limit, 1) || limit > 100) fail('INVALID_REQUEST');
    await identity();
    const page = await syncPage(limit);
    const pending = store.listPendingAcks({ limit }).map(x => store.getReceived(x.messageId));
    const allowed = new Map(page.items.map(x => [x.message.messageId, x]));
    for (const rec of pending) {
      const current = allowed.get(rec.message.messageId);
      if (!current || current.seq !== rec.seq || !sameMessage(current.message, rec.message)) fail('SYNC_BLOCKED');
    }
    await ackRecords(pending, page.streamEpoch, Math.max(page.ackedThrough, page.pageAfter), page.ackedThrough, store.getLease().cursor);
    return { acked: pending.map(x => x.message.messageId) };
  }
  const pageArgs = input => {
    if (!obj(input) || input.limit !== undefined && (!integer(input.limit, 1) || input.limit > 100) ||
      input.after !== undefined && (typeof input.after !== 'string' || input.after.length > 4096)) fail('INVALID_REQUEST');
    const q = new URLSearchParams();
    if (input.after !== undefined) q.set('after', input.after);
    if (input.limit !== undefined) q.set('limit', String(input.limit));
    return q.size ? `?${q}` : '';
  };
  const contacts = async (input = {}) => { await identity(); return call('GET', `/contacts${pageArgs(input)}`); };
  const conversations = async (input = {}) => { await identity(); return call('GET', `/conversations${pageArgs(input)}`); };
  const ensureConversation = async ({ peerAgentId }) => { await identity(); return call('POST', '/conversations', { peerAgentId: id(peerAgentId) }); };
  const history = async ({ conversationId, ...input }) => { await identity(); return call('GET', `/conversations/${pathId(id(conversationId))}/messages${pageArgs(input)}`); };
  const read = async messageId => { await identity(); return call('POST', `/messages/${pathId(id(messageId))}/read`, {}); };
  function close() { closed = true; leaseVerified = false; for (const req of active) req.destroy(); active.clear(); }
  const methods = { send, recoverSend, acquire, renewLease, release, receiveOnce, ackPending,
    contacts, conversations, ensureConversation, history, read };
  return Object.freeze({ ...Object.fromEntries(Object.entries(methods).map(([name, fn]) => [name,
    async (...args) => { try {
      if (closed) fail('STORAGE_UNAVAILABLE');
      let credential;
      try { credential = await getCredential(); } catch { fail('AUTH_REQUIRED'); }
      if (typeof credential !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(credential)) fail('AUTH_REQUIRED');
      return await credentials.run(credential, () => fn(...args));
    } catch (e) { throw safeError(e); } }])), close });
}
