import { randomUUID } from 'node:crypto';
import { closeSync } from 'node:fs';
import { join } from 'node:path';
import sqlite, { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { assertImSchemaV4Internal } from './schema-internal.js';
import { authorize, canonical, decode, exists, fail, fileHash, invalid, privateDirectory,
  operationBudget, protectedPath, publishBytes, publishPending, readBytes, ref, reserve, same, sha, shape, storage, time, uuid } from './recovery-records.js';

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
    return store.withLock(() => verifyV4(artifact(backupId), readBytes(manifestPath(backupId), budget), bounds, budget));
  }
  async function publish(input, context, inheritedBudget) {
    const budget = operationBudget(bounds, inheritedBudget);
    authorize(authority, context); shape(input, ['approvalRef']);
    if (!ref(input.approvalRef) || !db) invalid();
    let actors, allowed = false;
    try {
      actors = authority.publicationActors(context);
      shape(actors, ['executorActorId', 'approverActorId']);
      if (!ref(actors.executorActorId) || !ref(actors.approverActorId) || actors.executorActorId === actors.approverActorId) invalid();
      allowed = approvalAuthority?.authorizeBackup({ approvalRef: input.approvalRef, ...actors }, context) === true;
    } catch { /* deny without revealing adapter/context */ }
    if (!allowed) throw fail('RECOVERY_APPROVAL_DENIED');
    if (inFlight.has(db)) throw fail('RECOVERY_BUSY');
    const approval = { approvalRef: input.approvalRef, executorActorId: actors.executorActorId, approverActorId: actors.approverActorId };
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
      const actual = inspectV4(pending.path, bounds, budget), completedAt = clock();
      if (!time(completedAt)) invalid();
      const manifest = { formatVersion: 2, backupId: id, ...actual, completedAt, toolVersion: 'im-v2-backup-1', approval };
      const bytes = canonical('manifest', manifest);
      if (performance.now() >= deadline) throw fail('RECOVERY_BUSY');
      return store.withLock(() => {
        publishPending(pending.path, target, pending.identity);
        publishBytes(manifestPath(id), bytes, budget);
        return verifyV4(target, readBytes(manifestPath(id), budget), bounds, budget);
      });
    } catch (e) { throw e?.code?.startsWith('RECOVERY_') ? e : fail('RECOVERY_EVIDENCE_MISMATCH'); }
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
