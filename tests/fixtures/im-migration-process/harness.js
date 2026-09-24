import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, chmodSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open, seed, snapshot, migrationState } from './state.js';

const waitMs = 15000;
export const nativeOptions = { timeout: 120000,
  skip: process.platform === 'win32' ? 'Requires real Unix private-path permissions and native registry byte-range locks' : false };

function bounded(promise, ms, description) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error(`timeout: ${description}`)), ms);
  })]).finally(() => clearTimeout(timer));
}

function trackedFork() {
  const child = fork(new URL('./child.js', import.meta.url), [], {
    execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc', 'pipe'],
  });
  const tracked = { child, errors: [], exited: false, closed: false, messages: [], pending: null,
    stderr: '', stdout: '' };
  // Register these immediately after fork. An 'error' is never an exit. A failed
  // spawn can instead be confirmed by close. Both streams must close before rm.
  tracked.exit = new Promise(resolve => child.once('exit', (code, signal) => {
    tracked.exited = true; tracked.outcome = { code, signal }; resolve(tracked.outcome);
  }));
  tracked.close = new Promise(resolve => child.once('close', (code, signal) => {
    tracked.closed = true; tracked.outcome ??= { code, signal }; resolve(tracked.outcome);
    tracked.pending?.reject(Error(`worker closed before IPC: ${tracked.stderr}`));
  }));
  child.on('error', error => { tracked.errors.push(error); tracked.pending?.reject(error); });
  child.stdout.on('data', chunk => { tracked.stdout = (tracked.stdout + chunk).slice(-16384); });
  child.stderr.on('data', chunk => { tracked.stderr = (tracked.stderr + chunk).slice(-16384); });
  child.stdio[4].on('error', error => { tracked.errors.push(error); tracked.pending?.reject(error); });
  child.on('message', message => {
    if (tracked.pending) tracked.pending.resolve(message);
    else tracked.messages.push(message);
  });
  tracked.next = async type => {
    let message;
    if (tracked.messages.length) message = tracked.messages.shift();
    else {
      assert.equal(tracked.pending, null, 'only one IPC consumer');
      assert.equal(tracked.closed, false, `worker already closed: ${tracked.stderr}`);
      try {
        message = await bounded(new Promise((resolve, reject) => {
          tracked.pending = { resolve, reject };
        }), waitMs, `${type} IPC`);
      } finally { tracked.pending = null; }
    }
    assert.equal(message?.type, type, `unexpected worker message: ${JSON.stringify(message)}; ${tracked.stderr}`);
    return message;
  };
  tracked.send = message => bounded(new Promise((resolve, reject) => {
    child.send(message, error => error ? reject(error) : resolve());
  }), waitMs, 'IPC send');
  tracked.release = phase => bounded(new Promise((resolve, reject) => {
    child.stdio[4].write(`go:${phase.sequence}\n`, error => error ? reject(error) : resolve());
  }), waitMs, 'barrier GO');
  tracked.finish = async (code = 0) => {
    const outcome = await bounded(tracked.close, waitMs, 'worker close');
    assert.equal(tracked.exited, true, 'actual exit event observed');
    assert.equal(outcome.code, code, tracked.stderr);
    assert.equal(outcome.signal, null);
    assert.equal(tracked.errors.length, 0);
    assert.equal(tracked.messages.length, 0, 'no unexpected trailing response');
  };
  return tracked;
}

async function stop(tracked) {
  if (!tracked.closed && !tracked.exited) tracked.child.kill('SIGTERM');
  try { return await bounded(tracked.close, 2000, 'SIGTERM close'); }
  catch {
    if (!tracked.closed) tracked.child.kill('SIGKILL');
    return bounded(tracked.close, 3000, 'SIGKILL close');
  }
}

export function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'im-migration-process-'));
  chmodSync(root, 0o700);
  const children = [];
  t.after(async () => {
    const outcomes = await Promise.allSettled(children.map(stop));
    const failed = outcomes.filter(outcome => outcome.status === 'rejected');
    if (failed.length || children.some(child => !child.closed)) {
      throw new AggregateError(failed.map(outcome => outcome.reason), `unconfirmed owned child close; retained ${root}`);
    }
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, 'registry'), { mode: 0o700 });
  mkdirSync(join(root, 'registry', 'artifacts'), { mode: 0o700 });
  const caseId = randomUUID();
  const seeded = seed(root, caseId);
  const f = { root, caseId, ...seeded, children, grant: null };
  f.inspect = fn => { const db = open(root); try { return fn(db); } finally { db.close(); } };
  f.state = () => f.inspect(migrationState);
  f.invariants = () => assert.deepEqual(f.inspect(snapshot), f.baseline);
  f.start = async (operation, extra = {}) => {
    const tracked = trackedFork(); children.push(tracked);
    const ready = await tracked.next('ready');
    assert.equal(ready.pid, tracked.child.pid);
    await tracked.send({ type: 'go', job: { root, caseId, identity: f.identity,
      requestId: randomUUID(), operation, ...extra } });
    return tracked;
  };
  f.run = async (operation, extra = {}, errorCode) => {
    const tracked = await f.start(operation, extra);
    const message = await tracked.next(errorCode ? 'failure' : 'result');
    await tracked.finish(errorCode ? 1 : 0);
    if (errorCode) assert.equal(message.code, errorCode, message.stack);
    return message.result;
  };
  f.commit = (extra = {}, errorCode) => f.run('commit', { request: f.request, grant: f.grant, ...extra }, errorCode);
  f.approved = async () => {
    // A has exited before B can know the backup ID. No manifest/file hash leaves A.
    const published = await f.run('publish');
    assert.deepEqual(Object.keys(published).sort(), ['backupId', 'identity']);
    assert.deepEqual(published.identity, f.identity);
    f.backupId = published.backupId;
    // Traffic accepted AFTER the snapshot is an invariant, not the concurrent
    // writer probe below. A snapshot restore would lose this unacked message/key.
    const newKey = randomUUID();
    const later = await f.run('writer', { traffic: f.traffic, clientMessageId: newKey });
    assert.equal(later.replayed, false);
    assert.notEqual(later.messageId, f.traffic.baselineMessageId);
    f.baseline = f.inspect(snapshot);
    f.postBackup = { messageId: later.messageId, clientMessageId: newKey };
    const b = await f.start('preview', { backupId: f.backupId, bindings: f.bindings });
    const { preview } = await b.next('approval-needed');
    // Independent parent-side reviewer validates the request being granted.
    // Commit children receive this grant independently of their request object.
    assert.equal(createHash('sha256').update(JSON.stringify(preview.package)).digest('hex'), preview.planHash);
    assert.equal(preview.package.backupId, f.backupId);
    assert.equal(preview.package.instanceId, f.identity.instanceId);
    assert.equal(preview.package.instanceCreatedAt, f.identity.createdAt);
    assert.equal(preview.package.actorId, `operator-${caseId}`);
    assert.equal(preview.package.operation, 'bind-legacy-members');
    assert.equal(preview.package.expiresAt, 2000);
    assert.deepEqual(preview.package.proposedBindings, f.bindings);
    assert.deepEqual(preview.package.expectedImpact,
      { bindingCount: 2, legacyMessagesCopied: 0, imWriteModeChanged: false });
    const approval = { approver: `independent-reviewer-${caseId}`, planHash: preview.planHash, backupId: f.backupId };
    f.grant = { ...approval, caseId, active: true };
    await b.send({ type: 'approve', approval });
    f.request = (await b.next('result')).result;
    await b.finish();
    assert.deepEqual(f.request, { ...preview, approval });
    f.invariants();
    return f;
  };
  f.assertCompleted = result => {
    const state = f.state();
    assert.equal(state.bindings.length, 2);
    assert.equal(state.runs.length, 1);
    assert.equal(state.audits.length, 1);
    assert.deepEqual(result, { runId: f.request.package.previewId, status: 'completed',
      bindingCount: 2, completedAt: state.runs[0].completed_at });
    assert.equal(state.runs[0].status, 'completed');
    assert.equal(state.runs[0].preview_hash, f.request.package.sourceFingerprint);
    for (const [index, row] of state.bindings.entries()) {
      assert.equal(row.legacy_member, f.bindings[index].legacyMember);
      assert.equal(row.agent_id, f.bindings[index].agentId);
      assert.equal(row.migration_run_id, result.runId);
      assert.equal(row.approval_ref, f.request.planHash);
      assert.equal(row.status, 'active');
    }
    const audit = JSON.parse(state.audits[0].safe_details_json);
    assert.equal(audit.runId, result.runId);
    assert.equal(audit.planHash, f.request.planHash);
    assert.equal(audit.backupId, f.backupId);
    assert.equal(audit.approver, f.grant.approver);
    return state;
  };
  f.assertEmpty = () => assert.deepEqual(f.state(), { bindings: [], runs: [], audits: [] });
  // Read-only SQLite verification may create WAL/SHM sidecars for a WAL-mode
  // copy. Compare the two published immutable leaves, never transient sidecars.
  f.artifacts = () => Object.fromEntries(readdirSync(join(root, 'registry', 'artifacts'))
    .filter(name => name.endsWith('.sqlite') || name.endsWith('.sqlite.manifest.json')).sort()
    .map(name => [name, createHash('sha256').update(readFileSync(join(root, 'registry', 'artifacts', name))).digest('hex')]));
  f.killAtBarrier = async child => {
    assert.equal(child.child.kill('SIGKILL'), true);
    const outcome = await bounded(child.close, waitMs, 'killed worker close');
    assert.equal(child.exited, true);
    assert.equal(outcome.signal, 'SIGKILL');
    assert.equal(outcome.code, null);
    assert.equal(child.messages.length, 0, 'child must not deliver a commit response');
    assert.equal(child.errors.length, 0);
  };
  return f;
}
