// Private artifact inspection only. Callers must establish a completed native
// backup (or a settled exclusive pending backup), isolation/provenance, and hash
// evidence. Absence of sidecars or a matching hash alone does not prove closure.
import { lstatSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const invalid = () => { throw Object.assign(new Error('BACKUP_VERIFY_FAILED'), { code: 'BACKUP_VERIFY_FAILED' }); };
function noSidecars(path) {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try { lstatSync(`${path}${suffix}`); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    invalid();
  }
}
function identity(path) {
  const value = lstatSync(path);
  if (!value.isFile() || value.isSymbolicLink() || realpathSync(path) !== path) invalid();
  return value;
}

export function withClosedBackupSnapshot(path, inspect) {
  if (typeof path !== 'string' || !path || path.includes('\0') || /^file:/i.test(path) ||
      typeof inspect !== 'function' || Object.prototype.toString.call(inspect) === '[object AsyncFunction]') invalid();
  path = resolve(path);
  const before = identity(path);
  noSidecars(path);
  const uri = pathToFileURL(path);
  uri.searchParams.set('mode', 'ro'); uri.searchParams.set('immutable', '1');
  let db, result, failure;
  try {
    db = new DatabaseSync(uri, { readOnly: true });
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0');
    result = inspect(db);
    if (result && typeof result.then === 'function') {
      void Promise.resolve(result).catch(() => {});
      invalid();
    }
  } catch (error) { failure = { error }; }
  // Do not skip postconditions when inspect/open/close fails. Preserve the first
  // failure (including non-Error throws); any failed postcondition denies success.
  try { db?.close(); } catch (error) { failure ??= { error }; }
  try {
    const after = identity(path);
    if (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'mode', 'uid', 'gid', 'nlink'].some(key => before[key] !== after[key])) invalid();
  } catch (error) { failure ??= { error }; }
  try { noSidecars(path); } catch (error) { failure ??= { error }; }
  if (failure) throw failure.error;
  return result;
}
