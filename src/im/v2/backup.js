import { randomUUID } from 'node:crypto';
import { closeSync } from 'node:fs';
import { join } from 'node:path';
import sqlite, { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { types } from 'node:util';
import { assertImSchemaV4Internal } from './schema-internal.js';
import { assertImSchemaV5Internal } from './schema-v5-internal.js';
import { decodeImV5BackupRecord, encodeImV5BackupRecord } from './backup-v5-records.js';
import { canonical, decode, exists, fail, fileHash, invalid, privateDirectory,
  operationBudget, protectedPath, publishBytes, publishPending, readBytes, ref, rejectThenable, reserve, same, sha, shape, storage, time, uuid } from './recovery-records.js';

const inFlight = new WeakMap();
const defaults = Object.freeze({ maxMessages: 10000, maxVerifiedContentBytes: 104857600, maxOtherRecords: 10000,
  maxElapsedMs: 10000, maxFileBytes: 134217728, maxMetadataEntries: 10000 });
export function validationLimits(input = {}) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).some(k => !Object.hasOwn(defaults, k) ||
      !Object.hasOwn(Object.getOwnPropertyDescriptor(input, k), 'value'))) invalid();
  const limits = { ...defaults, ...input };
  for (const key of Object.keys(defaults)) if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > defaults[key]) invalid();
  return Object.freeze(limits);
}
// Content verification only: never mints provenance. Full P1 budget is explicit.
export function inspectV4(path, limits, budget = operationBudget(validationLimits(limits))) {
  privateDirectory(join(path, '..'));
  const before = protectedPath(path);
  budget.file(before.size);
  const beforeHash = fileHash(path, budget);
  if (exists(`${path}-wal`) || exists(`${path}-shm`) || exists(`${path}-journal`)) invalid();
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0; BEGIN');
    assertImSchemaV4Internal(db, budget);
    budget.tick();
    for (const row of db.prepare('PRAGMA integrity_check').iterate()) {
      budget.tick(); if (row.integrity_check !== 'ok') invalid();
    }
    budget.tick();
    for (const row of db.prepare('PRAGMA foreign_key_check').iterate()) { budget.tick(); invalid(); }
    budget.tick();
    const identity = db.prepare('SELECT instance_id,created_at FROM im_instance_identity').get();
    const marker = db.prepare('SELECT version,migration_checksum FROM im_schema').get();
    return { sourceId: identity.instance_id, sourceCreatedAt: identity.created_at,
      schemaVersion: marker.version, schemaChecksum: marker.migration_checksum, fileHash: beforeHash };
  } catch (e) { throw e?.code === 'RECOVERY_BUSY' || e?.code === 'IM_V2_BUDGET_EXCEEDED' ? fail('RECOVERY_BUSY') : fail('RECOVERY_EVIDENCE_MISMATCH'); }
  finally {
    db?.close();
    if (!same(before, protectedPath(path)) || beforeHash !== fileHash(path, budget) ||
        exists(`${path}-wal`) || exists(`${path}-shm`) || exists(`${path}-journal`)) invalid();
    budget.tick();
  }
}
export function verifyV4(path, manifestBytes, limits, budget = operationBudget(validationLimits(limits))) {
  const manifest = decode('manifest', manifestBytes);
  const actual = inspectV4(path, limits, budget);
  for (const key of ['sourceId', 'sourceCreatedAt', 'schemaVersion', 'schemaChecksum', 'fileHash'])
    if (actual[key] !== manifest[key]) invalid();
  const manifestHash = sha(manifestBytes); budget.tick();
  return { manifest, manifestHash };
}

function safeFailure(error) {
  try {
    if (!types.isProxy(error)) {
      const code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
      if (code === 'IM_V2_BUDGET_EXCEEDED') return fail('RECOVERY_BUSY');
      if (['RECOVERY_BUSY', 'RECOVERY_AUTH_DENIED', 'RECOVERY_APPROVAL_DENIED',
        'RECOVERY_UNSUPPORTED', 'RECOVERY_DURABILITY_UNCERTAIN', 'RECOVERY_EVIDENCE_MISMATCH'].includes(code)) return fail(code);
    }
  } catch { /* Never classify through a foreign getter or proxy trap. */ }
  return fail('RECOVERY_EVIDENCE_MISMATCH');
}

// Marker selection is bounded and stays inside the transaction that does the
// full validation. A failed exact5 validation can never fall back to exact4.
function inspectNative(path, limits, budget, expectedVersion) {
  privateDirectory(join(path, '..'));
  const before = protectedPath(path);
  budget.file(before.size);
  const beforeHash = fileHash(path, budget);
  const sidecars = () => {
    if (exists(`${path}-wal`) || exists(`${path}-shm`) || exists(`${path}-journal`)) invalid();
  };
  sidecars();
  let db, actual, failure;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0; BEGIN');
    budget.tick();
    const markers = db.prepare("SELECT CASE WHEN typeof(version)='integer' THEN version ELSE NULL END AS version FROM im_schema LIMIT 2").all();
    budget.tick();
    if (markers.length !== 1 || ![4, 5].includes(markers[0].version) ||
        (expectedVersion !== undefined && markers[0].version !== expectedVersion)) invalid();
    switch (markers[0].version) {
      case 4: assertImSchemaV4Internal(db, budget); break;
      case 5: assertImSchemaV5Internal(db, budget); break;
      default: invalid();
    }
    budget.tick();
    for (const row of db.prepare('PRAGMA integrity_check').iterate()) {
      budget.tick(); if (row.integrity_check !== 'ok') invalid();
    }
    budget.tick();
    for (const row of db.prepare('PRAGMA foreign_key_check').iterate()) { budget.tick(); invalid(); }
    budget.tick();
    const identity = db.prepare('SELECT instance_id,created_at FROM im_instance_identity LIMIT 1').get();
    const marker = db.prepare('SELECT version,migration_checksum FROM im_schema LIMIT 1').get();
    actual = { sourceId: identity.instance_id, sourceCreatedAt: identity.created_at,
      schemaVersion: marker.version, schemaChecksum: marker.migration_checksum, fileHash: beforeHash };
  } catch (error) { failure = safeFailure(error); }
  finally {
    try { db?.close(); } catch (error) { failure ??= safeFailure(error); }
    try {
      if (!same(before, protectedPath(path)) || beforeHash !== fileHash(path, budget)) invalid();
      sidecars(); budget.tick();
    } catch (error) { failure ??= safeFailure(error); }
  }
  if (failure) throw failure;
  return actual;
}
function inspectV5(path, limits, budget) { return inspectNative(path, limits, budget, 5); }
export function inspectNativeSnapshot(path, limits, budget = operationBudget(validationLimits(limits))) {
  return inspectNative(path, limits, budget);
}
export function decodeNativeManifest(bytes) {
  try {
    if (types.isProxy(bytes) || !Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 65536) invalid();
    // This parse selects a decoder only; all validation uses the original bytes.
    switch (JSON.parse(bytes.toString('utf8'))?.formatVersion) {
      case 2: return decode('manifest', bytes);
      case 3: return decodeImV5BackupRecord('manifest', bytes);
      default: invalid();
    }
  } catch { invalid(); }
}
export function verifyNativeBackup(path, manifestBytes, limits, budget = operationBudget(validationLimits(limits)), backupId) {
  const manifest = decodeNativeManifest(manifestBytes);
  if (backupId !== undefined && (!uuid(backupId) || manifest.backupId !== backupId)) invalid();
  let actual;
  switch (manifest.formatVersion) {
    case 2: actual = inspectV4(path, limits, budget); break;
    case 3: actual = inspectV5(path, limits, budget); break;
    default: invalid();
  }
  for (const key of ['sourceId', 'sourceCreatedAt', 'schemaVersion', 'schemaChecksum', 'fileHash'])
    if (actual[key] !== manifest[key]) invalid();
  const manifestHash = sha(manifestBytes); budget.tick();
  return { manifest, manifestHash };
}

function adapter(owner, name, args, code) {
  try {
    const fn = owner?.[name];
    if (typeof fn !== 'function' || types.isAsyncFunction(fn) || types.isGeneratorFunction(fn)) throw null;
    const result = Reflect.apply(fn, owner, args); rejectThenable(result);
    return result;
  } catch { throw fail(code); }
}
function backupApproval(authority, approval, context) {
  if (adapter(authority, 'authorizeBackup', [{ ...approval }, context], 'RECOVERY_APPROVAL_DENIED') !== true)
    throw fail('RECOVERY_APPROVAL_DENIED');
}
function backupAdmin(authority, context) {
  if (adapter(authority, 'authorizeAdmin', [context], 'RECOVERY_AUTH_DENIED') !== true)
    throw fail('RECOVERY_AUTH_DENIED');
}

function closeSnapshot(path, identity) {
  // Native backup may inherit WAL mode. Only our unexposed pending snapshot is
  // opened writable: SQLite itself drains/removes its sidecars, never raw unlink.
  if (!same(identity, protectedPath(path))) invalid();
  let copy;
  try {
    copy = new DatabaseSync(path);
    copy.exec('PRAGMA busy_timeout=0');
    const checkpoint = copy.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if (checkpoint.busy !== 0) throw fail('RECOVERY_BUSY');
    if (copy.prepare('PRAGMA journal_mode=DELETE').get().journal_mode !== 'delete') invalid();
  } finally { copy?.close(); }
  if (!same(identity, protectedPath(path)) || exists(`${path}-wal`) || exists(`${path}-shm`) || exists(`${path}-journal`)) invalid();
}

export function createImV2Backup({ db, root, authority, approvalAuthority, clock = Date.now, limits,
  backupTimeBudgetMs = 30000, backupRate = 256 } = {}) {
  const store = storage(root), bounds = validationLimits(limits);
  if (typeof clock !== 'function' || !Number.isSafeInteger(backupTimeBudgetMs) || backupTimeBudgetMs < 1 || backupTimeBudgetMs > 300000 ||
      !Number.isSafeInteger(backupRate) || backupRate < 1 || backupRate > 100000) invalid();
  const artifact = id => { if (!uuid(id)) invalid(); return join(store.root, 'registry', 'artifacts', `${id}.sqlite`); };
  const manifestPath = id => join(store.root, 'registry', 'artifacts', `${id}.manifest.json`);
  const status = () => Object.freeze({ nativeInFlight: !!(db && inFlight.has(db)) });
  const drain = () => db && inFlight.has(db) ? inFlight.get(db) : Promise.resolve();
  function verify({ backupId } = {}) {
    const budget = operationBudget(bounds);
    return store.withLock(() => verifyNativeBackup(artifact(backupId), readBytes(manifestPath(backupId), budget), bounds, budget, backupId));
  }
  async function publish(input, context, inheritedBudget) {
    const budget = operationBudget(bounds, inheritedBudget);
    let approvalRef, inputInvalid = false;
    try {
      if (types.isProxy(input)) invalid();
      shape(input, ['approvalRef']); approvalRef = input.approvalRef;
      if (!ref(approvalRef) || !db) invalid();
    } catch { inputInvalid = true; }
    backupAdmin(authority, context);
    if (inputInvalid) invalid();
    let approval;
    try {
      const actors = adapter(authority, 'publicationActors', [context], 'RECOVERY_APPROVAL_DENIED');
      if (types.isProxy(actors)) invalid();
      shape(actors, ['executorActorId', 'approverActorId']);
      if (!ref(actors.executorActorId) || !ref(actors.approverActorId) || actors.executorActorId === actors.approverActorId) invalid();
      approval = Object.freeze({ approvalRef, executorActorId: actors.executorActorId, approverActorId: actors.approverActorId });
    } catch { throw fail('RECOVERY_APPROVAL_DENIED'); }
    backupApproval(approvalAuthority, approval, context);
    if (inFlight.has(db)) throw fail('RECOVERY_BUSY');
    const id = randomUUID(), target = artifact(id);
    const pending = reserve(join(store.root, 'registry', 'artifacts'));
    closeSync(pending.fd);
    const deadline = performance.now() + backupTimeBudgetMs;
    let timer, running, settled, release;
    try {
      running = Promise.resolve().then(() => sqlite.backup(db, pending.path, { rate: backupRate }));
      settled = new Promise(resolve => { release = resolve; });
      inFlight.set(db, settled);
      // No cancellation API. Retain the exclusive pending file until native completion;
      // a timeout cannot publish anything or authorize caller to close the source.
      await Promise.race([running, new Promise((_, reject) => {
        timer = setTimeout(() => reject(fail('RECOVERY_BUSY')), backupTimeBudgetMs);
      })]);
      clearTimeout(timer);
      if (performance.now() >= deadline) throw fail('RECOVERY_BUSY');
      if (!same(pending.identity, protectedPath(pending.path))) invalid();
      budget.file(protectedPath(pending.path).size);
      closeSnapshot(pending.path, pending.identity);
      budget.tick();
      const actual = inspectNativeSnapshot(pending.path, bounds, budget), completedAt = clock();
      if (!time(completedAt)) invalid();
      let manifest, bytes;
      switch (actual.schemaVersion) {
        case 4:
          manifest = { formatVersion: 2, backupId: id, ...actual, completedAt, toolVersion: 'im-v2-backup-1', approval };
          bytes = canonical('manifest', manifest); break;
        case 5:
          manifest = { formatVersion: 3, backupId: id, ...actual, completedAt, toolVersion: 'im-v2-backup-2', approval };
          bytes = encodeImV5BackupRecord('manifest', manifest); break;
        default: invalid();
      }
      if (performance.now() >= deadline) throw fail('RECOVERY_BUSY');
      return store.withLock(() => {
        backupAdmin(authority, context);
        backupApproval(approvalAuthority, approval, context);
        budget.tick();
        if (performance.now() >= deadline) throw fail('RECOVERY_BUSY');
        publishPending(pending.path, target, pending.identity);
        publishBytes(manifestPath(id), bytes, budget);
        return verifyNativeBackup(target, readBytes(manifestPath(id), budget), bounds, budget, id);
      });
    } catch (e) { throw safeFailure(e); }
    finally {
      clearTimeout(timer);
      if (running) void running.then(() => {}, () => {}).then(() => {
        if (inFlight.get(db) === settled) inFlight.delete(db);
        release();
      });
    }
  }
  return Object.freeze({ publish, verify, status, drain });
}
