// Test-owned response-loss observer. Every event follows the real native call.
// Metadata SQL identifies connections; no raw coordination inode is opened.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { syncBuiltinESMExports } from 'node:module';

export function observeNative(after = () => {}) {
  const names = ['openSync', 'closeSync', 'fsyncSync', 'linkSync', 'unlinkSync', 'writeSync', 'renameSync'];
  const originals = Object.fromEntries(names.map(name => [name, fs[name]]));
  const dbOriginal = { exec: DatabaseSync.prototype.exec, prepare: DatabaseSync.prototype.prepare, close: DatabaseSync.prototype.close };
  const descriptors = new Map(), connections = new WeakMap(), events = [];
  let sequence = 0, connectionSequence = 0, restored = false;
  const emit = value => { const event = { seq: ++sequence, ...value }; events.push(event); after(event, events); return event; };
  const connection = db => {
    let value = connections.get(db);
    if (!value) {
      const row = Reflect.apply(dbOriginal.prepare, db, ['PRAGMA database_list']).all().find(row => row.name === 'main');
      value = { connection: ++connectionSequence, path: row.file };
      connections.set(db, value);
    }
    return value;
  };
  fs.openSync = (...args) => {
    const fd = originals.openSync(...args), st = fs.fstatSync(fd);
    descriptors.set(fd, { path: String(args[0]), fdType: st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other', dev: st.dev, ino: st.ino });
    return fd;
  };
  fs.closeSync = fd => { const result = originals.closeSync(fd); descriptors.delete(fd); return result; };
  fs.fsyncSync = fd => {
    const metadata = descriptors.get(fd), result = originals.fsyncSync(fd);
    assert.ok(metadata, 'sync descriptor came from an observed real open');
    emit({ op: 'fsync', fd, ...metadata }); return result;
  };
  for (const name of ['linkSync', 'unlinkSync', 'renameSync']) fs[name] = (...args) => {
    const result = originals[name](...args); emit({ op: name, paths: args.map(String) }); return result;
  };
  fs.writeSync = (...args) => { const result = originals.writeSync(...args); emit({ op: 'write', ...descriptors.get(args[0]), bytes: result }); return result; };
  DatabaseSync.prototype.exec = function(sql) {
    const metadata = connection(this), result = Reflect.apply(dbOriginal.exec, this, [sql]);
    emit({ op: 'exec', ...metadata, sql, transaction: this.isTransaction }); return result;
  };
  DatabaseSync.prototype.prepare = function(sql) {
    const statement = Reflect.apply(dbOriginal.prepare, this, [sql]);
    if (/^\s*(UPDATE|INSERT|DELETE)\b/i.test(sql)) {
      const metadata = connection(this), run = statement.run;
      statement.run = function(...args) {
        const result = Reflect.apply(run, this, args);
        emit({ op: 'mutation', ...metadata, sql, changes: result.changes }); return result;
      };
    }
    return statement;
  };
  DatabaseSync.prototype.close = function() {
    const metadata = connection(this), result = Reflect.apply(dbOriginal.close, this, []);
    emit({ op: 'db-close', ...metadata, isOpen: this.isOpen }); return result;
  };
  syncBuiltinESMExports();
  return { events, restore() {
    if (restored) return;
    restored = true; Object.assign(fs, originals); Object.assign(DatabaseSync.prototype, dbOriginal); syncBuiltinESMExports();
  } };
}
