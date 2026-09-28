import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonical, hash, fields } from './fixtures/im-v2-candidate-schema-v5/oracle.js';
import { runChild, successful } from './fixtures/im-v2-candidate-schema-v5/process.js';
import { vectors } from './fixtures/im-v2-maintenance-v5-records/vectors.js';

const terminal = process.env.B02B_TERMINAL_SOURCE_HASH;
const native = { skip: process.platform === 'win32' ? 'strict native recovery is UNSUPPORTED on Windows'
  : !terminal ? 'awaiting parent terminal runtime hash; moving runtime must not execute' : false };

test('independent canonical oracle has exact B0.1 order and newline domain', () => {
  for (const vector of vectors.filter(v => v.kind.startsWith('conversion'))) {
    const value = JSON.parse(vector.canonical);
    assert.equal(canonical(vector.kind, value), vector.canonical);
    assert.equal(hash(vector.kind, value), vector.hash, `frozen B0.1 ${vector.kind}`);
  }
  const p = Object.fromEntries(fields.conversionPlan.map((key, i) => [key, i]));
  const bytes = JSON.stringify(p);
  assert.equal(canonical('conversionPlan', { ...p }), bytes);
  assert.equal(hash('conversionPlan', p), createHash('sha256').update('im-center-schema-conversion-plan-v1\n' + bytes).digest('hex'));
  assert.notEqual(hash('conversionPlan', p), createHash('sha256').update('im-center-schema-conversion-plan-v1\0' + bytes).digest('hex'));
  assert.throws(() => canonical('conversionPlan', { ...p, extra: 1 }));
});

// Every case gets a private process. No global clock/native patch reaches any
// unrelated test, and known response-loss hooks run AFTER the native operation.
const cases = [
  ['intake', 'fresh'], ['intake', 'closed-v3'], ['intake', 'registered-v3'], ['intake', 'snapshot'], ['intake', 'snapshot-enabled'],
  ['surface'], ['limits'], ['capabilities'], ['strict-inputs'], ['callbacks'], ['approval-bindings'],
  ['wrong-approval'], ['self-approval'], ['final-revocation'], ['final-admin-revocation'], ['reentry'], ['source-gate'], ['invalidation'],
  ['ttl-expiry'], ['wall-regression'], ['final-wall-expiry'], ['final-wall-regression'], ['monotonic-deadline'],
  ['shared-budget', 'validation'], ['shared-budget', 'final-approval'], ['budget-caps'],
  ['drift', 'bytes'], ['drift', 'policy'], ['drift', 'epoch'], ['drift', 'identity'],
  ['precommit-rollback'], ['postcommit-response-loss'], ['native-close-response-loss'],
  ['unresolved-close'],
  ['candidate-file-sync-response-loss'], ['candidate-dir-sync-response-loss'],
  ['completion-pending-sync-response-loss'], ['completion-final-dir-sync-response-loss'],
  ['completion-missing'], ['completion-conflict'], ['old-facades'], ['locks'], ['restart-expired'], ['unknown-evidence'],
];
for (const [scenario, variant = ''] of cases) test(`candidate schema5 ${scenario} ${variant}`.trim(), native, async t => {
  assert.match(terminal, /^[0-9a-f]{64}$/, 'explicit terminal runtime-set SHA256');
  const execution = await runChild('./scenario.js', [scenario, variant], 90000);
  t.diagnostic(JSON.stringify(execution));
  const report = successful(execution);
  assert.equal(report.scenario, scenario); assert.equal(report.variant, variant); assert.equal(report.validated, true);
  assert.deepEqual(report.cleanupErrors, []);
});
