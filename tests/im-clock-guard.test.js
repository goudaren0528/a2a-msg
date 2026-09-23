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
