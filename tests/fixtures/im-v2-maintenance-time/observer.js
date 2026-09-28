// Installed ONLY in a dedicated child before importing the time engine. Every
// recorded native operation delegates to its real receiver. No product seam.
import fs from 'node:fs';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import { createRequire, registerHooks, syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { logicalImage } from './owner.js';

export function installObserver() {
  const sqlite = createRequire(import.meta.url)('node:sqlite');
  const original = { prepare: DatabaseSync.prototype.prepare, exec: DatabaseSync.prototype.exec,
    close: DatabaseSync.prototype.close, run: StatementSync.prototype.run,
    all: StatementSync.prototype.all, get: StatementSync.prototype.get, DatabaseSync: sqlite.DatabaseSync,
    wall: Date.now, mono: process.hrtime.bigint };
  const statements = new WeakMap(), connections = new Set(), ids = new WeakMap(), paths = new WeakMap();
  const events = []; let active = false, nextId = 0, armed = null, closeFault = null, statementHook = null;
  const clock = { wall: 100000, mono: 100000000000n, wallCalls: 0, monoCalls: 0, wallHook: null, monoHook: null };
  Date.now = function () { clock.wallCalls++; return clock.wallHook ? clock.wallHook() : clock.wall; };
  process.hrtime.bigint = function () { clock.monoCalls++; return clock.monoHook ? clock.monoHook() : clock.mono; };
  function connection(db) { connections.add(db); if (!ids.has(db)) ids.set(db, ++nextId); return ids.get(db); }
  function selected(path) {
    const db = [...connections].find(db => db.isOpen && (path === undefined || paths.get(db) === path));
    if (!db) throw new Error('no matching live owned connection'); return db;
  }
  // Replace only the child-local built-in constructor binding; return the real
  // native instance with its original prototype, never a fabricated DB receiver.
  sqlite.DatabaseSync = function ObservedDatabaseSync(...args) {
    if (!new.target) throw new TypeError('DatabaseSync requires new');
    if (active) events.push({ method: 'constructor', phase: 'before-native', databasePath: args[0] });
    const db = Reflect.construct(original.DatabaseSync, args);
    const path = typeof args[0] === 'string' && args[0].startsWith('file:') ? fileURLToPath(new URL(args[0])) : args[0];
    paths.set(db, path); connection(db);
    event(db, 'OPEN', 'constructor', 'after-native', { nativeCalled: true }); return db;
  };
  sqlite.DatabaseSync.prototype = original.DatabaseSync.prototype;
  Object.setPrototypeOf(sqlite.DatabaseSync, original.DatabaseSync);
  // node:sqlite named ESM exports are not refreshed by syncBuiltinESMExports in
  // the retained Node runtime. Redirect this engine's import only through a
  // child-owned ESM bridge to the instrumented built-in CommonJS export.
  const bridge = 'data:text/javascript,' + encodeURIComponent("import sqlite from 'node:sqlite'; export * from 'node:sqlite'; export const DatabaseSync = sqlite.DatabaseSync;");
  const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
    if (specifier === 'node:sqlite' && context.parentURL?.endsWith('/maintenance-time-internal.js'))
      return { url: bridge, shortCircuit: true };
    return nextResolve(specifier, context);
  } });
  function event(db, sql, method, phase, extra = {}) {
    const item = { connection: connection(db), databasePath: paths.get(db), sql, method, phase, open: db.isOpen,
      transaction: db.isOpen ? db.isTransaction : false, ...extra };
    if (active) events.push(item); return item;
  }
  function invoke(db, sql, method, call) {
    connection(db);
    const write = /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql);
    const commit = /^\s*COMMIT\s*;?\s*$/i.test(sql) && db.isTransaction;
    const matches = active && armed && (armed.match === 'commit' ? commit && armed.writerSeen : armed.match.test(sql));
    if (active && armed && write) armed.writerSeen = true;
    if (matches && armed.when === 'before') {
      const fault = armed; armed = null;
      event(db, sql, method, 'before-native-refusal', { nativeCalled: false, image: logicalImage(db, original.prepare) });
      fault.callback?.(); throw new Error('test-only native refusal');
    }
    const result = call();
    if (active) event(db, sql, method, 'after-native', { nativeCalled: true,
      ...(commit || write ? { image: logicalImage(db, original.prepare) } : {}) });
    if (matches) {
      const fault = armed; armed = null; fault.callback?.();
      if (fault.when === 'after') throw new Error('test-only native response loss');
    }
    return result;
  }
  DatabaseSync.prototype.prepare = function (sql) {
    const statement = original.prepare.call(this, sql); connection(this); statements.set(statement, { db: this, sql });
    if (active) { event(this, sql, 'prepare', 'after-native'); statementHook?.(sql); } return statement;
  };
  DatabaseSync.prototype.exec = function (sql) { return invoke(this, sql, 'exec', () => original.exec.call(this, sql)); };
  StatementSync.prototype.run = function (...args) {
    const info = statements.get(this);
    return info ? invoke(info.db, info.sql, 'run', () => original.run.apply(this, args)) : original.run.apply(this, args);
  };
  for (const method of ['all', 'get']) StatementSync.prototype[method] = function (...args) {
    const info = statements.get(this);
    return info ? invoke(info.db, info.sql, method, () => original[method].apply(this, args)) : original[method].apply(this, args);
  };
  DatabaseSync.prototype.close = function () {
    connection(this);
    if (active && closeFault === 'still-open') { event(this, 'CLOSE', 'close', 'before-native-refusal', { nativeCalled: false }); throw new Error('test close refused'); }
    const result = original.close.call(this); event(this, 'CLOSE', 'close', 'after-native', { nativeCalled: true });
    if (active && closeFault === 'response-loss') { closeFault = null; throw new Error('test close response loss'); }
    return result;
  };
  const mutations = ['writeFileSync', 'appendFileSync', 'writeSync', 'fsyncSync', 'fdatasyncSync', 'unlinkSync', 'renameSync',
    'chmodSync', 'mkdirSync', 'rmSync', 'truncateSync', 'ftruncateSync', 'copyFileSync', 'linkSync', 'symlinkSync'];
  const originals = Object.fromEntries(mutations.map(name => [name, fs[name]]));
  for (const name of mutations) fs[name] = function (...args) {
    const result = originals[name](...args); if (active) events.push({ fs: name, phase: 'after-native', nativeCalled: true }); return result;
  };
  const observations = ['openSync', 'readFileSync', 'lstatSync', 'statSync', 'readdirSync', 'realpathSync'];
  const originalObservations = Object.fromEntries(observations.map(name => [name, fs[name]]));
  for (const name of observations) {
    const wrapped = function (...args) {
      if (active) events.push({ fsRead: name, path: typeof args[0] === 'string' ? args[0] : null, phase: 'before-native' });
      return originalObservations[name](...args);
    };
    Object.assign(wrapped, originalObservations[name]); fs[name] = wrapped;
  }
  syncBuiltinESMExports();
  return { clock, events, original, constructorBridge: bridge,
    start() { active = true; events.length = 0; clock.wallCalls = clock.monoCalls = 0; },
    stop() { active = false; },
    arm(match, when, callback) { armed = { match, when, callback, writerSeen: false }; },
    closeFault(value) { closeFault = value; },
    statementHook(value) { statementHook = value; },
    image(path) { return logicalImage(selected(path), original.prepare); },
    read(sql, path) { return original.prepare.call(selected(path), sql).all(); },
    connectionId(path) { return connection(selected(path)); },
    ownedState(path) { const db = selected(path); return { connection: connection(db), open: db.isOpen, transaction: db.isTransaction }; },
    // Dedicated lifecycle children only: restore the actual native methods, then
    // explicitly clean the ORIGINAL handle. These are test actions, never proof
    // that the product rolled back or closed an unresolved resource.
    testCleanup(path) {
      const db = selected(path), actions = [];
      DatabaseSync.prototype.exec = original.exec; DatabaseSync.prototype.close = original.close;
      if (db.isTransaction) {
        const before = { open: db.isOpen, transaction: db.isTransaction };
        original.exec.call(db, 'ROLLBACK');
        actions.push({ action: 'test-native-rollback', connection: connection(db), before,
          after: { open: db.isOpen, transaction: db.isTransaction } });
      }
      original.close.call(db);
      actions.push({ action: 'test-native-close', connection: connection(db), open: db.isOpen });
      console.log(JSON.stringify({ phase: 'test-owned-cleanup', databasePath: path, actions, confirmedClosed: !db.isOpen }));
      return actions;
    },
    // Tests may model an independent ordinary floor update on the OWNED native
    // connection, between operations. No second handle and no production DB.
    ordinaryFloor(wall) { const db = [...connections].find(db => db.isOpen); original.run.call(original.prepare.call(db,
      'UPDATE im_clock SET last_observed_at=?'), wall); },
    arrangeDrift(callback) { const db = [...connections].find(db => db.isOpen);
      // Test-only deliberate lifetime breach, on the real owned native handle.
      // No replacement connection is opened while target ownership is live.
      return callback({ exec: sql => original.exec.call(db, sql),
        run: (sql, ...args) => original.run.call(original.prepare.call(db, sql), ...args),
        all: sql => original.prepare.call(db, sql).all() }); },
    allClosed() { return [...connections].every(db => !db.isOpen); },
    cleanup() {
      active = false; closeFault = null; armed = null; statementHook = null;
      for (const db of connections) if (db.isOpen) original.close.call(db);
      DatabaseSync.prototype.prepare = original.prepare; DatabaseSync.prototype.exec = original.exec;
      DatabaseSync.prototype.close = original.close; StatementSync.prototype.run = original.run;
      StatementSync.prototype.all = original.all; StatementSync.prototype.get = original.get;
      sqlite.DatabaseSync = original.DatabaseSync;
      hooks.deregister();
      Date.now = original.wall; process.hrtime.bigint = original.mono;
      for (const name of mutations) fs[name] = originals[name];
      for (const name of observations) fs[name] = originalObservations[name]; syncBuiltinESMExports();
    },
  };
}
