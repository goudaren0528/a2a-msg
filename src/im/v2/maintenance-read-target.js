import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { types } from 'node:util';
import { createHash } from 'node:crypto';
import { V4_DDL, V4_CHECKSUM } from './schema-internal.js';
import { V3_CHECKSUM } from './schema-history.js';
import { parseImV2Config } from './config.js';

/* Internal, synchronous P6-A composition only. Call ONLY after admin authorization.
 * The owner opened db at databasePath under replacement/rename exclusion and keeps
 * that exclusion (including other users/writers, close/reopen and schema changes)
 * until invalidate(), BEFORE releasing ownership/closing. Metadata and SQLite's
 * pathname cannot prove the inode originally opened by an arbitrary borrowed db.
 * No same-process JavaScript sandbox, live-reader lease or authorization is minted.
 * No writes/opens/close/fsync; OS atime is explicitly outside the zero-write claim.
 *
 * Trusted planner ledger contract (one ledger, timer started before this scope):
 *   config: detached full v2 configuration, including explicit enabled/writeMode;
 *   limits: {maxScanRows:1..10000,maxScanBytes:1..104857600,maxScanMs:1..1000};
 *   check(): null | 'SCAN_TIME' (invalid monotonic time must throw);
 *   reserve(rows,bytes): opaque ticket | 'SCAN_ROWS' | 'SCAN_BYTES' | 'SCAN_TIME';
 *   settle(ticket,actualRows,actualBytes): void, releases unused reservation.
 * reserve MUST atomically exclude held capacity, without counting it as consumed.
 * settle MUST account consumed work, including failed reads; no throwing adapters.
 * The planner uses this SAME ledger for hashes/framing/serialization and reads.
 * Limits may only be lowered from validated config. A JSON object isn't authority.
 *
 * consume(session,ledger) receives frozen identity and fixed reads below. It owns
 * final admin/config reauthorization and wall/policy-effective-time validation.
 * Reads return frozen {complete:true,value} OR {complete:false,stopReason:'SCAN_*'}.
 * Exhaustion is NOT a read fault; consume may return an incomplete prefix. Trust
 * exhaustion (including time at final checks) is READ_UNAVAILABLE, never a prefix.
 * Final checks have reserved row/byte capacity; time cannot be reserved.
 * projectX(key) -> opaque frozen projection with present, lengths, types. A
 * successful readProjected(projection) consumes that token once, returning a row
 * (or null). Text is retrieved as bytes and decoded fatally; BLOB is a detached
 * Uint8Array. No SQL/table/path/executor/db handle escapes. One payload per read;
 * the trusted planner must hash/release it before requesting the next payload.
 * Metadata projection and retrieval each charge one source-row/probe unit.
 * Session/SQL faults latch BEFORE examining thrown values; caught faults, expired
 * sessions used in a later scope and reentry poison the current scope as well.
 */

const targets = new WeakMap();
const connections = new WeakMap();
const localErrors = new WeakSet();
const nativePrepare = DatabaseSync.prototype.prepare;
const nativeExec = DatabaseSync.prototype.exec;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const nonnegative = n => Number.isSafeInteger(n) && n >= 0;
const uuid = s => typeof s === 'string' && UUID.test(s);
const hash = s => typeof s === 'string' && HASH.test(s);
const ref = s => typeof s === 'string' && s.length > 0 && s.length <= 255;
const sha = s => createHash('sha256').update(s).digest('hex');
const normalize = sql => sql.trim().replace(/\s+/g, ' ');
const failure = (suffix = 'READ_UNAVAILABLE') => {
  const error = Object.assign(new Error('Maintenance preview rejected'), { code: `MAINTENANCE_${suffix}` });
  localErrors.add(error);
  return error;
};
const fail = suffix => { throw failure(suffix); };
const safeError = error => localErrors.has(error) ? error : failure();
const freeze = value => {
  if (value && typeof value === 'object' && !(value instanceof Uint8Array)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
};
function ordinary(value, keys) {
  if (!value || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) fail('INVALID');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length || keys.some(k =>
    !descriptors[k] || !('value' in descriptors[k]) || !descriptors[k].enumerable)) fail('INVALID');
}
function synchronous(fn) {
  if (typeof fn !== 'function' || types.isProxy(fn) || types.isAsyncFunction(fn) || types.isGeneratorFunction(fn)) fail('INVALID');
}
function noThenable(value) {
  if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
    // Observe a native rejection without delegating to an overridden .then.
    if (types.isPromise(value)) { Promise.prototype.then.call(value, undefined, () => {}); fail('INVALID'); }
    let then;
    try { then = value.then; } catch { fail('INVALID'); }
    if (typeof then === 'function') {
      // Trusted adapters only. Observe a thenable rejection; never await it.
      try { Reflect.apply(then, value, [() => {}, () => {}]); } catch { /* sanitized below */ }
      fail('INVALID');
    }
  }
  return value;
}

export function createImV2MaintenanceReadTarget(options) {
  try {
    ordinary(options, ['db', 'databasePath']);
    const { db, databasePath } = options;
    if (!db || types.isProxy(db) || !(db instanceof DatabaseSync) || typeof databasePath !== 'string' ||
        !databasePath || databasePath.includes('\0') || !path.isAbsolute(databasePath) || path.normalize(databasePath) !== databasePath) fail('INVALID');
    // Native non-configurable getter is a brand probe, not a query/open. Calling
    // the copied unbound getter on a facade fails the native receiver check.
    const open = Object.getOwnPropertyDescriptor(db, 'isOpen');
    const transaction = Object.getOwnPropertyDescriptor(db, 'isTransaction');
    if (!open?.get || open.configurable || !transaction?.get || transaction.configurable ||
        Function.prototype.toString.call(open.get) !== 'function () { [native code] }' ||
        Function.prototype.toString.call(transaction.get) !== 'function () { [native code] }') fail('INVALID');
    // A getter bound to a real connection and copied onto a fake must also fail.
    // Genuine native accessors reject the unrelated receiver without DB work.
    for (const getter of [open.get, transaction.get]) {
      let rejected = false;
      try { getter.call(Object.create(null)); } catch { rejected = true; }
      if (!rejected) fail('INVALID');
    }
    open.get.call(db); // Closed native objects may register; authorized use rejects them.
    const state = { db, databasePath, open: open.get, transaction: transaction.get,
      invalid: false, busy: null, binding: null };
    const facade = Object.freeze({ invalidate() {
      state.invalid = true;
      if (state.busy) state.busy.fault = failure('TARGET_STALE');
    } });
    targets.set(facade, state);
    return facade;
  } catch (error) { throw localErrors.has(error) ? error : failure('INVALID'); }
}

function protectedFile(state) {
  if (process.platform === 'win32' || typeof process.geteuid !== 'function') fail();
  const uid = process.geteuid();
  const file = state.databasePath;
  const result = [];
  for (let current = file; ; current = path.dirname(current)) {
    const stat = fs.lstatSync(current, { bigint: true });
    const isFile = current === file;
    if (stat.isSymbolicLink() || (isFile ? !stat.isFile() || stat.nlink !== 1n : !stat.isDirectory()) ||
        (stat.uid !== BigInt(uid) && (!isFile && stat.uid !== 0n || isFile)) ||
        (stat.mode & (isFile ? 0o077n : 0o022n)) !== 0n) fail();
    result.push([current, stat.dev.toString(), stat.ino.toString(), stat.uid.toString(), stat.gid.toString(),
      stat.mode.toString(), ...(isFile ? [stat.size.toString(), stat.mtimeNs.toString(), stat.ctimeNs.toString()] : [])]);
    if (path.dirname(current) === current) break;
  }
  if (fs.realpathSync(file) !== file) fail();
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try { fs.lstatSync(file + suffix); } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    fail();
  }
  return JSON.stringify(result);
}

// Cost of the approved F frame. Text is valid UTF-8; numbers are safe integers.
function frame(value) {
  if (value === null) return 2;
  if (Array.isArray(value)) return 2 + String(value.length).length + value.reduce((n, x) => n + frame(x), 0);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return 2 + String(value).length;
  if (typeof value === 'string' || value instanceof Uint8Array) {
    const n = typeof value === 'string' ? Buffer.byteLength(value) : value.byteLength;
    return 2 + String(n).length + n;
  }
  fail('FACT_MISMATCH');
}
const arrayBound = (columns, material = 0) => 2 + String(columns).length + 24 * columns + material;
const STOP = new Set(['SCAN_ROWS', 'SCAN_BYTES', 'SCAN_TIME']);
function accounting(ledger) {
  if (!ledger || typeof ledger !== 'object') fail('INVALID');
  const limits = ledger.limits;
  for (const [key, max] of [['maxScanRows', 10000], ['maxScanBytes', 104857600], ['maxScanMs', 1000]]) {
    if (!limits || !Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > max) fail('POLICY_INVALID');
  }
  for (const key of ['check', 'reserve', 'settle']) synchronous(ledger[key]);
  let rows = 0, bytes = 0;
  let escrow = null;
  function check(trust) {
    let value;
    try { value = noThenable(ledger.check()); } catch { fail('CLOCK_UNSAFE'); }
    if (value !== null && value !== 'SCAN_TIME') fail('CLOCK_UNSAFE');
    if (value && trust) fail();
    return value;
  }
  function reserve(r, b, trust) {
    const timed = check(trust);
    if (timed) return timed;
    if (escrow) {
      if (r > escrow.rows || b > escrow.bytes) fail();
      escrow.rows -= r; escrow.bytes -= b;
      return { escrow: true, r, b };
    }
    const ticket = noThenable(ledger.reserve(r, b));
    if (STOP.has(ticket)) { if (trust) fail(); return ticket; }
    if (!ticket || typeof ticket !== 'object') fail();
    return { ticket, r, b };
  }
  function settle(token, r, b) {
    if (r > token.r || b > token.b) fail();
    rows += r; bytes += b;
    if (token.escrow) {
      escrow.rows += token.r - r; escrow.bytes += token.b - b;
      escrow.usedRows += r; escrow.usedBytes += b;
    } else noThenable(ledger.settle(token.ticket, r, b));
    if (rows > limits.maxScanRows || bytes > limits.maxScanBytes) fail();
  }
  return { check, reserve, settle,
    holdFinal() {
      // Same fixed gates twice (in snapshot and after COMMIT), with a bounded
      // allowance for pragma overhead. Changes requiring more fail closed.
      const r = rows * 2 + 16, b = bytes * 2 + 4096;
      const token = reserve(r, b, true);
      return { token, rows: r, bytes: b, usedRows: 0, usedBytes: 0 };
    },
    useFinal(held) { escrow = held; },
    releaseFinal(held) {
      escrow = null;
      noThenable(ledger.settle(held.token.ticket, held.usedRows, held.usedBytes));
    },
  };
}

const fields = (table, columns, key = 'singleton') => ({ table, columns: columns.split(' '), key });
const TABLE = {
  marker: fields('im_schema', 'version migration_checksum', 'version'),
  identity: fields('im_instance_identity', 'singleton instance_id created_at'),
  settings: fields('im_settings', 'singleton write_mode'),
  clock: fields('im_clock', 'singleton last_observed_at'),
  center: fields('im_center_state', 'singleton center_epoch recovery_counter status activation_ref recovery_run_id updated_at'),
  epoch: fields('im_center_epochs', 'center_epoch created_at origin recovery_counter', 'center_epoch'),
  run: fields('im_recovery_runs', 'run_id candidate_kind preparation_ref backup_id backup_file_hash manifest_hash candidate_base_hash candidate_reference old_epoch new_epoch approved_plan_hash approval_ref isolation_ack_ref rpo_report_json auth_review_ref activation_plan_hash activation_approval_ref status created_at verified_at activated_at activation_ref failure_code', 'run_id'),
  preparation: fields('im_schema_preparations', 'preparation_ref kind input_hash source_version source_schema_checksum import_epoch initial_epoch policy_hash created_at', 'preparation_ref'),
  policy: fields('im_retention_policies', 'policy_hash version effective_at message_retention_ms attachment_retention_ms safe_retry_window_ms audit_retention_ms canonical_json', 'policy_hash'),
  message: fields('im_messages', 'message_id conversation_id sender_id recipient_id client_message_id accepted_at in_reply_to title text correlation', 'message_id'),
  messageDependencies: fields('im_messages', 'message_id conversation_id in_reply_to', 'message_id'),
  content: fields('im_content_state', 'message_id state expires_at expired_at scrubbed_at policy_hash expiry_run_id scrub_run_id', 'message_id'),
  sendKey: fields('im_send_keys', 'sender_id client_message_id payload_hash message_id created_at retry_until status', 'message_id'),
  operation: fields('im_send_operation_keys', 'sender_id origin_epoch client_message_id storage_client_message_id source_protocol message_id', 'message_id'),
  reservation: fields('im_attachment_reservations', 'attachment_id message_id size sha256', 'message_id'),
  attachment: fields('im_attachments', 'attachment_id message_id name mime size sha256 data', 'message_id'),
  delivery: fields('im_deliveries', 'recipient_id seq message_id acked_at read_at', 'message_id'),
  conversation: fields('im_conversations', 'conversation_id agent_low agent_high created_at', 'conversation_id'),
  audit: fields('im_audit', 'id actor_kind actor_id action target_ids_json occurred_at safe_details_json', 'id'),
};
const expected = V4_DDL.map(sql => {
  const [, kind, name] = /^CREATE (TABLE|INDEX) (im_\w+)/.exec(sql);
  return [kind.toLowerCase(), name, kind === 'TABLE' ? name : / ON (im_\w+)/.exec(sql)[1], normalize(sql)];
}).sort((a, b) => a[1].localeCompare(b[1]));
const expectedAutoindexes = [];
for (const [kind, name, , sql] of expected) {
  if (kind !== 'table') continue;
  const count = (sql.match(/\bUNIQUE\b/g) || []).length + (sql.match(/\bPRIMARY KEY\b/g) || []).length -
    (/\bINTEGER (?:NOT NULL )?PRIMARY KEY\b/.test(sql) ? 1 : 0);
  for (let i = 1; i <= count; i++) expectedAutoindexes.push(`index:${name}:sqlite_autoindex_${name}_${i}`);
}
expectedAutoindexes.sort();

function reader(state, account, scope) {
  const projections = new WeakMap();
  function guard() {
    if (!scope.live || state.busy !== scope || state.invalid || scope.fault) {
      const error = scope.fault || failure(state.invalid ? 'TARGET_STALE' : 'READ_UNAVAILABLE');
      const active = state.busy || connections.get(state.db);
      if (active) active.fault = error;
      throw error;
    }
    if (!state.open.call(state.db) || state.transaction.call(state.db) !== scope.inTransaction) fail();
  }
  function query(sql, args, maxRows, maxBytes, trust = true) {
    guard();
    const token = account.reserve(maxRows, maxBytes, trust);
    if (STOP.has(token)) return { stopReason: token };
    let rows, settled = false;
    try {
      const stmt = nativePrepare.call(state.db, sql);
      rows = stmt.all(...args);
      if (rows.length > maxRows) fail();
      const used = rows.reduce((n, row) => n + frame(Object.values(row)), 0);
      account.settle(token, Math.max(1, rows.length), used);
      settled = true;
    } catch (error) {
      // Native failure may have consumed work: conservatively account the whole
      // reservation. Never inspect a provider-thrown object before latching.
      scope.fault = failure();
      if (!settled) account.settle(token, maxRows, maxBytes);
      throw safeError(error);
    }
    const stopReason = account.check(trust);
    return stopReason ? { stopReason } : { rows };
  }
  function project(spec, key, trust, singleton = false) {
    const columns = spec.columns;
    const where = singleton ? '' : ` WHERE ${spec.key}=?`;
    // A singleton probes two rows to reject duplicates/missing singleton facts.
    const maxRows = singleton ? 2 : 1;
    const expressions = columns.flatMap(c => [`typeof(${c}) AS ${c}_type`,
      `CASE WHEN typeof(${c}) IN ('text','blob') THEN length(CAST(${c} AS BLOB)) ELSE 0 END AS ${c}_length`,
      `${c} IS NULL AS ${c}_null`]);
    const result = query(`SELECT ${expressions.join(',')} FROM main.${spec.table}${where} LIMIT ${maxRows}`,
      singleton ? [] : [key], maxRows, maxRows * arrayBound(columns.length * 3, columns.length * 7), trust);
    if (result.stopReason) return result;
    if (singleton && result.rows.length !== 1) fail('SCHEMA_UNSUPPORTED');
    const row = result.rows[0];
    const lengths = {}, kinds = {};
    let bound = arrayBound(columns.length);
    if (row) for (const c of columns) {
      const kind = row[c + '_type'], n = row[c + '_length'];
      if (!['null', 'integer', 'text', 'blob'].includes(kind) || !nonnegative(n) ||
          (kind === 'null') !== (row[c + '_null'] === 1)) fail('FACT_MISMATCH');
      lengths[c] = kind === 'null' ? null : n; kinds[c] = kind;
      bound += n;
      if (!Number.isSafeInteger(bound)) fail();
    }
    const token = freeze({ present: !!row, lengths, types: kinds });
    projections.set(token, { spec, key, singleton, bound, row: !!row, trust });
    return { value: token };
  }
  function material(token) {
    const p = projections.get(token);
    if (!p) fail('INVALID');
    const { spec, key, singleton, bound, trust } = p;
    if (!p.row) { projections.delete(token); return { value: null }; }
    const expressions = spec.columns.map(c => token.types[c] === 'text' ? `CAST(${c} AS BLOB) AS ${c}` : c);
    const result = query(`SELECT ${expressions.join(',')} FROM main.${spec.table}${singleton ? '' : ` WHERE ${spec.key}=?`} LIMIT 1`,
      singleton ? [] : [key], 1, bound, trust);
    if (result.stopReason) return result;
    projections.delete(token);
    const row = result.rows[0];
    if (!row) fail('FACT_MISMATCH');
    for (const c of spec.columns) {
      if (token.types[c] === 'text') {
        if (!(row[c] instanceof Uint8Array) || row[c].byteLength !== token.lengths[c]) fail('FACT_MISMATCH');
        row[c] = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(row[c]);
      } else if (token.types[c] === 'blob') {
        if (!(row[c] instanceof Uint8Array) || row[c].byteLength !== token.lengths[c]) fail('FACT_MISMATCH');
      } else if (token.types[c] === 'integer' ? !Number.isSafeInteger(row[c]) : row[c] !== null) fail('FACT_MISMATCH');
    }
    return { value: freeze(row) };
  }
  function point(spec, key, singleton = false) {
    return material(project(spec, key, true, singleton).value).value;
  }
  function schema() {
    // Bound identifiers BEFORE materializing them, including unexpected objects.
    // sql=NULL autoindexes are checked explicitly below, not ignored by prefix.
    const cap = expected.length + expectedAutoindexes.length + 1;
    const sizes = query(`SELECT rowid, length(CAST(type AS BLOB)) AS t, length(CAST(name AS BLOB)) AS n,
      length(CAST(tbl_name AS BLOB)) AS b, length(CAST(sql AS BLOB)) AS s FROM main.sqlite_schema ORDER BY rowid LIMIT ${cap}`,
    [], cap, cap * arrayBound(5)).rows;
    if (sizes.length === cap) fail('SCHEMA_UNSUPPORTED');
    const manifest = [], auto = [];
    for (const size of sizes) {
      if (!nonnegative(size.t) || size.t > 8 || !nonnegative(size.n) || size.n > 255 ||
          !nonnegative(size.b) || size.b > 255 || size.s !== null && !nonnegative(size.s)) fail('SCHEMA_UNSUPPORTED');
      const row = query('SELECT type,name,tbl_name FROM main.sqlite_schema WHERE rowid=? LIMIT 1', [size.rowid], 1,
        arrayBound(3, size.t + size.n + size.b)).rows[0];
      if (!row) fail('SCHEMA_UNSUPPORTED');
      if (size.s === null) { auto.push(row); continue; }
      const sql = query('SELECT CAST(sql AS BLOB) AS sql FROM main.sqlite_schema WHERE rowid=? LIMIT 1',
        [size.rowid], 1, arrayBound(1, size.s)).rows[0]?.sql;
      if (!(sql instanceof Uint8Array) || sql.length !== size.s) fail('SCHEMA_UNSUPPORTED');
      manifest.push([row.type, row.name, row.tbl_name, normalize(new TextDecoder('utf-8', { fatal: true }).decode(sql))]);
    }
    if (JSON.stringify(manifest.sort((a, b) => a[1].localeCompare(b[1]))) !== JSON.stringify(expected)) fail('SCHEMA_UNSUPPORTED');
    // Exact autoindex set is derivable from each frozen table's PRIMARY KEY and
    // UNIQUE clauses (INTEGER PRIMARY KEY aliases the rowid, so has no index).
    if (JSON.stringify(auto.map(r => `${r.type}:${r.tbl_name}:${r.name}`).sort()) !== JSON.stringify(expectedAutoindexes)) fail('SCHEMA_UNSUPPORTED');
    const marker = point(TABLE.marker, null, true);
    if (marker.version !== 4 || marker.migration_checksum !== V4_CHECKSUM) fail('SCHEMA_UNSUPPORTED');
  }
  function pragma(name, column) {
    return query(`PRAGMA main.${name}`, [], 1, arrayBound(1, 16)).rows[0]?.[column];
  }
  return { guard, query, project, material, point, schema, pragma };
}

function policyRecord(row) {
  if (!row || !hash(row.policy_hash)) fail('POLICY_INVALID');
  let p;
  try { p = JSON.parse(row.canonical_json); } catch { fail('POLICY_INVALID'); }
  const keys = ['version', 'effectiveAt', 'messageRetentionMs', 'attachmentRetentionMs', 'safeRetryWindowMs',
    'auditRetentionMs', 'keyReservation', 'expiryEnabled', 'purgeEnabled', 'backupCleanupEnabled', 'backupRetentionMs'];
  if (!p || JSON.stringify(p) !== row.canonical_json || Object.keys(p).join() !== keys.join() ||
      sha(row.canonical_json) !== row.policy_hash || p.version !== 2 || p.keyReservation !== 'indefinite' ||
      !['expiryEnabled', 'purgeEnabled', 'backupCleanupEnabled'].every(k => typeof p[k] === 'boolean') ||
      p.purgeEnabled && !p.expiryEnabled || p.backupCleanupEnabled && p.backupRetentionMs === null ||
      p.backupRetentionMs !== null && (!nonnegative(p.backupRetentionMs) || p.backupRetentionMs === 0)) fail('POLICY_INVALID');
  for (const [a, b, value] of [['version', 'version', 2], ['effective_at', 'effectiveAt', p.effectiveAt],
    ['message_retention_ms', 'messageRetentionMs', 7776000000], ['attachment_retention_ms', 'attachmentRetentionMs', 7776000000],
    ['safe_retry_window_ms', 'safeRetryWindowMs', 604800000], ['audit_retention_ms', 'auditRetentionMs', 15552000000]]) {
    if (!nonnegative(p[b]) || p[b] !== value || row[a] !== value) fail('POLICY_INVALID');
  }
  return p;
}

function trust(read, config) {
  read.schema();
  const identity = read.point(TABLE.identity, null, true);
  const center = read.point(TABLE.center, null, true);
  const settings = read.point(TABLE.settings, null, true);
  const clock = read.point(TABLE.clock, null, true);
  if (identity.singleton !== 1 || !uuid(identity.instance_id) || !nonnegative(identity.created_at)) fail('TARGET_STALE');
  if (clock.singleton !== 1 || !nonnegative(clock.last_observed_at)) fail('CLOCK_UNSAFE');
  if (settings.singleton !== 1 || !['paused', 'enabled'].includes(settings.write_mode)) fail();
  if (center.status !== 'active') fail('DISABLED');
  if (center.singleton !== 1 || !uuid(center.center_epoch) || !nonnegative(center.recovery_counter) ||
      !ref(center.activation_ref) || !ref(center.recovery_run_id) || !nonnegative(center.updated_at)) fail();
  const epoch = read.point(TABLE.epoch, center.center_epoch);
  const run = read.point(TABLE.run, center.recovery_run_id);
  if (!epoch || !nonnegative(epoch.created_at) || epoch.recovery_counter !== center.recovery_counter || !run ||
      run.status !== 'active' || run.new_epoch !== center.center_epoch || run.activation_ref !== center.activation_ref ||
      !ref(run.auth_review_ref) || !ref(run.activation_approval_ref) || !hash(run.activation_plan_hash) ||
      !hash(run.approved_plan_hash) || !ref(run.approval_ref) || !ref(run.candidate_reference) ||
      !nonnegative(run.created_at) || !nonnegative(run.verified_at) || !nonnegative(run.activated_at) ||
      run.created_at > run.verified_at || run.verified_at > run.activated_at || run.failure_code !== null) fail();
  let preparation = null, historical = null, old = null, imported = null;
  if (['fresh_bootstrap', 'v3_import'].includes(run.candidate_kind)) {
    preparation = ref(run.preparation_ref) && read.point(TABLE.preparation, run.preparation_ref);
    if (!preparation || preparation.kind !== (run.candidate_kind === 'fresh_bootstrap' ? 'fresh' : 'v3_import') ||
        preparation.initial_epoch !== center.center_epoch || !nonnegative(preparation.created_at) ||
        epoch.origin !== preparation.kind || epoch.recovery_counter !== 0 || run.old_epoch !== null) fail();
    historical = policyRecord(read.point(TABLE.policy, preparation.policy_hash));
    if (sha(JSON.stringify([preparation.kind, preparation.source_version, preparation.source_schema_checksum,
      historical, preparation.preparation_ref])) !== preparation.input_hash) fail();
    if (preparation.kind === 'fresh') {
      if (preparation.source_version !== null || preparation.source_schema_checksum !== null || preparation.import_epoch !== null ||
          [run.backup_id, run.backup_file_hash, run.manifest_hash, run.candidate_base_hash, run.isolation_ack_ref, run.rpo_report_json].some(x => x !== null)) fail();
    } else {
      imported = uuid(preparation.import_epoch) && read.point(TABLE.epoch, preparation.import_epoch);
      if (preparation.source_version !== 3 || preparation.source_schema_checksum !== V3_CHECKSUM ||
          !imported || imported.origin !== 'v3_import' || imported.recovery_counter !== 0 ||
          !nonnegative(imported.created_at) || preparation.import_epoch === center.center_epoch ||
          !ref(run.isolation_ack_ref) || typeof run.rpo_report_json !== 'string') fail();
      if (run.backup_id === null ? [run.backup_file_hash, run.manifest_hash, run.candidate_base_hash].some(x => x !== null) :
        !uuid(run.backup_id) || !hash(run.backup_file_hash) || !hash(run.manifest_hash) || run.candidate_base_hash !== run.backup_file_hash) fail();
    }
  } else if (run.candidate_kind === 'snapshot_recovery') {
    old = uuid(run.old_epoch) && read.point(TABLE.epoch, run.old_epoch);
    if (run.preparation_ref !== null || !old || old.center_epoch === center.center_epoch ||
        !['fresh', 'v3_import', 'recovery'].includes(old.origin) || !nonnegative(old.created_at) ||
        !nonnegative(old.recovery_counter) || epoch.origin !== 'recovery' || epoch.recovery_counter <= old.recovery_counter ||
        !uuid(run.backup_id) || ![run.backup_file_hash, run.manifest_hash, run.candidate_base_hash].every(hash) ||
        !ref(run.isolation_ack_ref) || typeof run.rpo_report_json !== 'string') fail();
  } else fail();
  if (run.rpo_report_json !== null) { try { JSON.parse(run.rpo_report_json); } catch { fail(); } }
  const policy = read.point(TABLE.policy, config.retention.policyHash);
  policyRecord(policy);
  if (policy.canonical_json !== JSON.stringify(config.retention.policy)) fail('POLICY_INVALID');
  return { identity, center, settings, clock, epoch, run, preparation, historical, imported, old, policy };
}

function sessionFor(state, scope, read, evidence) {
  function operation(fn) {
    return (...args) => {
      try {
        read.guard();
        const result = fn(...args);
        return freeze(result.stopReason ? { complete: false, stopReason: result.stopReason } : { complete: true, value: result.value });
      } catch (error) {
        scope.fault = failure(); // latch before touching an arbitrary thrown object
        scope.fault = safeError(error);
        const active = state.busy || connections.get(state.db);
        if (active) active.fault = scope.fault;
        throw scope.fault;
      }
    };
  }
  const identity = freeze({ instanceId: evidence.identity.instance_id, instanceCreatedAt: evidence.identity.created_at,
    centerEpoch: evidence.center.center_epoch, globalFloorObservedAt: evidence.clock.last_observed_at,
    executionPolicyHash: evidence.policy.policy_hash, writeMode: evidence.settings.write_mode });
  const session = {
    get identity() {
      try { read.guard(); return identity; }
      catch (error) {
        scope.fault = failure(); scope.fault = safeError(error);
        const active = state.busy || connections.get(state.db);
        if (active) active.fault = scope.fault;
        throw scope.fault;
      }
    },
    readProjected: operation(token => read.material(token)),
    // Fixed epoch PK lookup for historical operation provenance; unlike identity,
    // this may describe an epoch other than the currently active center epoch.
    projectEpoch: operation(epochUuid => {
      if (!uuid(epochUuid)) fail('INVALID');
      return read.project(TABLE.epoch, epochUuid, false);
    }),
    projectMessageDependencies: operation(messageId => {
      if (!uuid(messageId)) fail('INVALID');
      return read.project(TABLE.messageDependencies, messageId, false);
    }),
    nextContent: operation((kind, through, after = null) => {
      if (!['expire', 'scrub'].includes(kind) || !nonnegative(through) || after !== null &&
          (!Array.isArray(after) || after.length !== 2 || !nonnegative(after[0]) || !uuid(after[1]))) fail('INVALID');
      const predicate = kind === 'expire' ? "state='live'" : "state='expired' AND scrubbed_at IS NULL";
      // Project UUID length before returning the key; corrupted unbounded TEXT
      // must never cross a speculative base-key read's fixed reservation.
      const result = read.query(`SELECT expires_at, CASE WHEN length(CAST(message_id AS BLOB))=36 THEN message_id ELSE NULL END AS message_id
        FROM main.im_content_state WHERE ${predicate} AND expires_at<=?${after === null ? '' : ' AND (expires_at,message_id)>(?,?)'}
        ORDER BY expires_at,im_content_state.message_id LIMIT 1`, after === null ? [through] : [through, ...after], 1, arrayBound(2, 36), false);
      if (result.stopReason) return result;
      const row = result.rows[0];
      if (row && (!nonnegative(row.expires_at) || !uuid(row.message_id))) fail('FACT_MISMATCH');
      return { value: row ? [row.expires_at, row.message_id] : null };
    }),
    nextAudit: operation((through, after = null) => {
      if (!nonnegative(through) || after !== null && (!Array.isArray(after) || after.length !== 2 ||
          !nonnegative(after[0]) || !Number.isSafeInteger(after[1]))) fail('INVALID');
      const result = read.query(`SELECT occurred_at,id FROM main.im_audit WHERE occurred_at<=?${after === null ? '' : ' AND (occurred_at,id)>(?,?)'}
        ORDER BY occurred_at,id LIMIT 1`, after === null ? [through] : [through, ...after], 1, arrayBound(2), false);
      if (result.stopReason) return result;
      const row = result.rows[0];
      if (row && (!nonnegative(row.occurred_at) || !Number.isSafeInteger(row.id))) fail('FACT_MISMATCH');
      return { value: row ? [row.occurred_at, row.id] : null };
    }),
  };
  for (const name of ['message', 'content', 'policy', 'sendKey', 'operation', 'reservation', 'attachment', 'delivery', 'conversation', 'audit']) {
    session['project' + name[0].toUpperCase() + name.slice(1)] = operation(key => {
      if (!(name === 'audit' ? Number.isSafeInteger(key) : name === 'policy' ? hash(key) : uuid(key))) fail('INVALID');
      return read.project(TABLE[name], key, false);
    });
  }
  return Object.freeze(session);
}

export function withMaintenanceReadSnapshot(readTarget, ledger, consume) {
  const state = targets.get(readTarget);
  if (!state) fail();
  if (state.busy || connections.has(state.db)) {
    const active = state.busy || connections.get(state.db);
    active.fault = failure();
    throw active.fault;
  }
  const scope = { live: true, inTransaction: false, fault: null };
  state.busy = scope;
  connections.set(state.db, scope);
  let account, held, began = false, result, binding, failed = false, error;
  try {
    synchronous(consume);
    if (state.invalid) fail('TARGET_STALE');
    account = accounting(ledger);
    let config;
    try { config = parseImV2Config(ledger.config); } catch { fail('POLICY_INVALID'); }
    if (config.enabled !== true) fail('DISABLED');
    if (!ledger.config || !['paused', 'enabled'].includes(ledger.config.writeMode) || !config.retention ||
        config.retention.policy.effectiveAt <= 0) fail('POLICY_INVALID');
    for (const key of ['maxScanRows', 'maxScanBytes', 'maxScanMs']) if (ledger.limits[key] > config.maintenance[key]) fail('POLICY_INVALID');
    // File/residue checks precede ANY SQLite read that might recover a journal.
    let file;
    try { file = protectedFile(state); }
    catch (caught) { if (state.binding) fail('TARGET_STALE'); throw caught; }
    if (state.binding && state.binding.file !== file) fail('TARGET_STALE');
    if (!state.open.call(state.db) || state.transaction.call(state.db) !== false) fail();
    const read = reader(state, account, scope);
    const pathname = () => {
      // Project variable-width pragma strings first, with a maximum two rows.
      const sizes = read.query('SELECT seq,length(CAST(name AS BLOB)) AS n,length(CAST(file AS BLOB)) AS f FROM pragma_database_list LIMIT 2',
        [], 2, 2 * arrayBound(3)).rows;
      if (sizes.length !== 1 || sizes[0].seq !== 0 || sizes[0].n !== 4 || sizes[0].f !== Buffer.byteLength(state.databasePath)) fail();
      const row = read.query('SELECT name,CAST(file AS BLOB) AS file FROM pragma_database_list LIMIT 1', [], 1,
        arrayBound(2, 4 + sizes[0].f)).rows[0];
      if (row.name !== 'main' || !Buffer.from(row.file).equals(Buffer.from(state.databasePath))) fail();
      if (read.pragma('journal_mode', 'journal_mode') !== 'delete') fail();
    };
    pathname();
    const cookie = read.pragma('schema_version', 'schema_version');
    const dataVersion = read.pragma('data_version', 'data_version');
    const changes = () => read.query('SELECT total_changes() AS n', [], 1, arrayBound(1)).rows[0]?.n;
    const totalChanges = changes();
    if (!nonnegative(cookie) || !nonnegative(dataVersion) || !nonnegative(totalChanges)) fail();
    if (state.binding && state.binding.cookie !== cookie) fail('TARGET_STALE');
    nativeExec.call(state.db, 'BEGIN'); began = true; scope.inTransaction = true;
    read.guard();
    const evidence = trust(read, config);
    binding = { file, cookie, evidence: JSON.stringify(evidence) };
    if (state.binding && JSON.stringify(binding) !== JSON.stringify(state.binding)) fail('TARGET_STALE');
    if (read.pragma('schema_version', 'schema_version') !== cookie || protectedFile(state) !== file) fail('TARGET_STALE');
    held = account.holdFinal();
    result = noThenable(consume(sessionFor(state, scope, read, evidence), ledger));
    read.guard();
    if (scope.fault) throw scope.fault;
    account.useFinal(held);
    const recheck = () => {
      if (state.invalid || protectedFile(state) !== file || read.pragma('schema_version', 'schema_version') !== cookie ||
          read.pragma('data_version', 'data_version') !== dataVersion) fail('TARGET_STALE');
      if (changes() !== totalChanges) fail();
      pathname();
      if (JSON.stringify(trust(read, config)) !== binding.evidence) fail('TARGET_STALE');
      read.guard();
    };
    recheck();
    nativeExec.call(state.db, 'COMMIT'); began = false; scope.inTransaction = false;
    recheck();
    account.check(true);
  } catch (caught) {
    failed = true;
    error = scope.fault !== null ? scope.fault : safeError(caught);
    scope.fault = error;
  } finally {
    scope.live = false;
    if (began) {
      try {
        if (state.transaction.call(state.db) !== true) fail();
        nativeExec.call(state.db, 'ROLLBACK');
        if (state.transaction.call(state.db) !== false) fail();
      } catch {
        state.invalid = true;
        if (!failed) { failed = true; error = failure(); }
      }
    }
    if (held) {
      try { account.releaseFinal(held); }
      catch { if (!failed) { failed = true; error = failure(); } }
    }
    state.busy = null;
    connections.delete(state.db);
  }
  // Settlement is callback-bearing: caught reentry/expired-session use can latch
  // a fault, and invalidate() can revoke the target after the last read check.
  // All cleanup is complete. Only private bookkeeping follows this final gate.
  if (!failed && (scope.fault !== null || state.invalid)) {
    failed = true;
    error = scope.fault !== null ? scope.fault : failure('TARGET_STALE');
  }
  if (failed) throw error;
  state.binding = binding; // only a fully successful first establishment binds
  return result;
}
