import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { migrateImSchema } from '../src/im/schema.js';
import { createImClockGuard } from '../src/im/clock-guard.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'im-clock-guard-'));
  const path = join(dir, 'im.sqlite');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
  migrateImSchema(db);
  db.exec('CREATE TABLE business(value INTEGER NOT NULL)');
  t.after(() => { try { db.close(); } catch { /* test may close early */ } rmSync(dir, { recursive: true, force: true }); });
  return { db, path };
}
const stored = db => db.prepare('SELECT last_observed_at FROM im_clock WHERE singleton=1').get().last_observed_at;

function intercepted(t, intercept) {
  const { db, path } = fixture(t);
  let updates = 0;
  const wrapped = new Proxy(db, { get(target, key) {
    if (key === 'prepare') return sql => {
      const statement = target.prepare(sql);
      if (sql !== 'UPDATE im_clock SET last_observed_at=? WHERE singleton=1') return statement;
      return new Proxy(statement, { get(stmt, method) {
        if (method === 'run') return (...args) => {
          updates++;
          const override = intercept.update?.(updates, args);
          return override === undefined ? stmt.run(...args) : override;
        };
        const value = stmt[method];
        return typeof value === 'function' ? value.bind(stmt) : value;
      } });
    };
    if (key === 'exec') return sql => {
      const override = intercept.exec?.(sql);
      if (override === 'after') { target.exec(sql); throw Error('commit reported failed after execution'); }
      return target.exec(sql);
    };
    const value = target[key];
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { db, path, wrapped };
}

test('future expiration observation commits independently of failed business write and rejects rollback clock', t => {
  const { db } = fixture(t);
  let time = 100;
  const guard = createImClockGuard({ db, clock: () => time });
  assert.throws(() => guard.current(), { code: 'CLOCK_UNSAFE' });
  assert.throws(() => guard.runWrite(() => {
    db.prepare('INSERT INTO business VALUES (1)').run();
    assert.equal(guard.current(), 100);
    throw Error('business failure');
  }), /business failure/);
  assert.equal(stored(db), 100);
  assert.deepEqual(db.prepare('SELECT * FROM business').all(), []);
  time = 99;
  assert.throws(() => guard.runRead(() => assert.fail('expired item resurrected')), { code: 'CLOCK_UNSAFE' });
});

test('read advances persisted floor and close/reopen does not resurrect expired state', t => {
  const { db, path } = fixture(t);
  let time = 500;
  const clock = () => time;
  const guard = createImClockGuard({ db, clock });
  assert.equal(guard.runRead(() => guard.current()), 500);
  assert.equal(stored(db), 500);
  db.close();
  const reopened = new DatabaseSync(path);
  reopened.exec('PRAGMA synchronous=FULL');
  time = 499;
  assert.throws(() => createImClockGuard({ db: reopened, clock }).runRead(() => 1), { code: 'CLOCK_UNSAFE' });
  reopened.close();
});

test('multiple modules share guard, nested reads reuse one sample and nested writes reject', t => {
  const { db } = fixture(t);
  let samples = 0;
  const clock = () => { samples++; return 10; };
  const guard = createImClockGuard({ db, clock });
  const acl = createImClockGuard({ db, clock });
  assert.equal(guard, acl);
  assert.throws(() => createImClockGuard({ db, clock: () => 10 }), { code: 'INVALID_REQUEST' });
  assert.equal(guard.runWrite(() => {
    assert.equal(acl.runRead(() => acl.current()), 10);
    assert.throws(() => acl.runWrite(() => acl.current()), { code: 'INVALID_REQUEST' });
    return guard.current();
  }), 10);
  assert.equal(samples, 1);
  assert.equal(guard.runRead(() => guard.runRead(() => guard.current())), 10);
  assert.equal(samples, 2);
  assert.throws(() => guard.runRead(() => guard.runWrite(() => 1)), { code: 'INVALID_REQUEST' });
  assert.throws(() => guard.current(), { code: 'CLOCK_UNSAFE' });
});

test('second connection advances floor between anchor and business lock: no callback on stale time', t => {
  const { db, path } = fixture(t);
  const other = new DatabaseSync(path);
  other.exec('PRAGMA synchronous=FULL');
  let time = 100;
  const second = createImClockGuard({ db: other, clock: () => 200 });
  const guarded = new Proxy(db, { get(target, key) {
    if (key === 'exec') return sql => {
      if (sql === 'BEGIN IMMEDIATE' && stored(db) === 100 && !other.isTransaction) second.runRead(() => 200);
      return target.exec(sql);
    };
    const value = target[key];
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const guard = createImClockGuard({ db: guarded, clock: () => time });
  let called = 0;
  assert.throws(() => guard.runWrite(() => { called++; }), { code: 'CLOCK_UNSAFE' });
  assert.equal(called, 0);
  assert.equal(stored(db), 200);
  time = 201;
  assert.equal(guard.runWrite(() => { called++; return guard.current(); }), 201);
  assert.equal(called, 1);
  other.close();
});

test('busy anchor lock never invokes callback; external transaction and asynchronous callbacks rejected', t => {
  const { db, path } = fixture(t);
  const locked = new DatabaseSync(path);
  locked.exec('BEGIN IMMEDIATE');
  const guard = createImClockGuard({ db, clock: () => 123 });
  let called = 0;
  assert.throws(() => guard.runRead(() => { called++; }), { code: 'STORAGE_UNAVAILABLE', retryable: true });
  assert.equal(called, 0);
  locked.exec('ROLLBACK');
  assert.throws(() => guard.runWrite(async () => { called++; }), { code: 'INVALID_REQUEST' });
  assert.throws(() => guard.runWrite(() => Promise.resolve(1)), { code: 'INVALID_REQUEST' });
  assert.equal(stored(db), 123); // thenable business callback rolls back, anchor stays.
  db.exec('BEGIN IMMEDIATE');
  assert.throws(() => guard.runRead(() => { called++; }), { code: 'CLOCK_UNSAFE' });
  assert.throws(() => guard.runWrite(() => { called++; }), { code: 'CLOCK_UNSAFE' });
  db.exec('ROLLBACK');
  assert.equal(called, 0);
  locked.close();
});

test('child process commits anchor then exits; parent reopen rejects backwards clock', t => {
  const { db, path } = fixture(t);
  db.close();
  const moduleUrl = new URL('../src/im/clock-guard.js', import.meta.url).href;
  const script = `import { DatabaseSync } from 'node:sqlite';\nimport { createImClockGuard } from ${JSON.stringify(moduleUrl)};\nconst db = new DatabaseSync(process.argv[1]); db.exec('PRAGMA synchronous=FULL'); createImClockGuard({ db, clock: () => 900 }).runRead(() => {}); db.close();`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, path], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const reopened = new DatabaseSync(path);
  assert.equal(stored(reopened), 900);
  assert.throws(() => createImClockGuard({ db: reopened, clock: () => 899 }).runRead(() => 1), { code: 'CLOCK_UNSAFE' });
  reopened.close();
});

test('unsafe synchronous policy and clock exceptions fail closed without callback', t => {
  const { db } = fixture(t);
  let called = 0;
  const guard = createImClockGuard({ db, clock: () => { throw Error('secret'); } });
  assert.throws(() => guard.runRead(() => { called++; }), { code: 'CLOCK_UNSAFE', message: 'Server clock unsafe' });
  db.exec('PRAGMA synchronous=NORMAL');
  assert.throws(() => guard.runRead(() => { called++; }), { code: 'CLOCK_UNSAFE' });
  assert.equal(called, 0);
});

test('fresh write samples under lock and refreshes monotonically without changing legacy scopes', t => {
  const { db } = fixture(t);
  let time = 100;
  let samples = 0;
  const clock = () => { samples++; return time; };
  const guard = createImClockGuard({ db, clock });
  assert.throws(() => guard.refreshCurrent(), { code: 'INVALID_REQUEST' });
  assert.equal(guard.runWriteFresh(() => {
    assert.equal(samples, 2);
    assert.equal(guard.current(), 100);
    assert.throws(() => guard.runWriteFresh(() => 1), { code: 'INVALID_REQUEST' });
    assert.throws(() => guard.runWrite(() => 1), { code: 'INVALID_REQUEST' });
    time = 120;
    assert.equal(guard.refreshCurrent(), 120);
    assert.equal(guard.current(), 120);
    return guard.runRead(() => guard.current());
  }), 120);
  assert.equal(stored(db), 120);
  assert.throws(() => guard.runWrite(() => guard.refreshCurrent()), { code: 'INVALID_REQUEST' });
  assert.throws(() => guard.runRead(() => guard.refreshCurrent()), { code: 'INVALID_REQUEST' });
  assert.throws(() => guard.refreshCurrent(), { code: 'INVALID_REQUEST' });
});

test('fresh write rollback keeps refreshed clock across close/reopen but not business changes', t => {
  const { db, path } = fixture(t);
  let time = 300;
  const guard = createImClockGuard({ db, clock: () => time });
  const failure = Error('business failed');
  assert.throws(() => guard.runWriteFresh(() => {
    db.prepare('INSERT INTO business VALUES (1)').run();
    time = 340;
    assert.equal(guard.refreshCurrent(), 340);
    db.prepare('INSERT INTO business VALUES (2)').run();
    throw failure;
  }), error => error === failure);
  assert.equal(stored(db), 340);
  db.close();
  const reopened = new DatabaseSync(path);
  reopened.exec('PRAGMA synchronous=FULL');
  assert.deepEqual(reopened.prepare('SELECT * FROM business').all(), []);
  assert.throws(() => createImClockGuard({ db: reopened, clock: () => 339 }).runWriteFresh(() => 1), { code: 'CLOCK_UNSAFE' });
  reopened.close();
});

test('fresh write rechecks floor advanced by another connection before invoking callback', t => {
  const { db, path } = fixture(t);
  const other = new DatabaseSync(path);
  other.exec('PRAGMA synchronous=FULL');
  let time = 100;
  const second = createImClockGuard({ db: other, clock: () => 200 });
  const guarded = new Proxy(db, { get(target, key) {
    if (key === 'exec') return sql => {
      if (sql === 'BEGIN IMMEDIATE' && stored(db) === 100 && !other.isTransaction) second.runRead(() => 200);
      return target.exec(sql);
    };
    const value = target[key];
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const guard = createImClockGuard({ db: guarded, clock: () => time });
  let called = 0;
  assert.throws(() => guard.runWriteFresh(() => { called++; }), { code: 'CLOCK_UNSAFE' });
  assert.equal(called, 0);
  assert.equal(stored(db), 200);
  time = 201;
  assert.equal(guard.runWriteFresh(() => { called++; return guard.current(); }), 201);
  assert.equal(called, 1);
  other.close();
});

test('fresh write rejects thenables and conflicting clocks; caught unsafe refresh cannot commit business', t => {
  const { db } = fixture(t);
  let time = 10;
  const clock = () => time;
  const guard = createImClockGuard({ db, clock });
  assert.equal(createImClockGuard({ db, clock }), guard);
  assert.throws(() => createImClockGuard({ db, clock: () => time }), { code: 'INVALID_REQUEST' });
  assert.throws(() => guard.runWriteFresh(async () => 1), { code: 'INVALID_REQUEST' });
  assert.throws(() => guard.runWriteFresh(() => Promise.resolve(1)), { code: 'INVALID_REQUEST' });
  assert.throws(() => guard.runWriteFresh(() => {
    db.prepare('INSERT INTO business VALUES (1)').run();
    time = 9;
    assert.throws(() => guard.refreshCurrent(), { code: 'CLOCK_UNSAFE' });
    return 'must not succeed';
  }), { code: 'CLOCK_UNSAFE' });
  assert.deepEqual(db.prepare('SELECT * FROM business').all(), []);
  assert.equal(stored(db), 10);
});

test('fresh write storage failures, including commit failure, never report business success', t => {
  const { db } = fixture(t);
  let failCommit = false;
  const guarded = new Proxy(db, { get(target, key) {
    if (key === 'exec') return sql => {
      if (sql === 'COMMIT' && failCommit) { failCommit = false; throw Error('injected commit failure'); }
      return target.exec(sql);
    };
    const value = target[key];
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const guard = createImClockGuard({ db: guarded, clock: () => 50 });
  assert.throws(() => guard.runWriteFresh(() => {
    db.prepare('INSERT INTO business VALUES (1)').run();
    failCommit = true;
    return 'success';
  }), { code: 'STORAGE_UNAVAILABLE' });
  assert.deepEqual(db.prepare('SELECT * FROM business').all(), []);
  assert.equal(stored(db), 50); // independently committed anchor survives
  assert.equal(guard.runWriteFresh(() => guard.current()), 50);
});

test('fresh scope cannot be reused after return; process highwater survives failed commit', t => {
  const { db } = fixture(t);
  let time = 80;
  let failCommit = false;
  const guarded = new Proxy(db, { get(target, key) {
    if (key === 'exec') return sql => {
      if (sql === 'COMMIT' && failCommit) { failCommit = false; throw Error('commit failed'); }
      return target.exec(sql);
    };
    const value = target[key];
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const guard = createImClockGuard({ db: guarded, clock: () => time });
  const late = guard.runWriteFresh(() => () => guard.refreshCurrent());
  assert.throws(late, { code: 'INVALID_REQUEST' });
  assert.throws(() => guard.runWriteFresh(() => {
    time = 90;
    guard.refreshCurrent();
    failCommit = true;
    return 'not committed';
  }), { code: 'STORAGE_UNAVAILABLE' });
  assert.equal(stored(db), 80);
  time = 89;
  assert.throws(() => guard.runWriteFresh(() => 1), { code: 'CLOCK_UNSAFE' });
});

test('process death before outer commit preserves independent anchor but not business or uncommitted refresh', t => {
  const { db, path } = fixture(t);
  db.close();
  const moduleUrl = new URL('../src/im/clock-guard.js', import.meta.url).href;
  const script = `import { DatabaseSync } from 'node:sqlite';
import { createImClockGuard } from ${JSON.stringify(moduleUrl)};
const db = new DatabaseSync(process.argv[1]); db.exec('PRAGMA synchronous=FULL');
let time = 70;
const guard = createImClockGuard({ db, clock: () => time });
guard.runWriteFresh(() => {
  db.prepare('INSERT INTO business VALUES (1)').run();
  time = 90; guard.refreshCurrent();
  process.exit(23);
});`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, path], { encoding: 'utf8' });
  assert.equal(child.status, 23, child.stderr);
  const reopened = new DatabaseSync(path);
  assert.equal(stored(reopened), 70);
  assert.deepEqual(reopened.prepare('SELECT * FROM business').all(), []);
  reopened.close();
});

test('fresh writes rethrow each falsy business failure after committing only the refreshed floor', t => {
  const { db } = fixture(t);
  let time = 100;
  const guard = createImClockGuard({ db, clock: () => time });
  for (const value of [undefined, null, false, 0, '']) {
    const previous = time;
    let caught = false;
    try {
      guard.runWriteFresh(() => {
        db.prepare('INSERT INTO business VALUES (1)').run();
        time = previous + 1;
        assert.equal(guard.refreshCurrent(), time);
        throw value;
      });
    } catch (error) { caught = true; assert.equal(error, value); }
    assert.equal(caught, true);
    assert.deepEqual(db.prepare('SELECT * FROM business').all(), []);
    assert.equal(stored(db), time);
    assert.equal(guard.runWriteFresh(() => guard.current()), time);
  }
});

test('caught refresh UPDATE fault cannot commit business; later recovered clock update persists max observation', t => {
  let fault = true;
  const { db, wrapped } = intercepted(t, { update: count => {
    if (count === 3 && fault) { fault = false; throw Error('refresh update failed'); }
  } });
  let time = 40;
  const guard = createImClockGuard({ db: wrapped, clock: () => time });
  assert.throws(() => guard.runWriteFresh(() => {
    db.prepare('INSERT INTO business VALUES (1)').run();
    time = 45;
    assert.throws(() => guard.refreshCurrent(), { code: 'STORAGE_UNAVAILABLE' });
    return 'cannot succeed';
  }), { code: 'STORAGE_UNAVAILABLE' });
  assert.deepEqual(db.prepare('SELECT * FROM business').all(), []);
  assert.equal(stored(db), 45);
  time = 44;
  assert.throws(() => guard.runWriteFresh(() => 1), { code: 'CLOCK_UNSAFE' });
});

for (const failure of ['throw', 'changes']) {
  test(`clock-only rewrite ${failure} failure aborts outer transaction and retains highwater`, t => {
    const { db, wrapped } = intercepted(t, { update: count => {
      if (count === 4) {
        if (failure === 'throw') throw Error('rewrite failed');
        return { changes: 0 };
      }
    } });
    let time = 60;
    const guard = createImClockGuard({ db: wrapped, clock: () => time });
    assert.throws(() => guard.runWriteFresh(() => {
      db.prepare('INSERT INTO business VALUES (1)').run();
      time = 65;
      guard.refreshCurrent();
      throw Error('business failed');
    }), { code: failure === 'throw' ? 'STORAGE_UNAVAILABLE' : 'CLOCK_UNSAFE' });
    assert.deepEqual(db.prepare('SELECT * FROM business').all(), []);
    assert.equal(stored(db), 60);
    assert.throws(() => guard.current(), { code: 'CLOCK_UNSAFE' });
    time = 64;
    assert.throws(() => guard.runWriteFresh(() => 1), { code: 'CLOCK_UNSAFE' });
  });
}

test('clock-only COMMIT failure overrides original business failure and clears scope', t => {
  let fail = false;
  const { db, wrapped } = intercepted(t, { exec: sql => {
    if (sql === 'COMMIT' && fail) { fail = false; throw Error('commit failed'); }
  } });
  let time = 70;
  const guard = createImClockGuard({ db: wrapped, clock: () => time });
  assert.throws(() => guard.runWriteFresh(() => {
    db.prepare('INSERT INTO business VALUES (1)').run();
    time = 75;
    guard.refreshCurrent();
    fail = true;
    throw Error('business failed');
  }), { code: 'STORAGE_UNAVAILABLE' });
  assert.deepEqual(db.prepare('SELECT * FROM business').all(), []);
  assert.equal(stored(db), 70);
  assert.throws(() => guard.current(), { code: 'CLOCK_UNSAFE' });
  time = 74;
  assert.throws(() => guard.runWriteFresh(() => 1), { code: 'CLOCK_UNSAFE' });
});

test('COMMIT wrapper throwing after real commit reports failure without claiming rollback', t => {
  let fail = false;
  const { db, wrapped } = intercepted(t, { exec: sql => {
    if (sql === 'COMMIT' && fail) { fail = false; return 'after'; }
  } });
  const guard = createImClockGuard({ db: wrapped, clock: () => 80 });
  assert.throws(() => guard.runWriteFresh(() => {
    db.prepare('INSERT INTO business VALUES (1)').run();
    fail = true;
    return 'not reported as success';
  }), { code: 'STORAGE_UNAVAILABLE' });
  assert.deepEqual(db.prepare('SELECT value FROM business').all().map(row => row.value), [1]);
  assert.equal(stored(db), 80);
  assert.throws(() => guard.current(), { code: 'CLOCK_UNSAFE' });
});

test('first under-lock floor UPDATE fault prevents callback and keeps independent anchor and highwater', t => {
  const { db, wrapped } = intercepted(t, { update: count => {
    if (count === 2) throw Error('under-lock update failed');
  } });
  let time = 90;
  const guard = createImClockGuard({ db: wrapped, clock: () => {
    const observed = time;
    time = 100;
    return observed;
  } });
  let called = false;
  assert.throws(() => guard.runWriteFresh(() => { called = true; }), { code: 'STORAGE_UNAVAILABLE' });
  assert.equal(called, false);
  assert.equal(stored(db), 90);
  time = 99;
  assert.throws(() => guard.runWriteFresh(() => { called = true; }), { code: 'CLOCK_UNSAFE' });
  assert.equal(called, false);
});
