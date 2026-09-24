import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync, mkdirSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

// Real file-backed SQLite. A single after hook closes before deleting, even
// after reopen; setup failures are failures, never caught to skip assertions.
export function environment(t) {
  const base = process.platform === 'win32' ? join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : join(tmpdir(), 'opencode');
  mkdirSync(base, {recursive:true});
  const dir = mkdtempSync(join(base, 'p4-journal-'));
  const file = join(dir, 'journal.sqlite');
  let db;
  const close = () => { if (db) { db.close(); db = undefined; } };
  t.after(() => { close(); rmSync(dir, {recursive:true, force:true}); });
  return {file, get db() { return db; }, close, open() {
    if (db) throw new Error('fixture connection already open');
    db = new DatabaseSync(file);
    db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
    return db;
  }};
}

// Hooks run AFTER the native call, allowing real mutations followed by a
// deterministic failure/incorrect changes count. No SQL engine is mocked.
export function observeDatabase(db) {
  const calls = [];
  let after;
  const wrapped = new Proxy(db, {get(target, key) {
    if (key === 'prepare') return sql => {
      const statement = target.prepare(sql);
      return new Proxy(statement, {get(stmt, method) {
        const fn = Reflect.get(stmt, method, stmt);
        if (typeof fn !== 'function') return fn;
        return (...args) => {
          const result = fn.apply(stmt, args);
          const call = {sql, method, args:[...args], result};
          calls.push(call);
          const replacement = after?.(call);
          return replacement === undefined ? result : replacement;
        };
      }});
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  }});
  return {db:wrapped, calls, reset() { calls.length = 0; }, after(fn) { after = fn; }};
}
