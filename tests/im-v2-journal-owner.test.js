import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, chmodSync, lstatSync, symlinkSync, linkSync, renameSync, rmSync, writeFileSync, mkdirSync, readFileSync, chownSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { createImV2Journal } from '../src/im/v2/journal.js';
import { acquireImV2JournalOwner as acquire, registerImV2JournalBinding as register, openImV2JournalDatabase } from '../src/im/v2/journal-owner.js';

const unavailable = e => e?.code === 'STORAGE_UNAVAILABLE';
const invalid = e => e?.code === 'INVALID_REQUEST';
const posix = { skip: process.platform === 'win32' ? 'requires actual native POSIX filesystem/SQLite locks' : false, timeout: 30000 };
const identity = path => { const s = lstatSync(path, { bigint: true }); return `${s.dev}:${s.ino}`; };

// One cleanup owner per root: all children must CLOSE before any DB or files
// are removed. A spawn error is not evidence of exit or close.
function fixture(t) {
  const root = mkdtempSync(join(homedir(), 'im-v2-owner-'));
  chmodSync(root, 0o700);
  const children = [], connections = [], owners = [];
  t.after(async () => {
    const results = await Promise.allSettled(children.map(child => child.terminate()));
    if (results.some(result => result.status === 'rejected')) {
      throw new Error(`unconfirmed child closure; retained artifacts: ${root}`);
    }
    try {
      for (const owner of owners.reverse()) owner.release();
      for (const db of connections.reverse()) if (db.isOpen) db.close();
    } catch (error) { throw new Error(`cleanup failed; retained artifacts: ${root}`, { cause: error }); }
    rmSync(root, { recursive: true, force: true });
  });
  const path = join(root, 'journal.sqlite');
  const db = process.platform === 'win32' ? new DatabaseSync(path) : openImV2JournalDatabase({ path });
  createImV2Journal({ db }); // offline provisioning completed before any owner
  db.close();
  if (process.platform !== 'win32') chmodSync(path, 0o600);
  function open(file = path) {
    const db = process.platform === 'win32' ? new DatabaseSync(file) : openImV2JournalDatabase({ path: file }); connections.push(db);
    if (process.platform === 'win32') db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
    const journal = createImV2Journal({ db });
    if (process.platform !== 'win32') register(journal, db); // no auto-registration
    return { db, journal };
  }
  return { root, path, side: `${path}.owner.sqlite`, open,
    own(journal) { const owner = acquire(journal); owners.push(owner); return owner; },
    child() { const child = spawnChild(path); children.push(child); return child; },
  };
}

function bounded(promise, ms, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
  })]).finally(() => clearTimeout(timer));
}
function spawnChild(path) {
  const proc = fork(new URL('./fixtures/im-v2-journal-owner/child.js', import.meta.url), [path], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let closed = false, exit, spawnError, stderr = '', waiter;
  const messages = [];
  // Register exit AND close immediately, before awaiting IPC or issuing kills.
  const exitPromise = new Promise(resolve => proc.once('exit', (code, signal) => {
    exit = { code, signal }; resolve(exit);
    if (waiter) { waiter.reject(new Error(`exit before IPC: ${JSON.stringify(exit)} ${stderr}`)); waiter = undefined; }
  }));
  const closePromise = new Promise(resolve => proc.once('close', (code, signal) => { closed = true; resolve({ code, signal }); }));
  proc.on('error', error => { spawnError = error; if (waiter) { waiter.reject(error); waiter = undefined; } });
  proc.stderr.on('data', data => { stderr = (stderr + data).slice(-8192); });
  proc.on('message', message => {
    if (waiter) { waiter.resolve(message); waiter = undefined; } else messages.push(message);
  });
  async function next() {
    if (messages.length) return messages.shift();
    if (spawnError) throw spawnError;
    if (exit || closed) throw new Error(`already exited: ${stderr}`);
    assert.equal(waiter, undefined, 'only one pending IPC request');
    try { return await bounded(new Promise((resolve, reject) => { waiter = { resolve, reject }; }), 5000, `IPC ${proc.pid}: ${stderr}`); }
    finally { waiter = undefined; }
  }
  return { proc, next,
    async command(command) { proc.send(command); return next(); },
    async stop() {
      proc.send('stop');
      assert.deepEqual(await bounded(exitPromise, 5000, 'normal child exit'), { code: 0, signal: null });
      await bounded(closePromise, 5000, 'normal child close');
    },
    async kill() {
      assert.equal(proc.kill('SIGKILL'), true);
      assert.deepEqual(await bounded(exitPromise, 5000, 'SIGKILL exit'), { code: null, signal: 'SIGKILL' });
      await bounded(closePromise, 5000, 'SIGKILL close');
    },
    async terminate() {
      if (closed) return;
      proc.kill('SIGTERM');
      try { await bounded(closePromise, 1500, 'TERM close'); }
      catch { proc.kill('SIGKILL'); await bounded(closePromise, 5000, 'KILL close'); }
    },
  };
}
async function ready(f) { const child = f.child(); assert.deepEqual(await child.next(), { type: 'ready' }); return child; }

test('trusted immutable registration and actual Windows unsupported gate', t => {
  const f = fixture(t), { db, journal } = f.open(), other = f.open();
  for (const fake of [null, {}, Object.freeze({}), () => {}]) assert.throws(() => acquire(fake), process.platform === 'win32' ? unavailable : invalid);
  assert.throws(() => register({}, db), invalid);
  if (process.platform !== 'win32') {
    assert.equal(register(journal, db), undefined);
    assert.throws(() => register(journal, other.db), invalid);
  }
  if (process.platform === 'win32') {
    assert.throws(() => openImV2JournalDatabase({ path: f.path }), unavailable);
    assert.throws(() => acquire(journal), unavailable);
    assert.throws(() => lstatSync(f.side), { code: 'ENOENT' });
  } else {
    const owner = f.own(journal);
    assert.ok(Object.isFrozen(owner));
    assert.deepEqual(Object.keys(owner).sort(), ['assertHeld', 'release']);
    owner.assertHeld(); owner.release(); owner.release();
    assert.throws(() => owner.assertHeld(), unavailable);
    f.own(journal).assertHeld();
  }
  assert.equal(db.prepare('SELECT 1 AS n').get().n, 1);
});

test('same facade, same DB other facade, second connection refused; distinct journals independent', posix, t => {
  const f = fixture(t), g = fixture(t), { db, journal } = f.open();
  const owner = f.own(journal), inode = identity(f.side);
  const same = createImV2Journal({ db }); register(same, db);
  const other = f.open();
  for (const facade of [journal, same, other.journal]) assert.throws(() => acquire(facade), unavailable);
  const independent = g.own(g.open().journal); independent.assertHeld();
  owner.assertHeld(); owner.release();
  f.own(other.journal).assertHeld();
  assert.equal(identity(f.side), inode);
});

test('reentrant caller DB query cannot erase an existing or in-progress reservation', posix, t => {
  const f = fixture(t), { db, journal } = f.open();
  const prepare = db.prepare;
  let checked = false;
  db.prepare = function (...args) {
    if (!checked) { checked = true; assert.throws(() => acquire(journal), unavailable); }
    return prepare.apply(this, args);
  };
  try { f.own(journal).assertHeld(); assert.equal(checked, true); }
  finally { db.prepare = prepare; }
  assert.throws(() => acquire(journal), unavailable);
});

test('closed and memory DB, external transaction, FK OFF and weak synchronous rejected', posix, t => {
  const f = fixture(t), { db, journal } = f.open();
  for (const [bad, good] of [['BEGIN', 'ROLLBACK'], ['PRAGMA foreign_keys=OFF', 'PRAGMA foreign_keys=ON'], ['PRAGMA synchronous=NORMAL', 'PRAGMA synchronous=FULL']]) {
    db.exec(bad); assert.throws(() => acquire(journal), unavailable); db.exec(good);
  }
  db.exec('PRAGMA synchronous=EXTRA');
  f.own(journal).release();
  db.close(); assert.throws(() => acquire(journal), unavailable);
  const memory = new DatabaseSync(':memory:');
  const fresh = createImV2Journal({ db: f.open().db });
  try { assert.throws(() => register(fresh, memory), invalid); }
  finally { memory.close(); }
});

for (const property of ['journal-mode', 'directory-mode', 'ancestor-mode', 'journal-link', 'sidecar-mode', 'sidecar-link', 'sidecar-symlink', 'sidecar-main-alias', 'version', 'wal', 'corruption', 'empty']) {
  test(`fail closed without repair: ${property}`, posix, t => {
    const f = fixture(t), { journal } = f.open();
    f.own(journal).release();
    const before = identity(f.side);
    if (property === 'journal-mode') chmodSync(f.path, 0o640);
    if (property === 'directory-mode') chmodSync(f.root, 0o750);
    if (property === 'ancestor-mode') {
      const dir = join(f.root, 'private'); mkdirSync(dir, { mode: 0o700 });
      const path = join(dir, 'journal.sqlite');
       const db = openImV2JournalDatabase({ path }); createImV2Journal({ db }); db.close();
      const nested = f.open(path); chmodSync(f.root, 0o720);
      assert.throws(() => acquire(nested.journal), unavailable); return;
    }
    if (property === 'journal-link') linkSync(f.path, join(f.root, 'hard'));
    if (property === 'sidecar-mode') chmodSync(f.side, 0o640);
    if (property === 'sidecar-link') linkSync(f.side, join(f.root, 'hard'));
    if (property === 'sidecar-symlink' || property === 'sidecar-main-alias') {
      renameSync(f.side, `${f.side}.original`);
      if (property === 'sidecar-symlink') symlinkSync(`${f.side}.original`, f.side);
      else linkSync(f.path, f.side);
    }
    if (property === 'version' || property === 'wal') {
      const side = new DatabaseSync(f.side);
      side.exec(property === 'version' ? 'PRAGMA user_version=2' : 'PRAGMA journal_mode=WAL'); side.close();
    }
    if (property === 'corruption' || property === 'empty') writeFileSync(f.side, property === 'empty' ? '' : 'not a sqlite database');
    const bytes = readFileSync(f.side);
    assert.throws(() => acquire(journal), unavailable);
    assert.throws(() => acquire(journal), unavailable);
    assert.deepEqual(readFileSync(f.side), bytes);
    if (!['sidecar-symlink', 'sidecar-main-alias'].includes(property)) assert.equal(identity(f.side), before);
  });
}

test('supplied final symlink is rejected before SQLite canonicalizes it', posix, t => {
  const f = fixture(t), original = f.open();
  const alias = join(f.root, 'alias'); symlinkSync(f.path, alias);
  assert.throws(() => openImV2JournalDatabase({ path: alias }), unavailable);
  f.own(original.journal).assertHeld();
});

test('external DB, moved external DB and proxy cannot register', posix, t => {
  const f = fixture(t), trusted = f.open();
  const external = new DatabaseSync(f.path);
  try {
    external.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
    assert.throws(() => register(createImV2Journal({ db: external }), external), invalid);
    assert.throws(() => register(Object.freeze({}), new Proxy(trusted.db, {})), invalid);
    const moved = `${f.path}.external`;
    renameSync(f.path, moved);
    assert.throws(() => register(Object.freeze({}), external), invalid);
    assert.throws(() => register(Object.freeze({}), trusted.db), unavailable);
  } finally { external.close(); }
});

test('open then move before registration refuses stale connection', posix, t => {
  const f = fixture(t), db = openImV2JournalDatabase({ path: f.path });
  t.after(() => { if (db.isOpen) db.close(); });
  const journal = createImV2Journal({ db }), moved = `${f.path}.moved`;
  renameSync(f.path, moved);
  assert.throws(() => register(journal, db), unavailable);
  assert.throws(() => lstatSync(f.side), { code: 'ENOENT' });
});

test('replacement before first registration cannot lend identity to original connection', posix, t => {
  const f = fixture(t);
  const original = openImV2JournalDatabase({ path: f.path });
  t.after(() => { if (original.isOpen) original.close(); });
  createImV2Journal({ db: original }); // deliberately do not register yet
  original.exec('PRAGMA user_version=101');
  const moved = `${f.path}.moved`;
  renameSync(f.path, moved);
  const originalInode = identity(moved);
  const replacement = openImV2JournalDatabase({ path: f.path });
  t.after(() => { if (replacement.isOpen) replacement.close(); });
  createImV2Journal({ db: replacement });
  replacement.exec('PRAGMA user_version=202');
  assert.notEqual(originalInode, identity(f.path));
  assert.equal(original.prepare('PRAGMA user_version').get().user_version, 101);
  assert.equal(replacement.prepare('PRAGMA user_version').get().user_version, 202);
  assert.throws(() => register(Object.freeze({}), original), unavailable);
  assert.throws(() => lstatSync(f.side), { code: 'ENOENT' });
  assert.throws(() => lstatSync(`${moved}.owner.sqlite`), { code: 'ENOENT' });
  assert.equal(original.isOpen, true);
  assert.equal(replacement.isOpen, true);
  assert.equal(original.prepare('PRAGMA user_version').get().user_version, 101);
  assert.equal(replacement.prepare('PRAGMA user_version').get().user_version, 202);
});

test('replacement cannot lend ownership to stale cached DB; distinct moved and replacement DBs can own independently', posix, t => {
  const f = fixture(t), old = f.open();
  old.db.exec('PRAGMA user_version=101');
  const moved = `${f.path}.moved`;
  renameSync(f.path, moved);
  const replacement = openImV2JournalDatabase({ path: f.path });
  createImV2Journal({ db: replacement });
  replacement.exec('PRAGMA user_version=202');
  replacement.close();
  assert.equal(old.db.prepare('PRAGMA user_version').get().user_version, 101);
  assert.throws(() => acquire(old.journal), unavailable);
  assert.throws(() => lstatSync(f.side), { code: 'ENOENT' });
  const a = f.open(moved), b = f.open();
  assert.equal(a.db.prepare('PRAGMA user_version').get().user_version, 101);
  assert.equal(b.db.prepare('PRAGMA user_version').get().user_version, 202);
  const ownerA = f.own(a.journal), ownerB = f.own(b.journal);
  ownerA.assertHeld(); ownerB.assertHeld();
  assert.notEqual(identity(`${moved}.owner.sqlite`), identity(f.side));
});

test('released facade cannot reacquire after original file moves and gets replaced', posix, t => {
  const f = fixture(t), old = f.open();
  f.own(old.journal).release();
  renameSync(f.path, `${f.path}.moved`);
  const replacement = openImV2JournalDatabase({ path: f.path });
  replacement.close();
  assert.throws(() => acquire(old.journal), unavailable);
});

for (const target of ['journal', 'directory']) {
  test(`canonical ${target} path becoming a symlink rejects`, posix, t => {
    const f = fixture(t), { journal } = f.open();
    const path = target === 'journal' ? f.path : f.root, moved = `${path}.moved`;
    renameSync(path, moved); symlinkSync(moved, path);
    try { assert.throws(() => acquire(journal), unavailable); }
    finally { rmSync(path); renameSync(moved, path); }
  });
}

test('foreign owned journal, sidecar and final directory reject on native root runner', posix, t => {
  if (process.geteuid() !== 0) return t.skip('requires euid 0 to construct foreign-owned fixture');
  const f = fixture(t), { journal } = f.open(); f.own(journal).release();
  for (const path of [f.path, f.side, f.root]) {
    chownSync(path, 65534, 65534);
    try { assert.throws(() => acquire(journal), unavailable); }
    finally { chownSync(path, 0, 0); }
  }
});

for (const target of ['journal', 'sidecar', 'directory']) {
  test(`held assertion rejects ${target} replacement, never retargets`, posix, t => {
    const f = fixture(t), { journal } = f.open(), owner = f.own(journal);
    const path = target === 'journal' ? f.path : target === 'sidecar' ? f.side : f.root;
    const moved = `${path}.moved`;
    renameSync(path, moved);
    try {
      if (target === 'directory') mkdirSync(path, { mode: 0o700 });
      else writeFileSync(path, '', { mode: 0o600 });
      assert.throws(() => owner.assertHeld(), unavailable);
      assert.throws(() => acquire(journal), unavailable);
    } finally {
      owner.release(); rmSync(path, { recursive: true, force: true }); renameSync(moved, path);
    }
  });
}

test('assertHeld checks caller DB state without owning or closing it', posix, t => {
  const f = fixture(t), { db, journal } = f.open(), owner = f.own(journal);
  db.exec('BEGIN'); assert.throws(() => owner.assertHeld(), unavailable); db.exec('ROLLBACK');
  owner.assertHeld(); db.close(); assert.throws(() => owner.assertHeld(), unavailable);
  owner.release();
});

test('renamed journal invalidates old facade; moved inode remains reserved while old sidecar held', posix, t => {
  const f = fixture(t), { journal } = f.open(), owner = f.own(journal);
  const moved = `${f.path}.moved`;
  renameSync(f.path, moved);
  try {
    const alternate = f.open(moved);
    assert.throws(() => acquire(alternate.journal), unavailable);
    assert.throws(() => owner.assertHeld(), unavailable);
  } finally { owner.release(); renameSync(moved, f.path); }
   f.own(journal).assertHeld();
});

test('strict IPC contention survives alternate facade construction; release then SIGKILL reuse inode', posix, async t => {
  const f = fixture(t);
  // All initial provisioning is sequential and precedes acquisition.
  const holder = await ready(f), contender = await ready(f);
  assert.deepEqual(await holder.command('go'), { type: 'locked' });
  const inode = identity(f.side);
  assert.deepEqual(await contender.command('go'), { type: 'unavailable' });
  assert.deepEqual(await contender.command('probe'), { type: 'probe', result: 'busy' });
  assert.deepEqual(await holder.command('alternate'), { type: 'held' });
  assert.deepEqual(await contender.command('probe'), { type: 'probe', result: 'busy' });
  assert.deepEqual(await holder.command('release'), { type: 'released' });
  assert.deepEqual(await contender.command('go'), { type: 'locked' });
  assert.equal(identity(f.side), inode);
  await holder.stop();
  await contender.kill();
  const successor = await ready(f);
  assert.deepEqual(await successor.command('go'), { type: 'locked' });
  assert.equal(identity(f.side), inode);
  assert.deepEqual(await successor.command('release'), { type: 'released' });
  assert.equal(identity(f.side), inode);
  await successor.stop();
});

test('first initialization ready/go race retains one sidecar with exactly one owner', posix, async t => {
  const f = fixture(t), a = await ready(f), b = await ready(f);
  assert.throws(() => lstatSync(f.side), { code: 'ENOENT' });
  // Both children have fully constructed their journals at this explicit barrier.
  const results = await Promise.all([a.command('go'), b.command('go')]);
  assert.equal(results.filter(r => r.type === 'locked').length, 1, JSON.stringify(results));
  const winner = results[0].type === 'locked' ? a : b, loser = winner === a ? b : a;
  assert.equal(results.find(r => r.type !== 'locked').type, 'unavailable');
  const inode = identity(f.side);
  assert.deepEqual(await loser.command('probe'), { type: 'probe', result: 'busy' });
  assert.deepEqual(await winner.command('release'), { type: 'released' });
  assert.deepEqual(await loser.command('go'), { type: 'locked' });
  assert.equal(identity(f.side), inode);
  await winner.stop(); await loser.stop();
});

for (const command of ['close-uncertainty', 'rollback-uncertainty']) {
  test(`release failure is observable and retryable: ${command}`, posix, async t => {
    const f = fixture(t), holder = await ready(f), contender = await ready(f);
    assert.deepEqual(await holder.command('go'), { type: 'locked' });
    const inode = identity(f.side);
    assert.deepEqual(await holder.command(command), { type: 'recovered' });
    assert.deepEqual(await contender.command('probe'), { type: 'probe', result: 'busy' });
    assert.equal(identity(f.side), inode);
    await holder.stop(); await contender.stop();
  });
}
