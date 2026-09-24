import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getInstanceIdentity } from './schema.js';
import { createImBackup } from './backup.js';
import { createBackupPublisher } from './backup-publisher.js';

const fail = code => Object.assign(new Error(code), { code });
const ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 255 && !/[\x00-\x1f\x7f]/.test(value);
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const exists = path => { try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const shape = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const validTime = value => Number.isSafeInteger(value) && value >= 0;
const instanceKeys = ['recordVersion', 'instanceId', 'dbLocation', 'registrationGeneration'];
const backupKeys = ['recordVersion', 'instanceId', 'registrationGeneration', 'backupId', 'fileHash', 'schemaVersion',
  'schemaChecksum', 'completedAt', 'executorActorId', 'backupApprovalId', 'backupApproverId', 'toolVersion',
  'artifactReference', 'manifestHash', 'publicationState', 'registeredAt'];
const revocationKeys = ['recordVersion', 'backupId', 'revokedAt'];
const invalid = () => { throw fail('REGISTRY_UNTRUSTED_RECORD'); };

// The default capability checks real OS protection. Overrides are exclusively for isolated tests.
function protectedPath(path, directory = false) {
  if (process.platform === 'win32' || typeof process.geteuid !== 'function') throw fail('REGISTRY_PERMISSION_UNVERIFIED');
  const st = lstatSync(path);
  if ((directory ? !st.isDirectory() : !st.isFile()) || st.isSymbolicLink() ||
      st.uid !== process.geteuid() || (st.mode & 0o077) || (!directory && st.nlink !== 1)) throw fail('REGISTRY_UNTRUSTED_PATH');
  return st;
}

function privateDirectory(path) {
  if (process.platform === 'win32' || typeof process.geteuid !== 'function') throw fail('REGISTRY_PERMISSION_UNVERIFIED');
  const full = resolve(path);
  let current = parse(full).root;
  const trustedOwner = st => st.uid === process.geteuid() || st.uid === 0;
  const rootInfo = lstatSync(current);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !trustedOwner(rootInfo) || (rootInfo.mode & 0o022)) throw fail('REGISTRY_UNTRUSTED_PATH');
  for (const part of full.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    const st = lstatSync(current);
    if (!st.isDirectory() || st.isSymbolicLink() || !trustedOwner(st)) throw fail('REGISTRY_UNTRUSTED_PATH');
    // A sticky parent (e.g. /tmp) cannot be used to replace someone else's child.
    if (current !== full && (st.mode & 0o022) && !(st.mode & 0o1000 && (st.uid === 0 || st.uid === process.geteuid())))
      throw fail('REGISTRY_UNTRUSTED_PATH');
  }
  protectedPath(full, true);
  return full;
}

function checkOpened(path, before, st) {
  if (!same(before, st) || !st.isFile() || (st.mode & 0o077) || st.nlink !== 1 ||
      !same(st, lstatSync(path))) throw fail('REGISTRY_UNTRUSTED_PATH');
}

function syncDirectory(root) {
  let fd;
  try { fd = openSync(root, constants.O_RDONLY); fsyncSync(fd); }
  finally { if (fd !== undefined) closeSync(fd); }
}

const defaultPlatform = Object.freeze({ privateDirectory, protectedPath, checkOpened, syncDirectory });

function readProtected(path, platform, max = 1024 * 1024) {
  const before = platform.protectedPath(path);
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const st = fstatSync(fd);
    platform.checkOpened(path, before, st);
    if (st.size > max || st.size < 1) throw fail('REGISTRY_UNTRUSTED_PATH');
    const chunks = [], buffer = Buffer.allocUnsafe(65536);
    let total = 0, count;
    while ((count = readSync(fd, buffer, 0, buffer.length, null))) {
      total += count;
      if (total > max) throw fail('REGISTRY_UNTRUSTED_PATH');
      chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    platform.checkOpened(path, before, fstatSync(fd));
    return Buffer.concat(chunks);
  } finally { if (fd !== undefined) closeSync(fd); }
}

function hashFile(path, platform) {
  const hash = createHash('sha256');
  const before = platform.protectedPath(path);
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const st = fstatSync(fd), buffer = Buffer.allocUnsafe(256 * 1024);
    platform.checkOpened(path, before, st);
    let count;
    while ((count = readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count));
    platform.checkOpened(path, before, fstatSync(fd));
    return hash.digest('hex');
  } finally { if (fd !== undefined) closeSync(fd); }
}

function buildRegistry({ dir, authority, clock = Date.now, fault, platform = defaultPlatform } = {}) {
  if (typeof dir !== 'string' || !dir || typeof clock !== 'function') throw fail('REGISTRY_INVALID_INPUT');
  if (!platform || !['privateDirectory', 'protectedPath', 'checkOpened', 'syncDirectory'].every(key => typeof platform[key] === 'function'))
    throw fail('REGISTRY_PERMISSION_UNVERIFIED');
  const root = platform.privateDirectory(dir);
  const uses = new Map(), waiters = new Set();
  const checkRoot = () => platform.privateDirectory(root);
  const requireAdmin = context => {
    let allowed = false;
    try { allowed = authority?.authorizeAdmin(context) === true; } catch { /* fail closed */ }
    if (!allowed) throw fail('REGISTRY_AUTH_DENIED');
  };
  const location = (reference, allowMissing = false) => {
    if (typeof reference !== 'string' || !reference || isAbsolute(reference) || reference.includes('\\') ||
        reference.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.')) ||
        !reference.startsWith('artifacts/')) throw fail('REGISTRY_ARTIFACT_DENIED');
    const parts = reference.split('/');
    if (parts.length !== 2 || !text(parts[1])) throw fail('REGISTRY_ARTIFACT_DENIED');
    platform.protectedPath(join(root, 'artifacts'), true);
    const path = join(root, ...parts);
    if (!allowMissing || exists(path)) platform.protectedPath(path);
    if (!allowMissing || exists(`${path}.manifest.json`)) platform.protectedPath(`${path}.manifest.json`);
    return path;
  };
  const syncDir = directory => {
    try { fault?.('directory-sync', directory); platform.protectedPath(directory, true); platform.syncDirectory(directory); }
    catch { throw fail('REGISTRY_DURABILITY_UNAVAILABLE'); }
  };
  const publish = (name, payload) => {
    checkRoot();
    const target = join(root, name);
    if (exists(target)) throw fail('REGISTRY_ALREADY_EXISTS');
    const pending = join(root, `.${randomUUID()}.pending`);
    let fd, owned, linked = false, pendingRemoved = false, rollbackChanged = false;
    try {
      fd = openSync(pending, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
      owned = fstatSync(fd);
      writeFileSync(fd, JSON.stringify(payload));
      fault?.('file-sync'); fsyncSync(fd);
      closeSync(fd); fd = undefined;
      if (!same(owned, platform.protectedPath(pending))) throw fail('REGISTRY_UNTRUSTED_PATH');
      linkSync(pending, target); // atomic no-replace, not rename-over-existing
      linked = true;
      // Remove the pending link before the final directory sync, so success never leaves two links.
      unlinkSync(pending); pendingRemoved = true;
      syncDir(root);
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      // Roll back only our own publication, and persist every directory-entry removal.
      try {
        if (linked) {
          if (!exists(target) || !same(owned, lstatSync(target))) throw fail('REGISTRY_CLEANUP_INCOMPLETE');
          unlinkSync(target); rollbackChanged = true;
        }
        if (owned && !pendingRemoved && exists(pending)) {
          if (!same(owned, lstatSync(pending))) throw fail('REGISTRY_CLEANUP_INCOMPLETE');
          unlinkSync(pending); pendingRemoved = true; rollbackChanged = true;
        }
        if (rollbackChanged) syncDir(root);
      } catch { throw fail('REGISTRY_CLEANUP_INCOMPLETE'); }
      if (error?.code?.startsWith('REGISTRY_')) throw error;
      if (error?.code === 'EEXIST') throw fail('REGISTRY_ALREADY_EXISTS');
      throw fail('REGISTRY_WRITE_FAILED');
    }
  };
  const record = (name, code = 'REGISTRY_NOT_FOUND') => {
    checkRoot();
    try { return JSON.parse(readProtected(join(root, name), platform).toString('utf8')); }
    catch (error) { if (error.code === 'ENOENT') throw fail(code); throw error.code?.startsWith('REGISTRY_') ? error : fail('REGISTRY_UNTRUSTED_RECORD'); }
  };
  const instance = () => {
    // Generation one is immutable; re-registration is deliberately not offered by this isolated module.
    const data = record('instance-1.json', 'REGISTRY_INSTANCE_NOT_FOUND');
    if (!shape(data, instanceKeys) || data.recordVersion !== 1 || !ID.test(data.instanceId) ||
        !text(data.dbLocation) || data.registrationGeneration !== 1) invalid();
    return data;
  };
  const publication = backupId => {
    if (!ID.test(backupId)) throw fail('REGISTRY_INVALID_INPUT');
    const data = record(`backup-${backupId}.json`);
    if (!shape(data, backupKeys) || data.recordVersion !== 1 || data.backupId !== backupId ||
        data.publicationState !== 'published' || !ID.test(data.instanceId) ||
        data.registrationGeneration !== 1 || !HASH.test(data.fileHash) || !HASH.test(data.schemaChecksum) ||
        !HASH.test(data.manifestHash) || !Number.isSafeInteger(data.schemaVersion) || data.schemaVersion < 1 ||
        !validTime(data.completedAt) || !validTime(data.registeredAt) ||
        ![data.executorActorId, data.backupApprovalId, data.backupApproverId, data.toolVersion, data.artifactReference].every(text)) invalid();
    return data;
  };
  const revoked = id => {
    if (!exists(join(root, `revoked-${id}.json`))) return false;
    const data = record(`revoked-${id}.json`);
    if (!shape(data, revocationKeys) || data.recordVersion !== 1 || data.backupId !== id || !validTime(data.revokedAt)) invalid();
    return true;
  };
  const busy = id => { if (uses.has(id)) throw fail('REGISTRY_IN_USE'); };

  function registerInstance({ instanceId, dbLocation, adminContext } = {}) {
    requireAdmin(adminContext);
    if (!ID.test(instanceId) || !text(dbLocation)) throw fail('REGISTRY_INVALID_INPUT');
    const value = { recordVersion: 1, instanceId, dbLocation, registrationGeneration: 1 };
    publish('instance-1.json', value);
    return { instanceId, registrationGeneration: 1 }; // never disclose dbLocation in public returns
  }
  function getInstance() {
    const { instanceId, registrationGeneration } = instance();
    return { instanceId, registrationGeneration };
  }
  function registerPublishedBackup({ instanceId, registrationGeneration, backupId, fileHash, schemaVersion,
    schemaChecksum, completedAt, executorActorId, backupApprovalId, backupApproverId, toolVersion,
    artifactReference, manifestHash, adminContext } = {}) {
    requireAdmin(adminContext);
    const current = instance();
    if (instanceId !== current.instanceId || registrationGeneration !== current.registrationGeneration) throw fail('REGISTRY_INSTANCE_MISMATCH');
    if (!ID.test(backupId) || !HASH.test(fileHash) || !HASH.test(schemaChecksum) || !HASH.test(manifestHash) ||
        !Number.isSafeInteger(schemaVersion) || schemaVersion < 1 || !Number.isSafeInteger(completedAt) || completedAt < 0 ||
        ![executorActorId, backupApprovalId, backupApproverId, toolVersion].every(text)) throw fail('REGISTRY_INVALID_INPUT');
    if (exists(join(root, `backup-${backupId}.json`))) throw fail('REGISTRY_ALREADY_EXISTS');
    const path = location(artifactReference);
    if (hashFile(path, platform) !== fileHash || hashFile(`${path}.manifest.json`, platform) !== manifestHash) throw fail('REGISTRY_ARTIFACT_MISMATCH');
    let manifest;
    try { manifest = JSON.parse(readProtected(`${path}.manifest.json`, platform).toString('utf8')); }
    catch { throw fail('REGISTRY_ARTIFACT_MISMATCH'); }
    if (!manifest || typeof manifest !== 'object' || manifest.sourceId !== instanceId || manifest.backupId !== backupId || manifest.fileHash !== fileHash || manifest.schemaVersion !== schemaVersion ||
        manifest.schemaChecksum !== schemaChecksum || manifest.completedAt !== completedAt ||
        manifest.toolVersion !== toolVersion || manifest.approvalId !== backupApprovalId ||
        manifest.verification?.integrityCheck !== true || manifest.verification?.foreignKeyCheck !== true ||
        manifest.verification?.schemaCheck !== true || manifest.verification?.hashCheck !== true) throw fail('REGISTRY_ARTIFACT_MISMATCH');
    // Defense in depth, not a provenance proof: only the closure-held writer can reach here.
    let copy;
    try {
      copy = new DatabaseSync(path, { readOnly: true });
      copy.exec('PRAGMA foreign_keys=ON');
      if (getInstanceIdentity(copy).instanceId !== instanceId ||
          createImBackup({ db: copy }).verify({ backupPath: path, manifestPath: `${path}.manifest.json` }).ok !== true)
        throw fail('REGISTRY_ARTIFACT_MISMATCH');
    } catch { throw fail('REGISTRY_ARTIFACT_MISMATCH'); }
    finally { copy?.close(); }
    const value = { recordVersion: 1, instanceId, registrationGeneration, backupId, fileHash, schemaVersion, schemaChecksum,
      completedAt, executorActorId, backupApprovalId, backupApproverId, toolVersion, artifactReference,
      manifestHash, publicationState: 'published', registeredAt: clock() };
    if (!Number.isSafeInteger(value.registeredAt) || value.registeredAt < 0) throw fail('REGISTRY_INVALID_INPUT');
    publish(`backup-${backupId}.json`, value);
    return { ...value, durability: 'durable' };
  }
  function resolveForMigration({ backupId, expected } = {}) {
    if (!ID.test(backupId) || !expected || typeof expected !== 'object') throw fail('REGISTRY_INVALID_INPUT');
    const data = publication(backupId);
    if (revoked(backupId)) throw fail('REGISTRY_REVOKED');
    const current = instance();
    if (data.instanceId !== current.instanceId || data.registrationGeneration !== current.registrationGeneration ||
        expected.instanceId !== data.instanceId || expected.registrationGeneration !== data.registrationGeneration) throw fail('REGISTRY_INSTANCE_MISMATCH');
    if (expected.fileHash !== data.fileHash) throw fail('REGISTRY_HASH_MISMATCH');
    if (expected.schemaVersion !== data.schemaVersion || expected.schemaChecksum !== data.schemaChecksum) throw fail('REGISTRY_SCHEMA_MISMATCH');
    const path = location(data.artifactReference);
    if (hashFile(path, platform) !== data.fileHash || hashFile(`${path}.manifest.json`, platform) !== data.manifestHash) throw fail('REGISTRY_ARTIFACT_MISMATCH');
    return { ...data }; // path is controlled and relative; no DB location or credential
  }
  function revokeBackup({ backupId, adminContext } = {}) {
    requireAdmin(adminContext);
    publication(backupId);
    busy(backupId);
    const revokedAt = clock();
    if (!validTime(revokedAt)) throw fail('REGISTRY_INVALID_INPUT');
    publish(`revoked-${backupId}.json`, { recordVersion: 1, backupId, revokedAt });
  }
  function beginUse(backupId) {
    if (!ID.test(backupId)) throw fail('REGISTRY_INVALID_INPUT');
    publication(backupId);
    if (revoked(backupId)) throw fail('REGISTRY_REVOKED');
    const token = Symbol('backup use');
    if (!uses.has(backupId)) uses.set(backupId, new Set());
    uses.get(backupId).add(token);
    let released = false;
    return Object.freeze({ backupId, end: () => {
      if (released) return;
      released = true;
      const active = uses.get(backupId);
      active.delete(token);
      if (active.size === 0) uses.delete(backupId);
      if (uses.size === 0) { for (const done of waiters) done(); waiters.clear(); }
    } });
  }
  function cleanupBackup({ backupId, adminContext } = {}) {
    requireAdmin(adminContext);
    busy(backupId);
    if (!revoked(backupId)) throw fail('REGISTRY_NOT_REVOKED');
    const path = location(publication(backupId).artifactReference, true);
    let changed = false;
    try {
      // Revocation remains durable; after partial failure retry cleanup of whichever leaf remains.
      for (const leaf of [path, `${path}.manifest.json`]) {
        fault?.('before-artifact-unlink', leaf);
        if (exists(leaf)) { platform.protectedPath(leaf); unlinkSync(leaf); changed = true; }
      }
    } catch {
      if (changed) { try { syncDir(dirname(path)); } catch { throw fail('REGISTRY_CLEANUP_INCOMPLETE'); } }
      throw fail('REGISTRY_CLEANUP_INCOMPLETE');
    }
    if (changed) syncDir(dirname(path));
  }
  const drain = () => uses.size ? new Promise(resolve => waiters.add(resolve)) : Promise.resolve();
  const registry = Object.freeze({ getInstance, resolveForMigration, revokeBackup, beginUse, cleanupBackup, drain,
    status: () => Object.freeze({ activeUses: uses.size }) });
  return { registry, writer: Object.freeze({ registerInstance, registerPublishedBackup }), artifactDirectory: join(root, 'artifacts') };
}

// Reader facade cannot mint provenance, including when reopened independently.
export function createBackupRegistry(options) { return buildRegistry(options).registry; }

// The sole supported minting path. Do not expose the closure-held writer or the backup primitive.
export function createTrustedBackupServices({ db, dir, authority, platform, clock, fault } = {}) {
  const { registry, writer, artifactDirectory } = buildRegistry({ dir, authority, platform, clock, fault });
  const backup = createImBackup({ db, authority, clock });
  const publisher = createBackupPublisher({ db, registry, writer, artifactDirectory, backup, authority });
  return Object.freeze({ publisher, registry });
}
