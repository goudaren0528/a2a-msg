import { request as httpsRequest } from 'node:https';
import { getCACertificates, checkServerIdentity } from 'node:tls';
import { createHash } from 'node:crypto';
import { acquireImV2JournalOwner } from './journal-owner.js';
import { PROTOCOL, ImV2Error, dataSchemas, successEnvelopeSchema, errorEnvelopeSchema,
  operationSchema, postSchemas, normalizeMessageRequest, fingerprintMessage,
  MAX_FILE_BODY_BYTES, MAX_ATTACHMENT_BYTES, MAX_CLIENT_PROGRESS_ROUNDS } from './contracts.js';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const DEADLINE_MS = 30000;
// A call makes at most ten listBatches calls (each <=100 batches), including
// any cursor validation reads, and at most ten ACK/receipt requests. Cursor
// syntax is validated locally at invocation, so validation consumes no pages.
const SCAN_PAGES = 10;
const fail = code => { throw new ImV2Error(code); };
const safeError = error => error instanceof ImV2Error ? new ImV2Error(error.code) : new ImV2Error('STORAGE_UNAVAILABLE');
const integer = (n, min = 0) => Number.isSafeInteger(n) && n >= min;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function object(value, keys, required = []) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).some(k => !keys.includes(k)) || required.some(k => !Object.hasOwn(value, k))) fail('INVALID_REQUEST');
  return value;
}
function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) fail('INVALID_REQUEST');
  return result.data;
}
function limit(value) {
  if (!integer(value, 1) || value > 100) fail('INVALID_REQUEST');
  return value;
}
function snapshotObject(value, keys, required = []) {
  return { ...object(value, keys, required) };
}
const INPUT_EPOCH = '00000000-0000-0000-0000-000000000000';
function snapshotSend(input) {
  const copy = snapshotObject(input, ['clientMessageId', 'conversationId', 'recipientAgentId',
    'title', 'text', 'attachment', 'inReplyTo', 'correlation']);
  if (copy.attachment !== undefined && copy.attachment !== null) copy.attachment = snapshotObject(copy.attachment,
    ['name', 'mime', 'sha256', 'dataBase64']);
  // This public input contract accepts canonical base64, not borrowed bytes.
  // Decode/copy and validate before scheduling. The placeholder is validation
  // scope only; authenticated /me supplies both actual epochs before use.
  return normalizeMessageRequest({ ...copy, protocol: PROTOCOL, centerEpoch: INPUT_EPOCH, originEpoch: INPUT_EPOCH });
}
function snapshotOperation(input) {
  return parse(operationSchema, snapshotObject(input, ['originEpoch', 'clientMessageId'], ['originEpoch', 'clientMessageId']));
}
function snapshotAcquire(input) {
  const copy = snapshotObject(input, ['instanceId', 'requestId'], ['instanceId', 'requestId']);
  const { instanceId, requestId } = parse(postSchemas.lease, { ...copy, protocol: PROTOCOL, centerEpoch: INPUT_EPOCH });
  return { instanceId, requestId };
}
function snapshotContinuation(input) {
  const c = snapshotObject(input, ['partitionId', 'pendingAfter', 'confirmedAfter', 'phase'],
    ['partitionId', 'pendingAfter', 'confirmedAfter', 'phase']);
  if (typeof c.partitionId !== 'string' || !HASH.test(c.partitionId) || !['pending', 'confirmed'].includes(c.phase)) fail('INVALID_REQUEST');
  for (const state of ['pending', 'confirmed']) {
    const token = c[`${state}After`];
    if (token === null) continue;
    if (typeof token !== 'string' || !token.length || Buffer.byteLength(token) > 512 || !/^[A-Za-z0-9_-]+$/.test(token)) fail('INVALID_REQUEST');
    let text, value;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(token, 'base64url')); value = JSON.parse(text); }
    catch { fail('INVALID_REQUEST'); }
    if (!Array.isArray(value) || value.length !== 6 || value[0] !== 2 || value[1] !== 'batches' ||
        value[2] !== c.partitionId || value[3] !== state || !integer(value[4]) ||
        typeof value[5] !== 'string' || !HASH.test(value[5]) || JSON.stringify(value) !== text ||
        Buffer.from(text).toString('base64url') !== token) fail('INVALID_REQUEST');
  }
  return c;
}
function snapshotReceive(input) {
  const copy = snapshotObject(input, ['limit']);
  return { limit: limit(copy.limit ?? 20) };
}
function snapshotAck(input) {
  const copy = snapshotObject(input, ['limit', 'continuation']);
  return { limit: limit(copy.limit ?? 20),
    continuation: copy.continuation === undefined ? undefined : snapshotContinuation(copy.continuation) };
}
function snapshotRead(input) {
  const copy = snapshotObject(input, ['messageId'], ['messageId']);
  if (typeof copy.messageId !== 'string' || !UUID.test(copy.messageId)) fail('INVALID_REQUEST');
  return copy;
}
function snapshotReconcile(input) {
  const copy = snapshotObject(input, ['oldPartitionId', 'decisionRef'], ['oldPartitionId', 'decisionRef']);
  if (typeof copy.oldPartitionId !== 'string' || !HASH.test(copy.oldPartitionId) ||
      typeof copy.decisionRef !== 'string' || !copy.decisionRef.length || copy.decisionRef.length > 255 ||
      /[\x00-\x1f\x7f]/.test(copy.decisionRef)) fail('INVALID_REQUEST');
  return copy;
}
// Cancellation detaches only the credential wait. Both fulfillment and
// rejection handlers remain attached to consume late settlement, but retain no
// operation continuation or credential after abort. External provider effects
// are not cancellable by this client. File/transport work is still awaited.
function credentialWait(provider, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; signal.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve(value);
    };
    const onAbort = () => finish(new ImV2Error('STORAGE_UNAVAILABLE'));
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      Promise.resolve(provider({ signal })).then(value => finish(null, value),
        () => finish(new ImV2Error('STORAGE_UNAVAILABLE')));
    } catch { finish(new ImV2Error('STORAGE_UNAVAILABLE')); }
  });
}
function headersOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('INVALID_REQUEST');
  const result = Object.create(null);
  for (const [key, value] of Object.entries(raw)) {
    const name = key.toLowerCase();
    if (Object.hasOwn(result, name) || typeof value !== 'string' || /[\r\n]/.test(value)) fail('INVALID_REQUEST');
    result[name] = value;
  }
  return result;
}

function nodeTransport(origin, ca) {
  // Explicit CA augmentation, no proxy agent or redirect machinery. Node's
  // ordinary certificate-chain and hostname checks remain mandatory.
  const certificates = ca === undefined ? undefined : [...getCACertificates('default'), ...[ca].flat()];
  return ({ method, path, credential, headers, body, binary, signal }) => new Promise((resolve, reject) => {
    const req = httpsRequest(new URL(path, origin), {
      method, agent: false, rejectUnauthorized: true, checkServerIdentity,
      ...(certificates ? { ca: certificates } : {}), signal,
      headers: { ...headers, authorization: `Bearer ${credential}` },
    }, res => {
      const chunks = []; let size = 0;
      res.on('error', reject);
      res.on('aborted', () => reject(new ImV2Error('STORAGE_UNAVAILABLE')));
      res.on('data', chunk => {
        size += chunk.length;
        if (size > (binary && res.statusCode === 200 ? MAX_ATTACHMENT_BYTES : MAX_FILE_BODY_BYTES)) {
          res.destroy(); req.destroy(); reject(new ImV2Error('PAYLOAD_TOO_LARGE'));
        } else chunks.push(chunk);
      });
      res.on('end', () => {
        if (!res.complete) return reject(new ImV2Error('STORAGE_UNAVAILABLE'));
        // Preserve duplicate header detection rather than Node's joined values.
        const responseHeaders = Object.create(null);
        for (let i = 0; i < res.rawHeaders.length; i += 2) {
          const name = res.rawHeaders[i].toLowerCase();
          if (Object.hasOwn(responseHeaders, name)) return reject(new ImV2Error('INVALID_REQUEST'));
          responseHeaders[name] = res.rawHeaders[i + 1];
        }
        resolve({ status: res.statusCode, headers: responseHeaders, body: Buffer.concat(chunks, size) });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

export function createImV2Client(options) {
  object(options, ['serverUrl', 'agentId', 'getCredential', 'journal', 'attachments', 'ca', 'transport'],
    ['serverUrl', 'agentId', 'getCredential', 'journal']);
  const { serverUrl, agentId, getCredential, journal, attachments, ca } = options;
  let url;
  try { url = new URL(serverUrl); } catch { fail('INVALID_REQUEST'); }
  if (typeof serverUrl !== 'string' || serverUrl !== url.origin || url.protocol !== 'https:' ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      Buffer.byteLength(serverUrl) > 2048 || typeof agentId !== 'string' || !UUID.test(agentId) || typeof getCredential !== 'function' ||
      options.transport !== undefined && typeof options.transport !== 'function' ||
      ca !== undefined && ![ca].flat().every(x => typeof x === 'string' || Buffer.isBuffer(x)) ||
      attachments !== undefined && (!attachments || typeof attachments.save !== 'function' || typeof attachments.verify !== 'function')) fail('INVALID_REQUEST');

  // Trusted provisioning/registration belongs to the caller. No journal method,
  // credential callback, or transport is touched before exclusive ownership.
  const owner = acquireImV2JournalOwner(journal);
  let transport;
  try { transport = options.transport ?? nodeTransport(serverUrl, ca); }
  catch { owner.release(); fail('STORAGE_UNAVAILABLE'); }
  let partition = null, stream = null, active = null, controller = null;
  let closing = false, closed = false, closePromise = null;
  let issuedContinuation = null, scanGuard = null;
  const scanWrites = new Set(['prepareBatch', 'recordMessage', 'recordExpiry', 'confirmBatch', 'markReconciliationRequired']);

  function held() { owner.assertHeld(); }
  function work() { held(); if (closing || controller?.signal.aborted) fail('IM_DISABLED'); }
  function changeStamp() {
    work();
    const stamp = journal.getChangeStamp();
    if (!stamp || typeof stamp.connectionId !== 'string' || !stamp.connectionId.length ||
        typeof stamp.localChanges !== 'bigint' || stamp.localChanges < 0n ||
        typeof stamp.externalVersion !== 'bigint' || stamp.externalVersion < 0n) fail('STORAGE_UNAVAILABLE');
    return Object.freeze({ connectionId: stamp.connectionId, localChanges: stamp.localChanges, externalVersion: stamp.externalVersion });
  }
  function sameStamp(a, b) {
    return a.connectionId === b.connectionId && a.localChanges === b.localChanges && a.externalVersion === b.externalVersion;
  }
  function checkScanStamp() {
    const stamp = changeStamp();
    if (scanGuard && !sameStamp(stamp, scanGuard.expected)) fail('PLAN_STALE');
    return stamp;
  }
  function local(name, ...args) {
    work();
    if (!scanGuard) return journal[name](...args);
    const before = checkScanStamp();
    const value = journal[name](...args);
    const after = changeStamp();
    if (scanWrites.has(name)) {
      // Exactly one synchronous owned mutation. Trusted journal clocks/helpers
      // must be pure and non-reentrant; this is not arbitrary same-stack SQL attribution.
      if (after.connectionId !== before.connectionId || after.externalVersion !== before.externalVersion ||
          after.localChanges < before.localChanges) fail('PLAN_STALE');
      scanGuard.expected = after;
    } else if (!sameStamp(before, after)) fail('PLAN_STALE');
    return value;
  }
  function run(fn) {
    if (closing || closed) return Promise.reject(new ImV2Error('IM_DISABLED'));
    if (active) return Promise.reject(new ImV2Error('OPERATION_FORBIDDEN'));
    controller = new AbortController();
    const pending = Promise.resolve().then(() => { work(); return fn(); }).catch(error => {
      issuedContinuation = null; throw safeError(error);
    });
    active = pending;
    return pending.finally(() => { if (active === pending) { active = null; controller = null; } });
  }
  function invoke(input, snapshot, fn) {
    // Execute snapshot/validation synchronously at invocation, outside run's
    // scheduled microtask. Async code below receives only this private copy.
    let copy;
    try { copy = snapshot(input); } catch (error) { issuedContinuation = null; return Promise.reject(safeError(error)); }
    return run(() => fn(copy));
  }
  function scope() { return { protocol: PROTOCOL, centerEpoch: partition.centerEpoch }; }
  function freeze() {
    issuedContinuation = null;
    if (partition) {
      held();
      // bindIdentity may already have durably frozen this partition.
      try { local('requireActivePartition', partition.partitionId); }
      catch (error) { if (error.code === 'RECOVERY_RECONCILIATION_REQUIRED') return; throw error; }
      local('markReconciliationRequired', partition.partitionId);
    }
  }
  async function request(method, path, kind, body, { initial = false, binary = null, fence } = {}) {
    work();
    const abort = new AbortController();
    const operationSignal = controller.signal;
    const onAbort = () => abort.abort();
    operationSignal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(onAbort, DEADLINE_MS);
    let credential;
    try {
      credential = await credentialWait(getCredential, abort.signal);
      work();
      if (scanGuard) checkScanStamp();
      if (abort.signal.aborted) fail('STORAGE_UNAVAILABLE');
      if (typeof credential !== 'string' || !credential.length || credential.length > 8192 || /[^\x21-\x7e]/.test(credential)) fail('INVALID_CREDENTIAL');
      const headers = { 'x-a2a-protocol': PROTOCOL,
        ...(!initial ? { 'x-a2a-center-epoch': partition.centerEpoch } : {}),
        ...(fence ? { 'x-a2a-instance-id': fence.instanceId, 'x-a2a-generation': String(fence.generation) } : {}) };
      const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      if (encoded) {
        if (encoded.length > MAX_FILE_BODY_BYTES) fail('PAYLOAD_TOO_LARGE');
        headers['content-type'] = 'application/json; charset=utf-8'; headers['content-length'] = String(encoded.length);
      }
      const response = await transport({ method, path: `/api/v2${path}`, credential, headers, body: encoded,
        binary: binary !== null, signal: abort.signal });
      credential = undefined;
      work();
      if (scanGuard) checkScanStamp();
      if (abort.signal.aborted) fail('STORAGE_UNAVAILABLE');
      if (!response || !integer(response.status, 100) || response.status > 599 || !Buffer.isBuffer(response.body)) fail('INVALID_REQUEST');
      const h = headersOf(response.headers), bytes = response.body;
      if (bytes.length > (binary && response.status === 200 ? MAX_ATTACHMENT_BYTES : MAX_FILE_BODY_BYTES)) fail('PAYLOAD_TOO_LARGE');
      if (h['content-encoding'] !== undefined && h['content-encoding'] !== 'identity') fail('INVALID_REQUEST');
      if (h['content-length'] !== undefined && (!/^(0|[1-9][0-9]*)$/.test(h['content-length']) || Number(h['content-length']) !== bytes.length)) fail('INVALID_REQUEST');
      if (binary && response.status === 200) {
        if (h['x-a2a-protocol'] !== PROTOCOL || h['x-a2a-center-epoch'] !== partition.centerEpoch ||
            h['content-length'] !== String(binary.size) || bytes.length !== binary.size || digest(bytes) !== binary.sha256) fail('INVALID_ATTACHMENT');
        return Buffer.from(bytes);
      }
      if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(h['content-type'] ?? '')) fail('INVALID_REQUEST');
      let json;
      try { json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('INVALID_REQUEST'); }
      if (response.status < 200 || response.status >= 300) {
        const e = parse(errorEnvelopeSchema, json), fixed = new ImV2Error(e.error.code);
        if (fixed.status !== response.status || fixed.retryable !== e.error.retryable || fixed.message !== e.error.message ||
            h['x-a2a-protocol'] !== undefined && h['x-a2a-protocol'] !== PROTOCOL ||
            h['x-a2a-center-epoch'] !== undefined && h['x-a2a-center-epoch'] !== (e.currentCenterEpoch ?? partition?.centerEpoch)) fail('INVALID_REQUEST');
        if (fixed.code === 'RECOVERY_RECONCILIATION_REQUIRED') freeze();
        throw fixed; // currentCenterEpoch is never identity authority.
      }
      if (response.status !== 200 && !(kind === 'send' && response.status === 201)) fail('INVALID_REQUEST');
      const envelope = parse(successEnvelopeSchema, json);
      if (h['x-a2a-protocol'] !== undefined && h['x-a2a-protocol'] !== envelope.protocol ||
          h['x-a2a-center-epoch'] !== undefined && h['x-a2a-center-epoch'] !== envelope.centerEpoch) fail('INVALID_REQUEST');
      if (!initial && envelope.centerEpoch !== partition.centerEpoch) { freeze(); fail('RECOVERY_RECONCILIATION_REQUIRED'); }
      const data = parse(dataSchemas[kind], envelope.data);
      if (kind === 'send' && data.replayed !== (response.status === 200)) fail('INVALID_REQUEST');
      return { ...envelope, data };
    } finally {
      credential = undefined; clearTimeout(timer); operationSignal.removeEventListener('abort', onAbort);
    }
  }
  async function probe(bind = true) {
    const { data, centerEpoch } = await request('GET', '/me', 'me', undefined, { initial: true });
    if (data.agentId !== agentId || data.centerEpoch !== centerEpoch) fail('INVALID_REQUEST');
    const identity = { centerOrigin: serverUrl, stableInstanceId: data.instanceId, agentId, centerEpoch };
    if (bind) {
      const partitionId = local('bindIdentity', identity);
      if (partition && partition.partitionId !== partitionId) { freeze(); fail('RECOVERY_RECONCILIATION_REQUIRED'); }
      partition = { ...identity, partitionId };
      local('requireActivePartition', partitionId);
    }
    return identity;
  }
  function find(op) { return local('findOutgoing', { centerOrigin: serverUrl, agentId, ...op }); }
  async function querySend(op) {
    const known = find(op);
    try {
      const { data } = await request('GET', `/sends/${op.originEpoch}/${op.clientMessageId}`, 'sendResult');
      if (data.originEpoch !== op.originEpoch || data.clientMessageId !== op.clientMessageId || data.retryUntil < data.acceptedAt) fail('INVALID_REQUEST');
      if (known) local('markAccepted', known.partition.partitionId, op, data);
      return data;
    } catch (error) {
      if (error.code === 'SEND_OUTCOME_UNKNOWN' && known) local('markRemoteUnknown', known.partition.partitionId, op);
      if (error.code === 'RESOURCE_NOT_FOUND' && known &&
          (known.outgoing.acceptance_state === 'accepted' || known.partition.partitionId !== partition.partitionId || op.originEpoch !== partition.centerEpoch)) {
        local('markRemoteUnknown', known.partition.partitionId, op);
        fail('SEND_OUTCOME_UNKNOWN');
      }
      throw error;
    }
  }
  async function postOriginal(saved) {
    if (!saved.request || saved.source_protocol !== PROTOCOL) fail('SEND_OUTCOME_UNKNOWN');
    if (saved.origin_epoch !== partition.centerEpoch || saved.partition_id !== partition.partitionId) fail('SEND_OUTCOME_UNKNOWN');
    const { data } = await request('POST', '/messages', 'send', saved.request);
    const m = data.message, original = normalizeMessageRequest(saved.request);
    // The POST message has no payloadHash. Reconstruct only its metadata hash;
    // attachment bytes are the original staged immutable bytes, never a GET.
    const normalized = { ...original, ...Object.fromEntries(['originEpoch', 'clientMessageId', 'conversationId',
      'recipientAgentId', 'title', 'text', 'inReplyTo', 'correlation'].map(k => [k, m[k]])),
      attachment: m.attachment === null ? null : { name: m.attachment.name, mime: m.attachment.mime,
        size: m.attachment.size, sha256: m.attachment.sha256, bytes: original.attachment?.bytes } };
    if (m.senderAgentId !== agentId || m.expiresAt < m.acceptedAt || fingerprintMessage(normalized) !== saved.fingerprint ||
        m.acceptedAt > Number.MAX_SAFE_INTEGER - 604800000) fail('INVALID_REQUEST');
    const result = { originEpoch: m.originEpoch, clientMessageId: m.clientMessageId, messageId: m.messageId,
      acceptedAt: m.acceptedAt, payloadHash: saved.fingerprint, sourceProtocol: PROTOCOL,
      contentState: 'live', retryUntil: m.acceptedAt + 604800000 };
    local('markAccepted', saved.partition_id, { originEpoch: saved.origin_epoch, clientMessageId: saved.client_message_id }, result);
    return result;
  }
  async function recover(op) {
    try { return await querySend(op); }
    catch (error) {
      if (error.code !== 'RESOURCE_NOT_FOUND' || op.originEpoch !== partition.centerEpoch) throw error;
      const known = find(op);
      if (!known || known.partition.partitionId !== partition.partitionId || known.outgoing.acceptance_state === 'accepted' ||
          known.outgoing.reconciliation_state !== 'none') fail('SEND_OUTCOME_UNKNOWN');
      return postOriginal(known.outgoing);
    }
  }
  function receiver() {
    if (!stream) fail('STALE_FENCE'); // A restart explicitly acquires (or replays acquisition) to discover its stream.
    const row = local('getReceiver', partition.partitionId, stream);
    if (!row || !UUID.test(row.instance_id ?? '') || !integer(row.generation, 1) || !integer(row.expires_at)) fail('STALE_FENCE');
    return row;
  }
  function fence(row = receiver()) { return { instanceId: row.instance_id, generation: row.generation }; }
  function leaseEvidence(data, expected) {
    if (data.centerEpoch !== partition.centerEpoch || data.instanceId !== expected.instanceId ||
        expected.generation !== undefined && data.generation !== expected.generation ||
        expected.streamEpoch !== undefined && data.streamEpoch !== expected.streamEpoch || data.expiresAt <= 0) fail('INVALID_REQUEST');
    return { ...data, historical: false };
  }
  async function renew(tuple, expectedStream) {
    const { data } = await request('POST', '/receiver/lease/renew', 'renew', { ...scope(), ...tuple });
    const evidence = leaseEvidence(data, { ...tuple, streamEpoch: expectedStream });
    local('setLease', partition.partitionId, evidence);
    if (stream !== evidence.streamEpoch) issuedContinuation = null;
    stream = evidence.streamEpoch;
    return evidence;
  }
  async function sync(n) {
    const row = receiver(), after = row.handled_cursor;
    const { data } = await request('GET', `/sync?streamEpoch=${stream}&after=${after}&limit=${n}`, 'sync', undefined, { fence: fence(row) });
    if (data.streamEpoch !== stream || data.ackedThrough > data.handledThrough || data.handledThrough < after ||
        data.items.length > n || data.pageAfter !== after + data.items.length || data.hasMore && data.items.length !== n) fail('INVALID_REQUEST');
    for (const [i, item] of data.items.entries()) {
      if (item.centerEpoch !== partition.centerEpoch || item.streamEpoch !== stream || item.seq !== after + i + 1) fail('INVALID_REQUEST');
      if (item.kind === 'message' && (item.message.recipientAgentId !== agentId || item.message.senderAgentId === agentId ||
          item.message.expiresAt < item.message.acceptedAt) || item.kind === 'content_expired' &&
          (item.tombstone.expiredAt < item.tombstone.expiresAt || item.tombstone.expiresAt < item.tombstone.acceptedAt)) fail('INVALID_REQUEST');
    }
    return data;
  }
  function fact(seq, kind) { return local('getReceivedFact', partition.partitionId, { streamEpoch: stream, seq, kind }); }
  async function verifyFact(ref) {
    const saved = fact(ref.seq, 'message');
    if (!saved || saved.messageId !== ref.messageId) fail('STORAGE_UNAVAILABLE');
    if (saved.fact.attachment) {
      if (!attachments) fail('INVALID_ATTACHMENT');
      if (await attachments.verify({ partition, messageId: saved.messageId, attachment: saved.fact.attachment,
        receipt: saved.attachmentReceipt }) !== true) fail('INVALID_ATTACHMENT');
      work();
      if (scanGuard) checkScanStamp();
    }
  }
  function prepare(kind, items) {
    const b = local('prepareBatch', partition.partitionId, { streamEpoch: stream, kind, items });
    return { batchId: b.batch_id, kind: b.kind, items: b.items, state: b.state,
      lastResponse: b.last_response_json === null ? null : JSON.parse(b.last_response_json), streamEpoch: b.stream_epoch };
  }
  async function persist(page) {
    for (const item of page.items) {
      if (item.kind === 'content_expired') local('recordExpiry', partition.partitionId,
        { streamEpoch: stream, seq: item.seq, tombstone: item.tombstone });
      else {
        const saved = fact(item.seq, 'message');
        let receipt = null;
        if (saved) { await verifyFact({ seq: item.seq, messageId: item.message.messageId }); receipt = saved.attachmentReceipt; }
        else if (item.message.attachment) {
          if (!attachments) fail('INVALID_ATTACHMENT');
          let downloadFailure;
          try {
            receipt = await attachments.save({ partition, messageId: item.message.messageId, attachment: item.message.attachment,
              download: async () => {
                try { return await request('GET', `/attachments/${item.message.attachment.attachmentId}`, null, undefined,
                  { binary: item.message.attachment }); }
                catch (error) { downloadFailure = error; throw error; }
              } });
          } catch (error) { throw downloadFailure ?? error; }
          work();
        }
        local('recordMessage', partition.partitionId, { streamEpoch: stream, seq: item.seq, message: item.message, receipt });
      }
    }
  }
  function budget() { return { rounds: 0, syncs: 0, pending: false, deferredExpiryResync: false }; }
  async function expiryResync(batch, b) {
    if (b.syncs >= MAX_CLIENT_PROGRESS_ROUNDS) { b.pending = true; return false; }
    b.syncs++;
    const page = await sync(100);
    // Only authenticated sync tombstones create expiry facts. A remote error
    // alone never creates a tombstone or discards an attachment receipt.
    let discovered = false;
    for (const item of page.items) {
      if (item.kind !== 'content_expired' || !batch.items.some(ref =>
        ref.seq === item.seq && ref.messageId === item.tombstone.messageId) || fact(item.seq, 'content_expired')) continue;
      local('recordExpiry', partition.partitionId, { streamEpoch: stream, seq: item.seq, tombstone: item.tombstone });
      discovered = true;
    }
    // Earlier/unrelated/already-known tombstones are not progress for this ACK.
    // Defer it until explicit receive processes the earlier trusted cursor page.
    return discovered;
  }
  async function dispatch(batch, b) {
    if (batch.streamEpoch !== stream) fail('CURSOR_RESET_REQUIRED');
    if (batch.kind === 'ack') {
      const live = [], expired = [];
      for (const ref of batch.items) {
        const expiredFact = fact(ref.seq, 'content_expired');
        if (expiredFact) { if (expiredFact.messageId !== ref.messageId) fail('STORAGE_UNAVAILABLE'); if (!expiredFact.serverConfirmed) expired.push(ref); }
        else live.push(ref);
      }
      if (live.length !== batch.items.length) {
        if (expired.length) await dispatch(prepare('expiry', expired), b);
        if (live.length) await dispatch(prepare('ack', live), b);
        return; // Preserve the obsolete original ACK, including pending state.
      }
    }
    if (batch.state === 'confirmed' && !batch.lastResponse?.progressPending) {
      const r = receiver();
      if (r.handled_cursor >= r.server_handled && r.acked_cursor >= r.server_acked) return;
    }
    while (b.rounds < MAX_CLIENT_PROGRESS_ROUNDS) {
      if (batch.kind === 'ack') for (const ref of batch.items) await verifyFact(ref);
      b.rounds++;
      let response;
      try { response = await request('POST', batch.kind === 'ack' ? '/acks' : '/expiry-receipts',
        batch.kind === 'ack' ? 'acks' : 'expiryReceipts', { ...scope(), ...fence(), streamEpoch: stream, items: batch.items }); }
      catch (error) {
        if (batch.kind === 'ack' && ['EXPIRY_RECEIPT_REQUIRED', 'CONTENT_EXPIRED'].includes(error.code)) {
          if (await expiryResync(batch, b)) return dispatch(batch, b);
          b.deferredExpiryResync = true; return;
        }
        throw error;
      }
      if (response.data.streamEpoch !== stream || response.data.ackedThrough > response.data.handledThrough) fail('INVALID_REQUEST');
      const progress = local('confirmBatch', batch.batchId, response);
      if (!response.data.progressPending && !progress.progressPending) {
        // Later confirmations may close a transient cursor gap. Derive that
        // requirement from current durable watermarks at return, never latch it.
        return;
      }
    }
    b.pending = true;
  }
  function startContinuation() { return { partitionId: partition.partitionId, pendingAfter: null, confirmedAfter: null, phase: 'pending' }; }
  function continuationMatches(value, record = issuedContinuation) {
    return record !== null && record.partitionId === partition?.partitionId && record.streamEpoch === stream &&
      ['partitionId', 'pendingAfter', 'confirmedAfter', 'phase'].every(key => value[key] === record.value[key]);
  }
  function issueContinuation(value, stamp, deferredExpiryResync) {
    // One value-based proof, not a transferable/restart capability. A detached
    // JSON copy is accepted; superseded values have no retained registry entry.
    const copy = Object.freeze({ ...value });
    issuedContinuation = Object.freeze({ value: copy, partitionId: partition.partitionId, streamEpoch: stream,
      journalStamp: stamp, deferredExpiryResync });
    return copy;
  }
  function receiveContinuation(deferredExpiryResync) {
    return issueContinuation(startContinuation(), changeStamp(), deferredExpiryResync);
  }
  function batchCursor(batch, phase) {
    return Buffer.from(JSON.stringify([2, 'batches', partition.partitionId, phase, batch.createdAt, batch.batchId])).toString('base64url');
  }
  function receiverNeedsResync() {
    // acquire discovered this stream from authenticated server evidence, and
    // dispatch rejects every other stream. Never trust continuation fields for
    // this result: even an empty final page must reread the durable watermarks.
    const r = receiver();
    if (![r.handled_cursor, r.acked_cursor, r.server_handled, r.server_acked].every(n => integer(n))) fail('STORAGE_UNAVAILABLE');
    return r.handled_cursor < r.server_handled || r.acked_cursor < r.server_acked;
  }
  async function scan(n, supplied) {
    const prior = issuedContinuation;
    issuedContinuation = null; // Consume on entry; failure never reissues proof.
    if (supplied !== undefined && !continuationMatches(supplied, prior)) fail('INVALID_REQUEST');
    const c = supplied === undefined ? startContinuation() : { ...supplied };
    if (c.partitionId !== partition.partitionId) fail('INVALID_REQUEST');
    const stamp = changeStamp();
    if (supplied !== undefined && !sameStamp(stamp, prior.journalStamp)) fail('PLAN_STALE');
    scanGuard = { expected: stamp };
    const b = budget(); let pages = 0;
    b.deferredExpiryResync = supplied === undefined ? false : prior.deferredExpiryResync;
    const result = continuation => {
      const resyncRequired = receiverNeedsResync() || b.deferredExpiryResync;
      const pending = continuation !== null || b.pending || resyncRequired;
      // Final stamp is the completion/proof linearization point. Later writes
      // belong to the next scan. Stamp samples have constant SQL cost, separate
      // from the <=10 listBatches page-call budget; no long read transaction.
      const finalStamp = checkScanStamp();
      return { pending, progressPending: pending, resyncRequired, rounds: b.rounds,
        continuation: continuation === null ? null : issueContinuation(continuation, finalStamp, b.deferredExpiryResync) };
    };
    try {
      while (pages < SCAN_PAGES) {
        const key = `${c.phase}After`;
        pages++;
        const page = local('listBatches', partition.partitionId, { state: c.phase, limit: n,
          ...(c[key] === null ? {} : { after: c[key] }) });
        for (const batch of page.items) {
          await dispatch(batch, b);
          if (b.pending) return result({ ...c });
          // A resync-deferred batch remains immutable/pending, but this scan moves
          // past it so it cannot starve later batches. Budget-exhausted exact
          // replays above retain the preceding cursor for the next explicit call.
          c[key] = batchCursor(batch, c.phase);
          if (b.rounds >= MAX_CLIENT_PROGRESS_ROUNDS) return result(c);
        }
        if (page.nextCursor === null) {
          if (c.phase === 'confirmed') return result(null);
          c.phase = 'confirmed';
        }
      }
      return result(c);
    } catch (error) {
      issuedContinuation = null;
      throw error;
    } finally { scanGuard = null; }
  }

  return Object.freeze({
    connect: () => run(async () => { await probe(); return { ...partition }; }),
    send: input => invoke(input, snapshotSend, async savedInput => {
      await probe();
      const normalized = { ...savedInput, ...scope(), originEpoch: partition.centerEpoch };
      const op = { originEpoch: normalized.originEpoch, clientMessageId: normalized.clientMessageId };
      const prior = find(op);
      if (prior) {
        if (prior.outgoing.source_protocol !== PROTOCOL || prior.outgoing.fingerprint !== fingerprintMessage(normalized)) fail('IDEMPOTENCY_CONFLICT');
        // Repeated send intent is query-only, including same-epoch operations
        // belonging to an archived stable identity. Never stage a second copy.
        try { return await querySend(op); }
        catch (error) { if (error.code === 'RESOURCE_NOT_FOUND') fail('SEND_OUTCOME_UNKNOWN'); throw error; }
      }
      const staged = local('stageOutgoing', partition.partitionId, normalized);
      return postOriginal(staged);
    }),
    getSendResult: input => invoke(input, snapshotOperation, async op => { await probe(); return querySend(op); }),
    recoverSend: input => invoke(input, snapshotOperation, async op => { await probe(); return recover(op); }),
    acquire: input => invoke(input, snapshotAcquire, async input => {
      await probe();
      const body = parse(postSchemas.lease, { ...scope(), ...input });
      const { data } = await request('POST', '/receiver/lease', 'lease', body);
      const evidence = leaseEvidence(data, input);
      if (data.historical) return renew({ instanceId: data.instanceId, generation: data.generation }, data.streamEpoch);
      local('setLease', partition.partitionId, evidence);
      if (stream !== evidence.streamEpoch) issuedContinuation = null;
      stream = evidence.streamEpoch; return evidence;
    }),
    renewLease: () => run(async () => { await probe(); return renew(fence(), stream); }),
    release: () => run(async () => {
      await probe(); const tuple = fence();
      const { data } = await request('POST', '/receiver/lease/release', 'release', { ...scope(), ...tuple });
      if (data.instanceId !== tuple.instanceId || data.generation !== tuple.generation) fail('INVALID_REQUEST');
      const cleared = local('clearLease', partition.partitionId, { streamEpoch: stream, ...tuple });
      return { ...data, localCleared: cleared.cleared };
    }),
    receiveOnce: (input = {}) => invoke(input, snapshotReceive, async ({ limit: n }) => {
      issuedContinuation = null;
      await probe(); receiver();
      const b = budget(); let page;
      for (;;) {
        page = await sync(n);
        try { await persist(page); break; }
        catch (error) {
          if (error.code !== 'CONTENT_EXPIRED') throw error;
          if (++b.syncs >= MAX_CLIENT_PROGRESS_ROUNDS) {
            b.deferredExpiryResync = true;
            const resyncRequired = receiverNeedsResync() || b.deferredExpiryResync;
            return { items: [], hasMore: page.hasMore, pending: true,
              progressPending: true, resyncRequired, continuation: receiveContinuation(b.deferredExpiryResync) };
          }
        }
      }
      for (const kind of ['expiry', 'ack']) {
        const items = page.items.filter(x => (x.kind === 'message' ? 'ack' : 'expiry') === kind)
          .map(x => ({ seq: x.seq, messageId: (x.message ?? x.tombstone).messageId }));
        if (items.length) await dispatch(prepare(kind, items), b);
      }
      const items = page.items.map(item => {
        const expired = fact(item.seq, 'content_expired');
        if (expired) return { kind: 'content_expired', seq: item.seq, tombstone: expired.fact,
          status: expired.serverConfirmed ? 'expired_processed' : 'pending' };
        const saved = fact(item.seq, 'message');
        return { kind: 'message', seq: item.seq, message: item.message,
          status: saved?.serverConfirmed ? 'delivered' : 'pending', attachmentReceipt: saved?.attachmentReceipt ?? null };
      });
      const resyncRequired = receiverNeedsResync() || b.deferredExpiryResync;
      const pending = b.pending || resyncRequired || items.some(x => x.status === 'pending') || page.progressPending && b.rounds === 0;
      return { items, hasMore: page.hasMore, pending, progressPending: pending, resyncRequired,
        rounds: b.rounds, continuation: pending ? receiveContinuation(b.deferredExpiryResync) : null };
    }),
    ackPending: (input = {}) => invoke(input, snapshotAck, async input => {
      // Reject fabricated values before /me could freeze/bind journal identity.
      // Recheck scope after the authenticated probe in scan(). No token means
      // explicit new coverage from the head, invalidating any previous proof.
      if (input.continuation === undefined) issuedContinuation = null;
      else if (!continuationMatches(input.continuation)) fail('INVALID_REQUEST');
      const n = input.limit; await probe(); receiver();
      return scan(n, input.continuation);
    }),
    read: input => invoke(input, snapshotRead, async input => {
      await probe(); const { data } = await request('POST', `/messages/${input.messageId}/read`, 'read', scope());
      if (data.messageId !== input.messageId) fail('INVALID_REQUEST'); return data;
    }),
    reconcileEpoch: input => invoke(input, snapshotReconcile, async input => {
      issuedContinuation = null;
      const identity = await probe(false);
      // Reconciliation requires an already-frozen original partition. Probing
      // here must not bind a fresh identity before the explicit decision validates.
      const partitionId = local('reconcilePartition', { ...input, newIdentity: identity });
      partition = { ...identity, partitionId }; stream = null; return { ...partition };
    }),
    close() {
      if (closePromise) return closePromise;
      issuedContinuation = null;
      closing = true; controller?.abort();
      closePromise = (async () => {
        if (active) try { await active; } catch { /* operation caller receives its own failure */ }
        owner.release(); // An uncertain release rejects close, never a clean-close claim.
        closed = true;
      })();
      return closePromise;
    },
  });
}
