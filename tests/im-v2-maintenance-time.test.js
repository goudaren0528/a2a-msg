import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scenarioNames } from './fixtures/im-v2-maintenance-time/scenarios.js';
import { errorLifecycleNames } from './fixtures/im-v2-maintenance-time/error-lifecycle.js';
import { createOwner, TARGET_LIMITS, digest, proposalOf } from './fixtures/im-v2-maintenance-time/owner.js';
import { vectors } from './fixtures/im-v2-maintenance-v5-records/vectors.js';
import { encodeMaintenanceV5Record, hashMaintenanceV5Record } from '../src/im/v2/maintenance-v5-records.js';

const native = { skip: process.platform === 'win32' ? 'Strict native private-filesystem target unsupported on Windows; portable cases are separate' : false };
const childPath = fileURLToPath(new URL('./fixtures/im-v2-maintenance-time/child.js', import.meta.url));
async function child(scenario, file = childPath, payload) {
  const argv = ['--disable-warning=ExperimentalWarning', file, scenario];
  const proc = spawn(process.execPath, argv, { stdio: [payload ? 'pipe' : 'ignore', 'pipe', 'pipe'], env: { ...process.env } });
  if (payload) proc.stdin.end(JSON.stringify(payload));
  let stdout = '', stderr = '', spawnError, ready = false, exited = false, exitResult;
  let timedOut = false;
  proc.stdout.on('data', bytes => { stdout += bytes; if (stdout.includes('"phase":"ready"')) ready = true; });
  proc.stderr.on('data', bytes => { stderr += bytes; });
  proc.on('error', error => { spawnError = error; }); // error is NOT exit/close.
  proc.on('exit', (code, signal) => { exited = true; exitResult = { code, signal }; });
  let killTimer;
  const readyTimer = setTimeout(() => { if (!ready) { timedOut = true; proc.kill('SIGTERM'); killTimer = setTimeout(() => proc.kill('SIGKILL'), 3000); } }, 15000);
  const deadline = setTimeout(() => { timedOut = true; proc.kill('SIGTERM'); killTimer = setTimeout(() => proc.kill('SIGKILL'), 3000); }, 90000);
  const result = await new Promise(resolve => proc.once('close', (code, signal) => resolve({ code, signal })));
  clearTimeout(readyTimer); clearTimeout(deadline); clearTimeout(killTimer);
  console.log(JSON.stringify({ scenario, argv: [process.execPath, ...argv], ready, exited, exit: exitResult,
    spawnError: spawnError ? { code: spawnError.code, message: spawnError.message } : null, close: result, timedOut }));
  if (stdout) console.log(stdout); if (stderr) console.error(stderr);
  assert.equal(spawnError, undefined); assert.equal(timedOut, false); assert.equal(ready, true);
  assert.equal(exited, true, 'actual exit must precede close'); assert.equal(result.signal, null);
  assert.deepEqual(exitResult, result, 'independent exit and drained-stream close observations agree');
  assert.equal(result.code, 0, `${scenario}\n${stderr}`);
  assert.match(stdout, /"confirmedClosed":true/); assert.match(stdout, /"phase":"complete"/);
  return stdout;
}

test('portable: independent proposal/anchor byte domains agree with committed golden vectors', () => {
  for (const kind of ['timeProposal', 'anchorEvidence']) {
    const vector = vectors.find(row => row.kind === kind), value = JSON.parse(vector.canonical);
    assert.equal(digest(kind, value), vector.hash);
    assert.equal(hashMaintenanceV5Record(kind, value), vector.hash);
    assert.equal(encodeMaintenanceV5Record(kind, value).toString(), vector.canonical);
  }
  const anchor = JSON.parse(vectors.find(row => row.kind === 'anchorEvidence').canonical);
  assert.equal(digest('timeProposal', proposalOf(anchor)), anchor.proposalHash);
});

test('portable: exact internal exports and thin public authority export', async () => {
  const internal = await import('../src/im/v2/maintenance-time-internal.js');
  const thin = await import('../src/im/v2/maintenance-time-authority.js');
  assert.deepEqual(Object.keys(internal).sort(), ['checkMaintenanceTimeSession', 'createMaintenanceTimeAuthority', 'openIsolatedMaintenanceTimeTarget']);
  assert.deepEqual(Object.keys(thin), ['createMaintenanceTimeAuthority']);
  assert.equal(thin.createMaintenanceTimeAuthority, internal.createMaintenanceTimeAuthority);
});

test('Windows strict unsupported: legal v5 fixture cannot acquire an owned native time target', { skip: process.platform !== 'win32' }, async () => {
  const owner = createOwner();
  try {
    const before = fs.readFileSync(owner.databasePath);
    const { openIsolatedMaintenanceTimeTarget } = await import('../src/im/v2/maintenance-time-internal.js');
    assert.throws(() => openIsolatedMaintenanceTimeTarget({ databasePath: owner.databasePath, limits: { ...TARGET_LIMITS } }),
      error => ['MAINTENANCE_READ_UNAVAILABLE', 'MAINTENANCE_SCHEMA_UNSUPPORTED'].includes(error.code));
    assert.deepEqual(fs.readFileSync(owner.databasePath), before);
  } finally { owner.dispose(); }
});

for (const scenario of scenarioNames) test(`native isolated time: ${scenario}`, native, () => child(scenario));

for (const scenario of errorLifecycleNames) test(`native isolated time: ${scenario}`, native,
  () => child(scenario, fileURLToPath(new URL('./fixtures/im-v2-maintenance-time/error-lifecycle-child.js', import.meta.url))));

test('native restart: actual child exit/close loses baseline; exact proof cannot restore it; new approval can', native, async () => {
  const owner = createOwner();
  const file = fileURLToPath(new URL('./fixtures/im-v2-maintenance-time/restart-child.js', import.meta.url));
  try {
    const first = await child('restart-first', file, { step: 'first', databasePath: owner.databasePath });
    const proof = first.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(event => event.phase === 'proof');
    assert.ok(proof); owner.seedUnchanged();
    await child('restart-second', file, { step: 'second', databasePath: owner.databasePath, preview: proof.preview });
    owner.seedUnchanged();
  } finally { owner.dispose(); }
});
