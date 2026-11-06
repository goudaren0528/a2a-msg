import { randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createImClient } from '../im/client.js';
import { createImJournal } from '../im/journal.js';
import { ImError, PROTOCOL } from '../im/contracts.js';
import { normalizeOrigin, parseNanaConfig } from './config.js';

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const CREDENTIAL = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_JSON = 16 * 1024 * 1024;
const fail = code => { throw new ImError(code); };
const asImError = code => { try { return new ImError(code); } catch { return new ImError('STORAGE_UNAVAILABLE'); } };
const uuid = value => {
  if (typeof value !== 'string' || !UUID.test(value)) fail('INVALID_REQUEST');
  return value;
};
const pageSize = (value, fallback) => {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) fail('INVALID_REQUEST');
  return value;
};

function requireDirectory(path) {
  let info;
  try { info = lstatSync(path); } catch { throw new ImError('INVALID_REQUEST'); }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new ImError('INVALID_REQUEST');
  return path;
}

// Durable cursor for "already handed to the host session". Separate from the IM
// journal so the journal schema/checksum stays untouched.
function readState(statePath) {
  if (!existsSync(statePath)) return { handedThrough: 0 };
  let value;
  try { value = JSON.parse(readFileSync(statePath, 'utf8')); } catch { fail('STORAGE_UNAVAILABLE'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 ||
      !Number.isSafeInteger(value.handedThrough) || value.handedThrough < 0) fail('STORAGE_UNAVAILABLE');
  return { handedThrough: value.handedThrough };
}

function fsyncDirectory(directory) {
  let fd;
  try { fd = openSync(directory, constants.O_RDONLY); fsyncSync(fd); }
  catch { /* Windows cannot open a directory for fsync; the renamed file was already flushed. */ }
  finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } } }
}

function writeState(statePath, handedThrough) {
  const temporary = `${statePath}.tmp-${process.pid}-${randomUUID()}`;
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify({ handedThrough })}\n`);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try { renameSync(temporary, statePath); }
  catch (error) { try { unlinkSync(temporary); } catch { /* ignore */ } throw error; }
  fsyncDirectory(dirname(statePath));
}

// Read-only GET lookup for operations the durable client does not expose. HTTPS
// only, no redirects, verified chain/hostname, bounded body, fixed error codes.
function httpsLookup(origin, getCredential) {
  return path => new Promise((resolve, reject) => {
    let credential;
    try { credential = getCredential(); } catch { reject(new ImError('AUTH_REQUIRED')); return; }
    if (!CREDENTIAL.test(credential)) { reject(new ImError('AUTH_REQUIRED')); return; }
    let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; error ? reject(error) : resolve(value); };
    const req = https.request(new URL(path, origin), { method: 'GET', rejectUnauthorized: true, timeout: 30000,
      headers: { Authorization: `Bearer ${credential}` } }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        if (settled) return;
        size += chunk.length;
        if (size > MAX_JSON) { req.destroy(); finish(new ImError('PAYLOAD_TOO_LARGE')); }
        else chunks.push(chunk);
      });
      res.on('end', () => finish(null, { status: res.statusCode, body: Buffer.concat(chunks, size) }));
      res.on('aborted', () => finish(new ImError('STORAGE_UNAVAILABLE')));
      res.on('error', () => finish(new ImError('STORAGE_UNAVAILABLE')));
    });
    req.on('timeout', () => { req.destroy(); finish(new ImError('STORAGE_UNAVAILABLE')); });
    req.on('error', () => finish(new ImError('STORAGE_UNAVAILABLE')));
    req.end();
  });
}

/**
 * Host-neutral Nana session adapter over IM v1.
 * Received messages are durable in the local IM journal BEFORE the server ACK; the
 * host session consumes them through queue()/handoff(), which keeps its own cursor.
 * `transport` is a privileged test/private-CA seam and never comes from user input.
 */
export function createNanaSession({ config: rawConfig, transport, clock = Date.now } = {}) {
  const config = parseNanaConfig(rawConfig);
  const origin = normalizeOrigin(config.serverUrl);
  requireDirectory(config.attachmentDirectory);
  requireDirectory(dirname(config.journalPath));
  requireDirectory(dirname(config.statePath));
  if (config.evidencePath) requireDirectory(dirname(config.evidencePath));

  function credential() {
    try {
      const value = readFileSync(config.credentialFile, 'utf8').trim();
      if (!CREDENTIAL.test(value)) throw Error();
      return value;
    } catch { throw new ImError('AUTH_REQUIRED'); }
  }

  const db = new DatabaseSync(config.journalPath);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
  const client = createImClient({
    serverUrl: origin,
    agentId: config.agentId,
    getCredential: async () => credential(),
    journal: scope => createImJournal({ db, ...scope }),
    attachmentDirectory: config.attachmentDirectory,
    ...(transport === undefined ? {} : { transport }),
  });
  const lookup = transport === undefined ? httpsLookup(origin, credential) : path => transport({
    method: 'GET', path, credential: credential(), headers: {}, binary: false });
  let closed = false;

  function appendEvidence(entry) {
    if (!config.evidencePath) return;
    const line = `${JSON.stringify({ at: clock(), ...entry })}\n`;
    const fd = openSync(config.evidencePath,
      constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { writeFileSync(fd, line); fsyncSync(fd); } finally { closeSync(fd); }
  }

  async function getMessage(messageId) {
    let response;
    try { response = await lookup(`/api/v1/messages/${encodeURIComponent(messageId)}`); }
    catch (error) { throw error instanceof ImError ? error : new ImError('STORAGE_UNAVAILABLE'); }
    if (!response || !Number.isInteger(response.status) || !Buffer.isBuffer(response.body) ||
        response.body.length > MAX_JSON) fail('STORAGE_UNAVAILABLE');
    let data;
    try { data = JSON.parse(response.body.toString('utf8')); } catch { fail('STORAGE_UNAVAILABLE'); }
    if (response.status >= 400) throw asImError(data?.error?.code);
    if (response.status !== 200 || !data || typeof data !== 'object' || Array.isArray(data)) fail('STORAGE_UNAVAILABLE');
    if (data.messageId !== messageId || data.senderAgentId !== config.agentId && data.recipientAgentId !== config.agentId)
      fail('STORAGE_UNAVAILABLE');
    return data;
  }

  function receiverRow() {
    return db.prepare('SELECT cursor, generation, expires_at FROM im_client_receiver WHERE center=? AND agent=?')
      .get(origin, config.agentId);
  }

  function rows(after, size) {
    return db.prepare(`SELECT seq, epoch, message_id, message_json, recorded_at, acked
      FROM im_client_received WHERE center=? AND agent=? AND seq>? ORDER BY seq LIMIT ?`)
      .all(origin, config.agentId, after, size);
  }

  function parseRow(row) {
    try { return JSON.parse(row.message_json); } catch { fail('STORAGE_UNAVAILABLE'); }
  }

  function queue() {
    if (closed) fail('STORAGE_UNAVAILABLE');
    const state = readState(config.statePath);
    const received = db.prepare('SELECT COUNT(*) n FROM im_client_received WHERE center=? AND agent=?')
      .get(origin, config.agentId)?.n ?? 0;
    const pending = db.prepare('SELECT COUNT(*) n FROM im_client_received WHERE center=? AND agent=? AND seq>?')
      .get(origin, config.agentId, state.handedThrough)?.n ?? 0;
    return { agentId: config.agentId, received, handedThrough: state.handedThrough, pending,
      cursor: receiverRow()?.cursor ?? 0 };
  }

  async function acquire({ instanceId = randomUUID(), requestId = randomUUID() } = {}) {
    return client.acquire({ instanceId: uuid(instanceId), requestId: uuid(requestId) });
  }

  async function release() {
    return client.release();
  }

  async function receive({ limit } = {}) {
    const size = pageSize(limit, 20);
    const instanceId = randomUUID(), requestId = randomUUID();
    const lease = await acquire({ instanceId, requestId });
    let page, reconciled = [], failure = null;
    try {
      reconciled = (await client.ackPending({ limit: size })).acked ?? [];
      page = await client.receiveOnce({ limit: size });
    } catch (error) { failure = error; }
    let releaseCode = null;
    try { await client.release(); } catch (error) { releaseCode = error?.code ?? 'STORAGE_UNAVAILABLE'; }
    if (failure) throw failure;
    const received = (page.items ?? []).map(item => ({
      seq: item.seq,
      streamEpoch: item.streamEpoch,
      messageId: item.message.messageId,
      senderAgentId: item.message.senderAgentId,
      title: item.message.title,
      acceptedAt: item.message.acceptedAt,
      recordedAt: item.recordedAt,
      acked: false,
    }));
    // receiveOnce() returns the journal record captured before markAcked(); read the
    // committed ACK state so callers never mistake a durable ACK for a pending one.
    if (received.length) {
      const first = received[0].seq, last = received[received.length - 1].seq;
      const committed = new Map(db.prepare(`SELECT seq, acked FROM im_client_received
        WHERE center=? AND agent=? AND seq>=? AND seq<=?`).all(origin, config.agentId, first, last)
        .map(row => [row.seq, row.acked === 1]));
      for (const item of received) item.acked = committed.get(item.seq) === true;
    }
    for (const item of received) appendEvidence({ type: 'receive', instanceId, seq: item.seq, messageId: item.messageId,
      senderAgentId: item.senderAgentId, streamEpoch: item.streamEpoch, acked: item.acked });
    if (reconciled.length) appendEvidence({ type: 'ack_pending', messageIds: reconciled });
    return { instanceId, generation: lease.generation, received, reconciled, releaseError: releaseCode, hasMore: page.hasMore === true };
  }

  function handoff({ limit } = {}) {
    if (closed) fail('STORAGE_UNAVAILABLE');
    const size = pageSize(limit, 20);
    const state = readState(config.statePath);
    const pending = rows(state.handedThrough, size);
    if (!pending.length) return { handedThrough: state.handedThrough, items: [] };
    const items = pending.map(row => {
      const message = parseRow(row);
      return { seq: row.seq, messageId: message.messageId, senderAgentId: message.senderAgentId,
        title: message.title, text: message.text, inReplyTo: message.inReplyTo, correlation: message.correlation,
        acceptedAt: message.acceptedAt, recordedAt: row.recorded_at, acked: row.acked === 1 };
    });
    const handedThrough = pending[pending.length - 1].seq;
    writeState(config.statePath, handedThrough);
    appendEvidence({ type: 'handoff', messageIds: items.map(item => item.messageId),
      seqs: items.map(item => item.seq), handedThrough });
    return { handedThrough, items };
  }

  async function send({ toAgentId, text, clientMessageId = randomUUID(), title = null, inReplyTo = null, correlation = null } = {}) {
    const recipientAgentId = uuid(toAgentId);
    if (typeof text !== 'string' || !text.length || text.length > 32000) fail('INVALID_REQUEST');
    if (title !== null && (typeof title !== 'string' || !title.length || title.length > 100)) fail('INVALID_REQUEST');
    if (inReplyTo !== null) uuid(inReplyTo);
    if (correlation !== null && (typeof correlation !== 'string' || correlation.length > 200)) fail('INVALID_REQUEST');
    const id = uuid(clientMessageId);
    const conversation = await client.ensureConversation({ peerAgentId: recipientAgentId });
    if (typeof conversation?.conversationId !== 'string') fail('STORAGE_UNAVAILABLE');
    const result = await client.send({ protocol: PROTOCOL, conversationId: conversation.conversationId,
      recipientAgentId, clientMessageId: id, title, text, inReplyTo, correlation });
    // An unconfirmed earlier send is never re-POSTed implicitly; the caller reconciles it.
    if (result?.status === 'pending') return { status: 'pending', clientMessageId: id, recipientAgentId };
    if (typeof result?.messageId !== 'string' || !Number.isSafeInteger(result?.acceptedAt)) fail('STORAGE_UNAVAILABLE');
    appendEvidence({ type: 'send', clientMessageId: id, messageId: result.messageId, recipientAgentId });
    return { status: 'accepted', clientMessageId: id, messageId: result.messageId,
      acceptedAt: result.acceptedAt, recipientAgentId };
  }

  async function message({ messageId } = {}) {
    const dto = await getMessage(uuid(messageId));
    return { messageId: dto.messageId, senderAgentId: dto.senderAgentId, recipientAgentId: dto.recipientAgentId,
      clientMessageId: dto.clientMessageId, acceptedAt: dto.acceptedAt,
      deliveredAt: dto.deliveredAt ?? null, readAt: dto.readAt ?? null };
  }

  async function read({ messageId } = {}) {
    const result = await client.read(uuid(messageId));
    return { messageId: result.messageId, readAt: result.readAt, changed: result.changed === true };
  }

  function close() {
    if (closed) return;
    closed = true;
    client.close();
    db.close();
  }

  return Object.freeze({ config, acquire, release, receive, queue, handoff, send, message, read, close });
}
