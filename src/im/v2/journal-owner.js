import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ImV2Error } from './contracts.js';

// Trusted internal registration only: registration is not a capability offered to
// network callers. It does not validate or initialize the journal itself.
const bindings = new WeakMap();
const opened = new WeakMap();
const paths = new Map();
const inodes = new Map();
const connections = new Map();
const unavailable = () => { throw new ImV2Error('STORAGE_UNAVAILABLE'); };
const invalid = () => { throw new ImV2Error('INVALID_REQUEST'); };
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const stat = p => lstatSync(p, { bigint: true });
const safeFile = s => s.isFile() && s.nlink === 1n && s.uid === BigInt(process.geteuid()) && (s.mode & 0o777n) === 0o600n;

function directory(path) {
  let p = path, first = true, result;
  for (;;) {
    const s = stat(p);
    if (!s.isDirectory() || s.isSymbolicLink() || (first
      ? s.uid !== BigInt(process.geteuid()) || (s.mode & 0o777n) !== 0o700n
      : (s.uid !== BigInt(process.geteuid()) && s.uid !== 0n) || (s.mode & 0o022n) !== 0n)) unavailable();
    if (first) result = s;
    first = false;
    const parent = dirname(p);
    if (parent === p) break;
    p = parent;
  }
  if (realpathSync(path) !== path) unavailable();
  return result;
}

function file(path) {
  const s = stat(path);
  if (!safeFile(s) || realpathSync(path) !== path) unavailable();
  return s;
}

function supported() {
  if (process.platform === 'win32' || typeof process.geteuid !== 'function' ||
      !Number.isInteger(constants.O_NOFOLLOW) || !Number.isInteger(constants.O_DIRECTORY)) unavailable();
}

// Offline, trusted provisioning only. Node's SQLite API does not expose its
// database fd: these synchronous path checks do not prove immunity to a
// malicious same-UID ABA swap during open.
export function openImV2JournalDatabase({ path } = {}) {
  supported();
  if (typeof path !== 'string' || !path || path.includes('\0')) invalid();
  let db;
  try {
    const canonicalPath = resolve(path);
    // Check the caller-supplied final component, not SQLite's canonicalization
    // of a symlink supplied as input.
    try { if (stat(path).isSymbolicLink()) unavailable(); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    const root = directory(dirname(canonicalPath));
    let identity;
    try { identity = file(canonicalPath); }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const fd = openSync(canonicalPath, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, 0o600);
      try {
        identity = fstatSync(fd, { bigint: true });
        if (!safeFile(identity)) unavailable();
        fsyncSync(fd);
      } finally { closeSync(fd); }
      syncDirectory(dirname(canonicalPath), root);
    }
    checkPath(canonicalPath, root, identity);
    db = new DatabaseSync(canonicalPath);
    db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
    const info = Object.freeze({ path: canonicalPath, root: Object.freeze({ dev: root.dev, ino: root.ino }),
      identity: Object.freeze({ dev: identity.dev, ino: identity.ino }), inode: `${identity.dev}:${identity.ino}` });
    opened.set(db, info);
    checkMain(db, info);
    return db;
  } catch {
    if (db) try { db.close(); } catch { /* only this function's connection */ }
    unavailable();
  }
}

function main(db) {
  const info = opened.get(db);
  if (!info || !db.isOpen || db.isTransaction !== false) unavailable();
  const rows = db.prepare('PRAGMA database_list').all();
  const names = rows.filter(r => r.name === 'main');
  if (names.length !== 1 || typeof names[0].file !== 'string' || !isAbsolute(names[0].file) ||
      resolve(names[0].file) !== names[0].file || names[0].file === ':memory:' ||
      db.prepare('PRAGMA foreign_keys').get().foreign_keys !== 1 ||
      ![2, 3].includes(db.prepare('PRAGMA synchronous').get().synchronous)) unavailable();
  if (names[0].file !== info.path) unavailable();
  checkPath(info.path, info.root, info.identity);
  return info;
}

function checkPath(path, root, identity) {
  if (!same(directory(dirname(path)), root) || !same(file(path), identity)) unavailable();
}

function checkMain(db, info) {
  const next = main(db);
  if (next.path !== info.path || !same(next.root, info.root) || !same(next.identity, info.identity)) unavailable();
}

function syncDirectory(path, identity) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    if (!same(fstatSync(fd, { bigint: true }), identity)) unavailable();
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

function inspectSidecar(db) {
  if (db.prepare('PRAGMA journal_mode').get().journal_mode.toLowerCase() !== 'delete' ||
      db.prepare('PRAGMA user_version').get().user_version !== 1 ||
      db.prepare('PRAGMA quick_check(1)').get().quick_check !== 'ok') unavailable();
}

export function registerImV2JournalBinding(journal, db) {
  if (!journal || typeof journal !== 'object' || !Object.isFrozen(journal) ||
      !opened.has(db)) invalid();
  supported();
  try { main(db); } catch { unavailable(); }
  if (bindings.has(journal)) { if (bindings.get(journal) !== db) invalid(); return; }
  bindings.set(journal, db);
}

// Preconditions: trusted registration of a successfully validated facade, an
// idle caller DB (no external transaction), private canonical POSIX storage.
// assertHeld is to be called outside short-lived journal business transactions.
export function acquireImV2JournalOwner(journal) {
  supported();
  if (!journal || (typeof journal !== 'object' && typeof journal !== 'function') || !bindings.has(journal)) invalid();
  const db = bindings.get(journal);
  const token = Symbol('journal owner');
  let info, side, sideIdentity, lock, initialized = false;
  const clearReservation = () => {
    if (info && paths.get(info.path) === token) paths.delete(info.path);
    if (info && inodes.get(info.inode) === token) inodes.delete(info.inode);
    if (connections.get(db) === token) connections.delete(db);
  };
  try {
    // DB reservation precedes even caller methods/getters. Unique tokens ensure
    // a failed, possibly reentrant attempt cannot erase another owner's slot.
    if (connections.has(db)) unavailable();
    connections.set(db, token);
    info = main(db);
    if (paths.has(info.path) || inodes.has(info.inode)) unavailable();
    paths.set(info.path, token);
    inodes.set(info.inode, token);
    side = `${info.path}.owner.sqlite`;
    try {
      sideIdentity = file(side); // NEVER raw-open an existing sidecar.
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const fd = openSync(side, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, 0o600);
      try {
        sideIdentity = fstatSync(fd, { bigint: true });
        if (!safeFile(sideIdentity)) unavailable();
        fsyncSync(fd);
      } finally { closeSync(fd); }
      checkPath(info.path, info.root, info.identity);
      checkPath(side, info.root, sideIdentity);
      // If interrupted before these durable steps finish, retain the sidecar:
      // a later attempt must fail closed, never unlink/recreate it.
      const init = new DatabaseSync(side, { timeout: 0 });
      try {
        init.exec('PRAGMA busy_timeout=0');
        init.exec('PRAGMA journal_mode=DELETE');
        init.exec('PRAGMA synchronous=FULL');
        init.exec('PRAGMA user_version=1');
        inspectSidecar(init);
      } finally { init.close(); }
      const syncfd = openSync(side, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!same(fstatSync(syncfd, { bigint: true }), sideIdentity)) unavailable();
        fsyncSync(syncfd);
      } finally { closeSync(syncfd); }
      syncDirectory(dirname(side), info.root);
      initialized = true;
    }
    if (same(sideIdentity, info.identity)) unavailable();
    checkPath(info.path, info.root, info.identity);
    checkPath(side, info.root, sideIdentity);
    lock = new DatabaseSync(side, { timeout: 0 });
    lock.exec('PRAGMA busy_timeout=0');
    inspectSidecar(lock);
    if (!initialized) checkPath(side, info.root, sideIdentity);
    checkMain(db, info);
    lock.exec('BEGIN IMMEDIATE');
    if (!lock.isTransaction) unavailable();
    checkMain(db, info);
    checkPath(side, info.root, sideIdentity);
    let state = 'held', rolledBack = false, closed = false;
    return Object.freeze({
      assertHeld() {
        if (state !== 'held') unavailable();
        try {
          checkMain(db, info);
          checkPath(side, info.root, sideIdentity);
          if (!lock.isTransaction || lock.prepare('PRAGMA database_list').all().find(r => r.name === 'main')?.file !== side) unavailable();
        } catch { unavailable(); }
      },
      release() {
        if (state === 'released') return;
        let failed = false;
        if (!closed) {
          if (!rolledBack) {
            try {
              if (!lock.isTransaction) unavailable();
              lock.exec('ROLLBACK');
              rolledBack = true;
            } catch { failed = true; }
          }
          try { lock.close(); closed = true; } catch { failed = true; }
        }
        if (closed) clearReservation();
        state = failed ? 'release_failed' : 'released';
        if (failed) unavailable();
      },
    });
  } catch {
    if (lock) {
      try { if (lock.isTransaction) lock.exec('ROLLBACK'); } catch { /* preserve failure */ }
      try { lock.close(); } catch { /* uncertain close retains reservation */ return unavailable(); }
    }
    clearReservation();
    unavailable();
  }
}
