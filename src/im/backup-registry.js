import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { withClosedBackupSnapshot } from './backup-snapshot.js';
import { getInstanceIdentity } from './schema.js';
import { createImBackup } from './backup.js';
import { createBackupPublisher } from './backup-publisher.js';
import { createRegistryLock } from './registry-lock.js';

const fail = code => Object.assign(new Error(code), { code });
const ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 255 && !/[\x00-\x1f\x7f]/.test(value);
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const exists = path => { try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const shape = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const validTime = value => Number.isSafeInteger(value) && value >= 0;
const instanceKeys = ['recordVersion', 'instanceId', 'instanceCreatedAt', 'dbLocation', 'registrationGeneration'];
const backupKeys = ['recordVersion', 'instanceId', 'instanceCreatedAt', 'registrationGeneration', 'backupId', 'fileHash', 'schemaVersion',
  'schemaChecksum', 'completedAt', 'executorActorId', 'backupApprovalId', 'backupApproverId', 'toolVersion',
  'artifactReference', 'manifestHash', 'publicationState', 'registeredAt'];
const revocationKeys = ['recordVersion', 'backupId', 'revokedAt'];
const invalid = () => { throw fail('REGISTRY_UNTRUSTED_RECORD'); };
// Authentic facade membership for the narrowly scoped independent-copy bridge.
const protectedCopies = new WeakMap();

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

function buildRegistry({ dir, authority, clock = Date.now, fault } = {}) {
  if (typeof dir !== 'string' || !dir || typeof clock !== 'function') throw fail('REGISTRY_INVALID_INPUT');
  const platform = defaultPlatform;
  const root = platform.privateDirectory(dir);
  const coordinator = createRegistryLock(root, platform);
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
    if (!shape(data, instanceKeys) || data.recordVersion !== 2 || !ID.test(data.instanceId) || !validTime(data.instanceCreatedAt) ||
        !text(data.dbLocation) || data.registrationGeneration !== 1) invalid();
    return data;
  };
  const publication = backupId => {
    if (!ID.test(backupId)) throw fail('REGISTRY_INVALID_INPUT');
    const data = record(`backup-${backupId}.json`);
    if (!shape(data, backupKeys) || data.recordVersion !== 2 || data.backupId !== backupId || !validTime(data.instanceCreatedAt) ||
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
  function registerInstance({ instanceId, instanceCreatedAt, dbLocation, adminContext } = {}) {
    requireAdmin(adminContext);
    if (!ID.test(instanceId) || !validTime(instanceCreatedAt) || !text(dbLocation)) throw fail('REGISTRY_INVALID_INPUT');
    const value = { recordVersion: 2, instanceId, instanceCreatedAt, dbLocation, registrationGeneration: 1 };
    coordinator.withLock(() => publish('instance-1.json', value));
    return { instanceId, instanceCreatedAt, registrationGeneration: 1 }; // never disclose dbLocation in public returns
  }
  function getInstance() {
    return coordinator.withLock(() => {
      const { instanceId, instanceCreatedAt, registrationGeneration } = instance();
      return { instanceId, instanceCreatedAt, registrationGeneration };
    });
  }
  function registerPublishedBackup({ instanceId, instanceCreatedAt, registrationGeneration, backupId, fileHash, schemaVersion,
    schemaChecksum, completedAt, executorActorId, backupApprovalId, backupApproverId, toolVersion,
    artifactReference, manifestHash, adminContext } = {}) {
    requireAdmin(adminContext);
    return coordinator.withLock(() => {
    const current = instance();
    if (instanceId !== current.instanceId || instanceCreatedAt !== current.instanceCreatedAt || registrationGeneration !== current.registrationGeneration) throw fail('REGISTRY_INSTANCE_MISMATCH');
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
    try {
      withClosedBackupSnapshot(path, copy => {
        const copied = getInstanceIdentity(copy);
        if (copied.instanceId !== instanceId || copied.createdAt !== instanceCreatedAt ||
            createImBackup({ db: copy }).verify({ backupPath: path, manifestPath: `${path}.manifest.json` }).ok !== true)
          throw fail('REGISTRY_ARTIFACT_MISMATCH');
      });
    } catch { throw fail('REGISTRY_ARTIFACT_MISMATCH'); }
    const value = { recordVersion: 2, instanceId, instanceCreatedAt, registrationGeneration, backupId, fileHash, schemaVersion, schemaChecksum,
      completedAt, executorActorId, backupApprovalId, backupApproverId, toolVersion, artifactReference,
      manifestHash, publicationState: 'published', registeredAt: clock() };
    if (!Number.isSafeInteger(value.registeredAt) || value.registeredAt < 0) throw fail('REGISTRY_INVALID_INPUT');
    publish(`backup-${backupId}.json`, value);
    return { ...value, durability: 'durable' };
    });
  }
  function metadataLocked({ backupId, expected } = {}) {
    if (!expected || typeof expected !== 'object' || typeof expected.fileHash !== 'string' || !HASH.test(expected.fileHash) ||
        typeof expected.manifestHash !== 'string' || !HASH.test(expected.manifestHash) ||
        !Number.isSafeInteger(expected.schemaVersion) || expected.schemaVersion < 1 ||
        typeof expected.schemaChecksum !== 'string' || !HASH.test(expected.schemaChecksum)) throw fail('REGISTRY_INVALID_INPUT');
    const data = boundPublicationLocked(backupId, expected);
    matchApprovedEvidence(data, expected);
    return data;
  }
  function boundPublicationLocked(backupId, expectedIdentity) {
    if (typeof backupId !== 'string' || !ID.test(backupId) || !expectedIdentity ||
        typeof expectedIdentity !== 'object' || typeof expectedIdentity.instanceId !== 'string' ||
        !ID.test(expectedIdentity.instanceId) || !validTime(expectedIdentity.instanceCreatedAt) ||
        expectedIdentity.registrationGeneration !== 1) throw fail('REGISTRY_INVALID_INPUT');
    const data = publication(backupId);
    if (revoked(backupId)) throw fail('REGISTRY_REVOKED');
    const current = instance();
    if (data.instanceId !== current.instanceId || data.instanceCreatedAt !== current.instanceCreatedAt ||
        data.registrationGeneration !== current.registrationGeneration || expectedIdentity.instanceId !== data.instanceId ||
        expectedIdentity.instanceCreatedAt !== data.instanceCreatedAt || expectedIdentity.registrationGeneration !== data.registrationGeneration) throw fail('REGISTRY_INSTANCE_MISMATCH');
    return data;
  }
  function matchApprovedEvidence(data, expected) {
    if (expected.fileHash !== data.fileHash) throw fail('REGISTRY_HASH_MISMATCH');
    if (expected.manifestHash !== data.manifestHash) throw fail('REGISTRY_HASH_MISMATCH');
    if (expected.schemaVersion !== data.schemaVersion || expected.schemaChecksum !== data.schemaChecksum) throw fail('REGISTRY_SCHEMA_MISMATCH');
  }
  function resolveLocked(input) {
    const data = metadataLocked(input);
    const path = location(data.artifactReference);
    if (hashFile(path, platform) !== data.fileHash || hashFile(`${path}.manifest.json`, platform) !== data.manifestHash) throw fail('REGISTRY_ARTIFACT_MISMATCH');
    return { ...data }; // path is controlled and relative; no DB location or credential
  }
  function verifyRecordLocked(data) {
    const path = location(data.artifactReference);
    if (hashFile(path, platform) !== data.fileHash || hashFile(`${path}.manifest.json`, platform) !== data.manifestHash) throw fail('REGISTRY_ARTIFACT_MISMATCH');
    const manifestPath = `${path}.manifest.json`;
    let manifest;
    try {
      manifest = JSON.parse(readProtected(manifestPath, platform).toString('utf8'));
      if (manifest.sourceId !== data.instanceId || manifest.backupId !== data.backupId ||
          manifest.fileHash !== data.fileHash || manifest.schemaVersion !== data.schemaVersion ||
          manifest.schemaChecksum !== data.schemaChecksum || manifest.completedAt !== data.completedAt ||
          manifest.toolVersion !== data.toolVersion || manifest.approvalId !== data.backupApprovalId ||
          hashFile(manifestPath, platform) !== data.manifestHash ||
          createImBackup({}).verify({ backupPath: path, manifestPath }).ok !== true) throw Error('invalid backup');
      withClosedBackupSnapshot(path, copy => {
        const identity = getInstanceIdentity(copy);
        if (identity.instanceId !== data.instanceId || identity.createdAt !== data.instanceCreatedAt) throw Error('wrong copy');
      });
    } catch { throw fail('REGISTRY_ARTIFACT_MISMATCH'); }
    return Object.freeze({ backupId: data.backupId, instanceId: data.instanceId,
      instanceCreatedAt: data.instanceCreatedAt, registrationGeneration: data.registrationGeneration,
      fileHash: data.fileHash, manifestHash: data.manifestHash, schemaVersion: data.schemaVersion,
      schemaChecksum: data.schemaChecksum });
  }
  function verifiedScope(input, callback, discover) {
    if (typeof callback !== 'function') throw fail('REGISTRY_INVALID_INPUT');
    if (Object.prototype.toString.call(callback) === '[object AsyncFunction]') throw fail('REGISTRY_ASYNC_CALLBACK');
    const supplied = discover ? input?.expectedIdentity : input?.expected;
    const snapshot = { backupId: input?.backupId, expected: { instanceId: supplied?.instanceId,
      instanceCreatedAt: supplied?.instanceCreatedAt, registrationGeneration: supplied?.registrationGeneration,
      ...(!discover && { fileHash: supplied?.fileHash, manifestHash: supplied?.manifestHash,
        schemaVersion: supplied?.schemaVersion, schemaChecksum: supplied?.schemaChecksum }) } };
    return coordinator.withLock(() => {
      let active = true;
      try {
        const data = discover ? boundPublicationLocked(snapshot.backupId, snapshot.expected) : metadataLocked(snapshot);
        const verified = verifyRecordLocked(data);
        const bound = { backupId: verified.backupId, expected: { ...verified } };
        const evidence = Object.freeze({ ...verified, recheck: () => {
          if (!active) throw fail('REGISTRY_USE_EXPIRED');
          const current = metadataLocked(bound);
          for (const key of ['backupId', 'instanceId', 'instanceCreatedAt', 'registrationGeneration',
            'fileHash', 'manifestHash', 'schemaVersion', 'schemaChecksum'])
            if (current[key] !== verified[key]) throw fail('REGISTRY_UNTRUSTED_RECORD');
          return verified;
        } });
        return callback(evidence);
      } finally { active = false; }
    });
  }
  function withVerifiedBackup(input, callback) { return verifiedScope(input, callback, false); }
  function withDiscoveredBackup(input, callback) { return verifiedScope(input, callback, true); }
  function resolveForMigration(input) { return coordinator.withLock(() => resolveLocked(input)); }
  function revokeBackup({ backupId, adminContext } = {}) {
    requireAdmin(adminContext);
    return coordinator.withLock(() => {
    publication(backupId);
    const revokedAt = clock();
    if (!validTime(revokedAt)) throw fail('REGISTRY_INVALID_INPUT');
    publish(`revoked-${backupId}.json`, { recordVersion: 1, backupId, revokedAt });
    });
  }
  function cleanupBackup({ backupId, adminContext } = {}) {
    requireAdmin(adminContext);
    return coordinator.withLock(() => {
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
    });
  }
  const registry = Object.freeze({ getInstance, resolveForMigration, withVerifiedBackup, withDiscoveredBackup, revokeBackup, cleanupBackup });
  protectedCopies.set(registry, (input, consume) => {
    if (!input || Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).some(key =>
      !['backupId', 'adminContext', 'limits', 'tick'].includes(key) ||
      !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key), 'value'))) throw fail('REGISTRY_INVALID_INPUT');
    const { backupId, adminContext, limits = {}, tick: outerTick } = input;
    if (!limits || Object.getPrototypeOf(limits) !== Object.prototype || Reflect.ownKeys(limits).some(key =>
      !['maxFileBytes', 'maxElapsedMs'].includes(key) ||
      !Object.hasOwn(Object.getOwnPropertyDescriptor(limits, key), 'value')) ||
      (outerTick !== undefined && typeof outerTick !== 'function')) throw fail('REGISTRY_INVALID_INPUT');
    const bounds = { maxFileBytes: 134217728, maxElapsedMs: 10000, ...limits };
    for (const key of Object.keys(bounds)) if (!Number.isSafeInteger(bounds[key]) || bounds[key] < 1 ||
      bounds[key] > (key === 'maxFileBytes' ? 134217728 : 10000)) throw fail('REGISTRY_INVALID_INPUT');
    const start = performance.now();
    const tick = () => {
      if (performance.now() - start > bounds.maxElapsedMs) throw fail('REGISTRY_BUSY');
      outerTick?.();
    };
    const rejectPromise = value => {
      if (value && typeof value.then === 'function') {
        void Promise.resolve(value).catch(() => {});
        throw fail('REGISTRY_ASYNC_CALLBACK');
      }
    };
    requireAdmin(adminContext);
    if (typeof consume !== 'function' || Object.prototype.toString.call(consume) === '[object AsyncFunction]')
      throw fail('REGISTRY_INVALID_INPUT');
    return coordinator.withLock(() => {
      const data = boundPublicationLocked(backupId, instance());
      if (data.schemaVersion !== 3) throw fail('REGISTRY_SCHEMA_MISMATCH');
      const path = location(data.artifactReference);
      const checkSize = () => { tick(); if (platform.protectedPath(path).size > bounds.maxFileBytes) throw fail('REGISTRY_BUSY'); };
      checkSize();
      const noSidecars = () => {
        if (['-wal', '-shm', '-journal'].some(suffix => exists(`${path}${suffix}`))) throw fail('REGISTRY_ARTIFACT_MISMATCH');
      };
      noSidecars();
      const recordBytes = readProtected(join(root, `backup-${backupId}.json`), platform, 65536);
      const manifestBytes = readProtected(`${path}.manifest.json`, platform, 65536);
      const sourceHash = () => {
        checkSize();
        const before = platform.protectedPath(path), digest = createHash('sha256');
        let fd;
        try {
          fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
          platform.checkOpened(path, before, fstatSync(fd));
          const buffer = Buffer.allocUnsafe(65536); let count, total = 0;
          while (true) {
            tick(); count = readSync(fd, buffer, 0, buffer.length, null); if (!count) break;
            total += count; if (total > bounds.maxFileBytes) throw fail('REGISTRY_BUSY');
            digest.update(buffer.subarray(0, count)); tick();
          }
          const after = fstatSync(fd); platform.checkOpened(path, before, after);
          if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) invalid();
          const result = digest.digest('hex'); tick(); return result;
        } finally { if (fd !== undefined) closeSync(fd); }
      };
      const verifyClosedSnapshot = () => {
        noSidecars(); checkSize();
        if (sourceHash() !== data.fileHash || createHash('sha256').update(manifestBytes).digest('hex') !== data.manifestHash)
          throw fail('REGISTRY_ARTIFACT_MISMATCH');
        try {
          const manifest = JSON.parse(manifestBytes.toString('utf8'));
          if (manifest.sourceId !== data.instanceId || manifest.backupId !== data.backupId || manifest.fileHash !== data.fileHash ||
              manifest.schemaVersion !== 3 || manifest.schemaChecksum !== data.schemaChecksum || manifest.completedAt !== data.completedAt ||
              manifest.toolVersion !== data.toolVersion || manifest.approvalId !== data.backupApprovalId ||
              ['integrityCheck', 'foreignKeyCheck', 'schemaCheck', 'hashCheck'].some(key => manifest.verification?.[key] !== true)) invalid();
          // Genuine registered online-backup provenance plus absence of sidecars
          // permits immutable reads. Never use this for arbitrary live databases.
          withClosedBackupSnapshot(path, copy => {
            tick();
            for (const row of copy.prepare('PRAGMA integrity_check').iterate()) { tick(); if (row.integrity_check !== 'ok') invalid(); }
            tick();
            for (const row of copy.prepare('PRAGMA foreign_key_check').iterate()) { tick(); invalid(); }
            tick();
            // Historical schema validation remains a noninterruptible synchronous
            // call; the first-error FK pass above prevents collecting corrupt rows.
            const identity = getInstanceIdentity(copy); tick();
            const marker = copy.prepare('SELECT version,migration_checksum FROM im_schema').get();
            if (identity.instanceId !== data.instanceId || identity.createdAt !== data.instanceCreatedAt ||
                marker.version !== 3 || marker.migration_checksum !== data.schemaChecksum) invalid();
          });
        } catch (e) {
          if (e?.code === 'REGISTRY_BUSY' || e?.code === 'RECOVERY_BUSY') throw e;
          throw fail('REGISTRY_ARTIFACT_MISMATCH');
        }
        noSidecars(); if (sourceHash() !== data.fileHash) throw fail('REGISTRY_ARTIFACT_MISMATCH'); tick();
      };
      verifyClosedSnapshot();
      let active = true;
      try {
        const result = consume(Object.freeze({ recordBytes: Buffer.from(recordBytes), manifestBytes: Buffer.from(manifestBytes),
          copyTo(writeChunk) {
            if (!active) throw fail('REGISTRY_USE_EXPIRED');
            if (typeof writeChunk !== 'function') throw fail('REGISTRY_INVALID_INPUT');
            if (Object.prototype.toString.call(writeChunk) === '[object AsyncFunction]') throw fail('REGISTRY_ASYNC_CALLBACK');
            checkSize();
            const before = platform.protectedPath(path);
            let fd;
            try {
              fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
              platform.checkOpened(path, before, fstatSync(fd));
              const buffer = Buffer.allocUnsafe(65536), digest = createHash('sha256');
              let count, total = 0;
              while (true) {
                tick(); count = readSync(fd, buffer, 0, buffer.length, null);
                if (!count) break;
                total += count; if (total > bounds.maxFileBytes) throw fail('REGISTRY_BUSY');
                const chunk = Buffer.from(buffer.subarray(0, count)); digest.update(chunk);
                const output = writeChunk(chunk);
                try { rejectPromise(output); } catch (e) { active = false; throw e; }
                tick();
              }
              const after = fstatSync(fd); platform.checkOpened(path, before, after);
              if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) invalid();
              if (digest.digest('hex') !== data.fileHash) throw fail('REGISTRY_ARTIFACT_MISMATCH');
              tick();
            } finally { if (fd !== undefined) closeSync(fd); }
          } }));
        rejectPromise(result);
        verifyClosedSnapshot();
        if (!recordBytes.equals(readProtected(join(root, `backup-${backupId}.json`), platform, 65536)) ||
             !manifestBytes.equals(readProtected(`${path}.manifest.json`, platform, 65536))) throw fail('REGISTRY_ARTIFACT_MISMATCH');
        tick();
        return result;
      } finally { active = false; }
    });
  });
  return { registry, writer: Object.freeze({ registerInstance, registerPublishedBackup }), artifactDirectory: join(root, 'artifacts') };
}

// No raw source path or registration writer crosses this boundary. The consuming
// trusted adapter must finish independent destination verification before return.
export function withProtectedBackupCopy(registry, input, consume) {
  const copy = protectedCopies.get(registry);
  if (!copy) throw fail('REGISTRY_INVALID_INPUT');
  return copy(input, consume);
}

// Reader facade cannot mint provenance, including when reopened independently.
export function createBackupRegistry(options) { return buildRegistry(options).registry; }

// The sole supported minting path. Do not expose the closure-held writer or the backup primitive.
export function createTrustedBackupServices({ db, dir, authority, clock, fault } = {}) {
  const { registry, writer, artifactDirectory } = buildRegistry({ dir, authority, clock, fault });
  const backup = createImBackup({ db, authority, clock });
  const publisher = createBackupPublisher({ db, registry, writer, artifactDirectory, backup, authority });
  return Object.freeze({ publisher, registry });
}
