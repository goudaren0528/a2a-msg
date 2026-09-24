import { createHash, randomUUID } from 'node:crypto';
import { constants, lstatSync, openSync, closeSync, writeFileSync, fsyncSync, linkSync, unlinkSync, readFileSync, statSync, readSync } from 'node:fs';
import { dirname, basename, join, resolve } from 'node:path';
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { assertImSchema, SUPPORTED_IM_SCHEMA_VERSIONS } from './schema.js';

const fail = code => Object.assign(new Error(code), { code });
const sha = path => {
  const hash = createHash('sha256');
  const fd = openSync(path, constants.O_RDONLY);
  const chunk = Buffer.allocUnsafe(256 * 1024);
  try { let length; while ((length = readSync(fd, chunk, 0, chunk.length, null)) !== 0) hash.update(chunk.subarray(0, length)); }
  finally { closeSync(fd); }
  return hash.digest('hex');
};
const flush = (path, flags = constants.O_RDWR) => { const fd = openSync(path, flags); try { fsyncSync(fd); } finally { closeSync(fd); } };
const inFlight = new WeakMap();
const hashPattern = /^[0-9a-f]{64}$/;
const metadata = value => typeof value === 'string' && value.length > 0 && value.length <= 255 && !/[\r\n\x00-\x1f]/.test(value);
const present = path => { try { lstatSync(path); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; } };
const own = (path, identity) => {
  try { const now = lstatSync(path); return now.dev === identity.dev && now.ino === identity.ino; }
  catch { return false; }
};

function inspect(path) {
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA foreign_keys=ON');
    if (db.prepare('PRAGMA integrity_check').all().some(row => row.integrity_check !== 'ok')) throw fail('BACKUP_VERIFY_FAILED');
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw fail('BACKUP_VERIFY_FAILED');
    assertImSchema(db);
    const { version, migration_checksum: schemaChecksum } = db.prepare('SELECT version,migration_checksum FROM im_schema').get();
    if (!SUPPORTED_IM_SCHEMA_VERSIONS.includes(version) || !hashPattern.test(schemaChecksum)) throw fail('BACKUP_VERIFY_FAILED');
    return { schemaVersion: version, schemaChecksum };
  } catch { throw fail('BACKUP_VERIFY_FAILED'); }
  finally { db?.close(); }
}

// The manifest is the success proof; a database file without a matching manifest is NOT a usable backup.
export function createImBackup({ db, authority, clock = Date.now, toolVersion = 'im-backup-v1', backupTimeBudgetMs = 30000,
  backupRate = 256, durability = 'strict', nativeBackup = sqliteBackup, fault } = {}) {
  const internalProof = Symbol('pending verification');
  const status = () => Object.freeze({ nativeInFlight: !!(db && inFlight.has(db)) });
  const drain = () => db && inFlight.has(db) ? inFlight.get(db) : Promise.resolve();
  async function backup({ destinationPath, approvalId, sourceId, adminContext } = {}) {
    // No filesystem output (including reservations) before this synchronous, literal-true check.
    let authorized = false;
    try { authorized = authority?.authorizeAdmin(adminContext) === true; }
    catch { /* fail closed */ }
    if (!authorized) throw fail('BACKUP_AUTH_DENIED');
    if (!metadata(approvalId) || !metadata(sourceId) || !metadata(toolVersion) ||
        !Number.isSafeInteger(backupTimeBudgetMs) || backupTimeBudgetMs < 1 || backupTimeBudgetMs > 300000 ||
        !Number.isSafeInteger(backupRate) || backupRate < 1 || backupRate > 100000 ||
        !['strict', 'best-effort'].includes(durability) ||
        typeof destinationPath !== 'string' || !destinationPath || !db) throw fail('BACKUP_FAILED');
    if (inFlight.has(db)) throw fail('BACKUP_BUSY');
    if (typeof nativeBackup !== 'function') throw fail('BACKUP_UNSUPPORTED');

    const target = resolve(destinationPath);
    const manifestPath = `${target}.manifest.json`;
    const parent = dirname(target);
    let temp, tempManifest, published, publishedManifest, runningBackup, settledBackup, releaseBackup;
    let degraded = false;
    const syncDirectory = () => {
      try { fault?.('directory-sync'); flush(parent, constants.O_RDONLY); }
      catch (error) {
        if (durability === 'best-effort' && ['EPERM', 'EACCES', 'EINVAL', 'ENOTSUP', 'EISDIR'].includes(error?.code)) degraded = true;
        else throw fail('BACKUP_DURABILITY_UNAVAILABLE');
      }
    };
    const deadline = performance.now() + backupTimeBudgetMs;
    const checkDeadline = () => { if (performance.now() >= deadline) throw fail('BACKUP_BUSY'); };
    try {
      if (!lstatSync(parent).isDirectory() || present(target) || present(manifestPath)) throw fail('BACKUP_TARGET_EXISTS');
      temp = join(parent, `.${basename(target)}.${randomUUID()}.pending`);
      tempManifest = `${temp}.manifest.pending`;
      // Node's online backup API takes a consistent SQLite snapshot while writes continue.
      {
        let timer;
        runningBackup = Promise.resolve().then(() => nativeBackup(db, temp, { rate: backupRate }));
        settledBackup = new Promise(resolve => { releaseBackup = resolve; });
        inFlight.set(db, settledBackup);
        // There is no native cancellation API. On timeout no output is published; a still-running
        // backup owns its private pending file until it settles, when cleanup is retried.
        try {
          await Promise.race([runningBackup, new Promise((_, reject) => {
            timer = setTimeout(() => reject(fail('BACKUP_BUSY')), Math.max(1, deadline - performance.now()));
          })]);
        } finally { clearTimeout(timer); }
        checkDeadline();
      }
      // SQLite has closed the destination connection; sync its final database bytes before publication.
      flush(temp);
      checkDeadline();
      const snapshot = inspect(temp);
      checkDeadline();
      const fileHash = sha(temp);
      checkDeadline();
      const completedAt = clock();
      if (!Number.isSafeInteger(completedAt) || completedAt < 0) throw fail('BACKUP_FAILED');
      const manifest = { backupId: randomUUID(), sourceId, ...snapshot, toolVersion, completedAt,
        fileHash, verification: { integrityCheck: true, foreignKeyCheck: true, schemaCheck: true, hashCheck: true }, approvalId };
      const fd = openSync(tempManifest, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try { writeFileSync(fd, JSON.stringify(manifest)); fsyncSync(fd); }
      finally { closeSync(fd); }
      if (!verify({ backupPath: temp, manifestPath: tempManifest }, internalProof).ok) throw fail('BACKUP_VERIFY_FAILED');
      checkDeadline();
      if (present(target) || present(manifestPath)) throw fail('BACKUP_TARGET_EXISTS');
      // Hard links are atomic no-replace publication within this one directory. Manifest goes LAST.
      fault?.('before-target-link');
      linkSync(temp, target);
      published = statSync(target);
      syncDirectory();
      fault?.('before-manifest-link');
      fault?.('manifest-link');
      linkSync(tempManifest, manifestPath);
      publishedManifest = statSync(manifestPath);
      syncDirectory();
      checkDeadline();
      return { backupPath: target, manifestPath, manifest, durability: degraded ? 'degraded' : 'durable' };
    } catch (error) {
      if (publishedManifest && own(manifestPath, publishedManifest)) { try { unlinkSync(manifestPath); } catch { /* report failure */ } }
      if (published && own(target, published)) { try { unlinkSync(target); } catch { /* no success manifest was published */ } }
      if (published) { try { syncDirectory(); } catch { /* already failing */ } }
      if (['BACKUP_TARGET_EXISTS', 'BACKUP_VERIFY_FAILED', 'BACKUP_BUSY', 'BACKUP_DURABILITY_UNAVAILABLE', 'BACKUP_UNSUPPORTED'].includes(error?.code)) throw fail(error.code);
      throw fail('BACKUP_FAILED');
    } finally {
      const clean = () => { for (const path of [temp && `${temp}-wal`, temp && `${temp}-shm`, temp, tempManifest]) if (path) { try { unlinkSync(path); } catch { /* pending files never count as proof */ } } };
      if (runningBackup) {
        void runningBackup.then(clean, clean).then(() => { if (inFlight.get(db) === settledBackup) inFlight.delete(db); releaseBackup(); });
      } else clean();
    }
  }

  function verify({ backupPath, manifestPath } = {}, proof) {
    try {
      if (typeof backupPath !== 'string' || typeof manifestPath !== 'string' ||
          (proof !== internalProof && (backupPath.includes('.pending') || manifestPath.includes('.pending'))) ||
          !lstatSync(backupPath).isFile() || !lstatSync(manifestPath).isFile()) throw fail('BACKUP_VERIFY_FAILED');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (!metadata(manifest.backupId) || !metadata(manifest.sourceId) || !metadata(manifest.approvalId) ||
          !metadata(manifest.toolVersion) || !Number.isSafeInteger(manifest.completedAt) ||
          manifest.completedAt < 0 || !hashPattern.test(manifest.fileHash) ||
          manifest.verification?.integrityCheck !== true || manifest.verification?.foreignKeyCheck !== true ||
          manifest.verification?.schemaCheck !== true || manifest.verification?.hashCheck !== true) throw fail('BACKUP_VERIFY_FAILED');
      if (sha(backupPath) !== manifest.fileHash) throw fail('BACKUP_VERIFY_FAILED');
      const snapshot = inspect(backupPath);
      if (snapshot.schemaVersion !== manifest.schemaVersion || snapshot.schemaChecksum !== manifest.schemaChecksum) throw fail('BACKUP_VERIFY_FAILED');
      return { ok: true, code: 'BACKUP_VERIFIED', backupId: manifest.backupId,
        schemaVersion: snapshot.schemaVersion, fileHash: manifest.fileHash };
    } catch { return { ok: false, code: 'BACKUP_VERIFY_FAILED' }; }
  }

  return Object.freeze({ backup, verify, status, drain });
}
