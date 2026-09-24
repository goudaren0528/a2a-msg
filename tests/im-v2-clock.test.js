import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeImSchemaV4 } from '../src/im/v2/migration.js';
import { createImV2ClockGuard, resolveImV2TimeGuard } from '../src/im/v2/clock.js';
import { database, freshOptions } from './fixtures/im-v2-schema/helpers.js';

const code = value => ({ code: value });
function fixture(t, initial = 100) {
  const db = database(t);
  db.exec('PRAGMA synchronous=FULL');
  initializeImSchemaV4(db, freshOptions());
  let time = initial;
  const clock = () => time;
  const guard = createImV2ClockGuard({ db, clock });
  const floor = () => db.prepare('SELECT last_observed_at FROM im_clock WHERE singleton=1').get().last_observed_at;
  return { db, clock, guard, floor, set: n => { time = n; } };
}
function proxy(db, hook) {
  return new Proxy(db, { get(target, key) {
    if (key === 'prepare') return sql => {
      const statement = target.prepare(sql);
      return new Proxy(statement, { get(s, operation) {
        if (typeof s[operation] !== 'function') return s[operation];
        return (...args) => { hook(sql, operation, args); return s[operation](...args); };
      } });
    };
    if (key === 'exec') return sql => { hook(sql, 'exec', []); return target.exec(sql); };
    return target[key];
  } });
}

test('canonical per-connection guard, clock identity and noncanonical guard rejection', t => {
  const { db, clock, guard } = fixture(t);
  assert.equal(createImV2ClockGuard({ db, clock }), guard);
  assert.equal(resolveImV2TimeGuard(db, clock, guard), guard);
  assert.equal(resolveImV2TimeGuard(db, clock), guard);
  assert.deepEqual(Object.keys(guard).sort(), ['current', 'refreshCurrent', 'runRead', 'runWriteFresh']);
  assert.throws(() => createImV2ClockGuard({ db, clock: () => 100 }), code('INVALID_REQUEST'));
  assert.throws(() => resolveImV2TimeGuard(db, clock, {}), code('INVALID_REQUEST'));
  assert.equal(guard.runRead(() => guard.current()), 100);
});

test('construction rejects FK OFF and weak synchronous without changing PRAGMAs; FULL/EXTRA accepted', t => {
  for (const mode of ['FULL', 'EXTRA', 'NORMAL', 'OFF']) {
    const db = database(t); db.exec(`PRAGMA synchronous=${mode}`);
    initializeImSchemaV4(db, freshOptions());
    const before = db.prepare('PRAGMA synchronous').get().synchronous;
    if (before >= 2) assert.ok(createImV2ClockGuard({ db }));
    else assert.throws(() => createImV2ClockGuard({ db }), code('CLOCK_UNSAFE'));
    assert.equal(db.prepare('PRAGMA synchronous').get().synchronous, before);
  }
  const db = database(t); initializeImSchemaV4(db, freshOptions());
  db.exec('PRAGMA foreign_keys=OFF');
  assert.throws(() => createImV2ClockGuard({ db }), code('CLOCK_UNSAFE'));
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 0);
});

test('read snapshot, nested read and fresh refresh; forbidden scopes and external transactions', t => {
  const { db, guard, set, floor } = fixture(t);
  assert.throws(() => guard.current(), code('INVALID_REQUEST'));
  assert.throws(() => guard.refreshCurrent(), code('INVALID_REQUEST'));
  assert.equal(guard.runRead(() => {
    assert.equal(guard.current(), 100);
    assert.equal(guard.runRead(() => guard.current()), 100);
    assert.throws(() => guard.refreshCurrent(), code('INVALID_REQUEST'));
    assert.throws(() => guard.runWriteFresh(() => {}), code('INVALID_REQUEST'));
    return guard.current();
  }), 100);
  set(110);
  assert.equal(guard.runWriteFresh(() => {
    assert.equal(guard.current(), 110);
    assert.equal(guard.runRead(() => guard.current()), 110);
    assert.throws(() => guard.runWriteFresh(() => {}), code('INVALID_REQUEST'));
    set(120);
    return guard.refreshCurrent();
  }), 120);
  assert.equal(floor(), 120);
  db.exec('BEGIN');
  assert.throws(() => guard.runRead(() => {}), code('INVALID_REQUEST'));
  assert.throws(() => guard.runWriteFresh(() => {}), code('INVALID_REQUEST'));
  db.exec('ROLLBACK');
});

test('async, thenable and invalid callbacks cannot leave business changes; asynchronous continuation has no scope', async t => {
  const { db, guard, floor } = fixture(t);
  let calls = 0;
  assert.throws(() => guard.runWriteFresh(async () => { calls++; }), code('INVALID_REQUEST'));
  assert.equal(calls, 0); assert.equal(floor(), 0);
  assert.throws(() => guard.runRead(async () => { calls++; }), code('INVALID_REQUEST'));
  assert.equal(calls, 0);
  assert.throws(() => guard.runWriteFresh(() => {
    db.exec('CREATE TABLE business(x)');
    return { then() {} };
  }), code('INVALID_REQUEST'));
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='business'").get().n, 0);
  assert.equal(floor(), 100, 'an independently committed clock anchor is allowed');
  const continued = new Promise(resolve => guard.runRead(() => { queueMicrotask(() => resolve(assert.throws(() => guard.current(), code('INVALID_REQUEST')))); }));
  await continued;
});

test('backward, negative, NaN and unsafe integer clock fail closed', t => {
  for (const bad of [99, -1, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    const { guard, set } = fixture(t);
    guard.runRead(() => {});
    set(bad);
    assert.throws(() => guard.runWriteFresh(() => assert.fail('callback must not run')), code('CLOCK_UNSAFE'));
  }
});

test('all falsy callback failures preserve exact thrown value and clock-only commit', t => {
  for (const value of [undefined, null, false, 0, '']) {
    const { db, guard, floor } = fixture(t);
    let caught = Symbol('not caught');
    try { guard.runWriteFresh(() => { db.exec('CREATE TABLE business(x)'); throw value; }); }
    catch (error) { caught = error; }
    assert.equal(caught, value);
    assert.equal(floor(), 100);
    assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='business'").get().n, 0);
  }
});

test('real file persists floor after failed business and reopen', t => {
  const dir = mkdtempSync(join(tmpdir(), 'im-v2-clock-'));
  const filename = join(dir, 'candidate.db');
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
  initializeImSchemaV4(db, freshOptions());
  const guard = createImV2ClockGuard({ db, clock: () => 987 });
  assert.throws(() => guard.runWriteFresh(() => { db.exec('CREATE TABLE rejected(x)'); throw Error('business'); }), /business/);
  db.close();
  const reopened = new DatabaseSync(filename);
  reopened.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
  assert.equal(reopened.prepare('SELECT last_observed_at FROM im_clock').get().last_observed_at, 987);
  assert.equal(reopened.prepare("SELECT count(*) n FROM sqlite_master WHERE name='rejected'").get().n, 0);
  assert.throws(() => createImV2ClockGuard({ db: reopened, clock: () => 986 }).runRead(() => {}), code('CLOCK_UNSAFE'));
  reopened.close();
  rmSync(dir, { recursive: true, force: true });
});

test('caught refresh fault latches and rolls back business', t => {
  const { db, guard, floor, set } = fixture(t);
  assert.throws(() => guard.runWriteFresh(() => {
    db.exec('CREATE TABLE business(x)');
    set(99);
    assert.throws(() => guard.refreshCurrent(), code('CLOCK_UNSAFE'));
    assert.throws(() => guard.current(), code('CLOCK_UNSAFE'));
    return 'must not succeed';
  }), code('CLOCK_UNSAFE'));
  assert.equal(floor(), 100);
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='business'").get().n, 0);
});

test('observes small hot path queries only, no full manifest/hash/FK scan after construction', t => {
  const db = database(t); db.exec('PRAGMA synchronous=FULL'); initializeImSchemaV4(db, freshOptions());
  const statements = [];
  const tracked = proxy(db, (sql, operation) => statements.push(`${operation} ${sql}`));
  const guard = createImV2ClockGuard({ db: tracked, clock: () => 100 });
  statements.length = 0;
  guard.runRead(() => guard.current());
  guard.runWriteFresh(() => guard.refreshCurrent());
  assert.ok(statements.length > 0);
  assert.ok(!statements.some(s => /sqlite_master|foreign_key_check|im_messages|im_retention_policies|pragma_table_info/i.test(s)));
});

test('foreign connection advances floor before locked fresh sample', t => {
  const dir = mkdtempSync(join(tmpdir(), 'im-v2-clock-'));
  const filename = join(dir, 'candidate.db');
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
  initializeImSchemaV4(db, freshOptions());
  const other = new DatabaseSync(filename);
  other.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
  let now = 100;
  let injected = false;
  const tracked = proxy(db, (sql, operation) => {
    if (!injected && operation === 'exec' && sql === 'BEGIN IMMEDIATE' &&
        db.prepare('SELECT last_observed_at FROM im_clock').get().last_observed_at === 100) {
      injected = true;
      other.prepare('UPDATE im_clock SET last_observed_at=120').run();
    }
  });
  const guard = createImV2ClockGuard({ db: tracked, clock: () => now });
  guard.runRead(() => {});
  assert.throws(() => guard.runWriteFresh(() => assert.fail('not reached')), code('CLOCK_UNSAFE'));
  assert.equal(injected, true);
  assert.equal(other.prepare('SELECT last_observed_at FROM im_clock').get().last_observed_at, 120);
  now = 125;
  assert.equal(guard.runWriteFresh(() => guard.current()), 125);
  db.close(); other.close(); rmSync(dir, { recursive: true, force: true });
});

test('schema cookie and marker drift fail before callback or clock anchor', t => {
  for (const drift of ['cookie', 'marker']) {
    const { db, guard, floor } = fixture(t);
    if (drift === 'cookie') db.exec('CREATE TABLE changed(x)');
    else db.prepare('UPDATE im_schema SET migration_checksum=?').run('0'.repeat(64));
    let count = 0;
    assert.throws(() => guard.runWriteFresh(() => count++), code('STORAGE_UNAVAILABLE'));
    assert.equal(count, 0);
    assert.equal(floor(), 0);
  }
});

test('schema drift between anchor and write lock rejects callback', t => {
  const db = database(t); db.exec('PRAGMA synchronous=FULL'); initializeImSchemaV4(db, freshOptions());
  let begins = 0;
  const tracked = proxy(db, (sql, operation) => {
    if (operation === 'exec' && sql === 'BEGIN IMMEDIATE' && ++begins === 2)
      db.prepare('UPDATE im_schema SET migration_checksum=?').run('0'.repeat(64));
  });
  const guard = createImV2ClockGuard({ db: tracked, clock: () => 100 });
  let count = 0;
  assert.throws(() => guard.runWriteFresh(() => count++), code('STORAGE_UNAVAILABLE'));
  assert.equal(count, 0);
  assert.equal(db.prepare('SELECT last_observed_at FROM im_clock').get().last_observed_at, 100);
});

test('read checks marker after anchor and before exposing its snapshot', t => {
  const db = database(t); db.exec('PRAGMA synchronous=FULL'); initializeImSchemaV4(db, freshOptions());
  let begins = 0;
  const tracked = proxy(db, (sql, operation) => {
    if (operation === 'exec' && sql === 'BEGIN' && ++begins === 2)
      db.prepare('UPDATE im_schema SET migration_checksum=?').run('0'.repeat(64));
  });
  const guard = createImV2ClockGuard({ db: tracked, clock: () => 100 });
  let called = 0;
  assert.throws(() => guard.runRead(() => called++), code('STORAGE_UNAVAILABLE'));
  assert.equal(called, 0);
  assert.equal(db.prepare('SELECT last_observed_at FROM im_clock').get().last_observed_at, 100);
});

test('first anchor UPDATE failure invokes no callback and retains process highwater', t => {
  const db = database(t); db.exec('PRAGMA synchronous=FULL'); initializeImSchemaV4(db, freshOptions());
  let now = 100, fail = true;
  const tracked = proxy(db, (sql, operation) => {
    if (fail && operation === 'run' && sql.startsWith('UPDATE im_clock SET last_observed_at=')) {
      fail = false; throw Error('injected update failure');
    }
  });
  const guard = createImV2ClockGuard({ db: tracked, clock: () => now });
  let count = 0;
  assert.throws(() => guard.runWriteFresh(() => count++), code('STORAGE_UNAVAILABLE'));
  assert.equal(count, 0);
  assert.equal(db.prepare('SELECT last_observed_at FROM im_clock').get().last_observed_at, 0);
  now = 99;
  assert.throws(() => guard.runRead(() => {}), code('CLOCK_UNSAFE'));
});

test('caught refresh UPDATE failure rolls back business and reanchors highest observed floor', t => {
  const db = database(t); db.exec('PRAGMA synchronous=FULL'); initializeImSchemaV4(db, freshOptions());
  let now = 100, updates = 0;
  const tracked = proxy(db, (sql, operation) => {
    if (operation === 'run' && sql.startsWith('UPDATE im_clock SET last_observed_at=') && ++updates === 3)
      throw Error('injected refresh update failure');
  });
  const guard = createImV2ClockGuard({ db: tracked, clock: () => now });
  assert.throws(() => guard.runWriteFresh(() => {
    db.exec('CREATE TABLE business(x)'); now = 130;
    assert.throws(() => guard.refreshCurrent(), code('STORAGE_UNAVAILABLE'));
  }), code('STORAGE_UNAVAILABLE'));
  assert.equal(db.prepare('SELECT last_observed_at FROM im_clock').get().last_observed_at, 130);
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='business'").get().n, 0);
});

test('clock-only rewrite failure and COMMIT failure override callback result', t => {
  for (const point of ['rewrite', 'commit']) {
    const db = database(t); db.exec('PRAGMA synchronous=FULL'); initializeImSchemaV4(db, freshOptions());
    let updates = 0, commits = 0, callbacks = 0;
    const tracked = proxy(db, (sql, operation) => {
      if (point === 'rewrite' && operation === 'run' && sql.startsWith('UPDATE im_clock SET last_observed_at=') && ++updates === 3)
        throw Error('rewrite failed');
      if (point === 'commit' && operation === 'exec' && sql === 'COMMIT' && ++commits === 3)
        throw Error('commit failed');
    });
    const guard = createImV2ClockGuard({ db: tracked, clock: () => 100 });
    assert.throws(() => guard.runWriteFresh(() => {
      callbacks++;
      db.exec('CREATE TABLE business(x)');
      if (point === 'rewrite') throw Error('business failure');
      return 'success';
    }), code('STORAGE_UNAVAILABLE'));
    assert.equal(callbacks, 1, 'fault occurs after the business callback has entered');
    assert.equal(db.isTransaction, false);
    assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='business'").get().n, 0);
  }
});

test('native COMMIT executes then wrapper reports error: outcome uncertain, no compensating rollback', t => {
  const db = database(t); db.exec('PRAGMA synchronous=FULL'); initializeImSchemaV4(db, freshOptions());
  let commits = 0;
  const tracked = new Proxy(db, { get(target, key) {
    if (key === 'exec') return sql => {
      const result = target.exec(sql);
      if (sql === 'COMMIT' && ++commits === 3) throw Error('post-commit wrapper failure');
      return result;
    };
    const value = target[key];
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const guard = createImV2ClockGuard({ db: tracked, clock: () => 100 });
  assert.throws(() => guard.runWriteFresh(() => { db.exec('CREATE TABLE committed(x)'); return 'success'; }), code('STORAGE_UNAVAILABLE'));
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='committed'").get().n, 1);
  assert.throws(() => guard.current(), code('INVALID_REQUEST'));
});

test('WAL concurrent marker/DDL mutation during validation cannot become trusted constructor baseline', t => {
  for (const mutation of ['marker', 'DDL']) {
    const dir = mkdtempSync(join(tmpdir(), 'im-v2-clock-'));
    const filename = join(dir, 'candidate.db');
    let db, writer;
    try {
      db = new DatabaseSync(filename);
      db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
      initializeImSchemaV4(db, freshOptions());
      writer = new DatabaseSync(filename);
      writer.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
      let injected = false, assertions = 0;
      const tracked = proxy(db, (sql, operation) => {
        if (operation === 'get' && sql.includes('pragma_foreign_key_check')) {
          assertions++;
          if (!injected) {
            injected = true;
            if (mutation === 'marker') writer.prepare('UPDATE im_schema SET migration_checksum=?').run('0'.repeat(64));
            else writer.exec('CREATE INDEX im_clock_unapproved ON im_clock(last_observed_at)');
          }
        }
      });
      let entered = 0;
      try {
        const guard = createImV2ClockGuard({ db: tracked, clock: () => 100 });
        assert.throws(() => guard.runRead(() => entered++), code('STORAGE_UNAVAILABLE'));
        assert.throws(() => guard.runWriteFresh(() => entered++), code('STORAGE_UNAVAILABLE'));
      } catch (error) { assert.equal(error.code, 'STORAGE_UNAVAILABLE'); }
      assert.equal(injected, true, 'external mutation ran before the final FK query in the established read snapshot');
      assert.equal(assertions, 1, 'full validator runs only once');
      assert.equal(entered, 0, 'changed state cannot become a trusted baseline');
      assert.equal(db.isTransaction, false);
    } finally {
      writer?.close(); db?.close(); rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('constructor native-BEGIN, validation, marker-read and COMMIT faults never cache or leave a transaction', t => {
  for (const point of ['BEGIN', 'validation', 'marker', 'COMMIT']) {
    const db = database(t); db.exec('PRAGMA synchronous=FULL'); initializeImSchemaV4(db, freshOptions());
    let inject = true, markerReads = 0, validationReads = 0;
    const tracked = proxy(db, (sql, operation) => {
      if (operation === 'get' && sql.includes('pragma_foreign_key_check')) validationReads++;
      if (operation === 'all' && sql === 'SELECT version,migration_checksum FROM im_schema LIMIT 2') markerReads++;
      if (!inject) return;
      if (point === 'BEGIN' && operation === 'exec' && sql === 'BEGIN') {
        inject = false; db.exec('BEGIN'); throw Error('after native BEGIN');
      }
      if (point === 'validation' && operation === 'get' && sql.includes('pragma_foreign_key_check')) {
        inject = false; throw Error('after validation started');
      }
      if (point === 'marker' && operation === 'all' && sql === 'SELECT version,migration_checksum FROM im_schema LIMIT 2' && markerReads === 2) {
        inject = false; throw Error('marker read failed');
      }
      if (point === 'COMMIT' && operation === 'exec' && sql === 'COMMIT') {
        inject = false; throw Error('before native COMMIT');
      }
    });
    const clock = () => 100;
    assert.throws(() => createImV2ClockGuard({ db: tracked, clock }), code('STORAGE_UNAVAILABLE'));
    assert.equal(db.isTransaction, false, `${point} cleanup`);
    const before = validationReads;
    const guard = createImV2ClockGuard({ db: tracked, clock });
    assert.equal(validationReads, before + 1, `${point} retries complete validator`);
    assert.equal(db.isTransaction, false);
    assert.equal(guard.runRead(() => guard.current()), 100);
    assert.equal(createImV2ClockGuard({ db: tracked, clock }), guard);
  }
});
