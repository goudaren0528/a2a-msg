import { ImV2Error } from './contracts.js';
import { assertImSchemaV4 } from './schema.js';
import { withImmediateTransaction } from '../transaction.js';

const guards = new WeakMap();
const validTime = value => Number.isSafeInteger(value) && value >= 0;
const failure = code => new ImV2Error(code);
const storage = () => failure('STORAGE_UNAVAILABLE');
const unsafe = () => failure('CLOCK_UNSAFE');

export function createImV2ClockGuard({ db, clock = Date.now } = {}) {
  if (!db || (typeof db !== 'object' && typeof db !== 'function') ||
      typeof db.prepare !== 'function' || typeof db.exec !== 'function' || typeof clock !== 'function')
    throw failure('INVALID_REQUEST');
  const existing = guards.get(db);
  if (existing) {
    if (existing.clock !== clock) throw failure('INVALID_REQUEST');
    return existing.guard;
  }
  if (db.isTransaction !== false) throw failure('INVALID_REQUEST');
  try {
    if (db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1 ||
        ![2, 3].includes(db.prepare('PRAGMA synchronous').get()?.synchronous)) throw unsafe();
  } catch (error) { throw error instanceof ImV2Error ? error : storage(); }
  let last, update, cookie, marker, schemaVersion, checksum;
  try {
    // The expensive initial assertion and trusted baseline must see one SQLite
    // snapshot. A concurrent writer must not become the baseline after validation.
    db.exec('BEGIN');
    assertImSchemaV4(db);
    cookie = db.prepare('PRAGMA schema_version');
    marker = db.prepare('SELECT version,migration_checksum FROM im_schema LIMIT 2');
    schemaVersion = cookie.get()?.schema_version;
    const rows = marker.all();
    if (rows.length !== 1 || rows[0].version !== 4) throw storage();
    checksum = rows[0].migration_checksum;
    last = db.prepare('SELECT last_observed_at FROM im_clock WHERE singleton=1');
    update = db.prepare('UPDATE im_clock SET last_observed_at=? WHERE singleton=1');
    if (db.isTransaction !== true) throw storage();
    db.exec('COMMIT');
    if (db.isTransaction !== false) throw storage();
  } catch {
    if (db.isTransaction) {
      try { db.exec('ROLLBACK'); } catch { /* Cannot claim a usable guard. */ }
    }
    throw storage();
  }

  let highwater = 0;
  let scope = null;
  function unchanged() {
    try {
      const rows = marker.all();
      if (cookie.get()?.schema_version !== schemaVersion || rows.length !== 1 ||
          rows[0].version !== 4 || rows[0].migration_checksum !== checksum) throw storage();
    } catch { throw storage(); }
  }
  function ready() {
    if (db.isTransaction !== false) throw failure('INVALID_REQUEST');
    try {
      if (db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1 ||
          ![2, 3].includes(db.prepare('PRAGMA synchronous').get()?.synchronous)) throw unsafe();
    } catch (error) { throw error instanceof ImV2Error ? error : storage(); }
    unchanged();
  }
  function persisted() {
    let row;
    try { row = last.get(); } catch { throw storage(); }
    if (!validTime(row?.last_observed_at)) throw unsafe();
    return row.last_observed_at;
  }
  function sample(floor) {
    let now;
    try { now = clock(); } catch { throw unsafe(); }
    if (!validTime(now) || now < floor || now < highwater) throw unsafe();
    highwater = now; // Retain even if UPDATE or COMMIT subsequently fails.
    return now;
  }
  function writeFloor(now) {
    try { if (update.run(now).changes !== 1) throw unsafe(); }
    catch (error) { throw error instanceof ImV2Error ? error : storage(); }
  }
  function anchor() {
    try { return withImmediateTransaction(db, () => {
      unchanged();
      const now = sample(persisted());
      writeFloor(now);
      return now;
    }); } catch (error) { throw error instanceof ImV2Error ? error : storage(); }
  }
  function checkCallback(fn) {
    if (typeof fn !== 'function' || fn.constructor?.name === 'AsyncFunction') throw failure('INVALID_REQUEST');
  }
  function invoke(fn) {
    const result = fn();
    if (result !== null && (typeof result === 'object' || typeof result === 'function') &&
        typeof result.then === 'function') throw failure('INVALID_REQUEST');
    return result;
  }
  function current() {
    if (!scope || db.isTransaction !== true) throw failure('INVALID_REQUEST');
    if (scope.fault) throw scope.fault;
    return scope.now;
  }
  function runRead(fn) {
    checkCallback(fn);
    if (scope) { current(); return invoke(fn); }
    ready();
    for (let attempt = 0; attempt < 3; attempt++) {
      const now = anchor();
      let entered = false;
      let stale = false;
      let callbackFailed = false;
      let callbackError;
      try {
        db.exec('BEGIN');
        try {
          unchanged();
          if (persisted() > now) stale = true;
          else {
            entered = true;
            scope = { now, fresh: false, fault: null };
            try {
              let result;
              try { result = invoke(fn); }
              catch (error) { callbackFailed = true; callbackError = error; throw error; }
              if (db.isTransaction !== true) throw storage();
              db.exec('COMMIT');
              return result;
            } finally { scope = null; }
          }
        } finally { if (db.isTransaction) db.exec('ROLLBACK'); }
      } catch (error) {
        if (callbackFailed) throw callbackError;
        if (error instanceof ImV2Error) throw error;
        throw storage();
      }
      if (!stale) throw storage();
    }
    throw storage();
  }
  function refreshCurrent() {
    if (!scope || !scope.fresh || db.isTransaction !== true) throw failure('INVALID_REQUEST');
    if (scope.fault) throw scope.fault;
    try {
      const now = sample(Math.max(persisted(), scope.now));
      writeFloor(now);
      scope.now = now;
      return now;
    } catch (error) {
      scope.fault = error instanceof ImV2Error ? error : storage();
      throw scope.fault;
    }
  }
  function runWriteFresh(fn) {
    checkCallback(fn);
    if (scope) throw failure('INVALID_REQUEST');
    ready();
    anchor(); // Independently durable, before any business transaction.
    let failed = false;
    let thrown;
    let result;
    try {
      withImmediateTransaction(db, () => {
        unchanged(); // Under the write lock, before clock observation or business callback.
        const now = sample(persisted());
        writeFloor(now);
        db.exec('SAVEPOINT im_v2_clock_business');
        scope = { now, fresh: true, fault: null };
        try {
          result = invoke(fn);
          if (scope.fault) throw scope.fault;
          if (db.isTransaction !== true) throw storage();
          db.exec('RELEASE SAVEPOINT im_v2_clock_business');
        } catch (error) {
          const fault = scope.fault;
          if (db.isTransaction !== true) throw storage();
          db.exec('ROLLBACK TO SAVEPOINT im_v2_clock_business');
          db.exec('RELEASE SAVEPOINT im_v2_clock_business');
          writeFloor(highwater);
          failed = true;
          thrown = fault || error;
        } finally { scope = null; }
      });
    } catch (error) { throw error instanceof ImV2Error ? error : storage(); }
    if (failed) throw thrown;
    return result;
  }

  const guard = Object.freeze({ runRead, runWriteFresh, current, refreshCurrent });
  guards.set(db, { clock, guard });
  return guard;
}

export function resolveImV2TimeGuard(db, clock = Date.now, timeGuard) {
  const canonical = createImV2ClockGuard({ db, clock });
  if (timeGuard !== undefined && timeGuard !== canonical) throw failure('INVALID_REQUEST');
  return canonical;
}
