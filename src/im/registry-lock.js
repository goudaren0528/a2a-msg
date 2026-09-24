import { constants, closeSync, fstatSync, fsyncSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const fail = code => Object.assign(new Error(code), { code });
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const asyncFunction = callback => Object.prototype.toString.call(callback) === '[object AsyncFunction]';
const busy = error => (error?.sqliteCode === 5 || error?.sqliteCode === 6 ||
  error?.code === 'SQLITE_BUSY' || error?.code === 'SQLITE_LOCKED' ||
  /\b(?:database is locked|database is busy|SQLITE_BUSY|SQLITE_LOCKED)\b/i.test(String(error?.message ?? '')));

// This is a lock database, not the live IM database. Never unlink it after initialization.
// SQLite owns the OS byte-range lock; a process dying releases it without a stale PID lease.
export function createRegistryLock(root, platform) {
  if (process.platform === 'win32' || typeof process.geteuid !== 'function' || !constants.O_NOFOLLOW)
    throw fail('REGISTRY_PERMISSION_UNVERIFIED');
  const path = join(root, 'coordination.sqlite');
  platform.privateDirectory(root);
  let fd;
  try {
    fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    const created = fstatSync(fd);
    platform.checkOpened(path, created, created);
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    let db;
    try {
      db = new DatabaseSync(path);
      db.exec('PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=0; PRAGMA user_version=1');
      db.close(); db = undefined;
      const current = platform.protectedPath(path);
      if (!same(current, created)) throw fail('REGISTRY_UNTRUSTED_PATH');
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      platform.checkOpened(path, current, fstatSync(fd));
      fsyncSync(fd);
      closeSync(fd); fd = undefined;
      platform.syncDirectory(root);
    } finally { db?.close(); }
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (error.code !== 'EEXIST') {
      // Once SQLite touched this path, never remove it: another opener may hold its inode.
      throw error.code?.startsWith('REGISTRY_') ? error : fail('REGISTRY_DURABILITY_UNAVAILABLE');
    }
  }
  function validate() {
    platform.privateDirectory(root);
    // Never open/close this inode outside SQLite once initialization is complete:
    // closing ANY raw fd in this process drops all its POSIX record locks, even
    // locks held by a different SQLite connection in an active transaction.
    // protectedPath uses lstat to check regular file, owner, mode and nlink.
    return platform.protectedPath(path);
  }
  validate();
  function probe() {
    // Never open a surprise WAL mode in writable mode: it might create sidecars.
    const before = validate();
    let read;
    try {
      read = new DatabaseSync(path, { readOnly: true });
      read.exec('PRAGMA busy_timeout=0');
      if (!same(before, validate()) || read.prepare('PRAGMA journal_mode').get().journal_mode.toLowerCase() !== 'delete' ||
          read.prepare('PRAGMA user_version').get().user_version !== 1)
        throw fail('REGISTRY_UNTRUSTED_PATH');
    } catch (error) {
      if (busy(error)) throw fail('REGISTRY_BUSY');
      throw error?.code?.startsWith('REGISTRY_') ? error : fail('REGISTRY_UNTRUSTED_PATH');
    }
    finally { read?.close(); }
  }
  // Another process may have won O_EXCL but not completed initialization. Fail
  // closed instead of opening or repairing its half-initialized inode.
  probe();
  function withLock(callback) {
    if (typeof callback !== 'function') throw fail('REGISTRY_INVALID_INPUT');
    if (asyncFunction(callback)) throw fail('REGISTRY_ASYNC_CALLBACK');
    probe();
    const before = validate();
    let db, locked = false, result, error, failed = false;
    try {
      db = new DatabaseSync(path, { readOnly: false });
      db.exec('PRAGMA busy_timeout=0');
      if (!same(before, validate())) throw fail('REGISTRY_UNTRUSTED_PATH');
      // Mode must be checked before BEGIN IMMEDIATE: a surprise WAL mode would lock
      // via sidecar files instead of the single protected coordination inode.
      if (db.prepare('PRAGMA journal_mode').get().journal_mode.toLowerCase() !== 'delete')
        throw fail('REGISTRY_UNTRUSTED_PATH');
      try { db.exec('BEGIN IMMEDIATE'); locked = true; }
      catch (cause) { if (busy(cause)) throw fail('REGISTRY_BUSY'); throw cause; }
      if (!same(before, validate())) throw fail('REGISTRY_UNTRUSTED_PATH');
      if (db.prepare('PRAGMA journal_mode').get().journal_mode.toLowerCase() !== 'delete' ||
          db.prepare('PRAGMA user_version').get().user_version !== 1 ||
          db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw fail('REGISTRY_UNTRUSTED_PATH');
      result = callback();
      if (result && typeof result.then === 'function') throw fail('REGISTRY_ASYNC_CALLBACK');
    } catch (cause) { error = busy(cause) ? fail('REGISTRY_BUSY') : cause; failed = true; }
    finally {
      if (locked) { try { db.exec('ROLLBACK'); } catch { error = fail('REGISTRY_LOCK_RELEASE_FAILED'); failed = true; } }
      try { db?.close(); } catch { error = fail('REGISTRY_LOCK_RELEASE_FAILED'); failed = true; }
    }
    if (failed) throw error;
    return result;
  }
  return Object.freeze({ withLock });
}
