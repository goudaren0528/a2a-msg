import { randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { types } from 'node:util';
import { privateDirectory, protectedPath, checkOpened } from './recovery-records.js';
import { projectCandidateBudget } from './schema-internal.js';
import { assertImSchemaV5Internal, V5_DDL, V5_MANIFEST, V5_CHECKSUM } from './schema-v5-internal.js';
import { encodeMaintenanceV5Record, decodeMaintenanceV5Record, hashMaintenanceV5Record } from './maintenance-v5-records.js';

/* NONRELEASE. The only caller is trusted offline SYNTHETIC fixture composition:
 * it closes construction first and excludes all other users/connections, schema
 * changes, rename/aliases, backup, recovery and conversion for this lifetime.
 * An absolute path and native file protection cannot prove production ownership.
 * In particular a completed conversion's closed-file hash is NOT a handoff.
 * No DB, arbitrary SQL callback, sampler or transferable writer token escapes.
 * Future B1 own-transaction checking is deliberately not implemented here.
 */
const targets = new WeakMap();
const authorities = new WeakMap();
// Also retain failed-construction/unresolved-close resources. Never open a new
// connection to their pathname on a subsequent constructor call.
const resources = new Map();
const frames = new Set();
// Internal errors may cross a callback boundary during forbidden reentry. Keep
// their classification off the Error object: a callback can mutate even a
// branded Error's code/message (or replace code with a throwing accessor).
const errorCodes = new WeakMap();
const nativeExec = DatabaseSync.prototype.exec;
const nativePrepare = DatabaseSync.prototype.prepare;
const nativeClose = DatabaseSync.prototype.close;
const wallNow = Date.now.bind(Date);
const monoNow = process.hrtime.bigint.bind(process.hrtime);
const budgetNow = performance.now.bind(performance);
const MAX = Number.MAX_SAFE_INTEGER;
const NS = 1000000n;
const MAX_NS = BigInt(MAX) * NS;
const SIX = Object.freeze({ maxMessages: 10000, maxVerifiedContentBytes: 104857600,
  maxOtherRecords: 10000, maxElapsedMs: 10000, maxMaintenanceAnchors: 10000,
  maxMaintenanceMetadataBytes: 10485760 });
const NINE = Object.freeze({ ...SIX, proposalTtlMs: 300000, acceptanceWindowMs: 5000, maxForwardJumpMs: 86400000 });
const PROPOSAL = Object.freeze(['version', 'instanceId', 'instanceCreatedAt', 'centerEpoch',
  'previousGeneration', 'previousAnchorHash', 'sessionNonce', 'proposedAt', 'proposalExpiresAt',
  'candidateWallAt', 'acceptNotBefore', 'acceptNotAfter', 'globalFloorObservedAt', 'maxForwardJumpMs']);
const ANCHOR = Object.freeze(['version', 'instanceId', 'instanceCreatedAt', 'generation', 'centerEpoch',
  'previousGeneration', 'previousAnchorHash', 'proposalHash', 'sessionNonce', 'proposedAt',
  'proposalExpiresAt', 'candidateWallAt', 'acceptNotBefore', 'acceptNotAfter', 'acceptedWallAt',
  'globalFloorObservedAt', 'globalFloorAtApproval', 'maxForwardJumpMs', 'approvalRef', 'executorId', 'approverId']);
const ANCHOR_COLUMNS = Object.freeze(['generation', 'center_epoch', 'previous_generation', 'previous_anchor_hash',
  'proposal_hash', 'anchor_hash', 'session_nonce', 'proposed_at', 'proposal_expires_at', 'candidate_wall_at',
  'accept_not_before', 'accept_not_after', 'accepted_wall_at', 'global_floor_observed_at',
  'global_floor_at_approval', 'max_forward_jump_ms', 'approval_ref', 'executor_id', 'approver_id']);
const CONVERSION_FILES = Object.freeze(['conversion-owner.json', 'conversion-pause-intent.json',
  'conversion-paused.json', 'conversion-plan.json', 'conversion-complete.json']);
const AUTOMATIC = V5_DDL.filter(sql => sql.startsWith('CREATE TABLE ')).flatMap(sql => {
  const name = /^CREATE TABLE (im_\w+)/.exec(sql)[1];
  const count = (sql.match(/\bUNIQUE\b|\bPRIMARY KEY\b/g) ?? []).length -
    Number(/\b\w+ INTEGER NOT NULL PRIMARY KEY\b|\b\w+ INTEGER PRIMARY KEY\b/.test(sql));
  return Array.from({ length: count }, (_, i) => ['index', `sqlite_autoindex_${name}_${i + 1}`, name, null]);
});
const OBJECTS = new Map([...V5_MANIFEST, ...AUTOMATIC].map(row => [row[1], row]));

function failure(suffix = 'INVALID') {
  const error = Object.assign(new Error('Maintenance time operation rejected'), { code: `MAINTENANCE_${suffix}` });
  errorCodes.set(error, suffix);
  return error;
}
function fail(suffix) { throw failure(suffix); }
function safe(error, fallback = 'READ_UNAVAILABLE') { return errorCodes.has(error) ? error : failure(fallback); }
// Never expose a branded object: external mutation must not affect a retained
// first fault or the result of a later catch/cleanup classification.
function outward(error) {
  const result = new Error('Maintenance time operation rejected');
  result.code = `MAINTENANCE_${errorCodes.get(safe(error))}`;
  return result;
}
function exposed(fn) {
  try { return fn(); }
  catch (error) { throw outward(error); }
}
function dataCode(error) {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function') || types.isProxy(error)) return undefined;
  return Object.getOwnPropertyDescriptor(error, 'code')?.value;
}
function poison(frame, error) {
  frame.fault ??= safe(error);
  return frame.fault;
}
function invalidCall() {
  const error = failure('INVALID');
  for (const frame of frames) poison(frame, error);
  throw error;
}
function admitPublicCall() {
  if (frames.size) invalidCall();
}
function poisonActiveTarget() {
  const error = failure('TARGET_STALE');
  for (const frame of frames) poison(frame, error);
  return error;
}
function shape(value, fields) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) fail('INVALID');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some(key => typeof key !== 'string' || !fields.includes(key))) fail('INVALID');
  const result = {};
  for (const field of fields) {
    const d = Object.getOwnPropertyDescriptor(value, field);
    if (!d || !d.enumerable || !Object.hasOwn(d, 'value')) fail('INVALID');
    result[field] = d.value;
  }
  return result;
}
function positive(n) { return Number.isSafeInteger(n) && !Object.is(n, -0) && n > 0; }
function nonnegative(n) { return Number.isSafeInteger(n) && !Object.is(n, -0) && n >= 0; }
function ref(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 255 &&
    !/[\x00-\x1f\x7f]/.test(value) && String.prototype.isWellFormed.call(value);
}
function limits(value, ceilings) {
  const result = shape(value, Object.keys(ceilings));
  for (const key of Object.keys(ceilings)) if (!positive(result[key]) || result[key] > ceilings[key]) fail('INVALID');
  return Object.freeze(result);
}
function synchronous(fn) {
  if (typeof fn !== 'function' || types.isProxy(fn) || types.isAsyncFunction(fn) || types.isGeneratorFunction(fn)) fail('INVALID');
  return fn;
}
function adapter(value, fields) {
  const copy = shape(value, fields);
  for (const field of fields) synchronous(copy[field]);
  return Object.freeze(copy);
}
function noThenable(frame, value) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return;
  if (types.isProxy(value)) throw poison(frame, failure('INVALID'));
  if (types.isPromise(value)) {
    const error = poison(frame, failure('INVALID')); // latch BEFORE any observation
    // Only an ordinary native promise can be observed without consulting a
    // hostile constructor/species. No foreign then/constructor getter is called.
    if (Object.getPrototypeOf(value) === Promise.prototype && !Object.hasOwn(value, 'constructor')) {
      try { Promise.prototype.then.call(value, undefined, () => {}); } catch { /* poisoned */ }
    }
    throw error;
  }
  for (let cursor = value; cursor !== null; cursor = Object.getPrototypeOf(cursor)) {
    if (types.isProxy(cursor)) throw poison(frame, failure('INVALID'));
    const then = Object.getOwnPropertyDescriptor(cursor, 'then');
    if (then && (!Object.hasOwn(then, 'value') || typeof then.value === 'function')) {
      const error = poison(frame, failure('INVALID'));
      // A data-method thenable may synchronously reject/reenter. Refusal was
      // already latched; invoking it never becomes approval or extends a frame.
      if (Object.hasOwn(then, 'value') && typeof then.value === 'function' && !types.isProxy(then.value) &&
          !types.isAsyncFunction(then.value) && !types.isGeneratorFunction(then.value)) {
        try { Reflect.apply(then.value, value, [() => {}, () => {}]); } catch { /* poisoned */ }
      }
      throw error;
    }
  }
}
function callback(a, frame, receiver, fn, args, denial) {
  guard(a.target, frame);
  let result;
  try { result = Reflect.apply(fn, receiver, args); }
  catch { throw poison(frame, failure(denial)); }
  try { noThenable(frame, result); }
  catch (error) { throw poison(frame, safe(error, 'INVALID')); }
  guard(a.target, frame);
  frame.budget.tick();
  return result;
}
function admin(a, frame, ctx) {
  if (callback(a, frame, a.admin, a.admin.authorizeAdmin, [ctx], 'AUTH_DENIED') !== true) fail('AUTH_DENIED');
}
function approval(a, frame, binding, ctx) {
  if (callback(a, frame, a.approval, a.approval.authorizeApproval, [binding, ctx], 'APPROVAL_DENIED') !== true) fail('APPROVAL_DENIED');
}
function budget(bounds) {
  const start = budgetNow();
  let last = start, bytes = 0;
  if (!Number.isFinite(start)) fail('READ_UNAVAILABLE');
  const six = Object.freeze(Object.fromEntries(Object.keys(SIX).map(key => [key, bounds[key]])));
  return { limits: six, tick() {
    const now = budgetNow();
    if (!Number.isFinite(now) || now < last || now - start > six.maxElapsedMs) fail('READ_UNAVAILABLE');
    last = now;
  }, reserve(n) {
    if (!nonnegative(n) || !Number.isSafeInteger(bytes + n) || bytes + n > six.maxMaintenanceMetadataBytes) fail('METADATA_LIMIT');
    bytes += n;
    this.tick();
  }, capacity(n) {
    if (!nonnegative(n) || !Number.isSafeInteger(bytes + n) || bytes + n > six.maxMaintenanceMetadataBytes) fail('METADATA_LIMIT');
    this.tick();
  } };
}
function codec(kind, value, account) {
  try {
    const copy = shape(value, kind === 'timeProposal' ? PROPOSAL : ANCHOR);
    let upper = 2;
    for (const [key, item] of Object.entries(copy)) {
      if (item !== null && typeof item !== 'number' && typeof item !== 'string') fail('INVALID');
      if (typeof item === 'string' && item.length > 255) fail('INVALID');
      upper += key.length + 6 + (typeof item === 'string' ? item.length * 6 + 2 : 32);
    }
    account?.capacity(upper);
    const bytes = encodeMaintenanceV5Record(kind, copy);
    account?.reserve(bytes.length);
    return { value: decodeMaintenanceV5Record(kind, bytes), bytes,
      hash: hashMaintenanceV5Record(kind, copy) };
  } catch (error) {
    if (errorCodes.has(error)) throw error;
    if (dataCode(error) === 'MAINTENANCE_METADATA_LIMIT') fail('METADATA_LIMIT');
    fail('INVALID');
  }
}
function missing(path) {
  try { lstatSync(path); return false; }
  catch (error) { if (dataCode(error) === 'ENOENT') return true; throw error; }
}
function filesystem(t, sidecars = true) {
  privateDirectory(dirname(t.path));
  protectedPath(t.path);
  const identity = [];
  for (let current = t.path; ; current = dirname(current)) {
    const st = lstatSync(current, { bigint: true });
    identity.push([current, st.dev.toString(), st.ino.toString(), st.uid.toString(), st.gid.toString(), st.mode.toString()]);
    if (current !== t.path) {
      for (const name of CONVERSION_FILES) if (!missing(join(current, name))) fail('SCHEMA_UNSUPPORTED');
    }
    if (current === dirname(current)) break;
  }
  // Reject the recovery workspace's fixed candidate location even before any
  // conversion owner file exists. Renaming arbitrary production data is outside
  // the trusted composition contract and cannot be detected from SQLite bytes.
  if (basename(dirname(dirname(t.path))) === 'runs' || realpathSync(t.path) !== t.path) fail('SCHEMA_UNSUPPORTED');
  if (sidecars) for (const suffix of ['-wal', '-shm', '-journal']) if (!missing(t.path + suffix)) fail('READ_UNAVAILABLE');
  return JSON.stringify(identity);
}
function fileGate(t, sidecars = true) {
  try {
    const identity = filesystem(t, sidecars);
    if (t.file !== null && identity !== t.file) stale(t);
    return identity;
  } catch (error) {
    if (t.binding) stale(t);
    throw safe(error);
  }
}
function revoke(t) {
  t.invalid = true;
  if (t.authority) { t.authority.pending = null; t.authority.session = null; }
  if (t.frame) poison(t.frame, failure('TARGET_STALE'));
}
function stale(t) { revoke(t); fail('TARGET_STALE'); }
function nativeState(t, field) {
  const result = Reflect.apply(t[field], t.db, []);
  if (typeof result !== 'boolean') fail('DURABILITY_UNCERTAIN');
  return result;
}
function guard(t, frame) {
  if (frame.fault) throw frame.fault;
  if (t.invalid || t.closed || t.frame !== frame) stale(t);
  if (nativeState(t, 'open') !== true || nativeState(t, 'transaction') !== frame.transaction) stale(t);
}
function exec(t, sql) { return Reflect.apply(nativeExec, t.db, [sql]); }
function statement(t, sql) { return Reflect.apply(nativePrepare, t.db, [sql]); }
function get(t, frame, sql, ...args) {
  guard(t, frame); frame.budget.tick();
  const result = statement(t, sql).get(...args);
  frame.budget.tick();
  return result;
}
function closeOwned(t, release = true) {
  if (t.closed) return;
  try { Reflect.apply(nativeClose, t.db, []); } catch { /* Native open state decides. */ }
  let closed = false;
  try { closed = nativeState(t, 'open') === false; } catch { /* retain */ }
  if (!closed) { t.uncertain = true; fail('DURABILITY_UNCERTAIN'); }
  t.closed = true;
  t.uncertain = false;
  if (release) resources.delete(t.path);
}
function openConnection(t) {
  // Only called initially or AFTER positively confirmed closure while retaining
  // the exact original file/ancestry and exclusive synthetic owner reservation.
  fileGate(t);
  t.db = new DatabaseSync(`${pathToFileURL(t.path).href}?mode=rw`, { enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false, allowExtension: false, timeout: 0 });
  resources.set(t.path, t);
  t.closed = false;
  t.open = Object.getOwnPropertyDescriptor(t.db, 'isOpen')?.get;
  t.transaction = Object.getOwnPropertyDescriptor(t.db, 'isTransaction')?.get;
  if (typeof t.open !== 'function' || typeof t.transaction !== 'function' || !nativeState(t, 'open') || nativeState(t, 'transaction')) fail('READ_UNAVAILABLE');
  exec(t, 'PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0');
}
function cleanupTransaction(t, frame) {
  if (!frame.transaction) return;
  // Once native transaction state became unresolved, another observation must
  // not silently turn cleanup into a guessed rollback. Retain for safe close.
  if (t.uncertain) fail('DURABILITY_UNCERTAIN');
  let active;
  try { active = nativeState(t, 'transaction'); }
  catch { t.uncertain = true; revoke(t); fail('DURABILITY_UNCERTAIN'); }
  if (active) {
    try {
      exec(t, 'ROLLBACK');
      if (nativeState(t, 'transaction') !== false) fail('DURABILITY_UNCERTAIN');
    } catch { t.uncertain = true; revoke(t); fail('DURABILITY_UNCERTAIN'); }
  }
  frame.transaction = false;
}
function begin(t, frame, write = false) {
  guard(t, frame);
  fileGate(t);
  frame.budget.tick();
  // If BEGIN's response throws after opening our transaction, cleanup still
  // knows that it is ours; no external connection can enter this private handle.
  frame.transaction = true;
  exec(t, write ? 'BEGIN IMMEDIATE' : 'BEGIN');
  guard(t, frame);
}
function endRead(t, frame) {
  guard(t, frame);
  exec(t, 'ROLLBACK'); // only a read snapshot, never an already committed writer
  frame.transaction = false;
  guard(t, frame);
  fileGate(t);
  frame.budget.tick();
}

// Whole-database manifest, including objects ignored by the IM-only validator.
// Length projection precedes fetching names/SQL, and unexpected objects are
// never adopted (including non-IM triggers with write side effects).
function manifest(t, frame) {
  const b = frame.budget;
  if (get(t, frame, 'SELECT 1 AS n FROM sqlite_temp_master LIMIT 1')) fail('SCHEMA_UNSUPPORTED');
  const count = get(t, frame, 'SELECT count(*) AS n FROM (SELECT 1 FROM sqlite_master LIMIT ?)', OBJECTS.size + 1).n;
  if (count !== OBJECTS.size) fail('SCHEMA_UNSUPPORTED');
  const seen = new Set();
  for (const size of statement(t, `SELECT rowid,length(CAST(type AS BLOB)) AS t,length(CAST(name AS BLOB)) AS n,
    length(CAST(tbl_name AS BLOB)) AS owner,coalesce(length(CAST(sql AS BLOB)),0) AS s FROM sqlite_master LIMIT ?`).iterate(OBJECTS.size)) {
    b.tick();
    if (![size.t, size.n, size.owner, size.s].every(nonnegative) || size.t > 8 || size.n > 255 || size.owner > 255) fail('SCHEMA_UNSUPPORTED');
    b.reserve(size.t + size.n + size.owner + size.s + 64);
    const row = get(t, frame, 'SELECT type,name,tbl_name,sql FROM sqlite_master WHERE rowid=?', size.rowid);
    const expected = OBJECTS.get(row.name);
    if (!expected || seen.has(row.name) || row.type !== expected[0] || row.tbl_name !== expected[2] ||
        (row.sql === null ? expected[3] !== null : expected[3] === null || row.sql.trim().replace(/\s+/g, ' ') !== expected[3])) fail('SCHEMA_UNSUPPORTED');
    seen.add(row.name);
  }
  b.reserve(64);
  const marker = get(t, frame, 'SELECT version,migration_checksum FROM im_schema LIMIT 1');
  if (!marker || marker.version !== 5 || marker.migration_checksum !== V5_CHECKSUM) fail('SCHEMA_UNSUPPORTED');
}
function preflight(t, frame) {
  const b = frame.budget;
  // This stable inherited projection differentiates row/content exhaustion from
  // metadata before the full v5 validator's intentionally coarser budget error.
  try { projectCandidateBudget(t.db, b, 4); }
  catch (error) {
    if (errorCodes.has(error)) throw error;
    if (dataCode(error) === 'IM_V2_BUDGET_EXCEEDED') fail('READ_UNAVAILABLE');
    fail('SCHEMA_UNSUPPORTED');
  }
  for (const [type, name] of V5_MANIFEST) {
    if (type !== 'table') continue;
    const cap = name === 'im_maintenance_time_anchors' ? b.limits.maxMaintenanceAnchors :
      ['im_maintenance_time_head', 'im_center_schema_transitions'].includes(name) ? 1 : b.limits.maxMessages + b.limits.maxOtherRecords;
    const count = get(t, frame, `SELECT count(*) AS n FROM (SELECT 1 FROM ${name} LIMIT ?)`, cap + 1).n;
    if (!nonnegative(count) || count > cap) fail('READ_UNAVAILABLE');
    const fields = statement(t, `PRAGMA table_info(${name})`).all().filter(row => row.type === 'TEXT' &&
      !(name === 'im_messages' && ['text', 'title', 'correlation'].includes(row.name)) &&
      !(name === 'im_attachments' && ['name', 'mime'].includes(row.name))).map(row => row.name);
    b.tick();
    if (!fields.length) continue;
    const expression = fields.map(field => `coalesce(length(CAST(${field} AS BLOB)),0)`).join('+');
    for (const row of statement(t, `SELECT ${expression} AS bytes FROM ${name} LIMIT ?`).iterate(cap + 1)) {
      const evidence = ['im_maintenance_time_anchors', 'im_center_schema_transitions'].includes(name);
      b.reserve(evidence ? row.bytes * 12 + 4096 : row.bytes + fields.length * 32);
    }
  }
}
function connection(t, frame) {
  if (get(t, frame, 'PRAGMA journal_mode').journal_mode !== 'delete' ||
      get(t, frame, 'PRAGMA foreign_keys').foreign_keys !== 1 ||
      get(t, frame, 'PRAGMA synchronous').synchronous !== 2 ||
      get(t, frame, 'PRAGMA busy_timeout').timeout !== 0) stale(t);
  const sizes = statement(t, 'SELECT seq,length(CAST(name AS BLOB)) AS n,length(CAST(file AS BLOB)) AS f FROM pragma_database_list LIMIT 3').all();
  frame.budget.tick();
  // SQLite may expose its empty temp schema after the manifest temp probe.
  if (sizes.some(row => row.seq === 0 ? row.n !== 4 || row.f !== Buffer.byteLength(t.path) :
    row.seq !== 1 || row.n !== 4 || row.f !== 0) || !sizes.some(row => row.seq === 0) || sizes.length > 2) stale(t);
  frame.budget.reserve(Buffer.byteLength(t.path) + 64);
  if (get(t, frame, "SELECT file FROM pragma_database_list WHERE name='main'")?.file !== t.path) stale(t);
}
function binding(f) {
  return JSON.stringify([f.cookie, f.instanceId, f.instanceCreatedAt, f.centerEpoch, f.status, f.writeMode]);
}
function chain(f) { return JSON.stringify([f.tipGeneration, f.tipHash, f.headGeneration, f.headHash]); }
function facts(t, frame, proposedChain = null) {
  guard(t, frame); fileGate(t); connection(t, frame);
  const cookie = get(t, frame, 'PRAGMA schema_version').schema_version;
  if (t.cookie !== null && cookie !== t.cookie) stale(t);
  if (t.binding !== null) {
    // Fixed bounded projections detect lifecycle drift before a broken inherited
    // relation could turn it into a retryable validation error. No unbounded text
    // is materialized on this early gate.
    const early = get(t, frame, `SELECT
      CASE WHEN length(CAST(i.instance_id AS BLOB))=36 THEN i.instance_id END AS instanceId,
      i.created_at AS instanceCreatedAt,
      CASE WHEN length(CAST(c.center_epoch AS BLOB))=36 THEN c.center_epoch END AS centerEpoch,
      CASE WHEN length(CAST(c.status AS BLOB))<=8 THEN c.status END AS status,
      CASE WHEN length(CAST(s.write_mode AS BLOB))<=8 THEN s.write_mode END AS writeMode
      FROM im_instance_identity i,im_center_state c,im_settings s
      WHERE i.singleton=1 AND c.singleton=1 AND s.singleton=1 LIMIT 1`);
    if (!early || binding({ cookie, ...early }) !== t.binding) stale(t);
    const marker = get(t, frame, `SELECT version,CASE WHEN length(CAST(migration_checksum AS BLOB))=64
      THEN migration_checksum END AS checksum FROM im_schema LIMIT 1`);
    if (!marker || marker.version !== 5 || marker.checksum !== V5_CHECKSUM) stale(t);
    const tip = get(t, frame, `SELECT generation,CASE WHEN length(CAST(anchor_hash AS BLOB))=64 THEN anchor_hash END AS hash
      FROM im_maintenance_time_anchors ORDER BY generation DESC LIMIT 1`);
    const head = get(t, frame, `SELECT generation,CASE WHEN length(CAST(anchor_hash AS BLOB))=64 THEN anchor_hash END AS hash
      FROM im_maintenance_time_head WHERE singleton=1`);
    if (JSON.stringify([tip?.generation ?? null, tip?.hash ?? null, head?.generation ?? null, head?.hash ?? null]) !==
        (proposedChain ?? t.chain)) stale(t);
    frame.budget.reserve(256);
  }
  manifest(t, frame);
  preflight(t, frame);
  let timed = false;
  // The validator accepts this documented standalone parent. Its parent tick is
  // the SAME deadline; no recovery brand or nested replacement budget is made.
  const parent = { limits: frame.budget.limits, tick() {
    try { frame.budget.tick(); }
    catch { timed = true; throw Object.assign(new Error('Validation budget exhausted'), { code: 'IM_V2_BUDGET_EXCEEDED' }); }
  } };
  try { assertImSchemaV5Internal(t.db, parent); }
  catch (error) {
    if (timed || dataCode(error) === 'IM_V2_BUDGET_EXCEEDED') fail('READ_UNAVAILABLE');
    fail('SCHEMA_UNSUPPORTED');
  }
  frame.budget.tick();
  if (get(t, frame, 'PRAGMA foreign_key_check')) fail('SCHEMA_UNSUPPORTED');
  // Existing validators establish all inherited relations. These fixed rows are
  // fetched only AFTER their projected lengths and full validation were charged.
  frame.budget.reserve(2048);
  const identity = get(t, frame, 'SELECT instance_id,created_at FROM im_instance_identity WHERE singleton=1');
  const center = get(t, frame, 'SELECT center_epoch,status FROM im_center_state WHERE singleton=1');
  const mode = get(t, frame, 'SELECT write_mode FROM im_settings WHERE singleton=1');
  const floor = get(t, frame, 'SELECT last_observed_at FROM im_clock WHERE singleton=1').last_observed_at;
  const tip = get(t, frame, 'SELECT generation,anchor_hash,accepted_wall_at FROM im_maintenance_time_anchors ORDER BY generation DESC LIMIT 1');
  const head = get(t, frame, 'SELECT generation,anchor_hash FROM im_maintenance_time_head WHERE singleton=1');
  const f = { cookie, instanceId: identity.instance_id, instanceCreatedAt: identity.created_at,
    centerEpoch: center.center_epoch, status: center.status, writeMode: mode.write_mode, floor,
    tipGeneration: tip?.generation ?? null, tipHash: tip?.anchor_hash ?? null, tipWall: tip?.accepted_wall_at ?? null,
    headGeneration: head?.generation ?? null, headHash: head?.anchor_hash ?? null };
  if (t.binding !== null && (binding(f) !== t.binding || chain(f) !== (proposedChain ?? t.chain))) stale(t);
  if (f.status !== 'active' || f.writeMode !== 'paused') fail('SCHEMA_UNSUPPORTED');
  const active = get(t, frame, `SELECT 1 AS valid FROM im_center_state c
    JOIN im_recovery_runs r ON r.run_id=c.recovery_run_id
    JOIN im_center_epochs e ON e.center_epoch=c.center_epoch
    WHERE c.singleton=1 AND r.status='active' AND r.new_epoch=c.center_epoch
      AND r.activation_ref=c.activation_ref AND e.recovery_counter=c.recovery_counter
      AND r.auth_review_ref IS NOT NULL AND r.activation_approval_ref IS NOT NULL
      AND r.activation_plan_hash IS NOT NULL AND r.failure_code IS NULL
      AND r.created_at<=r.verified_at AND r.verified_at<=r.activated_at LIMIT 1`);
  if (!active) fail('SCHEMA_UNSUPPORTED');
  if (!nonnegative(f.floor)) fail('SCHEMA_UNSUPPORTED');
  frame.budget.tick();
  return f;
}
function fixedFacts(t, frame, expected) {
  // After full validation, recheck only already-projected immutable facts under
  // the SAME SQLite snapshot. This final gate neither resets nor recharges a
  // whole validation pass and performs no arbitrary callback.
  guard(t, frame); fileGate(t); connection(t, frame);
  frame.budget.reserve(2048);
  const cookie = get(t, frame, 'PRAGMA schema_version').schema_version;
  const row = get(t, frame, `SELECT
    CASE WHEN length(CAST(i.instance_id AS BLOB))=36 THEN i.instance_id END AS instanceId,
    i.created_at AS instanceCreatedAt,
    CASE WHEN length(CAST(c.center_epoch AS BLOB))=36 THEN c.center_epoch END AS centerEpoch,
    CASE WHEN length(CAST(c.status AS BLOB))<=8 THEN c.status END AS status,
    CASE WHEN length(CAST(s.write_mode AS BLOB))<=8 THEN s.write_mode END AS writeMode,
    k.last_observed_at AS floor FROM im_instance_identity i,im_center_state c,im_settings s,im_clock k
    WHERE i.singleton=1 AND c.singleton=1 AND s.singleton=1 AND k.singleton=1 LIMIT 1`);
  if (!row || binding({ cookie, ...row }) !== binding(expected)) stale(t);
  const tip = get(t, frame, `SELECT generation,accepted_wall_at,CASE WHEN length(CAST(anchor_hash AS BLOB))=64
    THEN anchor_hash END AS hash FROM im_maintenance_time_anchors ORDER BY generation DESC LIMIT 1`);
  const head = get(t, frame, `SELECT generation,CASE WHEN length(CAST(anchor_hash AS BLOB))=64
    THEN anchor_hash END AS hash FROM im_maintenance_time_head WHERE singleton=1`);
  if (JSON.stringify([tip?.generation ?? null, tip?.hash ?? null, head?.generation ?? null, head?.hash ?? null]) !== chain(expected) ||
      (tip?.accepted_wall_at ?? null) !== expected.tipWall) stale(t);
  if (!nonnegative(row.floor)) fail('SCHEMA_UNSUPPORTED');
  return { ...expected, floor: row.floor };
}

export function openIsolatedMaintenanceTimeTarget(options) {
  let t;
  try {
    admitPublicCall();
    if (arguments.length !== 1) invalidCall();
    const input = shape(options, ['databasePath', 'limits']);
    const bounds = limits(input.limits, SIX);
    const path = input.databasePath;
    if (typeof path !== 'string' || !path || !String.prototype.isWellFormed.call(path) || /[\x00-\x1f\x7f]/.test(path) ||
        !isAbsolute(path) || normalize(path) !== path) fail('INVALID');
    if (resources.has(path)) fail(resources.get(path).uncertain ? 'DURABILITY_UNCERTAIN' : 'TARGET_STALE');
    const account = budget(bounds);
    t = { path, limits: bounds, db: null, file: null, cookie: null, binding: null, chain: null,
      invalid: false, closed: false, uncertain: false, authority: null, frame: null };
    t.file = fileGate(t);
    account.tick();
    let fd;
    try {
      const before = protectedPath(path);
      // No O_CREAT. Read the DELETE header before SQLite could recover anything.
      fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
      checkOpened(path, before, fstatSync(fd));
      const header = Buffer.alloc(100);
      if (readSync(fd, header, 0, 100, 0) !== 100 || header.toString('ascii', 0, 16) !== 'SQLite format 3\0' ||
          header[18] !== 1 || header[19] !== 1) fail('SCHEMA_UNSUPPORTED');
      checkOpened(path, before, fstatSync(fd));
    } finally { if (fd !== undefined) closeSync(fd); }
    fileGate(t);
    // SQLite URI mode=rw removes CREATE even though Node's default flags include
    // it. Passing the URI STRING preserves its query (a URL object would not).
    openConnection(t);
    const frame = { transaction: false, fault: null, budget: account };
    t.frame = frame;
    try {
      begin(t, frame);
      const f = facts(t, frame);
      endRead(t, frame);
      t.binding = binding(f); t.chain = chain(f); t.cookie = f.cookie;
    } finally { cleanupTransaction(t, frame); t.frame = null; }
    const facade = Object.freeze({ invalidate() {
      return exposed(() => {
        if (this !== facade || arguments.length !== 0) invalidCall();
        revoke(t);
        if (frames.size) poisonActiveTarget();
      });
    }, close() {
      return exposed(() => {
        if (this !== facade || arguments.length !== 0) invalidCall();
        if (frames.size) {
          revoke(t);
          throw poisonActiveTarget();
        }
        if (t.closed) return;
        revoke(t);
        closeOwned(t);
      });
    } });
    targets.set(facade, t);
    return facade;
  } catch (error) {
    let result = safe(error);
    for (const frame of frames) poison(frame, result);
    if (t?.db) {
      revoke(t);
      try { closeOwned(t); }
      catch { result = failure('DURABILITY_UNCERTAIN'); }
    }
    throw outward(result);
  }
}

function invoke(a, receiver, expected, args, capture, operation) {
  admitPublicCall();
  if (receiver !== expected || args.length !== 2) invalidCall();
  const t = a.target;
  if (t.invalid || t.closed) fail('TARGET_STALE');
  const frame = { transaction: false, fault: null, budget: budget(a.limits) };
  t.frame = frame;
  frames.add(frame);
  let result, error, success;
  try {
    const input = capture(args[0], frame.budget); // snapshot BEFORE first callback
    admin(a, frame, args[1]);
    result = operation(a, frame, input, args[1]);
    guard(t, frame);
    frame.budget.tick();
    success = true;
  } catch (caught) {
    const classified = safe(caught);
    error = errorCodes.get(classified) === 'DURABILITY_UNCERTAIN' ? classified : frame.fault ?? classified;
  }
  finally {
    try { cleanupTransaction(t, frame); }
    catch { t.uncertain = true; revoke(t); error = failure('DURABILITY_UNCERTAIN'); success = false; }
    if (success) {
      try { frame.budget.tick(); }
      catch (caught) { error = safe(caught); success = false; }
    }
    // Keep the frame live throughout cleanup. Caught reentry and invalidation
    // must still defeat success after the last cleanup/native response.
    if (t.uncertain) { error = failure('DURABILITY_UNCERTAIN'); success = false; }
    else if (frame.fault || t.invalid) {
      if (errorCodes.get(error) !== 'DURABILITY_UNCERTAIN') error = frame.fault ?? error ?? failure('TARGET_STALE');
      success = false;
    }
    t.frame = null;
    frames.delete(frame);
  }
  if (!success) throw error;
  // Deferred private registration/installation only after all cleanup succeeds.
  result.finish?.();
  return result.value;
}
function empty(input) { return shape(input, []); }
function approvalInput(input, account) {
  const value = shape(input, ['proposal', 'proposalHash', 'approvalRef']);
  if (typeof value.proposalHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.proposalHash) || !ref(value.approvalRef)) fail('INVALID');
  const proposal = codec('timeProposal', value.proposal, account);
  if (proposal.hash !== value.proposalHash) fail('FACT_MISMATCH');
  return { proposal: proposal.value, bytes: proposal.bytes, proposalHash: proposal.hash, approvalRef: value.approvalRef };
}
export function createMaintenanceTimeAuthority(options) {
  try {
    admitPublicCall();
    if (arguments.length !== 1) invalidCall();
    const input = shape(options, ['target', 'authority', 'approvalAuthority', 'executorId', 'limits']);
    const t = targets.get(input.target);
    if (!t) fail('INVALID');
    if (t.invalid || t.closed) fail('TARGET_STALE');
    if (t.authority) fail('INVALID');
    const bounds = limits(input.limits, { ...NINE, ...t.limits });
    if (!ref(input.executorId)) fail('INVALID');
    const a = { target: t, limits: bounds, executorId: input.executorId,
      admin: adapter(input.authority, ['authorizeAdmin']),
      approval: adapter(input.approvalAuthority, ['resolveApproval', 'authorizeApproval']),
      generation: randomUUID(), pending: null, session: null, highwater: null, lastMono: null };
    const facade = Object.freeze({ previewMaintenanceTimeAnchor(input, ctx) {
      return exposed(() => invoke(a, this, facade, arguments, empty, preview));
    }, approveMaintenanceTimeAnchor(input, ctx) {
      return exposed(() => invoke(a, this, facade, arguments, approvalInput, approve));
    }, getMaintenanceTimeStatus(input, ctx) {
      return exposed(() => invoke(a, this, facade, arguments, empty, status));
    } });
    authorities.set(facade, a);
    t.authority = a;
    return facade;
  } catch (error) {
    const result = safe(error, 'INVALID');
    for (const frame of frames) poison(frame, result);
    throw outward(result);
  }
}

function wall() { const value = wallNow(); if (!nonnegative(value)) fail('CLOCK_UNSAFE'); return value; }
function mono() { const value = monoNow(); if (typeof value !== 'bigint' || value < 0n) fail('CLOCK_UNSAFE'); return value; }
function add(a, b) { if (!nonnegative(a) || !nonnegative(b) || a > MAX - b) fail('CLOCK_UNSAFE'); return a + b; }
function minimum(a, f) { return Math.max(f.floor, f.instanceCreatedAt, f.tipWall ?? 0, a.highwater ?? 0); }
function observe(a, now, ns) {
  const safeMono = a.lastMono === null || ns >= a.lastMono;
  const safeWall = a.highwater === null || now >= a.highwater;
  a.highwater = Math.max(a.highwater ?? 0, now);
  if (a.lastMono === null || ns > a.lastMono) a.lastMono = ns;
  return safeMono && safeWall;
}
function preview(a, frame, input, ctx) {
  const t = a.target;
  begin(t, frame);
  const f = facts(t, frame);
  const at = wall();
  if (at < minimum(a, f)) fail('CLOCK_UNSAFE');
  const origin = mono();
  if (a.lastMono !== null && origin < a.lastMono) fail('CLOCK_UNSAFE');
  const encoded = codec('timeProposal', { version: 1, instanceId: f.instanceId, instanceCreatedAt: f.instanceCreatedAt,
    centerEpoch: f.centerEpoch, previousGeneration: f.tipGeneration, previousAnchorHash: f.tipHash,
    sessionNonce: randomUUID(), proposedAt: at, proposalExpiresAt: add(at, a.limits.proposalTtlMs),
    candidateWallAt: at, acceptNotBefore: at, acceptNotAfter: add(at, a.limits.acceptanceWindowMs),
    globalFloorObservedAt: f.floor, maxForwardJumpMs: a.limits.maxForwardJumpMs }, frame.budget);
  admin(a, frame, ctx);
  const final = fixedFacts(t, frame, f);
  if (final.floor !== f.floor || binding(final) !== binding(f) || chain(final) !== chain(f)) fail('FACT_MISMATCH');
  endRead(t, frame);
  const pending = { bytes: encoded.bytes, hash: encoded.hash, generation: a.generation,
    binding: binding(f), chain: chain(f), headGeneration: f.headGeneration, headHash: f.headHash, mono: origin };
  return { value: Object.freeze({ proposal: encoded.value, proposalHash: encoded.hash }), finish() { a.pending = pending; } };
}
function session(a, f) {
  const s = a.session;
  return s && s.generation === a.generation && s.binding === binding(f) &&
    s.anchor.generation === f.headGeneration && s.hash === f.headHash ? s : null;
}
function status(a, frame, input, ctx) {
  begin(a.target, frame);
  const f = facts(a.target, frame), present = !!session(a, f);
  const value = Object.freeze({ version: 1, instanceId: f.instanceId, instanceCreatedAt: f.instanceCreatedAt,
    centerEpoch: f.centerEpoch, headGeneration: f.headGeneration, headHash: f.headHash,
    sessionPresent: present, reason: present ? null : f.headGeneration === null ? 'TIME_ANCHOR_REQUIRED' : 'PROCESS_REANCHOR_REQUIRED' });
  admin(a, frame, ctx);
  const final = fixedFacts(a.target, frame, f);
  if (final.floor !== f.floor) fail('FACT_MISMATCH');
  endRead(a.target, frame);
  return { value };
}
function rowProposal(row, f) {
  return { version: 1, instanceId: f.instanceId, instanceCreatedAt: f.instanceCreatedAt, centerEpoch: row.center_epoch,
    previousGeneration: row.previous_generation, previousAnchorHash: row.previous_anchor_hash, sessionNonce: row.session_nonce,
    proposedAt: row.proposed_at, proposalExpiresAt: row.proposal_expires_at, candidateWallAt: row.candidate_wall_at,
    acceptNotBefore: row.accept_not_before, acceptNotAfter: row.accept_not_after,
    globalFloorObservedAt: row.global_floor_observed_at, maxForwardJumpMs: row.max_forward_jump_ms };
}
function evidence(proposal, extra, account) {
  const all = { ...proposal, ...extra };
  return codec('anchorEvidence', Object.fromEntries(ANCHOR.map(key => [key, all[key]])), account);
}
function replay(a, frame, input, f) {
  // Full validation/projected metadata already bounds the retained row. Charge
  // its additional retrieval before allocation and reconstruct exact bytes.
  const size = get(a.target, frame, `SELECT length(CAST(approval_ref AS BLOB))+length(CAST(executor_id AS BLOB))+
    length(CAST(approver_id AS BLOB)) AS bytes FROM im_maintenance_time_anchors WHERE proposal_hash=?`, input.proposalHash);
  if (!size) return null;
  frame.budget.reserve(size.bytes * 6 + 4096);
  const row = get(a.target, frame, 'SELECT * FROM im_maintenance_time_anchors WHERE proposal_hash=?', input.proposalHash);
  const p = codec('timeProposal', rowProposal(row, f), frame.budget);
  if (!p.bytes.equals(input.bytes) || p.hash !== input.proposalHash || row.executor_id !== a.executorId ||
      row.approval_ref !== input.approvalRef || !ref(row.approver_id) || row.approver_id === a.executorId) fail('FACT_MISMATCH');
  const anchor = evidence(p.value, { generation: row.generation, proposalHash: row.proposal_hash,
    acceptedWallAt: row.accepted_wall_at, globalFloorAtApproval: row.global_floor_at_approval,
    approvalRef: row.approval_ref, executorId: row.executor_id, approverId: row.approver_id }, frame.budget);
  if (anchor.hash !== row.anchor_hash) fail('FACT_MISMATCH');
  return anchor;
}
function pending(a, input, f) {
  const p = a.pending;
  if (!p || p.generation !== a.generation || p.hash !== input.proposalHash || !p.bytes.equals(input.bytes) ||
      p.binding !== binding(f) || p.chain !== chain(f)) fail('FACT_MISMATCH');
  return p;
}
function approvalBinding(a, input, registered) {
  const p = input.proposal;
  return Object.freeze({ kind: 'maintenance-time-anchor', proposalHash: input.proposalHash, approvalRef: input.approvalRef,
    instanceId: p.instanceId, instanceCreatedAt: p.instanceCreatedAt, centerEpoch: p.centerEpoch,
    previousGeneration: p.previousGeneration, previousAnchorHash: p.previousAnchorHash,
    headGeneration: registered.headGeneration, headHash: registered.headHash, sessionNonce: p.sessionNonce,
    proposedAt: p.proposedAt, proposalExpiresAt: p.proposalExpiresAt, candidateWallAt: p.candidateWallAt,
    acceptNotBefore: p.acceptNotBefore, acceptNotAfter: p.acceptNotAfter, globalFloorObservedAt: p.globalFloorObservedAt,
    maxForwardJumpMs: p.maxForwardJumpMs, executorId: a.executorId });
}
function acceptTime(a, registered, p, f) {
  const at = wall();
  const low = minimum(a, f);
  let ns;
  try { ns = mono(); }
  catch (error) { a.highwater = Math.max(a.highwater ?? 0, at); throw error; }
  const safeObservation = observe(a, at, ns); // retain rejected observations conservatively
  if (!safeObservation || at < low || at < p.acceptNotBefore || at > p.acceptNotAfter || at >= p.proposalExpiresAt ||
      ns < registered.mono || ns - registered.mono >= BigInt(a.limits.proposalTtlMs) * NS || f.floor < p.globalFloorObservedAt) fail('CLOCK_UNSAFE');
  return { at, ns };
}
function newCapacity(a, frame, input, approverId, f) {
  const count = get(a.target, frame, 'SELECT count(*) AS n FROM (SELECT 1 FROM im_maintenance_time_anchors LIMIT ?)', a.limits.maxMaintenanceAnchors + 1).n;
  if (!nonnegative(count) || count >= a.limits.maxMaintenanceAnchors) fail('READ_UNAVAILABLE');
  // Same evidence projection as v5, plus canonical framing and new head. Bound
  // encoding before allocation, then project exact canonical lengths using the
  // largest admissible accepted wall (no authority time observation here).
  const p = input.proposal;
  if (f.floor > Math.min(p.acceptNotAfter, p.proposalExpiresAt - 1)) fail('CLOCK_UNSAFE');
  const textBytes = [p.centerEpoch, p.previousAnchorHash, input.proposalHash, '0'.repeat(64), p.sessionNonce,
    input.approvalRef, a.executorId, approverId].reduce((n, value) => n + (value === null ? 0 : Buffer.byteLength(value)),
  approverId === null ? 255 * 3 : 0);
  const projection = textBytes * 12 + 4096 + 512;
  frame.budget.capacity(projection + 4096 + textBytes * 6);
  if (approverId === null) return;
  const template = evidence(p, { generation: f.tipGeneration === null ? 1 : add(f.tipGeneration, 1),
    proposalHash: input.proposalHash, acceptedWallAt: Math.min(p.acceptNotAfter, p.proposalExpiresAt - 1),
    globalFloorAtApproval: f.floor, approvalRef: input.approvalRef, executorId: a.executorId, approverId });
  frame.budget.capacity(projection + input.bytes.length + template.bytes.length);
}
function anchorRow(anchor, hash) {
  const row = { anchor_hash: hash };
  for (const [key, value] of Object.entries(anchor)) row[key.replace(/[A-Z]/g, c => '_' + c.toLowerCase())] = value;
  return ANCHOR_COLUMNS.map(key => row[key]);
}
function envelope(encoded, replayed, sessionEstablished) {
  return Object.freeze({ anchor: encoded.value, anchorHash: encoded.hash, replayed, sessionEstablished });
}
function approve(a, frame, input, ctx) {
  const t = a.target;
  begin(t, frame);
  let f = facts(t, frame);
  const stored = replay(a, frame, input, f);
  if (stored) {
    admin(a, frame, ctx);
    fixedFacts(t, frame, f);
    endRead(t, frame);
    return { value: envelope(stored, true, false) };
  }
  pending(a, input, f);
  endRead(t, frame);
  begin(t, frame, true);
  f = facts(t, frame);
  const registered = pending(a, input, f), p = input.proposal;
  if (f.floor < p.globalFloorObservedAt) fail('CLOCK_UNSAFE');
  if (f.tipGeneration === MAX) fail('CLOCK_UNSAFE');
  const generation = f.tipGeneration === null ? 1 : f.tipGeneration + 1;
  // Capacity must be available before asking a resolver for a new approval.
  // The real actor is reprojected below; this bounds its maximum UTF-8 size.
  newCapacity(a, frame, input, null, f);
  admin(a, frame, ctx);
  const bindingRecord = approvalBinding(a, input, registered);
  let resolved;
  try {
    resolved = shape(callback(a, frame, a.approval, a.approval.resolveApproval,
      [bindingRecord, ctx], 'APPROVAL_DENIED'), ['approverId']);
  } catch (error) { throw poison(frame, safe(error, 'APPROVAL_DENIED')); }
  if (!ref(resolved.approverId) || resolved.approverId === a.executorId) fail('APPROVAL_DENIED');
  const approved = Object.freeze({ ...bindingRecord, approverId: resolved.approverId });
  approval(a, frame, approved, ctx);
  acceptTime(a, registered, p, f);
  newCapacity(a, frame, input, approved.approverId, f);
  const final = facts(t, frame);
  pending(a, input, final);
  if (final.floor < f.floor) fail('CLOCK_UNSAFE');
  f = final;
  newCapacity(a, frame, input, approved.approverId, f);
  admin(a, frame, ctx);
  approval(a, frame, approved, ctx);
  const afterCallbacks = fixedFacts(t, frame, f);
  pending(a, input, afterCallbacks);
  if (afterCallbacks.floor < f.floor) fail('CLOCK_UNSAFE');
  f = afterCallbacks;
  newCapacity(a, frame, input, approved.approverId, f);
  guard(t, frame); fileGate(t); frame.budget.tick();
  // Callback-free final interval. No authority time resampling after this pair.
  const accepted = acceptTime(a, registered, p, f);
  const encoded = evidence(p, { generation, proposalHash: input.proposalHash, acceptedWallAt: accepted.at,
    globalFloorAtApproval: f.floor, approvalRef: input.approvalRef, executorId: a.executorId,
    approverId: approved.approverId }, frame.budget);
  const values = anchorRow(encoded.value, encoded.hash);
  frame.budget.tick(); guard(t, frame);
  statement(t, `INSERT INTO im_maintenance_time_anchors (${ANCHOR_COLUMNS.join(',')}) VALUES (${ANCHOR_COLUMNS.map(() => '?').join(',')})`).run(...values);
  frame.budget.tick(); guard(t, frame);
  statement(t, `INSERT INTO im_maintenance_time_head(singleton,center_epoch,generation,anchor_hash) VALUES (1,?,?,?)
    ON CONFLICT(singleton) DO UPDATE SET center_epoch=excluded.center_epoch,generation=excluded.generation,anchor_hash=excluded.anchor_hash`).run(f.centerEpoch, generation, encoded.hash);
  frame.budget.tick(); guard(t, frame);
  const update = statement(t, 'UPDATE im_clock SET last_observed_at=? WHERE singleton=1').run(accepted.at);
  if (update.changes !== 1) fail('FACT_MISMATCH');
  frame.budget.tick(); guard(t, frame);
  const expectedChain = JSON.stringify([generation, encoded.hash, generation, encoded.hash]);
  let acknowledged = false;
  try { exec(t, 'COMMIT'); acknowledged = true; }
  catch {
    let active;
    try { active = nativeState(t, 'transaction'); }
    catch {
      let closed = false;
      try { closed = nativeState(t, 'open') === false; } catch { /* unresolved */ }
      if (!closed) { a.session = null; a.pending = null; t.uncertain = true; revoke(t); fail('DURABILITY_UNCERTAIN'); }
      active = false;
    }
    if (active) {
      cleanupTransaction(t, frame);
      fail('READ_UNAVAILABLE');
    }
    // Transaction ended: never roll back a committed writer. Resolve closure
    // before opening a replacement under retained ownership and the SAME budget.
    // A throwing close is success only when the native open getter says false.
    frame.transaction = false;
    a.session = null; a.pending = null;
    try {
      closeOwned(t, false);
      frame.budget.tick();
      openConnection(t);
      begin(t, frame);
      const actual = facts(t, frame, expectedChain);
      const proof = replay(a, frame, input, actual);
      if (!proof || proof.hash !== encoded.hash || actual.floor !== accepted.at || !proof.bytes.equals(encoded.bytes)) fail('FACT_MISMATCH');
      endRead(t, frame);
      t.chain = expectedChain;
    } catch {
      t.uncertain = true; revoke(t); fail('DURABILITY_UNCERTAIN');
    }
  }
  if (acknowledged) {
    // Revoke previous private authority as soon as commit is acknowledged, even
    // if subsequent noncallback cleanup cannot establish the replacement.
    frame.transaction = false;
    a.session = null; a.pending = null;
    t.chain = expectedChain;
  }
  guard(t, frame); fileGate(t); frame.budget.tick();
  return { value: envelope(encoded, false, acknowledged), finish() {
    if (acknowledged) a.session = { generation: a.generation, binding: binding(f), anchor: encoded.value,
      hash: encoded.hash, mono: accepted.ns, elapsed: 0n };
  } };
}

function check(a, frame, input, ctx) {
  begin(a.target, frame);
  let f = facts(a.target, frame);
  // Complete authorization before observations; status/replay never enter here.
  admin(a, frame, ctx);
  f = fixedFacts(a.target, frame, f);
  const s = session(a, f);
  const at = wall();
  let ns;
  try { ns = mono(); }
  catch (error) { a.highwater = Math.max(a.highwater ?? 0, at); throw error; }
  let unsafe = at < minimum(a, f), elapsed = null;
  const observationSafe = observe(a, at, ns);
  if (s) {
    const elapsedNs = ns - s.mono;
    if (elapsedNs < 0n) fail('CLOCK_UNSAFE'); // cannot project a nonnegative DTO
    const projected = BigInt(s.anchor.acceptedWallAt) * NS + elapsedNs;
    const reported = elapsedNs / NS;
    if (projected < 0n || projected > MAX_NS || reported > BigInt(MAX)) fail('CLOCK_UNSAFE');
    const delta = BigInt(at) * NS - projected;
    if ((delta < 0n ? -delta : delta) > BigInt(s.anchor.maxForwardJumpMs) * NS || elapsedNs < s.elapsed) unsafe = true;
    elapsed = Number(reported);
    if (elapsedNs > s.elapsed) s.elapsed = elapsedNs;
  }
  if (!observationSafe) unsafe = true;
  const reason = unsafe ? 'CLOCK_UNSAFE' : f.headGeneration === null ? 'TIME_ANCHOR_REQUIRED' : !s ? 'PROCESS_REANCHOR_REQUIRED' : null;
  const value = Object.freeze({ version: 1, schemaVersion: 5, observedWallAt: at, globalFloorObservedAt: f.floor,
    anchorGeneration: f.headGeneration, anchorHash: f.headHash, sessionNonce: s?.anchor.sessionNonce ?? null,
    anchorWallAt: f.headGeneration === null ? null : f.tipWall, monotonicElapsedMs: elapsed,
    maxForwardJumpMs: s?.anchor.maxForwardJumpMs ?? a.limits.maxForwardJumpMs, executable: reason === null, reason });
  endRead(a.target, frame);
  return { value };
}
export function checkMaintenanceTimeSession(timeAuthority, input, ctx) {
  return exposed(() => {
    admitPublicCall();
    if (arguments.length !== 3) invalidCall();
    const a = authorities.get(timeAuthority);
    if (!a) invalidCall();
    return invoke(a, timeAuthority, timeAuthority, [input, ctx], empty, check);
  });
}
