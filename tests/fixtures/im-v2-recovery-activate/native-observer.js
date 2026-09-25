// Child-only wrappers: real descriptors, fstat types, native calls and close order.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

export function observeNative({ candidate, completion, directory, fault = null, readonly = false, publication = false, locks = [] }) {
  const real = Object.fromEntries(['openSync', 'closeSync', 'fsyncSync', 'linkSync', 'unlinkSync', 'writeSync', 'mkdirSync'].map(k => [k, fs[k]]));
  const exec = DatabaseSync.prototype.exec, prepare = DatabaseSync.prototype.prepare, close = DatabaseSync.prototype.close;
  const descriptors = new Map(), readers = new Set(), held = new Map(), events = [], mutations = [];
  let linked = false, unlinked = false, fired = false, previous = null;
  const mutates = sql => /\b(UPDATE|INSERT|DELETE\s+FROM|CREATE|DROP|REPLACE|VACUUM|REINDEX)\b/i.test(sql);
  const rejectMutation = sql => { if (mutates(sql)) { mutations.push(sql); if (!publication) throw Error('unexpected SQL mutation'); } };
  DatabaseSync.prototype.exec = function(sql) {
    rejectMutation(sql);
    const result = exec.call(this, sql);
    if (/\bBEGIN\b/i.test(sql)) held.set(this, prepare.call(this, 'PRAGMA database_list').all().find(row => row.name === 'main')?.file);
    if (/\b(COMMIT|ROLLBACK)\b/i.test(sql)) held.delete(this);
    return result;
  };
  DatabaseSync.prototype.prepare = function(sql) {
    // Query only to identify native candidate handles; no replacement DB facade.
    const files = prepare.call(this, 'PRAGMA database_list').all();
    if (files.some(row => row.file === candidate)) readers.add(this);
    rejectMutation(sql);
    return prepare.call(this, sql);
  };
  DatabaseSync.prototype.close = function() { const result = close.call(this); readers.delete(this); held.delete(this); return result; };
  fs.openSync = (...args) => {
    const fd = real.openSync(...args), st = fs.fstatSync(fd);
    descriptors.set(fd, { fd, path: String(args[0]), type: st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other' });
    return fd;
  };
  fs.closeSync = fd => { const result = real.closeSync(fd); descriptors.delete(fd); return result; };
  fs.linkSync = (...args) => {
    assert.equal(readonly || !publication, false, 'unexpected publication');
    const result = real.linkSync(...args);
    if (String(args[1]) === completion) linked = true;
    events.push({ operation: 'link', from: String(args[0]), path: String(args[1]), native: true });
    return result;
  };
  fs.unlinkSync = (...args) => {
    assert.equal(readonly || !publication, false, 'unexpected repair/unlink');
    const result = real.unlinkSync(...args);
    if (linked && String(args[0]).endsWith('.pending')) unlinked = true;
    events.push({ operation: 'unlink', path: String(args[0]), native: true });
    return result;
  };
  for (const name of ['writeSync', 'mkdirSync']) fs[name] = (...args) => {
    assert.equal(readonly || !publication, false, 'unexpected filesystem content write');
    return real[name](...args);
  };
  fs.fsyncSync = fd => {
    assert.equal(readonly, false, 'readonly observation must never fsync');
    const descriptor = descriptors.get(fd);
    assert.ok(descriptor, 'fsync must resolve to actual opened fd/path/type');
    let phase;
    if (descriptor.path === candidate && descriptor.type === 'file') phase = 'candidate-file';
    else if (descriptor.path === completion && descriptor.type === 'file') phase = 'completion-file';
    else if (descriptor.path === directory && descriptor.type === 'directory') {
      phase = publication && linked && unlinked ? 'publication-directory' : previous === 'candidate-file' ? 'candidate-directory' : previous === 'completion-file' ? 'completion-directory' : 'other-directory';
    } else phase = 'other';
    if (!publication && ['candidate-file', 'candidate-directory', 'completion-file', 'completion-directory'].includes(phase)) {
      assert.equal(readers.size, 0, 'all owned candidate readers close before durability sync');
      assert.deepEqual([...held.values()].filter(path => locks.includes(path)), locks, 'source -> workspace -> candidate locks remain held during sync');
    }
    const event = { operation: 'fsync', ...descriptor, phase, native: false, readers: readers.size, locks: [...held.values()] };
    events.push(event); previous = phase;
    if (!fired && phase === fault) {
      fired = true; event.fault = 'before-native';
      throw Object.assign(Error('test-only before-native fsync failure'), { code: 'EIO' });
    }
    const result = real.fsyncSync(fd); event.native = true;
    return result;
  };
  syncBuiltinESMExports();
  return { events, mutations, get fired() { return fired; }, get publicationComplete() { return linked && unlinked; },
    restore() { Object.assign(fs, real); Object.assign(DatabaseSync.prototype, { exec, prepare, close }); syncBuiltinESMExports(); } };
}
