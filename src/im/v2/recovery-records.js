// Private P5 storage/encoding support. This module cannot mint registry provenance.
import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  opendirSync, readSync, realpathSync, unlinkSync, writeSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { dirname, join, parse, resolve, sep } from 'node:path';
import { createRegistryLock } from '../registry-lock.js';

export const fail = code => Object.assign(new Error(code), { code });
export const invalid = () => { throw fail('RECOVERY_EVIDENCE_MISMATCH'); };
export const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
export const hash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
export const time = value => Number.isSafeInteger(value) && value >= 0;
export const ref = value => typeof value === 'string' && value.length > 0 && value.length <= 255 && !/[\x00-\x1f\x7f]/.test(value);
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
export const exists = path => { try { lstatSync(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const operationBudgets = new WeakSet();
export function operationBudget(limits, inherited) {
  if (inherited !== undefined) {
    if (!operationBudgets.has(inherited) || Object.keys(limits).some(key => inherited.limits[key] > limits[key])) invalid();
    return inherited;
  }
  // Start at the first validation step, before any hash/read. Native asynchronous
  // snapshot creation has its own deadline and does not consume this soft budget.
  let start;
  let entries = 0;
  const budget = Object.freeze({ limits: Object.freeze({ ...limits }), tick() {
    const now = performance.now(); start ??= now;
    if (now - start > limits.maxElapsedMs) throw fail('RECOVERY_BUSY');
  }, file(size) {
    this.tick();
    if (size > limits.maxFileBytes) throw fail('RECOVERY_BUSY');
  }, entry() {
    this.tick();
    if (++entries > limits.maxMetadataEntries) throw fail('RECOVERY_BUSY');
  } });
  operationBudgets.add(budget); return budget;
}
export function deepFreeze(value) {
  for (const child of Object.values(value)) if (child && typeof child === 'object') deepFreeze(child);
  return Object.freeze(value);
}
export function rejectThenable(value) {
  if (value && typeof value.then === 'function') {
    // Observe rejection without awaiting or extending the lock-bound capability.
    void Promise.resolve(value).catch(() => {});
    invalid();
  }
}
export function directoryEntries(path, budget, consume) {
  privateDirectory(path);
  const directory = opendirSync(path, { bufferSize: 1 });
  try {
    let entry;
    while ((entry = directory.readSync())) { budget.entry(); consume(entry.name); }
    budget.tick();
  } finally { directory.closeSync(); }
}
export function shape(value, fields) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== fields.length ||
      !fields.every(k => Object.hasOwn(value, k) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, k), 'value'))) invalid();
}
function ordered(value, rules) {
  const keys = Object.keys(rules); shape(value, keys);
  const result = {};
  for (const key of keys) { if (!rules[key](value[key])) invalid(); result[key] = value[key]; }
  return result;
}
const one = x => x === 1;
const approval = value => {
  const result = ordered(value, { approvalRef: ref, executorActorId: ref, approverActorId: ref });
  if (result.executorActorId === result.approverActorId) invalid();
  return result;
};
export function canonical(kind, value) {
  let result;
  if (kind === 'manifest') {
    result = ordered(value, { formatVersion: x => x === 2, backupId: uuid, sourceId: uuid, sourceCreatedAt: time,
      schemaVersion: x => x === 4, schemaChecksum: hash, fileHash: hash, completedAt: time,
      toolVersion: x => x === 'im-v2-backup-1', approval: x => !!approval(x) });
    result.approval = approval(value.approval);
  } else if (kind === 'record') {
    result = ordered(value, { recordVersion: x => x === 3, backupId: uuid, instanceId: uuid, instanceCreatedAt: time,
      schemaVersion: x => x === 3 || x === 4, schemaChecksum: hash, fileHash: hash, manifestHash: hash,
      completedAt: time, artifactReference: ref, publicationKind: x => ['native-v4', 'imported-registered-v3'].includes(x),
      sourceEvidenceHash: hash, registeredAt: time });
    if (result.artifactReference !== `registry/artifacts/${result.backupId}.sqlite` ||
        result.schemaVersion !== (result.publicationKind === 'native-v4' ? 4 : 3)) invalid();
  } else if (kind === 'source') {
    result = ordered(value, { version: one, kind: x => x === 'registered-backup', sourceRef: ref,
      registryFormat: x => x === 2 || x === 3, instanceId: uuid, instanceCreatedAt: time, backupId: uuid,
      fileHash: hash, manifestHash: hash, schemaVersion: x => x === 3 || x === 4, schemaChecksum: hash,
      completedAt: time, importedRecordHash: x => x === null || hash(x) });
    if (result.sourceRef !== `backup:${result.backupId}` || (result.registryFormat === 3
      ? result.schemaVersion !== 4 || result.importedRecordHash !== null
      : result.schemaVersion !== 3 || !hash(result.importedRecordHash))) invalid();
  } else if (kind === 'hold') result = ordered(value, { version: one, holdId: uuid, backupId: uuid,
    recoveryRunId: uuid, stageHash: hash, createdAt: time });
  else if (kind === 'binding') result = ordered(value, { version: one, holdId: uuid, stageHash: hash,
    preparePlanHash: hash, boundAt: time });
  else if (kind === 'release') result = ordered(value, { version: one, holdId: uuid, recoveryRunId: uuid,
    terminalState: x => ['active', 'failed'].includes(x), stateEvidenceHash: hash, approvalRef: ref, releasedAt: time });
  else invalid();
  const bytes = Buffer.from(JSON.stringify(result));
  if (bytes.length > 65536) invalid();
  return bytes;
}
export function decode(kind, bytes) {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length > 65536 || !bytes.length) invalid();
    const value = JSON.parse(bytes.toString('utf8'));
    if (!canonical(kind, value).equals(bytes)) invalid();
    return value;
  } catch { invalid(); }
}
export function authorize(authority, context) {
  let ok = false;
  try { ok = authority?.authorizeAdmin(context) === true; } catch { /* deny */ }
  if (!ok) throw fail('RECOVERY_AUTH_DENIED');
}
export function nativePlatform() {
  if (process.platform === 'win32' || typeof process.geteuid !== 'function' || !constants.O_NOFOLLOW)
    throw fail('RECOVERY_UNSUPPORTED');
}
export function protectedPath(path, directory = false) {
  nativePlatform();
  const st = lstatSync(path);
  if (st.isSymbolicLink() || (directory ? !st.isDirectory() : !st.isFile()) || st.uid !== process.geteuid() ||
      (st.mode & 0o777) !== (directory ? 0o700 : 0o600) || (!directory && st.nlink !== 1)) invalid();
  return st;
}
export function privateDirectory(path) {
  nativePlatform();
  const full = resolve(path);
  let current = parse(full).root;
  for (const part of ['', ...full.slice(current.length).split(sep).filter(Boolean)]) {
    current = join(current, part);
    const st = lstatSync(current);
    if (!st.isDirectory() || st.isSymbolicLink() || ![0, process.geteuid()].includes(st.uid) ||
        ((st.mode & 0o022) && !(current !== full && st.mode & 0o1000))) invalid();
  }
  protectedPath(full, true);
  if (realpathSync(full) !== full) invalid();
  return full;
}
export function checkOpened(path, before, opened) {
  const current = protectedPath(path);
  if (!same(before, opened) || !same(current, opened) || !opened.isFile() || opened.nlink !== 1 ||
      opened.uid !== process.geteuid() || (opened.mode & 0o777) !== 0o600) invalid();
}
export function syncDirectory(path) {
  const before = protectedPath(path, true);
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    if (!same(before, fstatSync(fd)) || !same(before, protectedPath(path, true))) invalid();
    fsyncSync(fd);
  } finally { if (fd !== undefined) closeSync(fd); }
}
export function streamFile(path, consume, budget, maxBytes = budget?.limits.maxFileBytes) {
  privateDirectory(dirname(path));
  const before = protectedPath(path);
  budget?.file(before.size);
  if (maxBytes !== undefined && before.size > maxBytes) invalid();
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    checkOpened(path, before, fstatSync(fd));
    const buffer = Buffer.allocUnsafe(65536);
    let n, total = 0;
    while (true) {
      budget?.tick();
      n = readSync(fd, buffer, 0, buffer.length, null);
      if (!n) break;
      total += n; budget?.file(total);
      if (maxBytes !== undefined && total > maxBytes) invalid();
      consume(buffer.subarray(0, n)); budget?.tick();
    }
    const after = fstatSync(fd);
    checkOpened(path, before, after);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) invalid();
    budget?.tick();
  } finally { if (fd !== undefined) closeSync(fd); }
}
export function readBytes(path, budget) {
  const chunks = []; let total = 0;
  streamFile(path, chunk => { total += chunk.length; if (total > 65536) invalid(); chunks.push(Buffer.from(chunk)); }, budget, 65536);
  return Buffer.concat(chunks);
}
export function fileHash(path, budget) {
  const digest = createHash('sha256'); streamFile(path, chunk => digest.update(chunk), budget);
  const result = digest.digest('hex'); budget?.tick(); return result;
}
export function reserve(directory) {
  privateDirectory(directory);
  const path = join(directory, `.${randomUUID()}.pending`);
  let fd;
  try {
    fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    const identity = fstatSync(fd); checkOpened(path, identity, identity);
    return { path, fd, identity };
  } catch { if (fd !== undefined) closeSync(fd); throw fail('RECOVERY_DURABILITY_UNCERTAIN'); }
}
export function writeAll(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) { const n = writeSync(fd, bytes, offset, bytes.length - offset); if (!n) invalid(); offset += n; }
}
export function publishPending(pending, target, identity) {
  try {
    privateDirectory(dirname(target));
    if (!same(identity, protectedPath(pending))) invalid();
    let fd;
    try {
      fd = openSync(pending, constants.O_RDONLY | constants.O_NOFOLLOW);
      checkOpened(pending, identity, fstatSync(fd)); fsyncSync(fd);
    } finally { if (fd !== undefined) closeSync(fd); }
    linkSync(pending, target);
    const a = lstatSync(pending), b = lstatSync(target);
    if (!same(identity, a) || !same(identity, b) || a.nlink !== 2 || b.nlink !== 2) invalid();
    unlinkSync(pending);
    protectedPath(target);
    syncDirectory(dirname(target));
  } catch { throw fail('RECOVERY_DURABILITY_UNCERTAIN'); }
}
export function resyncPublished(path, budget) {
  budget?.tick();
  // Call only after canonical validation under the same coordinator. Visibility
  // after a failed publication is not durability, including on facade reopen.
  try {
    privateDirectory(dirname(path));
    const before = protectedPath(path);
    let fd;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      checkOpened(path, before, fstatSync(fd)); fsyncSync(fd);
      checkOpened(path, before, fstatSync(fd));
    } finally { if (fd !== undefined) closeSync(fd); }
    syncDirectory(dirname(path));
  } catch { throw fail('RECOVERY_DURABILITY_UNCERTAIN'); }
  budget?.tick();
}
export function publishBytes(path, bytes, budget) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 65536 || !bytes.length) invalid();
  budget?.tick();
  if (exists(path)) {
    if (!readBytes(path, budget).equals(bytes)) throw fail('RECOVERY_DURABILITY_UNCERTAIN');
    resyncPublished(path, budget); return;
  }
  const pending = reserve(dirname(path));
  try { writeAll(pending.fd, bytes); fsyncSync(pending.fd); }
  catch { throw fail('RECOVERY_DURABILITY_UNCERTAIN'); }
  finally { closeSync(pending.fd); }
  publishPending(pending.path, path, pending.identity);
  budget?.tick();
}
export function storage(root) {
  root = privateDirectory(root);
  for (const relative of ['registry', 'registry/artifacts', 'registry/records', 'registry/holds', 'registry/releases']) {
    const path = join(root, relative);
    if (!exists(path)) {
      try { mkdirSync(path, { mode: 0o700 }); syncDirectory(dirname(path)); }
      catch { throw fail('RECOVERY_DURABILITY_UNCERTAIN'); }
    }
    privateDirectory(path);
  }
  const platform = { privateDirectory, protectedPath, checkOpened, syncDirectory };
  let coordinator;
  const mapError = e => { throw e?.code === 'REGISTRY_BUSY' ? fail('RECOVERY_BUSY') :
    e?.code?.startsWith('RECOVERY_') ? e : fail('RECOVERY_EVIDENCE_MISMATCH'); };
  try { coordinator = createRegistryLock(root, platform); } catch (e) { mapError(e); }
  return { root, withLock(callback) { try { return coordinator.withLock(callback); } catch (e) { mapError(e); } } };
}
