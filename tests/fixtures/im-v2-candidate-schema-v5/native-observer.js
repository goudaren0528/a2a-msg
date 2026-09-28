// Adapted from committed B0.2a observer; callbacks always follow native success.
// Additional FK/transaction/inode facts make the v5 transaction phase explicit.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { syncBuiltinESMExports } from 'node:module';

export function observeNative(after = () => {}) {
  const names = ['openSync', 'closeSync', 'fsyncSync', 'linkSync', 'unlinkSync', 'writeSync', 'renameSync', 'readSync'];
  const originals = Object.fromEntries(names.map(name => [name, fs[name]]));
  const native = { exec: DatabaseSync.prototype.exec, prepare: DatabaseSync.prototype.prepare, close: DatabaseSync.prototype.close };
  const descriptors = new Map(), connections = new WeakMap(), events = [];
  let sequence = 0, serial = 0, restored = false;
  const emit = value => { const event = { seq: ++sequence, ...value }; events.push(event); after(event, events); };
  function connection(db) {
    let value = connections.get(db);
    if (!value) {
      const row = Reflect.apply(native.prepare, db, ['PRAGMA database_list']).all().find(row => row.name === 'main');
      const st = row.file ? fs.statSync(row.file) : null;
      value = { connection: ++serial, path: row.file, dev: st?.dev, ino: st?.ino, nlink: st?.nlink };
      connections.set(db, value);
      emit({ op: 'db-seen', ...value });
    }
    return value;
  }
  const state = db => ({ transaction: db.isTransaction,
    foreignKeys: Reflect.apply(native.prepare, db, ['PRAGMA foreign_keys']).get().foreign_keys });
  fs.openSync = (...args) => {
    const fd = originals.openSync(...args), st = fs.fstatSync(fd);
    descriptors.set(fd, { path: String(args[0]), fdType: st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other', dev: st.dev, ino: st.ino });
    return fd;
  };
  fs.closeSync = fd => { const result = originals.closeSync(fd); descriptors.delete(fd); return result; };
  fs.readSync = (...args) => { const result = originals.readSync(...args); emit({ op: 'file-read', ...descriptors.get(args[0]), bytes: result }); return result; };
  fs.fsyncSync = fd => {
    const metadata = descriptors.get(fd), result = originals.fsyncSync(fd);
    assert.ok(metadata, 'native fsync descriptor identified'); emit({ op: 'fsync', fd, ...metadata }); return result;
  };
  for (const name of ['linkSync', 'unlinkSync', 'renameSync']) fs[name] = (...args) => {
    const result = originals[name](...args); emit({ op: name, paths: args.map(String) }); return result;
  };
  fs.writeSync = (...args) => { const result = originals.writeSync(...args); emit({ op: 'write', ...descriptors.get(args[0]), bytes: result }); return result; };
  DatabaseSync.prototype.exec = function(sql) {
    const metadata = connection(this), result = Reflect.apply(native.exec, this, [sql]);
    emit({ op: 'exec', ...metadata, sql, ...state(this) }); return result;
  };
  DatabaseSync.prototype.prepare = function(sql) {
    const statement = Reflect.apply(native.prepare, this, [sql]);
    const metadata = connection(this);
    emit({ op: 'prepare', ...metadata, sql, ...state(this) });
    if (/^\s*(UPDATE|INSERT|DELETE)\b/i.test(sql)) {
      const db = this, run = statement.run;
      statement.run = function(...args) {
        const result = Reflect.apply(run, this, args);
        emit({ op: 'mutation', ...metadata, sql, changes: result.changes, ...state(db) }); return result;
      };
    }
    return statement;
  };
  DatabaseSync.prototype.close = function() {
    const metadata = connection(this), result = Reflect.apply(native.close, this, []);
    emit({ op: 'db-close', ...metadata, isOpen: this.isOpen }); return result;
  };
  syncBuiltinESMExports();
  return { events, restore() {
    if (restored) return; restored = true;
    Object.assign(fs, originals); Object.assign(DatabaseSync.prototype, native); syncBuiltinESMExports();
  } };
}
