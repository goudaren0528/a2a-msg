import { createHash } from 'node:crypto';
import { ImError, MAX_ATTACHMENT_BYTES, normalizeMessageRequest, fingerprintMessage, PROTOCOL } from './contracts.js';
import { withImmediateTransaction } from './transaction.js';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]{64}$/;
const fail = code => { throw new ImError(code); };
const integer = (v, min = 0) => Number.isSafeInteger(v) && v >= min;
const object = (v, keys) => v !== null && typeof v === 'object' && !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype && Object.keys(v).every(k => keys.includes(k));
const requireObject = (v, keys) => { if (!object(v, keys)) fail('INVALID_REQUEST'); };
const id = v => { if (typeof v !== 'string' || !UUID.test(v)) fail('INVALID_REQUEST'); return v.toLowerCase(); };
const hash = v => createHash('sha256').update(v).digest('hex');
// Base64 (10 MiB) + worst-case JSON-escaped 32k UTF-16 code units (6 bytes each),
// plus bounded title/name/mime/correlation and fixed DTO keys/UUIDs.
const MAX_JSON = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 210_000;
const MAX_RECEIVED_JSON = 210_000;
const DDL = Object.freeze({
  im_client_meta: `CREATE TABLE im_client_meta (version INTEGER NOT NULL, checksum TEXT NOT NULL)`,
  im_client_outgoing: `CREATE TABLE im_client_outgoing (center TEXT NOT NULL, agent TEXT NOT NULL, client_id TEXT NOT NULL, fingerprint TEXT NOT NULL, payload TEXT NOT NULL CHECK(length(payload)<=${MAX_JSON}), created_at INTEGER NOT NULL, message_id TEXT, accepted_at INTEGER, PRIMARY KEY(center,agent,client_id))`,
  im_client_received: `CREATE TABLE im_client_received (center TEXT NOT NULL, agent TEXT NOT NULL, epoch TEXT NOT NULL, seq INTEGER NOT NULL, message_id TEXT NOT NULL, fingerprint TEXT NOT NULL, message_json TEXT NOT NULL CHECK(length(message_json)<=${MAX_RECEIVED_JSON}), receipt_json TEXT, recorded_at INTEGER NOT NULL, acked INTEGER NOT NULL DEFAULT 0 CHECK(acked IN (0,1)), PRIMARY KEY(center,agent,epoch,seq), UNIQUE(center,agent,epoch,message_id))`,
  im_client_receiver: `CREATE TABLE im_client_receiver (center TEXT NOT NULL, agent TEXT NOT NULL, epoch TEXT, cursor INTEGER NOT NULL DEFAULT 0, instance_id TEXT, generation INTEGER, expires_at INTEGER, PRIMARY KEY(center,agent))`,
});
const checksum = hash(JSON.stringify(DDL));
const schemaMismatch = () => { const error = new Error('IM journal schema mismatch'); error.code = 'IM_SCHEMA_MISMATCH'; throw error; };

// Caller owns connection lifecycle, permissions and FK configuration.
export function migrateImJournal(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function') fail('STORAGE_UNAVAILABLE');
  return withImmediateTransaction(db, () => {
    const names = Object.keys(DDL);
    const existing = names.map(name => db.prepare('SELECT sql FROM sqlite_master WHERE type=? AND name=?').get('table', name)?.sql);
    if (db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'im_client_%' AND type IN ('table','view','trigger','index')").all()
      .some(row => !names.includes(row.name))) schemaMismatch();
    if (existing[0] === undefined && existing.some(Boolean)) schemaMismatch();
    if (existing[0] !== undefined) {
      if (existing.some((sql, i) => sql !== DDL[names[i]])) schemaMismatch();
      const rows = db.prepare('SELECT version,checksum FROM im_client_meta').all();
      if (rows.length !== 1 || rows[0].version !== 1 || rows[0].checksum !== checksum) schemaMismatch();
      return;
    }
    for (const sql of Object.values(DDL)) db.exec(sql);
    db.prepare('INSERT INTO im_client_meta(version,checksum) VALUES (?,?)').run(1, checksum);
  });
}

function centerOrigin(value) {
  if (typeof value !== 'string' || value.length > 2048) fail('INVALID_REQUEST');
  let url;
  try { url = new URL(value); } catch { fail('INVALID_REQUEST'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      url.pathname !== '/' || value !== url.origin && value !== `${url.origin}/`) fail('INVALID_REQUEST');
  return url.origin;
}
const page = opts => {
  requireObject(opts, ['limit']);
  const limit = opts.limit ?? 20;
  if (!integer(limit, 1) || limit > 100) fail('INVALID_REQUEST');
  return limit;
};
function validateMessage(m, recipient) {
  requireObject(m, ['messageId','conversationId','senderAgentId','recipientAgentId','clientMessageId','title','text','inReplyTo','correlation','acceptedAt','attachment']);
  if (Object.keys(m).length !== 11) fail('INVALID_REQUEST');
  for (const key of ['messageId','conversationId','senderAgentId','recipientAgentId','clientMessageId']) id(m[key]);
  if (m.recipientAgentId.toLowerCase() !== recipient || m.senderAgentId.toLowerCase() === recipient ||
      typeof m.title !== 'string' && m.title !== null || m.title?.length > 100 ||
      typeof m.text !== 'string' || m.text.length > 32000 ||
      m.inReplyTo !== null && (typeof m.inReplyTo !== 'string' || !UUID.test(m.inReplyTo)) ||
      m.correlation !== null && (typeof m.correlation !== 'string' || m.correlation.length > 200) ||
      !integer(m.acceptedAt)) fail('INVALID_REQUEST');
  if (m.attachment !== null) {
    const a = m.attachment;
    requireObject(a, ['attachmentId','name','mime','size','sha256']);
    id(a.attachmentId);
    if (typeof a.name !== 'string' || !a.name.length || a.name.length > 200 || a.name.includes('..') ||
        /[\\/\x00-\x1f\x7f]/.test(a.name) || a.name === '.' ||
        a.mime !== null && (typeof a.mime !== 'string' || !a.mime.length || a.mime.length > 100) ||
        !integer(a.size, 1) || a.size > MAX_ATTACHMENT_BYTES || !HEX.test(a.sha256)) fail('INVALID_ATTACHMENT');
  }
  if (!m.text.length && m.attachment === null) fail('INVALID_REQUEST');
  return JSON.stringify(m);
}

export function createImJournal({ db, centerId, agentId, testOnlyMemory = false } = {}) {
  const center = centerOrigin(centerId), agent = id(agentId);
  try {
    if (!db || typeof db.prepare !== 'function' ||
        ![2, 3].includes(db.prepare('PRAGMA synchronous').get()?.synchronous)) fail('STORAGE_UNAVAILABLE');
    const databases = db.prepare('PRAGMA database_list').all();
    if (!Array.isArray(databases) || !databases.some(row => row.name === 'main' &&
        (row.file || testOnlyMemory === true))) fail('STORAGE_UNAVAILABLE');
  } catch { fail('STORAGE_UNAVAILABLE'); }
  migrateImJournal(db);
  const scope = [center, agent];
  const now = () => { const n = Date.now(); if (!integer(n)) fail('CLOCK_UNSAFE'); return n; };
  const receiver = () => db.prepare('SELECT * FROM im_client_receiver WHERE center=? AND agent=?').get(...scope);
  const tx = fn => withImmediateTransaction(db, fn);
  function stageOutgoing(rawRequest) {
    const normalized = normalizeMessageRequest(rawRequest);
    if (normalized.recipientAgentId.toLowerCase() === agent) fail('INVALID_REQUEST');
    const fingerprint = fingerprintMessage(normalized);
    const payload = JSON.stringify({ protocol: PROTOCOL, conversationId: normalized.conversationId,
      recipientAgentId: normalized.recipientAgentId, clientMessageId: normalized.clientMessageId,
      title: normalized.title, text: normalized.text,
      attachment: normalized.attachment && { name: normalized.attachment.name, mime: normalized.attachment.mime,
        sha256: normalized.attachment.sha256, dataBase64: normalized.attachment.bytes.toString('base64') },
      inReplyTo: normalized.inReplyTo, correlation: normalized.correlation });
    if (Buffer.byteLength(payload) > MAX_JSON) fail('PAYLOAD_TOO_LARGE');
    return tx(() => {
      const old = db.prepare('SELECT fingerprint FROM im_client_outgoing WHERE center=? AND agent=? AND client_id=?').get(...scope, normalized.clientMessageId);
      if (old && old.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT');
      if (!old) db.prepare('INSERT INTO im_client_outgoing(center,agent,client_id,fingerprint,payload,created_at) VALUES (?,?,?,?,?,?)')
        .run(...scope, normalized.clientMessageId, fingerprint, payload, now());
      return getOutgoing(normalized.clientMessageId);
    });
  }
  function getOutgoing(clientMessageId) {
    const row = db.prepare('SELECT * FROM im_client_outgoing WHERE center=? AND agent=? AND client_id=?').get(...scope, id(clientMessageId));
    return row ? { clientMessageId: row.client_id, fingerprint: row.fingerprint, request: JSON.parse(row.payload),
      createdAt: row.created_at, messageId: row.message_id, acceptedAt: row.accepted_at } : null;
  }
  function listPendingOutgoing(opts = {}) {
    const limit = page(opts);
    return db.prepare('SELECT client_id,created_at FROM im_client_outgoing WHERE center=? AND agent=? AND message_id IS NULL ORDER BY created_at,client_id LIMIT ?')
      .all(...scope, limit).map(r => ({ clientMessageId: r.client_id, createdAt: r.created_at }));
  }
  function markAccepted(clientMessageId, result) {
    const key = id(clientMessageId);
    requireObject(result, ['messageId','acceptedAt']);
    const messageId = id(result.messageId);
    if (!integer(result.acceptedAt)) fail('INVALID_REQUEST');
    return tx(() => {
      const row = db.prepare('SELECT message_id,accepted_at FROM im_client_outgoing WHERE center=? AND agent=? AND client_id=?').get(...scope, key);
      if (!row) fail('RESOURCE_NOT_FOUND');
      if (row.message_id !== null && (row.message_id !== messageId || row.accepted_at !== result.acceptedAt)) fail('IDEMPOTENCY_CONFLICT');
      if (row.message_id === null) db.prepare('UPDATE im_client_outgoing SET message_id=?,accepted_at=? WHERE center=? AND agent=? AND client_id=?').run(messageId, result.acceptedAt, ...scope, key);
      return getOutgoing(key);
    });
  }
  function recordReceived(input) {
    requireObject(input, ['streamEpoch','seq','message','attachmentReceipt']);
    const epoch = id(input.streamEpoch);
    if (!integer(input.seq, 1)) fail('INVALID_REQUEST');
    const messageJson = validateMessage(input.message, agent);
    const a = input.message.attachment, receipt = input.attachmentReceipt ?? null;
    if (a && !receipt || !a && receipt) fail('INVALID_ATTACHMENT');
    if (receipt) {
      requireObject(receipt, ['path','sha256','size']);
      if (Object.keys(receipt).length !== 3) fail('INVALID_ATTACHMENT');
      if (typeof receipt.path !== 'string' || !receipt.path.length || receipt.path.length > 4096 ||
          /[\x00-\x1f\x7f]/.test(receipt.path) || receipt.sha256 !== a.sha256 || receipt.size !== a.size) fail('INVALID_ATTACHMENT');
    }
    const receiptJson = receipt ? JSON.stringify(receipt) : null;
    const fingerprint = hash(JSON.stringify([epoch, input.seq, messageJson, receiptJson]));
    return tx(() => {
      let state = receiver();
      if (!state) {
        db.prepare('INSERT INTO im_client_receiver(center,agent,epoch) VALUES (?,?,?)').run(...scope, epoch);
        state = receiver();
      }
      if (state.epoch !== epoch) fail('CURSOR_RESET_REQUIRED');
      const old = db.prepare('SELECT fingerprint FROM im_client_received WHERE center=? AND agent=? AND epoch=? AND (seq=? OR message_id=?)').all(...scope, epoch, input.seq, input.message.messageId);
      if (old.length) {
        if (old.length !== 1 || old[0].fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT');
      } else db.prepare('INSERT INTO im_client_received(center,agent,epoch,seq,message_id,fingerprint,message_json,receipt_json,recorded_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(...scope, epoch, input.seq, input.message.messageId, fingerprint, messageJson, receiptJson, now());
      return getReceived(input.message.messageId);
    });
  }
  function getReceived(messageId) {
    const row = db.prepare('SELECT * FROM im_client_received WHERE center=? AND agent=? AND message_id=?').get(...scope, id(messageId));
    return row ? { streamEpoch: row.epoch, seq: row.seq, message: JSON.parse(row.message_json),
      attachmentReceipt: row.receipt_json && JSON.parse(row.receipt_json), recordedAt: row.recorded_at, acked: !!row.acked } : null;
  }
  function listPendingAcks(opts = {}) {
    const limit = page(opts);
    return db.prepare('SELECT epoch,seq,message_id FROM im_client_received WHERE center=? AND agent=? AND acked=0 ORDER BY seq LIMIT ?')
      .all(...scope, limit).map(r => ({ streamEpoch: r.epoch, seq: r.seq, messageId: r.message_id }));
  }
  function markAcked(input) {
    requireObject(input, ['messageIds','ackedThrough','streamEpoch','syncAckedThrough','localCursor','seqs']);
    const epoch = id(input.streamEpoch);
    if (!Array.isArray(input.messageIds) || input.messageIds.length < 1 || input.messageIds.length > 100 ||
         !integer(input.ackedThrough) || !integer(input.syncAckedThrough) || !integer(input.localCursor) ||
         !Array.isArray(input.seqs) || input.seqs.length !== input.messageIds.length ||
          input.seqs.some(seq => !integer(seq, 1)) ||
          input.ackedThrough < input.syncAckedThrough) fail('INVALID_REQUEST');
    const ids = input.messageIds.map(id);
    if (new Set(ids).size !== ids.length) fail('INVALID_REQUEST');
    return tx(() => {
      const state = receiver();
      if (!state || state.epoch !== epoch || state.cursor !== input.localCursor ||
          input.syncAckedThrough < state.cursor) fail('CURSOR_RESET_REQUIRED');
      const lookup = db.prepare('SELECT seq FROM im_client_received WHERE center=? AND agent=? AND epoch=? AND message_id=?');
      for (let i = 0; i < ids.length; i++) {
        const messageId = ids[i];
        if (lookup.get(...scope, epoch, messageId)?.seq !== input.seqs[i]) fail('DELIVERY_REQUIRED');
      }
      for (const messageId of ids) {
        db.prepare('UPDATE im_client_received SET acked=1 WHERE center=? AND agent=? AND epoch=? AND message_id=?').run(...scope, epoch, messageId);
      }
      let cursor = state.cursor;
      const next = db.prepare('SELECT acked FROM im_client_received WHERE center=? AND agent=? AND epoch=? AND seq=?');
      while (next.get(...scope, epoch, cursor + 1)?.acked === 1) cursor++;
      // A newly filled hole may bridge previously ACKed rows beyond this batch's max seq.
      // The response may claim no more than the prefix proven by durable local ACKs.
      if (input.ackedThrough < cursor ||
          input.ackedThrough > Math.max(input.syncAckedThrough, ...input.seqs, cursor)) fail('CURSOR_RESET_REQUIRED');
      if (cursor !== state.cursor) db.prepare('UPDATE im_client_receiver SET cursor=? WHERE center=? AND agent=?').run(cursor, ...scope);
      return { streamEpoch: epoch, cursor };
    });
  }
  function setLease(input) {
    requireObject(input, ['instanceId','generation','expiresAt','streamEpoch']);
    const instance = id(input.instanceId), epoch = input.streamEpoch === undefined ? undefined : id(input.streamEpoch);
    if (!integer(input.generation, 1) || !integer(input.expiresAt)) fail('INVALID_REQUEST');
    return tx(() => {
      const current = receiver();
      if (current && (current.generation > input.generation ||
          current.generation === input.generation && current.instance_id !== instance)) fail('STALE_FENCE');
      if (current && epoch !== undefined && current.epoch !== null && current.epoch !== epoch) fail('CURSOR_RESET_REQUIRED');
      db.prepare(`INSERT INTO im_client_receiver(center,agent,epoch,instance_id,generation,expires_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(center,agent) DO UPDATE SET epoch=COALESCE(excluded.epoch,im_client_receiver.epoch),
        instance_id=excluded.instance_id,generation=excluded.generation,expires_at=excluded.expires_at`)
        .run(...scope, epoch ?? null, instance, input.generation, input.expiresAt);
      return getLease();
    });
  }
  function getLease() {
    const row = receiver();
    return row?.instance_id ? { instanceId: row.instance_id, generation: row.generation,
      expiresAt: row.expires_at, streamEpoch: row.epoch, cursor: row.cursor } : null;
  }
  return Object.freeze({ stageOutgoing, getOutgoing, listPendingOutgoing, markAccepted, recordReceived,
    getReceived, listPendingAcks, markAcked, setLease, getLease });
}
