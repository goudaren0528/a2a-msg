import { randomUUID } from 'node:crypto';
import ipaddr from 'ipaddr.js';
import { ImV2Error, PROTOCOL, errorEnvelope, postSchemas, dataSchemas,
  parseQuery, parseSyncQuery } from './contracts.js';
import { parseImV2Config } from './config.js';

const fail = code => { throw new ImV2Error(code); };
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const DEADLINE_MS = 30000; // bounded internal deadline; no new production config key
const MAX_RATE_BUCKETS = 4096;
const MAX_REJECTION_RESPONSES = 16; // excess responders cannot themselves exhaust the active set
const WINDOW_MS = 60000;
const CHUNK = 65536;
function loopback(address) {
  try { const ip = ipaddr.parse(address); return ip.range() === 'loopback' ||
    ip.kind() === 'ipv6' && ip.isIPv4MappedAddress() && ip.toIPv4Address().range() === 'loopback'; }
  catch { return false; }
}
function route(method, path) {
  const parts = path.split('/');
  if (method === 'GET') {
    if (path === '/me') return ['me'];
    if (path === '/contacts') return ['contacts'];
    if (path === '/conversations') return ['conversations'];
    if (path === '/sync') return ['sync'];
    if (parts.length === 4 && parts[1] === 'sends' && UUID.test(parts[2]) && UUID.test(parts[3])) return ['sendResult',parts[2],parts[3]];
    if (parts.length === 4 && parts[1] === 'conversations' && UUID.test(parts[2]) && parts[3] === 'messages') return ['history',parts[2]];
    if (parts.length === 3 && parts[1] === 'messages' && UUID.test(parts[2])) return ['message',parts[2]];
    if (parts.length === 3 && parts[1] === 'attachments' && UUID.test(parts[2])) return ['attachment',parts[2]];
  }
  if (method === 'POST') {
    if (path === '/conversations') return ['conversation'];
    if (path === '/messages') return ['send'];
    if (parts.length === 4 && parts[1] === 'messages' && UUID.test(parts[2]) && parts[3] === 'read') return ['read',parts[2]];
    if (path === '/receiver/lease') return ['lease'];
    if (path === '/receiver/lease/renew') return ['renew'];
    if (path === '/receiver/lease/release') return ['release'];
    if (path === '/acks') return ['acks'];
    if (path === '/expiry-receipts') return ['expiryReceipts'];
  }
  return null;
}
function rawHeaders(req) {
  const fields = Object.create(null);
  const raw = req.rawHeaders;
  if (!Array.isArray(raw) || raw.length % 2) fail('INVALID_REQUEST');
  const unique = new Set(['authorization','x-a2a-protocol','x-a2a-center-epoch','x-a2a-instance-id',
    'x-a2a-generation','content-type','content-length','transfer-encoding','host']);
  for (let i=0; i<raw.length; i+=2) {
    const name = raw[i].toLowerCase();
    if (unique.has(name) && Object.hasOwn(fields,name)) fail('INVALID_REQUEST');
    fields[name] = raw[i+1];
  }
  if (fields['content-length'] !== undefined && fields['transfer-encoding'] !== undefined) fail('INVALID_REQUEST');
  return fields;
}
function pathAndQuery(req) {
  const raw = req.url;
  if (typeof raw !== 'string' || raw.length > 4096 || !raw.startsWith('/') || raw.includes('#') || raw.includes('\\')) fail('INVALID_REQUEST');
  const p = raw.split('?')[0];
  if (/%|\/\/|(?:^|\/)\.\.?\/?(?:\/|$)/i.test(p) || !/^[\x21-\x7e]*$/.test(p)) fail('INVALID_REQUEST');
  const queryPart = raw.slice(p.length);
  if (/%(?![0-9a-fA-F]{2})/.test(queryPart)) fail('INVALID_REQUEST');
  try { decodeURIComponent(queryPart.replace(/\+/g,' ')); } catch { fail('INVALID_REQUEST'); }
  let u;
  try { u = new URL(raw,'http://localhost'); } catch { fail('INVALID_REQUEST'); }
  if (u.pathname !== p) fail('INVALID_REQUEST');
  return {path:p, entries:u.searchParams.entries()};
}
function query(kind, entries) {
  if (['contacts','conversations','history'].includes(kind)) {
    const v = parseQuery(entries,{allowed:['after','limit']});
    return { ...(v.after === undefined ? {} : {after:v.after}), limit:Number(v.limit) };
  }
  if (kind === 'sync') {
    const v = parseSyncQuery(entries);
    return {streamEpoch:v.streamEpoch, ...(v.after === undefined ? {} : {after:Number(v.after)}),limit:Number(v.limit)};
  }
  parseQuery(entries);
  return {};
}
function statusAndJson(res,status,value) {
  if (res.destroyed || res.writableEnded) return;
  const data = Buffer.from(JSON.stringify(value));
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','content-length':data.length,
    'cache-control':'no-store','x-content-type-options':'nosniff'});
  res.end(data);
}
// Register completion/termination before writing: a short response can finish
// synchronously, and a slow peer can keep an ended response pending indefinitely.
function waitForWrite(res, bytes) {
  return new Promise((resolve,reject) => {
    let settled = false, drained = false;
    const cleanup = () => { res.off('drain',onDrain); res.off('close',onClose); res.off('error',onError); };
    const done = error => {
      if (settled) return;
      settled = true; cleanup();
      if (error) reject(error); else resolve();
    };
    const onDrain = () => { drained = true; done(); };
    const onClose = () => done(new ImV2Error('INVALID_REQUEST'));
    const onError = () => done(new ImV2Error('STORAGE_UNAVAILABLE'));
    res.once('drain',onDrain); res.once('close',onClose); res.once('error',onError);
    try {
      const writable = res.write(bytes);
      if (writable || drained) done();
      else if (res.destroyed) onClose();
    } catch { done(new ImV2Error('STORAGE_UNAVAILABLE')); }
  });
}
function detached(body) { const { protocol, centerEpoch, ...args } = body; return args; }
function sameMeta(a,b) { return a.attachmentId === b.attachmentId && a.messageId === b.messageId &&
  a.name === b.name && a.mime === b.mime && a.size === b.size && a.sha256 === b.sha256; }

export function createImV2Handler(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Reflect.ownKeys(options).some(k => !['auth','acl','messages','delivery','policy','trustedTimers'].includes(k))) fail('INVALID_REQUEST');
  const {auth,acl,messages,delivery,policy,trustedTimers} = options;
  const config = parseImV2Config(policy);
  if (!config.enabled || !config.transport || !config.limits ||
      !['authenticate','me','withRead'].every(k => typeof auth?.[k] === 'function') ||
      typeof acl?.assertAttachmentAccess !== 'function' ||
      !['listContacts','listConversations','ensureConversation','send','getSendResult','listHistory',
        'getMessage','getAttachment','markRead'].every(k => typeof messages?.[k] === 'function') ||
      !['acquire','renew','release','sync','ack','recordExpiryReceipts'].every(k => typeof delivery?.[k] === 'function')) fail('INVALID_REQUEST');
  if (trustedTimers !== undefined && (!trustedTimers || typeof trustedTimers.setTimeout !== 'function' ||
      typeof trustedTimers.clearTimeout !== 'function')) fail('INVALID_REQUEST');
  const timers = trustedTimers ?? {setTimeout,clearTimeout};
  const active = new Set(), buckets = new Map();
  let closed = false;
  function charge(identity) {
    const now = Date.now();
    const prior = buckets.get(identity);
    if (prior && prior.until > now) {
      if (++prior.count > config.limits.maxRequestsPerMinute) fail('RATE_LIMITED');
      return;
    }
    buckets.delete(identity);
    if (buckets.size >= MAX_RATE_BUCKETS) {
      for (const [key,value] of buckets) if (value.until <= now) buckets.delete(key);
      if (buckets.size >= MAX_RATE_BUCKETS) fail('RATE_LIMITED');
    }
    buckets.set(identity,{count:1,until:now+WINDOW_MS});
  }
  function close() {
    if (closed) return;
    closed = true;
    for (const item of active) item.terminate();
    buckets.clear();
  }
  async function handle(req,res) {
    const rawUrl = req.url;
    if (typeof rawUrl !== 'string' || !(rawUrl === '/api/v1' || rawUrl.startsWith('/api/v1/') ||
        rawUrl.startsWith('/api/v1?') || rawUrl === '/api/v2' || rawUrl.startsWith('/api/v2/') || rawUrl.startsWith('/api/v2?'))) return false;
    const item = {req,res,expired:false,released:false,timer:null,terminate:null};
    const release = () => {
      if (item.released) return;
      item.released = true;
      if (item.timer !== null) timers.clearTimeout(item.timer);
      req.off('close',onRequestClose); req.off('error',onRequestError);
      res.off('finish',onFinish); res.off('close',onResponseClose); res.off('error',onResponseError);
      active.delete(item);
    };
    const terminate = () => {
      if (!req.destroyed) req.destroy();
      if (!res.destroyed) res.destroy();
      release();
    };
    item.terminate = terminate;
    const onRequestClose = () => {
      // IncomingMessage closes normally after a complete upload, often before
      // ServerResponse finishes. An incomplete close is a disconnected upload.
      if (!req.complete || req.aborted) terminate();
      else if (res.writableFinished || res.destroyed) release();
    };
    const onRequestError = () => terminate();
    const onFinish = () => {
      if (!req.complete || req.aborted) terminate();
      else release();
    };
    const onResponseClose = () => {
      if (!req.complete && !req.destroyed) req.destroy();
      release();
    };
    const onResponseError = () => terminate();
    req.on('close',onRequestClose); req.on('error',onRequestError);
    res.on('finish',onFinish); res.on('close',onResponseClose); res.on('error',onResponseError);
    active.add(item);
    if (active.size > config.limits.maxConnections + MAX_REJECTION_RESPONSES) {
      terminate(); // saturated responder budget: no untracked partial upload
      return true;
    }
    // Without a deadline we cannot safely own a pending response or unread upload.
    // Registration failure must not enter the normal JSON-error path, which could
    // leave an unbounded active slot when the peer does not read that response.
    try {
      item.timer = timers.setTimeout(() => { item.expired = true; terminate(); },DEADLINE_MS);
    } catch {
      terminate();
      return true;
    }
    if (item.released) { timers.clearTimeout(item.timer); return true; }
    const requestId = randomUUID();
    try {
      if (closed) fail('IM_DISABLED');
      if (active.size > config.limits.maxConnections) fail('RATE_LIMITED');
      if (config.transport.mode === 'direct-tls' ? req.socket?.encrypted !== true :
        !loopback(req.socket?.remoteAddress) || !loopback(req.socket?.localAddress)) fail('TLS_REQUIRED');
      const headers = rawHeaders(req);
      const parsed = pathAndQuery(req);
      const isV1 = parsed.path === '/api/v1' || parsed.path.startsWith('/api/v1/');
      if (isV1) fail('PROTOCOL_UPGRADE_REQUIRED');
      // Pre-auth IP budget is a transport safeguard, never a substitute for credential validation.
      // Transport addresses only: forwarded headers are deliberately ignored.
      charge(`ip:${req.socket?.remoteAddress ?? 'unknown'}`);
      const path = parsed.path.slice('/api/v2'.length);
      if (headers['x-a2a-protocol'] !== PROTOCOL) fail('UNSUPPORTED_VERSION');
      const match = route(req.method,path);
      const [kind,id,id2] = match ?? ['unknown'];
      const max = kind === 'send' ? config.limits.maxFileBodyBytes : config.limits.maxBodyBytes;
      if (req.method === 'GET') {
        if (headers['content-length'] !== undefined || headers['transfer-encoding'] !== undefined ||
            headers['content-type'] !== undefined) fail('INVALID_REQUEST');
      } else {
        if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(headers['content-type'] ?? '') ||
            headers['transfer-encoding'] && headers['transfer-encoding'].toLowerCase() !== 'chunked') fail('INVALID_REQUEST');
        if (headers['content-length'] !== undefined && (!/^(?:0|[1-9][0-9]*)$/.test(headers['content-length']) ||
            !Number.isSafeInteger(Number(headers['content-length'])) || Number(headers['content-length']) > max))
          fail('PAYLOAD_TOO_LARGE');
      }
      const bearer = headers.authorization;
      if (bearer === undefined) fail('AUTH_REQUIRED');
      if (typeof bearer !== 'string' || !/^Bearer [^\s]+$/.test(bearer)) fail('INVALID_CREDENTIAL');
      const credential = bearer.slice(7);
      const principal = auth.authenticate(credential);
      charge(`credential:${principal.credentialId}`);
      if (!match) fail('RESOURCE_NOT_FOUND');
      const epoch = headers['x-a2a-center-epoch'];
      if (epoch !== undefined && !UUID.test(epoch)) fail('INVALID_REQUEST');
      if (kind !== 'me' && epoch === undefined) fail('INVALID_REQUEST');
      const scope = {protocol:PROTOCOL,centerEpoch:epoch};
      // Real auth gate before resource paths, cursor parsing, or body schema disclosures.
      if (kind !== 'me') auth.withRead(principal,scope,() => undefined);
      const params = query(kind,parsed.entries);
      let body;
      if (req.method === 'POST') {
        const chunks=[]; let size=0;
        for await (const chunk of req) {
          if (closed || item.expired || req.aborted) fail('INVALID_REQUEST');
          size += chunk.length;
          if (size > max) fail('PAYLOAD_TOO_LARGE');
          chunks.push(chunk);
        }
        if (item.expired || req.aborted || closed) fail('INVALID_REQUEST');
        let json;
        try { json=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,size))); }
        catch { fail('INVALID_REQUEST'); }
        const schema = postSchemas[kind === 'send' ? 'message' : kind];
        const parsedBody = schema.safeParse(json);
        if (!parsedBody.success || json.protocol !== PROTOCOL || json.centerEpoch !== epoch) fail('INVALID_REQUEST');
        // A send without a real attachment remains subject to the generic JSON
        // byte cap, including whitespace (not just parsed JSON string length).
        if (kind === 'send' && json.attachment == null && size > config.limits.maxBodyBytes) fail('PAYLOAD_TOO_LARGE');
        body = parsedBody.data;
      }
      let data, dataKind = kind, status = 200;
      switch (kind) {
        case 'me': data = auth.me(credential,epoch === undefined ? {} : {centerEpoch:epoch}); break;
        case 'contacts': data = messages.listContacts(principal,scope,params); break;
        case 'conversations': data = messages.listConversations(principal,scope,params); break;
        case 'conversation': data = messages.ensureConversation(principal,scope,detached(body)); break;
        case 'send': data = messages.send(principal,scope,detached(body)); status = data.replayed ? 200 : 201; break;
        case 'sendResult': data = messages.getSendResult(principal,scope,{originEpoch:id,clientMessageId:id2}); break;
        case 'history': data = messages.listHistory(principal,scope,{conversationId:id,...params}); break;
        case 'message': data = messages.getMessage(principal,scope,{messageId:id}); break;
        case 'read': data = messages.markRead(principal,scope,{messageId:id}); break;
        case 'lease': data = delivery.acquire(principal,scope,detached(body)); break;
        case 'renew': data = delivery.renew(principal,scope,detached(body)); break;
        case 'release': data = delivery.release(principal,scope,detached(body)); break;
        case 'acks': data = delivery.ack(principal,scope,detached(body)); break;
        case 'expiryReceipts': data = delivery.recordExpiryReceipts(principal,scope,detached(body)); break;
        case 'sync': {
          const instanceId = headers['x-a2a-instance-id'];
          const generation = headers['x-a2a-generation'];
          if (!UUID.test(instanceId ?? '') || !/^[1-9][0-9]*$/.test(generation ?? '') ||
              !Number.isSafeInteger(Number(generation))) fail('INVALID_REQUEST');
          data = delivery.sync(principal,scope,{instanceId,generation:Number(generation),...params}); break;
        }
        case 'attachment': {
          const value = messages.getAttachment(principal,scope,{attachmentId:id});
          const original = acl.assertAttachmentAccess(principal,scope,id);
          if (!sameMeta(value,original)) fail('STORAGE_UNAVAILABLE');
          if (!Buffer.isBuffer(value.data) || value.data.length !== original.size) fail('STORAGE_UNAVAILABLE');
          const filename = encodeURIComponent(original.name).replace(/['()*]/g,c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
          const recheck = () => { if (closed || item.expired || res.destroyed) fail('INVALID_REQUEST');
            if (!sameMeta(original,acl.assertAttachmentAccess(principal,scope,id))) fail('STORAGE_UNAVAILABLE'); };
          recheck();
          const safeMime = original.mime && /^[\x21-\x7e]+$/.test(original.mime) && !/[;\\]/.test(original.mime)
            ? original.mime : 'application/octet-stream';
          res.writeHead(200,{'content-type':safeMime,'content-length':original.size,
            'content-disposition':`attachment; filename*=UTF-8''${filename}`,
            'x-a2a-protocol':PROTOCOL,'x-a2a-center-epoch':epoch,'cache-control':'no-store','x-content-type-options':'nosniff'});
          for (let offset=0; offset<value.data.length; offset+=CHUNK) {
            recheck();
            await waitForWrite(res,value.data.subarray(offset,Math.min(offset+CHUNK,value.data.length)));
          }
          recheck(); res.end(); return true;
        }
      }
      if (!dataSchemas[dataKind].safeParse(data).success) fail('STORAGE_UNAVAILABLE');
      statusAndJson(res,status,{protocol:PROTOCOL,centerEpoch:kind === 'me' ? data.centerEpoch : epoch,data});
    } catch (error) {
      const fixed = error instanceof ImV2Error ? error : new ImV2Error('STORAGE_UNAVAILABLE');
      if (res.headersSent || res.destroyed || item.expired) terminate();
      else {
        // Never drain an untrusted rejected upload to salvage keep-alive. Flush
        // the bounded fixed error, then finish destroys the still-owned request.
        if (!req.complete) res.shouldKeepAlive = false;
        try { statusAndJson(res,fixed.status,errorEnvelope(fixed,requestId)); }
        catch { terminate(); }
      }
    }
    return true;
  }
  return Object.freeze({handle,close});
}
