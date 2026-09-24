// TEST ONLY: transport instrumentation, never an auth/business replacement.
import assert from 'node:assert/strict';
import { Duplex } from 'node:stream';
import { IncomingMessage, ServerResponse, createServer as httpServer, request as httpRequest } from 'node:http';
import { createServer as httpsServer, request as httpsRequest } from 'node:https';
import { connect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { readFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { createImV2Center } from '../../../src/im/v2/server.js';
import { createImV2Handler } from '../../../src/im/v2/http.js';
import { PROTOCOL } from '../../../src/im/v2/contracts.js';

export const TIMEOUT = 10000;
export const key = readFileSync(new URL('../im-tls/localhost-test-only.key', import.meta.url));
export const cert = readFileSync(new URL('../im-tls/localhost-test-only.crt', import.meta.url));
export const turn = () => new Promise(resolve => setImmediate(resolve));
export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export async function bounded(promise, label, ms = 2000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}
export function scheduler() {
  const pending = new Map();
  let serial = 0;
  return {
    pending,
    setTimeout(fn, ms) { const id = ++serial; pending.set(id, { fn, ms }); return id; },
    clearTimeout(id) { pending.delete(id); },
    fire(id = pending.keys().next().value) {
      assert.ok(pending.has(id), 'a live deadline must still exist');
      const { fn, ms } = pending.get(id);
      assert.ok(ms > 0 && ms <= 30000, 'bounded internal deadline');
      pending.delete(id); fn();
    },
  };
}
export function headers(f, credential = f.credentials[0]) {
  return { authorization: `Bearer ${credential}`, 'x-a2a-protocol': PROTOCOL,
    'x-a2a-center-epoch': f.centerEpoch };
}
export function setup(t, f, { limits = {}, transport, timers = scheduler(), onSend } = {}) {
  const policy = { ...f.policy, limits: { ...f.policy.limits, ...limits },
    ...(transport ? { transport } : {}) };
  const center = createImV2Center({ db: f.db, policy, clock: f.clock });
  // Observe the real entrypoint, preserving execution and every other module.
  const messages = onSend ? { ...center.modules.messages, send(...args) {
    onSend(); return center.modules.messages.send(...args);
  } } : center.modules.messages;
  const handler = createImV2Handler({ ...center.modules, messages, policy, trustedTimers: timers });
  t.after(() => { handler.close(); center.close(); });
  return { center, handler, timers, policy };
}

// A real paired Duplex and real Node HTTP objects. No HTTP parser/TLS handshake
// runs here. Synthetic endpoint labels exercise only the handler's address gate.
// Holding the native writable callback gives end() != writableFinished and a
// genuine write(false); it does not fabricate res.end(), finish, or drain.
class PairedSocket extends Duplex {
  constructor({ stalled = false, highWaterMark = 16384 } = {}) {
    super({ highWaterMark });
    this.stalled = stalled; this.held = []; this.frames = [];
    this.remoteAddress = '127.0.0.1'; this.localAddress = '127.0.0.1';
    this.errors = []; this.on('error', error => this.errors.push(error));
  }
  _read() {}
  _write(chunk, encoding, callback) {
    this.frames.push(Buffer.from(chunk));
    if (this.stalled) this.held.push({ chunk: Buffer.from(chunk), callback });
    else { this.peer.push(Buffer.from(chunk)); callback(); }
  }
  flush() {
    this.stalled = false;
    for (const { chunk, callback } of this.held.splice(0)) {
      if (!this.peer.destroyed) this.peer.push(chunk);
      callback();
    }
  }
  _destroy(error, callback) {
    if (!this.peer.destroyed) this.peer.destroy();
    for (const held of this.held.splice(0)) held.callback(error ?? new Error('TEST transport terminated'));
    callback(error);
  }
  cork() { return super.cork(); }
  setTimeout() { return this; }
}
export function exchange(t, f, { path = '/api/v2/me', method = 'GET', extraHeaders = {},
  credential, stalled = false, highWaterMark, complete = true, remoteAddress, localAddress } = {}) {
  const socket = new PairedSocket({ stalled, highWaterMark });
  const peer = new PairedSocket(); socket.peer = peer; peer.peer = socket;
  if (remoteAddress) socket.remoteAddress = remoteAddress;
  if (localAddress) socket.localAddress = localAddress;
  const req = new IncomingMessage(socket);
  req.url = path; req.method = method; req.httpVersionMajor = 1; req.httpVersionMinor = 1;
  req.headers = { ...headers(f, credential), ...extraHeaders };
  req.rawHeaders = Object.entries(req.headers).flat();
  req.complete = complete;
  if (complete) req.push(null);
  const res = new ServerResponse(req); res.assignSocket(socket);
  const errors = []; req.on('error', error => errors.push(error)); res.on('error', error => errors.push(error));
  const responseClosed = deferred(), socketClosed = deferred(), finished = deferred();
  res.once('close', responseClosed.resolve); socket.once('close', socketClosed.resolve);
  res.once('finish', finished.resolve);
  // Drain peer so the test controls only the server-side writable callback.
  const received = []; peer.on('data', chunk => received.push(chunk));
  t.after(async () => {
    req.destroy(); res.destroy(); socket.destroy(); peer.destroy();
    await bounded(socketClosed.promise, 'paired socket cleanup');
  });
  return { req, res, socket, peer, errors, responseClosed: responseClosed.promise,
    socketClosed: socketClosed.promise, finished: finished.promise,
    bytes: () => Buffer.concat(received),
    json: () => JSON.parse(Buffer.concat(socket.frames).toString().split('\r\n\r\n')[1]),
  };
}

export async function listen(t, handler, { tls = false, instrument } = {}) {
  const sockets = new Set(), requests = [], operations = [], errors = [], parserErrors = [];
  const incoming = deferred();
  const listener = (req, res) => {
    const record = { req, res, completeAtEntry: req.complete, errors: [], ended: false,
      responseClosed: deferred(), socketClosed: deferred() };
    requests.push(record); req.on('error', error => record.errors.push(error));
    req.once('end', () => { record.ended = true; });
    res.once('close', record.responseClosed.resolve);
    req.socket.once('close', record.socketClosed.resolve);
    instrument?.(req, res, record);
    const operation = handler.handle(req, res);
    operations.push(operation); operation.catch(error => errors.push(error));
    incoming.resolve(record);
  };
  const server = tls ? httpsServer({ key, cert }, listener) : httpServer(listener);
  server.on('connection', socket => {
    sockets.add(socket); socket.on('error', error => errors.push(error));
    socket.once('close', () => sockets.delete(socket));
  });
  // Observe parser errors without installing clientError (which changes Node's
  // default parser-400 response). emit still executes the original behavior.
  const emit = server.emit;
  server.emit = function (name, ...args) {
    if (name === 'clientError') parserErrors.push(args[0]);
    return emit.call(this, name, ...args);
  };
  t.after(async () => {
    handler.close();
    const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    const fallback = setTimeout(() => { for (const socket of sockets) socket.destroy(); }, 50);
    try { await bounded(closed, 'owned listener cleanup'); }
    finally { clearTimeout(fallback); for (const socket of sockets) socket.destroy(); }
    await bounded(Promise.allSettled(operations), 'owned handler operations cleanup');
  });
  await bounded(new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  }), 'loopback listen');
  return { server, port: server.address().port, tls, sockets, requests, operations, errors,
    parserErrors, incoming: incoming.promise };
}

export async function call(endpoint, f, { path = '/api/v2/me', method = 'GET', payload,
  credential, extraHeaders = {} } = {}) {
  const requester = endpoint.tls ? httpsRequest : httpRequest;
  return bounded(new Promise((resolve, reject) => {
    const req = requester({ hostname: 'localhost', port: endpoint.port, path, method, agent: false,
      lookup: (_host, _options, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]),
      ...(endpoint.tls ? { ca: cert } : {}),
      headers: { ...headers(f, credential), ...(payload ? { 'content-type': 'application/json',
        'content-length': payload.length } : {}), ...extraHeaders } }, res => {
      const chunks = [], errors = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', error => errors.push(error));
      res.once('close', () => {
        const bytes = Buffer.concat(chunks);
        try {
          resolve({ status: res.statusCode, headers: res.headers, complete: res.complete, errors, bytes,
            body: res.complete && res.headers['content-type']?.startsWith('application/json') ? JSON.parse(bytes) : undefined });
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(2000, () => req.destroy(new Error('TEST request timeout')));
    req.on('error', reject); req.end(payload);
  }), 'HTTP client request', 3000);
}

// Raw client deliberately does not end its writable side after the frame. Tests
// can leave a declared request body unfinished without a producer/drain loop.
export async function raw(t, endpoint, frame) {
  const chunks = [], errors = [], closed = deferred(), response = deferred();
  const socket = endpoint.tls ? tlsConnect({ host: '127.0.0.1', port: endpoint.port,
    servername: 'localhost', ca: cert }) : connect({ host: '127.0.0.1', port: endpoint.port });
  socket.on('error', error => errors.push(error));
  socket.setTimeout(4000, () => socket.destroy(new Error('TEST raw client timeout')));
  socket.once('close', () => {
    const bytes = Buffer.concat(chunks), split = bytes.indexOf('\r\n\r\n');
    // Node's native parser-400 response is close-delimited on some releases.
    // Accept that framing only at terminal close, never while upload is open.
    if (split >= 0) {
      const head = bytes.subarray(0, split).toString();
      if (!/\r\n(?:content-length|transfer-encoding):/i.test(head)) {
        const body = bytes.subarray(split + 4);
        response.resolve({ status: Number(head.split(' ')[1]), head, bytes: body, body: undefined });
      }
    }
    closed.resolve();
  });
  socket.on('data', chunk => {
    chunks.push(chunk);
    const bytes = Buffer.concat(chunks), split = bytes.indexOf('\r\n\r\n');
    if (split < 0) return;
    const head = bytes.subarray(0, split).toString();
    const length = /\r\ncontent-length:\s*(\d+)/i.exec(head);
    if (length && bytes.length >= split + 4 + Number(length[1])) {
      const body = bytes.subarray(split + 4, split + 4 + Number(length[1]));
      try {
        response.resolve({ status: Number(head.split(' ')[1]), head, bytes: body,
          body: /content-type:\s*application\/json/i.test(head) ? JSON.parse(body) : undefined });
      } catch (error) { response.reject(error); }
    }
  });
  t.after(async () => { socket.destroy(); await bounded(closed.promise, 'raw client cleanup'); });
  await bounded(new Promise((resolve, reject) => {
    socket.once(endpoint.tls ? 'secureConnect' : 'connect', resolve); socket.once('error', reject);
  }), 'raw client connect');
  socket.write(frame);
  return { socket, errors, closed: closed.promise, response: response.promise, bytes: () => Buffer.concat(chunks) };
}
export function frame(f, { method = 'GET', path = '/api/v2/me', fields = [], body = '',
  credential = f.credentials[0], protocol = PROTOCOL } = {}) {
  return Buffer.concat([Buffer.from(`${method} ${path} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${credential}\r\nX-A2A-Protocol: ${protocol}\r\nX-A2A-Center-Epoch: ${f.centerEpoch}\r\n${fields.map(([k,v]) => `${k}: ${v}\r\n`).join('')}\r\n`), Buffer.from(body)]);
}
export function sendInput(f, overrides = {}) {
  return { ...f.scope, originEpoch: f.centerEpoch, clientMessageId: randomUUID(),
    conversationId: f.conversationId, recipientAgentId: f.b, text: 'test', ...overrides };
}
export function attachment(bytes) {
  return { name: 'test.bin', mime: 'application/octet-stream',
    sha256: createHash('sha256').update(bytes).digest('hex'), dataBase64: bytes.toString('base64') };
}
export function sendAttachment(f, center, bytes) {
  const { protocol, centerEpoch, ...input } = sendInput(f, { attachment: attachment(bytes) });
  return center.modules.messages.send(center.modules.auth.authenticate(f.credentials[0]), f.scope, input).message;
}
export function businessSnapshot(f) {
  const tables = ['im_messages', 'im_attachments', 'im_attachment_reservations', 'im_send_keys',
    'im_send_operation_keys', 'im_content_state', 'im_deliveries', 'im_receive_state',
    'im_sync_progress', 'im_audit', 'im_conversations'];
  return Object.fromEntries(tables.map(table => [table, f.native.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}
