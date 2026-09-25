import { createHash } from 'node:crypto';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const PLAN = ['version','runId','instanceId','instanceCreatedAt','centerEpoch','kind','executionPolicyHash','createdAt','expiresAt','clockObservedAt','timeEvidence','selection','candidates','candidateDigest','budget','scan'];
const TIME = ['version','schemaVersion','observedWallAt','globalFloorObservedAt','anchorGeneration','anchorHash','sessionNonce','anchorWallAt','monotonicElapsedMs','maxForwardJumpMs','executable','reason'];
const SELECTION = ['version','cutoffAt','eligibleThroughAt','sortVersion','after','limit','effect','auditActions'];
const CANDIDATE = ['key','messageId','auditId','contentPolicyHash','expectedState','expiresAt','expectedFingerprint','expectedBytes','expectedRows'];
const BUDGET = ['maxRows','maxProofRows','maxBytes','maxScanRows','maxScanBytes','maxScanMs','maxWriteMs','planTtlMs','maxForwardJumpMs','plannedRows','plannedBytes'];
const SCAN = ['version','rowsRead','bytesRead','elapsedMs','plannedRangeEnd','lastScanned','nextCursor','hasMore','complete','stopReason','candidateCount','heldCount','skippedCount','held','heldCounts','rangeDigest'];
const HELD = ['key','messageId','auditId','reason','expectedFingerprint','expectedRows','expectedBytes'];
const COUNTS = ['oversizedGroup','auditProtected','auditActionUnknown'];
const EFFECT = { expire: 'expire-only', scrub: 'scrub', audit: 'audit-delete' };
const AUDIT_ACTIONS = ['conversation.created','message.read'];
const NORMAL_STOPS = ['END','LIMIT','ROW_BUDGET','BYTE_BUDGET','METADATA_LIMIT'];
const SCAN_STOPS = ['SCAN_ROWS','SCAN_BYTES','SCAN_TIME'];
const internalErrors = new WeakMap();

function fail(code = 'MAINTENANCE_CODEC_INVALID') {
  const error = new Error('Maintenance preview rejected');
  error.code = code;
  internalErrors.set(error, code);
  throw error;
}
function ensure(ok) { if (!ok) fail(); }
function number(x, max = Number.MAX_SAFE_INTEGER) { ensure(Number.isSafeInteger(x) && !Object.is(x, -0) && x >= 0 && x <= max); return x; }
function positive(x, max) { number(x, max); ensure(x > 0); return x; }
function signed(x) { ensure(Number.isSafeInteger(x) && !Object.is(x, -0)); return x; }
function string(x, regex) { ensure(typeof x === 'string' && regex.test(x)); return x; }
function bool(x) { ensure(typeof x === 'boolean'); return x; }
function nullable(x, check) { return x === null ? null : check(x); }
function array(x, max = 100) {
  ensure(Array.isArray(x) && Object.getPrototypeOf(x) === Array.prototype && x.length <= max && Object.keys(x).length === x.length && Reflect.ownKeys(x).length === x.length + 1);
  for (let i = 0; i < x.length; i++) {
    const d = Object.getOwnPropertyDescriptor(x, String(i));
    ensure(d && d.enumerable && 'value' in d);
  }
  return x;
}
function shape(x, fields) {
  ensure(x !== null && typeof x === 'object' && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype);
  const keys = Reflect.ownKeys(x);
  ensure(keys.length === fields.length && fields.every(k => {
    const descriptor = Object.getOwnPropertyDescriptor(x, k);
    return descriptor && descriptor.enumerable && 'value' in descriptor;
  }) && keys.every(k => typeof k === 'string' && fields.includes(k)));
  return Object.fromEntries(fields.map(k => [k, x[k]]));
}
function scalarString(s) {
  ensure(typeof s === 'string' && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(s));
  return s;
}
function inspect(x, depth = 1, seen = new Set()) {
  ensure(depth <= 16);
  if (typeof x === 'string') return scalarString(x);
  if (typeof x === 'number') { signed(x); return x; }
  if (typeof x === 'boolean' || x === null) return x;
  ensure(typeof x === 'object' && !seen.has(x)); seen.add(x);
  if (Array.isArray(x)) {
    array(x, 10000);
    const copy = x.map(y => inspect(y, depth + 1, seen));
    seen.delete(x);
    return copy;
  }
  ensure(Object.getPrototypeOf(x) === Object.prototype);
  const result = {};
  for (const k of Reflect.ownKeys(x)) {
    ensure(typeof k === 'string'); scalarString(k);
    const d = Object.getOwnPropertyDescriptor(x, k);
    ensure(d.enumerable && 'value' in d);
    Object.defineProperty(result, k, { value: inspect(d.value, depth + 1, seen), enumerable: true, writable: true, configurable: true });
  }
  seen.delete(x);
  return result;
}
function key(x, kind) {
  array(x, 2); ensure(x.length === 2);
  return [number(x[0]), kind === 'audit' ? signed(x[1]) : string(x[1], UUID)];
}
function cmp(a, b) { return a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1; }
function canonicalCursor(t) {
  array(t, 10); ensure(t.length === 10 && t[0] === 2 && t[1] === 'maintenance' && t[8] === 1);
  const kind = t[5]; ensure(Object.hasOwn(EFFECT, kind));
  return [2,'maintenance',string(t[2], UUID),number(t[3]),string(t[4], UUID),kind,string(t[6], HASH),number(t[7]),1,key(t[9], kind)];
}
function cursorText(t) {
  const bytes = encoder.encode(JSON.stringify(canonicalCursor(t)));
  ensure(bytes.length <= 768);
  const text = Buffer.from(bytes).toString('base64url');
  ensure(text.length <= 1024);
  return text;
}
function digest(tag, bytes) { return createHash('sha256').update(tag, 'ascii').update(Buffer.from([0])).update(bytes).digest('hex'); }
function frame(x) {
  if (x === null) return Buffer.from('n;');
  if (typeof x === 'boolean') return Buffer.from(x ? 'b1;' : 'b0;');
  if (typeof x === 'number') { signed(x); return Buffer.from(`i${x};`); }
  if (typeof x === 'string') { const b = encoder.encode(scalarString(x)); return Buffer.concat([Buffer.from(`s${b.length}:`), b]); }
  array(x, 10000);
  return Buffer.concat([Buffer.from(`a${x.length}:`), ...x.map(frame)]);
}
function h(tag, value) { return digest(tag, frame(value)); }
function canonicalPlan(input) {
  const p = shape(input, PLAN);
  ensure(p.version === 2 && Object.hasOwn(EFFECT, p.kind));
  const kind = p.kind;
  p.runId = string(p.runId, UUID); p.instanceId = string(p.instanceId, UUID);
  p.instanceCreatedAt = number(p.instanceCreatedAt); p.centerEpoch = string(p.centerEpoch, UUID);
  p.executionPolicyHash = string(p.executionPolicyHash, HASH);
  p.createdAt = number(p.createdAt); p.expiresAt = number(p.expiresAt); p.clockObservedAt = number(p.clockObservedAt);
  const t = p.timeEvidence = shape(p.timeEvidence, TIME);
  ensure(t.version === 1 && (t.schemaVersion === 4 || t.schemaVersion === 5));
  t.observedWallAt = number(t.observedWallAt); t.globalFloorObservedAt = number(t.globalFloorObservedAt);
  t.anchorGeneration = nullable(t.anchorGeneration, positive); t.anchorHash = nullable(t.anchorHash, x => string(x, HASH));
  t.sessionNonce = nullable(t.sessionNonce, x => string(x, UUID)); t.anchorWallAt = nullable(t.anchorWallAt, number);
  t.monotonicElapsedMs = nullable(t.monotonicElapsedMs, number);
  t.maxForwardJumpMs = positive(t.maxForwardJumpMs, 86400000); t.executable = bool(t.executable);
  ensure([null,'SCHEMA_UPGRADE_REQUIRED','TIME_ANCHOR_REQUIRED','PROCESS_REANCHOR_REQUIRED','CLOCK_UNSAFE'].includes(t.reason));
  const anchor = t.anchorGeneration !== null;
  ensure((t.anchorHash !== null) === anchor && (t.anchorWallAt !== null) === anchor);
  ensure((t.sessionNonce !== null) === (t.monotonicElapsedMs !== null) && (!t.sessionNonce || anchor));
  if (t.schemaVersion === 4) ensure(!anchor && t.sessionNonce === null && !t.executable && t.reason === 'SCHEMA_UPGRADE_REQUIRED');
  else {
    ensure(t.reason !== 'SCHEMA_UPGRADE_REQUIRED');
    if (t.executable) ensure(anchor && t.sessionNonce !== null && t.reason === null);
    else if (t.reason !== 'CLOCK_UNSAFE') ensure(t.reason === (anchor ? 'PROCESS_REANCHOR_REQUIRED' : 'TIME_ANCHOR_REQUIRED') && t.sessionNonce === null);
  }
  const s = p.selection = shape(p.selection, SELECTION);
  ensure(s.version === 1 && s.sortVersion === 1);
  s.cutoffAt = number(s.cutoffAt); s.eligibleThroughAt = nullable(s.eligibleThroughAt, number);
  s.after = nullable(s.after, x => key(x, kind)); s.limit = positive(s.limit, 100);
  ensure(s.effect === EFFECT[kind]);
  array(s.auditActions, 2);
  ensure(JSON.stringify(s.auditActions) === JSON.stringify(kind === 'audit' ? AUDIT_ACTIONS : []));
  ensure(s.cutoffAt <= t.observedWallAt);
  ensure(s.eligibleThroughAt === (kind === 'audit' ? (s.cutoffAt >= 15552000000 ? s.cutoffAt - 15552000000 : null) : s.cutoffAt));
  const b = p.budget = shape(p.budget, BUDGET);
  for (const [name, cap] of Object.entries({maxRows:100,maxBytes:10485760,maxScanRows:10000,maxScanBytes:104857600,maxScanMs:1000,maxWriteMs:1000,planTtlMs:300000,maxForwardJumpMs:86400000})) b[name] = positive(b[name], cap);
  ensure(b.maxProofRows === 2 && b.maxForwardJumpMs === t.maxForwardJumpMs);
  b.plannedRows = number(b.plannedRows); b.plannedBytes = number(b.plannedBytes);
  ensure(p.createdAt === p.clockObservedAt && p.createdAt === t.observedWallAt && p.expiresAt - p.createdAt === b.planTtlMs);
  const scan = p.scan = shape(p.scan, SCAN);
  ensure(scan.version === 1);
  for (const n of ['rowsRead','bytesRead','elapsedMs','candidateCount','heldCount','skippedCount']) scan[n] = number(scan[n]);
  ensure(scan.rowsRead <= b.maxScanRows && scan.bytesRead <= b.maxScanBytes);
  scan.plannedRangeEnd = nullable(scan.plannedRangeEnd, x => key(x, kind));
  scan.lastScanned = nullable(scan.lastScanned, x => key(x, kind));
  ensure(JSON.stringify(scan.plannedRangeEnd) === JSON.stringify(scan.lastScanned));
  scan.complete = bool(scan.complete);
  ensure(scan.hasMore === null || typeof scan.hasMore === 'boolean');
  ensure([...NORMAL_STOPS,...SCAN_STOPS].includes(scan.stopReason));
  scan.rangeDigest = string(scan.rangeDigest, HASH);
  const counts = scan.heldCounts = shape(scan.heldCounts, COUNTS);
  for (const n of COUNTS) counts[n] = number(counts[n]);
  array(p.candidates); array(scan.held);
  p.candidates = p.candidates.map(raw => {
    const c = shape(raw, CANDIDATE);
    c.key = key(c.key, kind);
    c.messageId = nullable(c.messageId, x => string(x, UUID)); c.auditId = nullable(c.auditId, signed);
    c.contentPolicyHash = nullable(c.contentPolicyHash, x => string(x, HASH));
    c.expiresAt = nullable(c.expiresAt, number);
    c.expectedFingerprint = string(c.expectedFingerprint, HASH); c.expectedBytes = number(c.expectedBytes); c.expectedRows = positive(c.expectedRows);
    ensure(kind === 'audit' ? c.messageId === null && c.auditId === c.key[1] && c.contentPolicyHash === null && c.expectedState === null && c.expiresAt === null && c.expectedRows === 1 : c.messageId === c.key[1] && c.auditId === null && c.contentPolicyHash !== null && c.expectedState === (kind === 'expire' ? 'live' : 'expired') && c.expiresAt === c.key[0]);
    if (kind === 'expire') ensure(c.expectedBytes === 0 && c.expectedRows <= 2);
    if (kind === 'scrub') ensure(c.expectedRows <= 4);
    return c;
  });
  scan.held = scan.held.map(raw => {
    const c = shape(raw, HELD);
    c.key = key(c.key, kind); c.messageId = nullable(c.messageId, x => string(x, UUID)); c.auditId = nullable(c.auditId, signed);
    c.expectedFingerprint = string(c.expectedFingerprint, HASH); c.expectedRows = number(c.expectedRows); c.expectedBytes = number(c.expectedBytes);
    ensure(['OVERSIZED_GROUP','AUDIT_PROTECTED','AUDIT_ACTION_UNKNOWN'].includes(c.reason));
    ensure(kind === 'audit' ? c.messageId === null && c.auditId === c.key[1] : c.messageId === c.key[1] && c.auditId === null && c.reason === 'OVERSIZED_GROUP');
    if (c.reason !== 'OVERSIZED_GROUP') ensure(c.expectedRows === 0 && c.expectedBytes === 0);
    else ensure(c.expectedRows > b.maxRows || c.expectedBytes > b.maxBytes);
    if (kind === 'expire') ensure(c.expectedBytes === 0 && c.expectedRows <= 2);
    if (kind === 'scrub') ensure(c.expectedRows <= 4);
    if (kind === 'audit') ensure(c.expectedRows <= 1);
    return c;
  });
  const ordered = [...p.candidates.map(c => ({ ...c, reason: 'candidate' })), ...scan.held].sort((a,z) => cmp(a.key,z.key));
  const identities = new Set();
  for (let i = 0; i < ordered.length; i++) {
    const c = ordered[i];
    ensure((i === 0 || cmp(ordered[i-1].key,c.key) < 0) && (s.after === null || cmp(s.after,c.key) < 0) && s.eligibleThroughAt !== null && c.key[0] <= s.eligibleThroughAt);
    const identity = kind === 'audit' ? c.auditId : c.messageId;
    ensure(!identities.has(identity));
    identities.add(identity);
  }
  for (const list of [p.candidates,scan.held]) for (let i = 1; i < list.length; i++) ensure(cmp(list[i-1].key,list[i].key) < 0);
  ensure(ordered.length <= s.limit && scan.candidateCount === p.candidates.length && scan.heldCount === scan.held.length && scan.skippedCount === scan.heldCount);
  ensure(counts.oversizedGroup === scan.held.filter(x => x.reason === 'OVERSIZED_GROUP').length && counts.auditProtected === scan.held.filter(x => x.reason === 'AUDIT_PROTECTED').length && counts.auditActionUnknown === scan.held.filter(x => x.reason === 'AUDIT_ACTION_UNKNOWN').length);
  ensure(b.plannedRows === p.candidates.reduce((v,c) => v+c.expectedRows,0) && b.plannedBytes === p.candidates.reduce((v,c) => v+c.expectedBytes,0) && b.plannedRows <= b.maxRows && b.plannedBytes <= b.maxBytes);
  ensure(JSON.stringify(scan.plannedRangeEnd) === JSON.stringify(ordered.length ? ordered.at(-1).key : null));
  if (scan.complete) {
    ensure(scan.elapsedMs <= b.maxScanMs);
    ensure(scan.hasMore !== null && NORMAL_STOPS.includes(scan.stopReason));
    ensure(scan.hasMore ? scan.stopReason !== 'END' && scan.lastScanned !== null : scan.stopReason === 'END');
    if (scan.stopReason === 'LIMIT') ensure(ordered.length === s.limit);
  } else ensure(scan.hasMore === null && SCAN_STOPS.includes(scan.stopReason));
  if (scan.nextCursor === null) ensure(!scan.lastScanned || scan.complete && !scan.hasMore);
  else {
    const tuple = [2,'maintenance',p.instanceId,p.instanceCreatedAt,p.centerEpoch,kind,p.executionPolicyHash,s.cutoffAt,1,scan.lastScanned];
    ensure(scan.lastScanned !== null && scan.nextCursor === cursorText(tuple) && (!scan.complete || scan.hasMore));
  }
  const identity = [2,p.instanceId,p.instanceCreatedAt,p.centerEpoch,kind,p.executionPolicyHash,s.version,s.cutoffAt,s.eligibleThroughAt,s.sortVersion,s.after,s.limit,s.effect,s.auditActions];
  const outcomes = ordered.map(c => [c.key,c.reason,c.expectedFingerprint,c.expectedRows,c.expectedBytes]);
  ensure(scan.rangeDigest === h('a2a-msg.im.maintenance.range.v1',[identity,scan.plannedRangeEnd,scan.hasMore,outcomes]));
  p.candidateDigest = string(p.candidateDigest, HASH);
  ensure(p.candidateDigest === h('a2a-msg.im.maintenance.candidates.v2',[identity,scan.plannedRangeEnd,scan.rangeDigest,p.candidates.map(c => [c.key,c.messageId,c.auditId,c.contentPolicyHash,c.expectedState,c.expiresAt,c.expectedFingerprint,c.expectedBytes,c.expectedRows])]));
  ensure(JSON.stringify(p.candidates).length <= 65536);
  return p;
}
function bytesOf(bytes, cap) {
  ensure((Object.getPrototypeOf(bytes) === Uint8Array.prototype || Object.getPrototypeOf(bytes) === Buffer.prototype) && Object.getPrototypeOf(bytes.buffer) === ArrayBuffer.prototype);
  if (bytes.byteLength > cap) fail('MAINTENANCE_METADATA_LIMIT');
  return Buffer.from(bytes);
}
// Recursive lexical pass detects escaped aliases before JSON.parse and bounds depth.
function parse(bytes) {
  let text;
  try { text = decoder.decode(bytes); } catch { fail(); }
  ensure(!text.startsWith('\uFEFF'));
  let i = 0;
  const ws = () => { while (/[\x20\t\r\n]/.test(text[i] ?? '')) i++; };
  const str = () => {
    ensure(text[i++] === '"'); const start = i-1;
    while (i < text.length) {
      if (text[i] === '"') { i++; let x; try { x = JSON.parse(text.slice(start,i)); } catch { fail(); } scalarString(x); return x; }
      if (text[i] === '\\') { i++; if (text[i] === 'u') { ensure(/^[0-9a-fA-F]{4}$/.test(text.slice(i+1,i+5))); i += 5; } else { ensure('"\\/bfnrt'.includes(text[i] ?? '\0')); i++; } }
      else { ensure(text.charCodeAt(i) >= 32); i++; }
    }
    fail();
  };
  const value = depth => {
    ensure(depth <= 16); ws();
    if (text[i] === '"') return str();
    if (text[i] === '{') {
      i++; ws(); const o = {}; const seen = new Set();
      if (text[i] === '}') { i++; return o; }
      do {
        ws(); const k = str(); ensure(!seen.has(k)); seen.add(k); ws(); ensure(text[i++] === ':');
        Object.defineProperty(o,k,{value:value(depth+1),enumerable:true,writable:true,configurable:true}); ws();
        if (text[i] === '}') { i++; return o; } ensure(text[i++] === ',');
      } while (true);
    }
    if (text[i] === '[') {
      i++; ws(); const a = []; if (text[i] === ']') { i++; return a; }
      do { a.push(value(depth+1)); ws(); if (text[i] === ']') { i++; return a; } ensure(text[i++] === ','); } while (true);
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i));
    ensure(token); i += token[0].length;
    return JSON.parse(token[0]);
  };
  const result = value(1); ws(); ensure(i === text.length);
  return result;
}
function freeze(x) { if (x && typeof x === 'object') { for (const child of Object.values(x)) freeze(child); Object.freeze(x); } return x; }
function safe(fn) {
  try { return fn(); }
  catch (e) {
    const code = e !== null && (typeof e === 'object' || typeof e === 'function')
      ? internalErrors.get(e) : undefined;
    fail(code === 'MAINTENANCE_METADATA_LIMIT' ? code : 'MAINTENANCE_CODEC_INVALID');
  }
}
export function encodeMaintenancePlan(plan) { return safe(() => { const bytes = encoder.encode(JSON.stringify(canonicalPlan(inspect(plan)))); if (bytes.length > 65536) fail('MAINTENANCE_METADATA_LIMIT'); return bytes; }); }
export function decodeMaintenancePlan(bytes) { return safe(() => { const copied = bytesOf(bytes,65536); const raw = parse(copied); const canonical = encodeMaintenancePlan(raw); ensure(copied.equals(Buffer.from(canonical))); return freeze(canonicalPlan(raw)); }); }
export function hashMaintenancePlan(plan) { return safe(() => digest('a2a-msg.im.maintenance.plan.v2', encodeMaintenancePlan(plan))); }
export function encodeMaintenanceCursor(tuple) { return safe(() => cursorText(inspect(tuple))); }
export function decodeMaintenanceCursor(cursor) { return safe(() => { ensure(typeof cursor === 'string' && cursor.length > 0 && cursor.length <= 1024 && /^[A-Za-z0-9_-]+$/.test(cursor)); const raw = Buffer.from(cursor,'base64url'); ensure(raw.length <= 768 && raw.toString('base64url') === cursor); const tuple = parse(raw); ensure(cursorText(tuple) === cursor); return freeze(canonicalCursor(tuple)); }); }
