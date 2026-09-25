import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { types } from 'node:util';
import { parseImV2Config, hashRetentionPolicy } from './config.js';
import { withMaintenanceReadSnapshot } from './maintenance-read-target.js';
import { encodeMaintenancePlan, decodeMaintenancePlan, encodeMaintenanceCursor, decodeMaintenanceCursor } from './maintenance-plan.js';

// Offline diagnostic composition only. No executor, durable clock, or DB handle.
const errors = new WeakMap();
const stops = new Set(['SCAN_ROWS', 'SCAN_BYTES', 'SCAN_TIME']);
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const POLICY = ['version', 'effectiveAt', 'messageRetentionMs', 'attachmentRetentionMs', 'safeRetryWindowMs',
  'auditRetentionMs', 'keyReservation', 'expiryEnabled', 'purgeEnabled', 'backupCleanupEnabled', 'backupRetentionMs'];
const ACTIONS = ['conversation.created', 'message.read'];
const PROTECTED = ['message.accepted', 'ack_delivery', 'expiry_receipt', 'acquire_receiver', 'renew_receiver', 'release_receiver'];
const EFFECT = { expire: 'expire-only', scrub: 'scrub', audit: 'audit-delete' };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hashBytes = (tag, bytes) => createHash('sha256').update(tag, 'ascii').update('\0').update(bytes).digest('hex');
const integer = x => Number.isSafeInteger(x) && !Object.is(x, -0);
const natural = x => integer(x) && x >= 0;
const uuid = x => typeof x === 'string' && UUID.test(x);
const hash = x => typeof x === 'string' && HASH.test(x);
const utf8 = x => x === null ? 0 : Buffer.byteLength(x);
const compare = (a, b) => a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1;
function fail(code = 'FACT_MISMATCH') {
  const error = Object.assign(new Error('Maintenance preview rejected'), { code: `MAINTENANCE_${code}` });
  errors.set(error, code);
  throw error;
}
function ensure(value, code) { if (!value) fail(code); }
function scalar(value) {
  return typeof value === 'string' && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
}
function fields(value, required, optional = []) {
  ensure(value && typeof value === 'object' && !types.isProxy(value) && Object.getPrototypeOf(value) === Object.prototype, 'INVALID');
  const descriptors = Object.getOwnPropertyDescriptors(value), result = {};
  const names = Reflect.ownKeys(descriptors);
  ensure(required.every(k => Object.hasOwn(descriptors, k)) && names.every(k => typeof k === 'string' && [...required, ...optional].includes(k)), 'INVALID');
  for (const k of names) {
    const d = descriptors[k];
    ensure(d.enumerable && Object.hasOwn(d, 'value'), 'INVALID');
    Object.defineProperty(result, k, { value: d.value, enumerable: true });
  }
  return result;
}
function data(value, seen = new Set(), depth = 1) {
  ensure(depth <= 16, 'POLICY_INVALID');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') { ensure(scalar(value), 'POLICY_INVALID'); return value; }
  if (typeof value === 'number') { ensure(natural(value), 'POLICY_INVALID'); return value; }
  ensure(value && typeof value === 'object' && !types.isProxy(value) && !seen.has(value) &&
    Object.getPrototypeOf(value) === Object.prototype, 'POLICY_INVALID');
  seen.add(value);
  const result = {};
  for (const k of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, k);
    ensure(typeof k === 'string' && d.enumerable && Object.hasOwn(d, 'value'), 'POLICY_INVALID');
    Object.defineProperty(result, k, { value: data(d.value, seen, depth + 1), enumerable: true });
  }
  seen.delete(value);
  return result;
}
function synchronous(fn) {
  ensure(typeof fn === 'function' && !types.isProxy(fn) && !types.isAsyncFunction(fn) && !types.isGeneratorFunction(fn), 'INVALID');
  return fn;
}
function method(adapter, name) {
  ensure(adapter && typeof adapter === 'object' && !types.isProxy(adapter), 'INVALID');
  const d = Object.getOwnPropertyDescriptor(adapter, name);
  ensure(d && Object.hasOwn(d, 'value'), 'INVALID');
  return synchronous(d.value);
}
function syncResult(value) {
  if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
    ensure(!types.isProxy(value), 'INVALID');
    if (types.isPromise(value)) { Promise.prototype.then.call(value, undefined, () => {}); fail('INVALID'); }
    // Accessor-free data boundary. Ordinary thenables are observed synchronously;
    // getter thenables are rejected without executing a caller reflection hook.
    let object = value;
    while (object !== null) {
      ensure(!types.isProxy(object), 'INVALID');
      const d = Object.getOwnPropertyDescriptor(object, 'then');
      if (d) {
        ensure(Object.hasOwn(d, 'value'), 'INVALID');
        if (typeof d.value === 'function') {
          synchronous(d.value);
          try { Reflect.apply(d.value, value, [() => {}, () => {}]); } catch { /* rejected regardless */ }
          fail('INVALID');
        }
        break;
      }
      object = Object.getPrototypeOf(object);
    }
  }
  return value;
}
function configSnapshot(raw) {
  const snapshot = data(raw);
  ensure(['enabled', 'writeMode', 'retention', 'maintenance'].every(k => Object.hasOwn(snapshot, k)) &&
    snapshot.retention && snapshot.maintenance && Object.hasOwn(snapshot.retention, 'policyHash'), 'POLICY_INVALID');
  const policy = fields(snapshot.retention.policy, POLICY);
  const canonical = Object.fromEntries(POLICY.map(k => [k, policy[k]]));
  const config = parseImV2Config({ ...snapshot, retention: { ...snapshot.retention, policy: canonical } });
  ensure(config.retention.policy.effectiveAt > 0 && natural(config.maintenance.maxKeyReservations) && config.maintenance.maxKeyReservations > 0, 'POLICY_INVALID');
  return config;
}
function canonicalConfig(config) {
  const sort = x => x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k, sort(x[k])])) : x;
  return JSON.stringify(sort(config));
}

// Typed streaming frames: never stringify a Uint8Array, nor concatenate payloads.
function frame(value, emit) {
  if (value === null) { emit('n;'); return; }
  if (typeof value === 'boolean') { emit(value ? 'b1;' : 'b0;'); return; }
  if (typeof value === 'number') { ensure(integer(value)); emit(`i${value};`); return; }
  if (typeof value === 'string') { ensure(scalar(value)); emit(`s${utf8(value)}:`); emit(value); return; }
  if (value instanceof Uint8Array) { emit(`x${value.byteLength}:`); emit(value); return; }
  ensure(Array.isArray(value));
  emit(`a${value.length}:`);
  for (const item of value) frame(item, emit);
}
function frameSize(value) { let size = 0; frame(value, b => { size += typeof b === 'string' ? utf8(b) : b.byteLength; }); return size; }
function digest(tag, value) {
  const h = createHash('sha256').update(tag, 'ascii').update('\0');
  frame(value, bytes => h.update(bytes));
  return h.digest('hex');
}
const textCell = value => value === null ? null : [utf8(value), digest('a2a-msg.im.maintenance.text.v1', value)];

function createLedger(config) {
  const limits = Object.freeze(Object.fromEntries(['maxScanRows', 'maxScanBytes', 'maxScanMs'].map(k => [k, config.maintenance[k]])));
  const start = performance.now();
  let previous = start, elapsed = 0, rows = 0, bytes = 0, heldRows = 0, heldBytes = 0;
  const tickets = new Map();
  function check() {
    const now = performance.now();
    ensure(Number.isFinite(now) && now >= previous && Number.isFinite(start), 'CLOCK_UNSAFE');
    previous = now; elapsed = Math.ceil(now - start);
    ensure(natural(elapsed), 'CLOCK_UNSAFE');
    return elapsed > limits.maxScanMs ? 'SCAN_TIME' : null;
  }
  function reserve(r, b) {
    ensure(natural(r) && natural(b), 'READ_UNAVAILABLE');
    if (r > limits.maxScanRows - rows - heldRows) return 'SCAN_ROWS';
    if (b > limits.maxScanBytes - bytes - heldBytes) return 'SCAN_BYTES';
    if (check()) return 'SCAN_TIME';
    const ticket = Object.freeze({});
    tickets.set(ticket, [r, b]); heldRows += r; heldBytes += b;
    return ticket;
  }
  function settle(ticket, r, b) {
    const capacity = tickets.get(ticket);
    ensure(capacity && natural(r) && natural(b) && r <= capacity[0] && b <= capacity[1], 'READ_UNAVAILABLE');
    tickets.delete(ticket); heldRows -= capacity[0]; heldBytes -= capacity[1]; rows += r; bytes += b;
  }
  function resize(ticket, b) {
    const capacity = tickets.get(ticket);
    ensure(capacity && capacity[0] === 0 && natural(b), 'READ_UNAVAILABLE');
    if (b - capacity[1] > limits.maxScanBytes - bytes - heldBytes) return 'SCAN_BYTES';
    if (check()) return 'SCAN_TIME';
    heldBytes += b - capacity[1]; tickets.set(ticket, [0, b]);
    return null;
  }
  return { config, limits, check, reserve, settle,
    resize,
    reservedBytes(ticket) { const capacity = tickets.get(ticket); ensure(capacity, 'READ_UNAVAILABLE'); return capacity[1]; },
    stats: () => ({ rows, bytes, elapsed, tickets: tickets.size }),
    release(ticket) { settle(ticket, 0, 0); },
  };
}

// Only planner-owned budget exceptions are converted into incomplete prefixes.
const scanErrors = new WeakMap();
function stop(reason) { const e = new Error(); scanErrors.set(e, reason); throw e; }
function result(read) { if (!read.complete) stop(read.stopReason); return read.value; }
function point(session, name, key, required = true) {
  const row = result(session.readProjected(result(session[`project${name}`](key))));
  ensure(!required || row !== null);
  return row;
}
function history(row) {
  ensure(row && hash(row.policy_hash) && scalar(row.canonical_json));
  let policy;
  try {
    const parsed = JSON.parse(row.canonical_json);
    fields(parsed, POLICY);
    policy = Object.fromEntries(POLICY.map(k => [k, parsed[k]]));
    ensure(hashRetentionPolicy(policy) === row.policy_hash && JSON.stringify(policy) === row.canonical_json);
    parseImV2Config({ retention: { policy, policyHash: row.policy_hash } });
  } catch { fail(); }
  for (const [column, key] of [['version', 'version'], ['effective_at', 'effectiveAt'], ['message_retention_ms', 'messageRetentionMs'],
    ['attachment_retention_ms', 'attachmentRetentionMs'], ['safe_retry_window_ms', 'safeRetryWindowMs'], ['audit_retention_ms', 'auditRetentionMs']]) {
    ensure(natural(row[column]) && row[column] === policy[key]);
  }
  return policy;
}
function boundedText(value, max, nullable = false, min = 0) {
  ensure(nullable && value === null || scalar(value) && value.length >= min && value.length <= max);
}
function validJson(text) {
  ensure(scalar(text) && [...text].length >= 2 && [...text].length <= 65536);
  try { JSON.parse(text); } catch { fail(); }
}
function auditGroup(session, ledger, key) {
  const ticket = ledger.reserve(0, 2048);
  if (stops.has(ticket)) stop(ticket);
  let used = 0;
  try {
  const a = point(session, 'Audit', key[1]);
  ensure(integer(a.id) && a.id === key[1] && natural(a.occurred_at) && a.occurred_at === key[0] && ['admin', 'agent', 'system'].includes(a.actor_kind));
  boundedText(a.actor_id, 255, false, 1); boundedText(a.action, 128, false, 1);
  validJson(a.target_ids_json); validJson(a.safe_details_json);
  const descriptor = [1, 'audit-row', a.id, textCell(a.actor_kind), textCell(a.actor_id), textCell(a.action),
    textCell(a.target_ids_json), a.occurred_at, textCell(a.safe_details_json)];
  used = frameSize(descriptor);
  ensure(used <= 2048, 'READ_UNAVAILABLE');
  const expectedFingerprint = digest('a2a-msg.im.maintenance.audit.v1', descriptor);
  if (ledger.check()) stop('SCAN_TIME');
  const reason = ACTIONS.includes(a.action) ? null : PROTECTED.includes(a.action) ? 'AUDIT_PROTECTED' : 'AUDIT_ACTION_UNKNOWN';
  return { key, messageId: null, auditId: a.id, contentPolicyHash: null, expectedState: null, expiresAt: null,
    expectedFingerprint, expectedBytes: reason ? 0 : [a.actor_kind, a.actor_id, a.action, a.target_ids_json, a.safe_details_json].reduce((n, x) => n + utf8(x), 0),
    expectedRows: reason ? 0 : 1, reason };
  } finally { ledger.settle(ticket, 0, used); }
}
// Match the frozen target's per-material reservation, including its scalar
// headroom. Admission must cover these bounds, not only the eventual SQL bytes.
function materialCapacity(projection) {
  if (!projection.present) return { rows: 0, bytes: 0 };
  const lengths = Object.values(projection.lengths);
  const bytes = 2 + String(lengths.length).length + 24 * lengths.length + lengths.reduce((n, x) => n + (x ?? 0), 0);
  ensure(natural(bytes), 'READ_UNAVAILABLE');
  return { rows: 1, bytes };
}
function projectedFrameSize(projection, column, cell = false) {
  const type = projection.types[column], length = projection.lengths[column];
  if (type === 'null') return 2;
  if (cell) {
    ensure(type === 'text');
    return frameSize([length, '0'.repeat(64)]);
  }
  if (type === 'integer') return frameSize(Number.MAX_SAFE_INTEGER);
  ensure(type === 'text' || type === 'blob');
  return 2 + String(length).length + length;
}
const arrayFrameSize = sizes => 2 + String(sizes.length).length + sizes.reduce((n, x) => n + x, 0);
function groupEntry(group, reason) {
  return reason ? { key: group.key, messageId: group.messageId, auditId: group.auditId, reason,
    expectedFingerprint: group.expectedFingerprint, expectedRows: group.expectedRows, expectedBytes: group.expectedBytes }
    : Object.fromEntries(['key', 'messageId', 'auditId', 'contentPolicyHash', 'expectedState', 'expiresAt', 'expectedFingerprint', 'expectedBytes', 'expectedRows'].map(k => [k, group[k]]));
}
function contentGroup(session, ledger, key, kind, plan, outputTicket) {
  // Discover dependencies without reading title/text/correlation or payload.
  // Keep both genuine one-use heavy projections until the entire group fits.
  const messageProjection = result(session.projectMessage(key[1]));
  const attachmentProjection = result(session.projectAttachment(key[1]));
  ensure(messageProjection.present);
  const dependencies = point(session, 'MessageDependencies', key[1]);
  ensure(dependencies.message_id === key[1] && uuid(dependencies.conversation_id) &&
    (dependencies.in_reply_to === null || uuid(dependencies.in_reply_to)));
  const c = point(session, 'Content', key[1]);
  const k = point(session, 'SendKey', key[1]);
  const o = point(session, 'Operation', key[1]);
  const r = point(session, 'Reservation', key[1], false);
  const d = point(session, 'Delivery', key[1]);
  ensure([c, k, o, d, ...(r ? [r] : [])].every(row => row.message_id === key[1]));
  ensure(hash(c.policy_hash) && uuid(o.origin_epoch));
  const p = point(session, 'Policy', c.policy_hash);
  history(p);
  ensure(p.policy_hash === c.policy_hash);
  const v = point(session, 'Conversation', dependencies.conversation_id);
  const e = point(session, 'Epoch', o.origin_epoch);
  ensure(e.center_epoch === o.origin_epoch && natural(e.created_at) && natural(e.recovery_counter) && ['fresh', 'v3_import', 'recovery'].includes(e.origin));
  ensure(['a2a-msg.im.v1', 'a2a-msg.im.v2'].includes(o.source_protocol) && (o.source_protocol !== 'a2a-msg.im.v1' || e.origin === 'v3_import'));
  if (dependencies.in_reply_to !== null) {
    const parent = point(session, 'MessageDependencies', dependencies.in_reply_to);
    ensure(parent.message_id === dependencies.in_reply_to && parent.conversation_id === dependencies.conversation_id && parent.message_id !== key[1]);
  }
  ensure(attachmentProjection.present === !!r);

  // All other mandatory reads (including historical origin and reply existence)
  // are now consumed in the shared ledger. Derive descriptor framing from their
  // actual facts and the retained projections, never a per-message guess.
  const fixed = [
    [c.message_id, c.state, c.expires_at, c.expired_at, c.scrubbed_at, c.policy_hash, textCell(c.expiry_run_id), textCell(c.scrub_run_id)],
    [p.policy_hash, p.version, p.effective_at, p.message_retention_ms, p.attachment_retention_ms, p.safe_retry_window_ms, p.audit_retention_ms, textCell(p.canonical_json)],
    [k.sender_id, k.client_message_id, k.payload_hash, k.message_id, k.created_at, k.retry_until, k.status],
    [o.sender_id, o.origin_epoch, o.client_message_id, o.storage_client_message_id, o.source_protocol, o.message_id],
    r && [r.attachment_id, r.message_id, r.size, r.sha256],
  ];
  const delivery = [d.recipient_id, d.seq, d.message_id, d.acked_at, d.read_at];
  const conversation = [v.conversation_id, v.agent_low, v.agent_high, v.created_at];
  const messageFrame = arrayFrameSize(['message_id', 'conversation_id', 'sender_id', 'recipient_id', 'client_message_id', 'accepted_at',
    'in_reply_to', 'title', 'text', 'correlation'].map(column => projectedFrameSize(messageProjection, column, ['title', 'text', 'correlation'].includes(column))));
  const payloadFrame = attachmentProjection.present ? arrayFrameSize([
    ...['attachment_id', 'message_id', 'name', 'mime', 'size', 'sha256'].map(column => projectedFrameSize(attachmentProjection, column, ['name', 'mime'].includes(column))),
    frameSize([attachmentProjection.lengths.data, '0'.repeat(64), '0'.repeat(64)]),
  ]) : frameSize(null);
  const descriptorCapacity = arrayFrameSize([frameSize(1), frameSize('message-group'), messageFrame,
    ...fixed.map(frameSize), payloadFrame, frameSize(delivery), frameSize(conversation)]);
  const lengths = messageProjection.lengths, attachmentLengths = attachmentProjection.lengths;
  const projected = { key, messageId: key[1], auditId: null, contentPolicyHash: c.policy_hash, expectedState: c.state, expiresAt: c.expires_at,
    expectedFingerprint: '0'.repeat(64), expectedBytes: kind === 'expire' ? 0 :
      (lengths.text ?? 0) + (lengths.title ?? 0) + (lengths.correlation ?? 0) +
      (attachmentProjection.present ? (attachmentLengths.data ?? 0) + (attachmentLengths.name ?? 0) + (attachmentLengths.mime ?? 0) : 0),
    expectedRows: 1 + Number(k.status !== 'expired') + (kind === 'expire' ? 0 :
      Number(lengths.text > 0 || lengths.title !== null || lengths.correlation !== null) + Number(attachmentProjection.present)), reason: null };
  const oversized = projected.expectedRows > plan.budget.maxRows || projected.expectedBytes > plan.budget.maxBytes;
  // A normal remainder/metadata stop needs only this lookahead, never approves it.
  if (!oversized && (plan.budget.plannedRows + projected.expectedRows > plan.budget.maxRows ||
    plan.budget.plannedBytes + projected.expectedBytes > plan.budget.maxBytes)) return projected;
  const list = oversized ? plan.scan.held : plan.candidates;
  list.push(groupEntry(projected, oversized ? 'OVERSIZED_GROUP' : null));
  const output = outputBound(plan);
  list.pop();
  if (output.metadata > 65536) return projected;
  const messageCapacity = materialCapacity(messageProjection), attachmentCapacity = materialCapacity(attachmentProjection);
  const growth = Math.max(0, output.bytes - ledger.reservedBytes(outputTicket));
  const admission = ledger.reserve(messageCapacity.rows + attachmentCapacity.rows,
    messageCapacity.bytes + attachmentCapacity.bytes + descriptorCapacity + growth);
  if (stops.has(admission)) stop(admission);
  // This is an admission proof, not an observed read. Release it immediately so
  // the target can make its legitimate per-read reservations. In this synchronous
  // snapshot the only following consumers are the admitted output growth,
  // descriptor and two material reads; each settles <= its admitted bound.
  // Existing prefix output and final-trust escrow remain held throughout.
  ledger.release(admission);
  const resizeReason = ledger.resize(outputTicket, output.bytes);
  if (resizeReason) stop(resizeReason);
  const ticket = ledger.reserve(0, descriptorCapacity);
  if (stops.has(ticket)) stop(ticket);
  let used = 0;
  try {
  const m = result(session.readProjected(messageProjection));
  ensure(m && [m.message_id, m.conversation_id, m.sender_id, m.recipient_id, o.origin_epoch, o.client_message_id].every(uuid) &&
    m.message_id === key[1] && m.sender_id !== m.recipient_id && m.conversation_id === dependencies.conversation_id && m.in_reply_to === dependencies.in_reply_to);
  ensure(v.conversation_id === m.conversation_id && uuid(v.agent_low) && uuid(v.agent_high) && v.agent_low < v.agent_high && natural(v.created_at) &&
    [m.sender_id, m.recipient_id].every(id => id === v.agent_low || id === v.agent_high));
  const storage = o.source_protocol === 'a2a-msg.im.v1' ? o.client_message_id : `v2:${o.origin_epoch}:${o.client_message_id}`;
  ensure(k.sender_id === m.sender_id && o.sender_id === m.sender_id && m.client_message_id === storage &&
    k.client_message_id === storage && o.storage_client_message_id === storage && hash(k.payload_hash) && ['live', 'expired'].includes(k.status));
  ensure(natural(m.accepted_at) && natural(k.created_at) && k.created_at === m.accepted_at && natural(k.retry_until) && k.retry_until >= k.created_at &&
    natural(c.expires_at) && m.accepted_at <= Number.MAX_SAFE_INTEGER - p.message_retention_ms && c.expires_at === m.accepted_at + p.message_retention_ms && c.expires_at === key[0]);
  ensure(c.state === (kind === 'expire' ? 'live' : 'expired') && c.scrubbed_at === null && c.scrub_run_id === null);
  if (c.state === 'live') ensure(c.expired_at === null && c.expiry_run_id === null);
  else { ensure(natural(c.expired_at) && c.expired_at >= c.expires_at); boundedText(c.expiry_run_id, 255, false, 1); }
  ensure(d.recipient_id === m.recipient_id && natural(d.seq) && d.seq > 0 && (d.acked_at === null || natural(d.acked_at)) &&
    (d.read_at === null || natural(d.read_at) && d.acked_at !== null));
  boundedText(m.text, 32000); boundedText(m.title, 100, true); boundedText(m.correlation, 200, true);
  if (r) ensure(uuid(r.attachment_id) && natural(r.size) && r.size > 0 && r.size <= 10485760 && hash(r.sha256));

    const a = result(session.readProjected(attachmentProjection));
    ensure(!!a === !!r && (m.text.length > 0 || a !== null));
    let payload = null, attachment = null, attachmentBytes = 0;
    if (a) {
      ensure(a.message_id === m.message_id && a.attachment_id === r.attachment_id && a.size === r.size && a.sha256 === r.sha256 &&
        a.data instanceof Uint8Array && a.data.byteLength === a.size && sha(a.data) === a.sha256);
      boundedText(a.name, 200, false, 1); boundedText(a.mime, 100, true, 1);
      ensure(a.name !== '.' && !a.name.includes('..') && !/[\\/\x00-\x1f\x7f]/.test(a.name));
      attachment = [a.name, a.mime, a.size, a.sha256];
      attachmentBytes = a.size + utf8(a.name) + utf8(a.mime);
      payload = [a.attachment_id, a.message_id, textCell(a.name), textCell(a.mime), a.size, a.sha256,
        [a.data.byteLength, digest('a2a-msg.im.maintenance.blob.v1', a.data), a.sha256]];
    }
    const fingerprint = o.source_protocol === 'a2a-msg.im.v1'
      ? ['a2a-msg.im.v1', m.conversation_id, m.recipient_id, o.client_message_id, m.title, m.text, attachment, m.in_reply_to, m.correlation]
      : ['a2a-msg.im.v2', o.origin_epoch, m.conversation_id, m.recipient_id, o.client_message_id, m.title, m.text, attachment, m.in_reply_to, m.correlation];
    ensure(sha(JSON.stringify(fingerprint)) === k.payload_hash);
    const descriptor = [1, 'message-group',
      [m.message_id, m.conversation_id, m.sender_id, m.recipient_id, m.client_message_id, m.accepted_at, m.in_reply_to, textCell(m.title), textCell(m.text), textCell(m.correlation)],
      ...fixed, payload, delivery, conversation];
    used = frameSize(descriptor); ensure(used <= descriptorCapacity, 'READ_UNAVAILABLE');
    const expectedFingerprint = digest('a2a-msg.im.maintenance.message.v1', descriptor);
    if (ledger.check()) stop('SCAN_TIME');
    return { key, messageId: m.message_id, auditId: null, contentPolicyHash: c.policy_hash, expectedState: c.state, expiresAt: c.expires_at,
      expectedFingerprint, expectedBytes: kind === 'expire' ? 0 : utf8(m.text) + utf8(m.title) + utf8(m.correlation) + attachmentBytes,
      expectedRows: 1 + Number(k.status !== 'expired') + (kind === 'expire' ? 0 : Number(m.text !== '' || m.title !== null || m.correlation !== null) + Number(a !== null)), reason: null };
  } finally { ledger.settle(ticket, 0, used); }
}

function selectionIdentity(plan) {
  const s = plan.selection;
  return [2, plan.instanceId, plan.instanceCreatedAt, plan.centerEpoch, plan.kind, plan.executionPolicyHash,
    s.version, s.cutoffAt, s.eligibleThroughAt, s.sortVersion, s.after, s.limit, s.effect, s.auditActions];
}
function digestInputs(plan, calculate = true) {
  const identity = selectionIdentity(plan), s = plan.scan;
  const outcomes = [...plan.candidates.map(c => [c.key, 'candidate', c.expectedFingerprint, c.expectedRows, c.expectedBytes]),
    ...s.held.map(h => [h.key, h.reason, h.expectedFingerprint, h.expectedRows, h.expectedBytes])].sort((a, b) => compare(a[0], b[0]));
  const range = [identity, s.plannedRangeEnd, s.hasMore, outcomes];
  const rangeDigest = calculate ? digest('a2a-msg.im.maintenance.range.v1', range) : '0'.repeat(64);
  const candidates = [identity, s.plannedRangeEnd, rangeDigest, plan.candidates.map(c => [c.key, c.messageId, c.auditId,
    c.contentPolicyHash, c.expectedState, c.expiresAt, c.expectedFingerprint, c.expectedBytes, c.expectedRows])];
  return { range, candidates, rangeDigest, candidateDigest: calculate ? digest('a2a-msg.im.maintenance.candidates.v2', candidates) : null };
}
function cursor(plan, key) {
  return encodeMaintenanceCursor([2, 'maintenance', plan.instanceId, plan.instanceCreatedAt, plan.centerEpoch,
    plan.kind, plan.executionPolicyHash, plan.selection.cutoffAt, 1, key]);
}
function envelope(plan, planHash) { return { plan, planHash, complete: plan.scan.complete, nextCursor: plan.scan.nextCursor }; }
// Fixed scalar allowance breaks the counters/serialization measurement cycle.
// Reserve both independent metadata envelopes and final hash-input frames. The
// allowance is charged once, with exact non-scalar framing/serialization bytes.
// It also covers replacing provisional counters with safe-integer decimal
// scalars and the fixed-width plan hash after canonical preparation. Reusing
// these already materialized metadata bytes is not another source-row read.
const SCALAR_ALLOWANCE = 1024;
function outputBound(plan) {
  const size = Buffer.byteLength(JSON.stringify(plan));
  const inputs = digestInputs(plan, false);
  const bound = size + SCALAR_ALLOWANCE + 2048; // maximum cursor twice + hashes/scalars
  return { metadata: bound, bytes: 2 * bound + frameSize(inputs.range) + frameSize(inputs.candidates) };
}

export function createImV2MaintenancePreview(options) {
  const { readTarget, authority, policyProvider, ...optional } = fields(options, ['readTarget', 'authority', 'policyProvider'], ['clock']);
  const authorize = method(authority, 'authorize'), getConfig = method(policyProvider, 'getConfig');
  const clock = Object.hasOwn(optional, 'clock') ? synchronous(optional.clock) : Date.now;
  let busy = false, poisoned = false;
  function previewMaintenance(request, adminContext) {
    if (busy) { poisoned = true; fail('INVALID'); }
    busy = true;
    let ledger, outputTicket, plannerError, targetError;
    try {
      const input = fields(request, ['kind'], ['after', 'limit']);
      ensure(typeof input.kind === 'string' && Object.hasOwn(EFFECT, input.kind), 'INVALID');
      const kind = input.kind, limit = Object.hasOwn(input, 'limit') ? input.limit : 20;
      ensure(natural(limit) && limit >= 1 && limit <= 100, 'INVALID');
      let after = null;
      if (Object.hasOwn(input, 'after')) {
        ensure(typeof input.after === 'string' && input.after.length > 0, 'INVALID');
        try { after = decodeMaintenanceCursor(input.after); } catch { fail('INVALID'); }
        ensure(after[5] === kind, 'INVALID');
      }
      const invoke = (fn, self, args, code) => {
        let value;
        try { value = Reflect.apply(fn, self, args); } catch { poisoned = true; fail(code); }
        try { value = syncResult(value); } catch { poisoned = true; fail('INVALID'); }
        ensure(!poisoned, code);
        return value;
      };
      const gate = () => ensure(invoke(authorize, authority, [adminContext], 'AUTH_DENIED') === true, 'AUTH_DENIED');
      const get = () => {
        const raw = invoke(getConfig, policyProvider, [], 'POLICY_INVALID');
        try { return configSnapshot(raw); } catch { fail('POLICY_INVALID'); }
      };
      gate();
      const config = get(), canonical = canonicalConfig(config);
      ledger = createLedger(config);
      let plan;
      try {
        plan = withMaintenanceReadSnapshot(readTarget, ledger, session => {
          try {
            const identity = session.identity;
            const wall = invoke(clock, undefined, [], 'CLOCK_UNSAFE');
            ensure(natural(wall) && natural(identity.globalFloorObservedAt) && wall >= identity.globalFloorObservedAt && wall <= Number.MAX_SAFE_INTEGER - config.maintenance.planTtlMs, 'CLOCK_UNSAFE');
            ensure(config.retention.policy.effectiveAt <= wall, 'POLICY_INVALID');
            if (after) {
              ensure(after[2] === identity.instanceId && after[3] === identity.instanceCreatedAt && after[4] === identity.centerEpoch, 'TARGET_STALE');
              ensure(after[6] === identity.executionPolicyHash, 'POLICY_STALE');
              ensure(after[7] <= wall, 'CLOCK_UNSAFE');
            }
            const cutoff = after ? after[7] : wall;
            const m = config.maintenance;
            const p = { version: 2, runId: randomUUID(), instanceId: identity.instanceId, instanceCreatedAt: identity.instanceCreatedAt,
              centerEpoch: identity.centerEpoch, kind, executionPolicyHash: identity.executionPolicyHash,
              createdAt: wall, expiresAt: wall + m.planTtlMs, clockObservedAt: wall,
              timeEvidence: { version: 1, schemaVersion: 4, observedWallAt: wall, globalFloorObservedAt: identity.globalFloorObservedAt,
                anchorGeneration: null, anchorHash: null, sessionNonce: null, anchorWallAt: null, monotonicElapsedMs: null,
                maxForwardJumpMs: m.maxForwardJumpMs, executable: false, reason: 'SCHEMA_UPGRADE_REQUIRED' },
              selection: { version: 1, cutoffAt: cutoff, eligibleThroughAt: kind === 'audit' ? cutoff >= 15552000000 ? cutoff - 15552000000 : null : cutoff,
                sortVersion: 1, after: after ? after[9] : null, limit, effect: EFFECT[kind], auditActions: kind === 'audit' ? [...ACTIONS] : [] },
              candidates: [], candidateDigest: '0'.repeat(64),
              budget: { maxRows: m.maxRows, maxProofRows: 2, maxBytes: m.maxBytes, maxScanRows: m.maxScanRows, maxScanBytes: m.maxScanBytes,
                maxScanMs: m.maxScanMs, maxWriteMs: m.maxWriteMs, planTtlMs: m.planTtlMs, maxForwardJumpMs: m.maxForwardJumpMs, plannedRows: 0, plannedBytes: 0 },
              scan: { version: 1, rowsRead: 0, bytesRead: 0, elapsedMs: 0, plannedRangeEnd: null, lastScanned: null, nextCursor: null,
                hasMore: false, complete: true, stopReason: 'END', candidateCount: 0, heldCount: 0, skippedCount: 0, held: [],
                heldCounts: { oversizedGroup: 0, auditProtected: 0, auditActionUnknown: 0 }, rangeDigest: '0'.repeat(64) } };
            outputTicket = ledger.reserve(0, outputBound(p).bytes);
            if (stops.has(outputTicket)) { outputTicket = null; fail('READ_UNAVAILABLE'); }
            const s = p.scan;
            try {
              while (p.selection.eligibleThroughAt !== null) {
                const key = result(kind === 'audit' ? session.nextAudit(p.selection.eligibleThroughAt, s.lastScanned || p.selection.after)
                  : session.nextContent(kind, p.selection.eligibleThroughAt, s.lastScanned || p.selection.after));
                if (key === null) break;
                ensure((s.lastScanned || p.selection.after) === null || compare(s.lastScanned || p.selection.after, key) < 0);
                s.hasMore = true;
                if (p.candidates.length + s.held.length === limit) { s.stopReason = 'LIMIT'; break; }
                 const group = kind === 'audit' ? auditGroup(session, ledger, key) : contentGroup(session, ledger, key, kind, p, outputTicket);
                let reason = group.reason;
                if (!reason && (group.expectedRows > m.maxRows || group.expectedBytes > m.maxBytes)) reason = 'OVERSIZED_GROUP';
                if (!reason && p.budget.plannedRows + group.expectedRows > m.maxRows) { s.stopReason = 'ROW_BUDGET'; break; }
                if (!reason && p.budget.plannedBytes + group.expectedBytes > m.maxBytes) { s.stopReason = 'BYTE_BUDGET'; break; }
                 const entry = groupEntry(group, reason);
                const list = reason ? s.held : p.candidates;
                list.push(entry);
                const bound = outputBound(p);
                list.pop();
                if (bound.metadata > 65536) { ensure(s.lastScanned !== null, 'METADATA_LIMIT'); s.stopReason = 'METADATA_LIMIT'; break; }
                // Atomic private escrow growth preserves the valid-prefix output
                // reservation on failure, including elapsed-budget exhaustion.
                const resizeReason = ledger.resize(outputTicket, bound.bytes);
                if (resizeReason) stop(resizeReason);
                list.push(entry);
                s.plannedRangeEnd = key; s.lastScanned = key; s.hasMore = false;
                if (reason) s.heldCounts[reason === 'OVERSIZED_GROUP' ? 'oversizedGroup' : reason === 'AUDIT_PROTECTED' ? 'auditProtected' : 'auditActionUnknown']++;
                else { p.budget.plannedRows += entry.expectedRows; p.budget.plannedBytes += entry.expectedBytes; }
              }
            } catch (error) {
              const reason = scanErrors.get(error);
              if (!reason) throw error;
              s.complete = false; s.hasMore = null; s.stopReason = reason;
            }
            s.candidateCount = p.candidates.length; s.heldCount = s.held.length; s.skippedCount = s.held.length;
            s.nextCursor = s.lastScanned && (!s.complete || s.hasMore) ? cursor(p, s.lastScanned) : null;
            gate();
            const finalConfig = get();
            gate();
            ensure(canonicalConfig(finalConfig) === canonical, 'POLICY_STALE');
            ensure(!poisoned, 'INVALID');
            return p;
          } catch (error) { plannerError = error; throw error; }
        });
      } catch (error) {
        if (plannerError && errors.has(plannerError)) throw plannerError;
        // Target errors are already sanitized by the genuine imported capability;
        // never inspect arbitrary callback exceptions or their code/message getters.
        targetError = error;
        throw error;
      }
      const inputs = digestInputs(plan);
      plan.scan.rangeDigest = inputs.rangeDigest; plan.candidateDigest = inputs.candidateDigest;
      const stats = ledger.stats();
      plan.scan.rowsRead = stats.rows;
      // Scalar allowance accounts the final counter/timing patches without a
      // self-referential byte-length loop. All other output bytes are measured.
      const outputBytes = 2 * Buffer.byteLength(JSON.stringify(plan)) + Buffer.byteLength(JSON.stringify({ plan: null, planHash: '0'.repeat(64), complete: false, nextCursor: null })) +
        utf8(plan.scan.nextCursor) + frameSize(inputs.range) + frameSize(inputs.candidates) + SCALAR_ALLOWANCE;
      ledger.settle(outputTicket, 0, outputBytes); outputTicket = null;
      plan.scan.bytesRead = ledger.stats().bytes;
      ensure(!ledger.check(), 'READ_UNAVAILABLE');
      plan.scan.elapsedMs = ledger.stats().elapsed;
      // First finish canonical validation, deep freezing, plan hashing and exact
      // envelope preparation. None of this main work lies after the reported
      // observation boundary below. The codec sees only planner-owned data.
      const encoded = encodeMaintenancePlan(plan);
      const frozen = decodeMaintenancePlan(encoded);
      const prepared = envelope(frozen, hashBytes('a2a-msg.im.maintenance.plan.v2', encoded));
      ensure(Buffer.byteLength(JSON.stringify(prepared)) <= 65536, 'METADATA_LIMIT');

      // Finite terminal scalar boundary (contract §8.2): this observation includes
      // all target finalization and the main encode/decode/hash/envelope work.
      // Thereafter perform exactly one bounded scalar seal, not a measurement /
      // rehash fixed-point loop. The pre-reserved SCALAR_ALLOWANCE covers decimal
      // width changes; both final serializations remain independently <=64KiB.
      // All non-scalar fields are the codec's frozen canonical values. Replacing
      // the validated safe-integer elapsed scalar preserves canonical key order.
      // The tail rehashes at most 64KiB and prepares at most 64KiB of envelope;
      // it does not read data, reclassify, revalidate descriptors, or call adapters.
      ensure(!ledger.check(), 'READ_UNAVAILABLE');
      const terminalElapsedMs = ledger.stats().elapsed;
      const sealedScan = Object.freeze({ ...frozen.scan, elapsedMs: terminalElapsedMs });
      const sealedPlan = Object.freeze({ ...frozen, scan: sealedScan });
      const sealedBytes = Buffer.from(JSON.stringify(sealedPlan), 'utf8');
      ensure(sealedBytes.byteLength <= 65536, 'METADATA_LIMIT');
      const answer = envelope(sealedPlan, hashBytes('a2a-msg.im.maintenance.plan.v2', sealedBytes));
      ensure(Buffer.byteLength(JSON.stringify(answer)) <= 65536, 'METADATA_LIMIT');
      Object.freeze(answer);
      // A veto-only observation covers the bounded scalar-sealing tail. It never
      // rewrites elapsedMs and restarts hashing. Any overrun (including one in
      // the tail) refuses disclosure; equality with the cap remains valid.
      // elapsedMs denotes the terminal preparation boundary, not physical time
      // after return or the later veto sample. Invalid/regressing time still
      // throws CLOCK_UNSAFE through the same, never-reset monotonic ledger.
      ensure(!ledger.check(), 'READ_UNAVAILABLE');
      ensure(!poisoned && ledger.stats().tickets === 0, 'READ_UNAVAILABLE');
      return answer;
    } catch (error) {
      if (errors.has(error) || error === targetError) throw error;
      fail('CODEC_INVALID');
    } finally {
      if (outputTicket && ledger) ledger.release(outputTicket);
      busy = false; poisoned = false;
    }
  }
  return Object.freeze({ previewMaintenance });
}
