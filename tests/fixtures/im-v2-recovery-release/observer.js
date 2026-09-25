// Native-only instrumentation; no candidate/registry replacement or platform shim.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
export function observe(s, { readonly = false, fault = null, probe = () => {} } = {}) {
  const real = Object.fromEntries(['openSync', 'closeSync', 'fsyncSync', 'linkSync', 'unlinkSync', 'writeSync', 'mkdirSync'].map(k => [k, fs[k]]));
  const exec = DatabaseSync.prototype.exec, prepare = DatabaseSync.prototype.prepare, close = DatabaseSync.prototype.close;
  const descriptors = new Map(), readers = new Set(), held = new Map(), events = [], markerIO = [];
  const inMarkers = path => path === dirname(s.marker) || dirname(path) === dirname(s.marker);
  let previous, published = false, fired = false, terminalProbed = false;
  const noMutation = sql => assert.doesNotMatch(sql, /\b(UPDATE|INSERT|DELETE\s+FROM|CREATE|DROP|REPLACE|VACUUM|REINDEX)\b/i);
  DatabaseSync.prototype.exec = function(sql) {
    noMutation(sql); const result = exec.call(this, sql);
    if (/\bBEGIN\b/i.test(sql)) held.set(this, prepare.call(this, 'PRAGMA database_list').all().find(row => row.name === 'main')?.file);
    if (/\b(COMMIT|ROLLBACK)\b/i.test(sql)) held.delete(this);
    return result;
  };
  DatabaseSync.prototype.prepare = function(sql) {
    noMutation(sql);
    if (prepare.call(this, 'PRAGMA database_list').all().some(row => row.file === s.path)) readers.add(this);
    if (!terminalProbed && sql.includes('FROM im_recovery_runs') && s.locks.every(path => [...held.values()].includes(path))) {
      terminalProbed = true; probe('terminal-verify');
    }
    return prepare.call(this, sql);
  };
  DatabaseSync.prototype.close = function() { const result = close.call(this); readers.delete(this); held.delete(this); return result; };
  const controls = () => assert.deepEqual([...held.values()].filter(path => s.locks.includes(path)), s.locks);
  fs.openSync = (...args) => {
    const path = String(args[0]), flags = args[1];
    const writing = typeof flags === 'number' ? Boolean(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC)) : /[wa+]/.test(flags);
    const fd = real.openSync(...args); descriptors.set(fd, { path, directory: fs.fstatSync(fd).isDirectory() });
    if (inMarkers(path) && writing) markerIO.push({ operation: 'open-write', path, native: true });
    return fd;
  };
  fs.closeSync = fd => { const result = real.closeSync(fd); descriptors.delete(fd); return result; };
  fs.linkSync = (...args) => {
    assert.equal(readonly, false); controls(); assert.equal(String(args[1]), s.marker);
    probe('marker-publish'); const result = real.linkSync(...args); published = true;
    markerIO.push({ operation: 'link', path: String(args[1]), native: true });
    events.push({ operation: 'link', phase: 'marker-publish', native: true }); return result;
  };
  for (const name of ['unlinkSync', 'writeSync', 'mkdirSync']) fs[name] = (...args) => {
    assert.equal(readonly, false); const result = real[name](...args);
    const path = name === 'writeSync' ? descriptors.get(args[0])?.path : String(args[0]);
    if (path && inMarkers(path)) markerIO.push({ operation: name, path, native: true });
    return result;
  };
  fs.fsyncSync = fd => {
    assert.equal(readonly, false); const entry = descriptors.get(fd); assert.ok(entry);
    let phase = entry.path === s.path ? 'candidate-file' : entry.path === s.completion ? 'completion-file' : entry.path === s.marker ? 'marker-file' :
      entry.directory && entry.path === s.dir ? previous === 'candidate-file' ? 'candidate-directory' : 'completion-directory' :
        entry.directory && entry.path === dirname(s.marker) ? 'marker-directory' : 'marker-pending';
    controls(); assert.equal(readers.size, 0); probe(phase);
    const event = { operation: 'fsync', phase, native: false, path: entry.path, locks: [...held.values()] };
    events.push(event); previous = phase;
    if (!fired && phase === fault) { fired = true; event.fault = 'before-native'; throw Object.assign(Error('test-only fsync fault'), { code: 'EIO' }); }
    const result = real.fsyncSync(fd); event.native = true;
    if (inMarkers(entry.path)) markerIO.push({ operation: 'fsync', path: entry.path, native: true });
    return result;
  };
  syncBuiltinESMExports();
  return { events, markerIO, get published() { return published; }, get fired() { return fired; },
    restore() { Object.assign(fs, real); Object.assign(DatabaseSync.prototype, { exec, prepare, close }); syncBuiltinESMExports(); } };
}
