import { ImError } from './contracts.js';
import { withImmediateTransaction } from './transaction.js';

const coordinators = new WeakMap();
const validTime = value => Number.isSafeInteger(value) && value >= 0;
const invalid = () => new ImError('CLOCK_UNSAFE');
const unavailable = () => new ImError('STORAGE_UNAVAILABLE');

// An operation uses one committed observation. Business rollback never rolls it back.
export function createImClockGuard({ db, clock = Date.now } = {}) {
  if (!db || (typeof db !== 'object' && typeof db !== 'function') ||
      typeof db.prepare !== 'function' || typeof db.exec !== 'function' || typeof clock !== 'function') {
    throw new ImError('INVALID_REQUEST');
  }
  const existing = coordinators.get(db);
  if (existing) {
    if (existing.clock !== clock) throw new ImError('INVALID_REQUEST');
    return existing.guard;
  }
  let highwater = 0;
  let scope = null;
  const last = db.prepare('SELECT last_observed_at FROM im_clock WHERE singleton=1');
  const update = db.prepare('UPDATE im_clock SET last_observed_at=? WHERE singleton=1');

  function ready() {
    if (db.isTransaction !== false) throw invalid();
    // Do not silently weaken or change a caller's durability policy.
    let mode;
    try { mode = db.prepare('PRAGMA synchronous').get()?.synchronous; }
    catch { throw unavailable(); }
    if (mode !== 2 && mode !== 3) throw invalid();
  }

  function persisted() {
    let row;
    try { row = last.get(); } catch { throw unavailable(); }
    if (!validTime(row?.last_observed_at)) throw invalid();
    return row.last_observed_at;
  }

  function sample(previous) {
    let now;
    try { now = clock(); } catch { throw invalid(); }
    if (!validTime(now) || now < previous || now < highwater) throw invalid();
    return now;
  }

  function anchor() {
    try {
      return withImmediateTransaction(db, () => {
        const now = sample(persisted());
        // Retain a future observation even if UPDATE or COMMIT fails.
        highwater = now;
        const result = update.run(now);
        if (result.changes !== 1) throw invalid();
        return now;
      });
    } catch (error) {
      if (error instanceof ImError) throw error;
      throw unavailable();
    }
  }

  function callback(fn) {
    if (typeof fn !== 'function' || fn.constructor?.name === 'AsyncFunction') throw new ImError('INVALID_REQUEST');
  }

  function invoke(fn) {
    const result = fn();
    if (result !== null && (typeof result === 'object' || typeof result === 'function') &&
        typeof result.then === 'function') throw new ImError('INVALID_REQUEST');
    return result;
  }

  function current() {
    if (!scope || db.isTransaction !== scope.transaction) throw invalid();
    return scope.now;
  }

  function runRead(fn) {
    callback(fn);
    if (scope) { current(); return invoke(fn); }
    ready();
    for (let attempt = 0; attempt < 3; attempt++) {
      const now = anchor();
      let stale = false;
      let entered = false;
      try {
        // Pin a SQLite read snapshot so a later connection cannot invalidate
        // the clock floor used for this operation's database reads.
        db.exec('BEGIN');
        try {
          if (persisted() > now) stale = true;
          else {
            entered = true;
            scope = { now, transaction: true, write: false };
            try {
              const result = invoke(fn);
              if (db.isTransaction !== true) throw invalid();
              db.exec('COMMIT');
              return result;
            } finally { scope = null; }
          }
        } finally { if (db.isTransaction) db.exec('ROLLBACK'); }
      } catch (error) {
        if (entered || error instanceof ImError) throw error;
        throw unavailable();
      }
      if (!stale) throw unavailable();
    }
    throw unavailable();
  }

  function runWrite(fn) {
    callback(fn);
    // Business methods may emit post-commit notifications on return. Reject
    // nested writes so a method cannot return before its outer transaction commits.
    if (scope) throw new ImError('INVALID_REQUEST');
    ready();
    for (let attempt = 0; attempt < 3; attempt++) {
      const now = anchor();
      let stale = false;
      let entered = false;
      let result;
      try {
        result = withImmediateTransaction(db, () => {
          if (persisted() > now) { stale = true; return undefined; }
          entered = true;
          scope = { now, transaction: true, write: true };
          try { return invoke(fn); }
          finally { scope = null; }
        });
      } catch (error) {
        if (entered || error instanceof ImError) throw error;
        throw unavailable();
      }
      if (!stale) return result;
    }
    throw unavailable();
  }

  const guard = Object.freeze({ runRead, runWrite, current });
  coordinators.set(db, { clock, guard });
  return guard;
}
