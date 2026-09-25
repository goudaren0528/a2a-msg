// Independent contract tests for A's pre-hold scope. Test staging below proves
// consumer composition only; it does not implement or accept candidate B/core.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import * as api from '../src/im/v2/backup-registry.js';
import { authority, context, unsupported } from './fixtures/im-v2-backup/helpers.js';
import { setup, triple, thrown, deeplyFrozen, directoryState, stageBeforeEstablish, durableEvidence, hash } from './fixtures/im-v2-recovery-source-intent/helpers.js';

const enter = (f, callback, registry = f.registry, input = { backupId: f.record.backupId }, ctx = context) => {
  assert.equal(typeof api.withRecoverySourceIntent, 'function', 'frozen new API is exported');
  return api.withRecoverySourceIntent(registry, input, ctx, callback);
};
const invalid = { code: 'RECOVERY_INVALID' };
const mismatch = { code: 'RECOVERY_EVIDENCE_MISMATCH' };
const registryState = f => directoryState(join(f.registryRoot, 'registry'));

for (const v3 of [false, true]) test(`intent ${v3 ? 'imported registered v3' : 'actual native v4'} metadata: frozen, no copy or writes before establishment`, { skip: unsupported }, async t => {
  const f = await setup(t, { v3 }), before = registryState(f), input = triple();
  let escaped;
  const result = enter(f, proof => {
    assert.deepEqual(Object.keys(proof).sort(), ['establish', 'record', 'sourceEvidence']);
    assert.deepEqual(proof.record, f.record); assert.deepEqual(proof.sourceEvidence, f.sourceEvidence);
    deeplyFrozen(proof); assert.equal(proof.copyTo, undefined); assert.equal(proof.hold, undefined);
    assert.equal(proof.record.publicationKind, v3 ? 'imported-registered-v3' : 'native-v4');
    escaped = proof.establish;
    assert.deepEqual(registryState(f), before);
    return 'read-only-intent';
  });
  assert.equal(result, 'read-only-intent');
  assert.deepEqual(registryState(f), before);
  assert.throws(() => escaped(input), invalid);
  assert.equal(f.registry.checkCleanup({ backupId: f.record.backupId }, context).reason, 'DISABLED');
  f.unchanged();
});

test('intent genuine private facade, exact outer input and literal synchronous admin approval are required', { skip: unsupported }, async t => {
  const f = await setup(t), before = registryState(f);
  let prefixes = 0;
  const callback = () => { prefixes++; };
  for (const fake of [{ ...f.registry }, Object.create(f.registry), new Proxy(f.registry, {})]) {
    assert.throws(() => enter(f, callback, fake), mismatch);
  }
  for (const input of [null, {}, { backupId: f.record.backupId, stagePersisted: true },
    { backupId: f.record.backupId, recoveryRunId: triple().recoveryRunId },
    { backupId: f.record.backupId, path: f.root }, { backupId: f.record.backupId, writer: callback }]) {
    thrown(() => enter(f, callback, f.registry, input));
  }
  for (const value of [false, 1, 'true', {}, Promise.resolve(true)]) {
    const registry = api.createImV2BackupRegistry({ ...f.options, authority: { ...authority, authorizeAdmin: () => value } });
    thrown(() => enter(f, callback, registry));
  }
  const registry = api.createImV2BackupRegistry({ ...f.options, authority: { ...authority, authorizeAdmin: async () => true } });
  thrown(() => enter(f, callback, registry));
  assert.throws(() => enter(f, async () => { prefixes++; }), mismatch);
  assert.equal(prefixes, 0);
  assert.deepEqual(registryState(f), before); f.unchanged();
});

for (const v3 of [false, true]) test(`test-only durable locator/proof/stage precede establish and actual ${v3 ? 'v3' : 'v4'} copy`, { skip: unsupported }, async t => {
  const f = await setup(t, { v3 });
  let established, escaped, input;
  const target = join(f.root, 'test-composed-copy.sqlite');
  enter(f, intent => {
    assert.deepEqual(fs.readdirSync(join(f.registryRoot, 'registry/holds')), []);
    const staged = stageBeforeEstablish(f.root, intent, triple().recoveryRunId);
    input = staged.input;
    for (const name of ['locator.json', 'proof.json', 'stage.json', 'plan.json']) assert.ok(fs.statSync(join(staged.path, name)).size > 0);
    assert.equal(hash(fs.readFileSync(join(staged.path, 'stage.json'))), input.stageHash);
    assert.deepEqual(fs.readdirSync(join(f.registryRoot, 'registry/holds')), []);
    established = intent.establish(input); escaped = intent.establish;
    assert.deepEqual(Object.keys(established).sort(), ['binding', 'copyTo', 'hold', 'record', 'sourceEvidence']);
    deeplyFrozen(established);
    assert.deepEqual(established.record, f.record); assert.deepEqual(established.sourceEvidence, f.sourceEvidence);
    assert.equal(established.hold.backupId, f.record.backupId);
    assert.equal(established.hold.recoveryRunId, input.recoveryRunId);
    assert.equal(established.hold.stageHash, input.stageHash);
    assert.equal(established.binding.holdId, established.hold.holdId);
    assert.equal(established.binding.preparePlanHash, input.preparePlanHash);
    durableEvidence(f.registryRoot, established);
    const beforeRepeat = registryState(f);
    assert.strictEqual(intent.establish({ ...input }), established, 'same triple returns same object and capability');
    assert.deepEqual(registryState(f), beforeRepeat);
    const fd = fs.openSync(target, 'wx', 0o600);
    try {
      established.copyTo(chunk => { durableEvidence(f.registryRoot, established); fs.writeFileSync(fd, chunk); });
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    assert.equal(hash(fs.readFileSync(target)), f.record.fileHash);
  });
  assert.throws(() => escaped(input), invalid);
  assert.throws(() => established.copyTo(() => assert.fail('escaped copy')), invalid);
  assert.deepEqual(f.registry.getHold({ holdId: established.hold.holdId }, context), { hold: established.hold, binding: established.binding, release: null });
  assert.equal(f.registry.checkCleanup({ backupId: f.record.backupId }, context).reason, 'HOLD');
  let retry;
  enter(f, intent => { retry = intent.establish(input); });
  assert.deepEqual(retry.hold, established.hold); assert.deepEqual(retry.binding, established.binding);
  f.unchanged();
});

test('null-plan establishment is durable and exact repeated identity is preserved', { skip: unsupported }, async t => {
  const f = await setup(t), input = { ...triple(), preparePlanHash: null };
  let held;
  enter(f, intent => {
    held = intent.establish(input); assert.equal(held.binding, null);
    assert.strictEqual(intent.establish({ ...input }), held);
    durableEvidence(f.registryRoot, held);
  });
  assert.deepEqual(fs.readdirSync(join(f.registryRoot, 'registry/holds')), [`${held.hold.holdId}.json`]);
  f.unchanged();
});

test('each differing triple poisons established scope and revokes its previous copy capability', { skip: unsupported }, async t => {
  const f = await setup(t);
  for (const key of ['recoveryRunId', 'stageHash', 'preparePlanHash']) {
    const input = triple(); let held, escaped;
    thrown(() => enter(f, intent => {
      escaped = intent.establish; held = intent.establish(input);
      const changed = { ...input, [key]: key === 'recoveryRunId' ? triple().recoveryRunId : 'c'.repeat(64) };
      thrown(() => intent.establish(changed));
      thrown(() => held.copyTo(() => assert.fail('poisoned copy sink called')));
      thrown(() => intent.establish(input));
      return 'must-not-succeed';
    }));
    assert.throws(() => escaped(input), invalid);
    durableEvidence(f.registryRoot, held);
    assert.deepEqual(f.registry.getHold({ holdId: held.hold.holdId }, context).hold, held.hold);
  }
  f.unchanged();
});

test('malformed second establishment poisons a previously usable copy capability', { skip: unsupported }, async t => {
  const f = await setup(t), input = triple(); let held;
  thrown(() => enter(f, intent => {
    held = intent.establish(input);
    let bytes = 0; held.copyTo(chunk => { bytes += chunk.length; });
    assert.ok(bytes > 0, 'capability was actually usable before poison');
    thrown(() => intent.establish({ ...input, stagePersisted: true }));
    thrown(() => held.copyTo(() => assert.fail('copy after malformed establishment')));
    return 'caught';
  }));
  durableEvidence(f.registryRoot, held);
  assert.deepEqual(f.registry.verify({ backupId: f.record.backupId }, context).record, f.record);
  f.unchanged();
});

test('malformed or augmented establishment poisons even when caught; no hold/binding is written', { skip: unsupported }, async t => {
  const f = await setup(t), good = triple();
  const cases = [null, {}, { ...good, recoveryRunId: 'invalid' }, { ...good, stageHash: 'x' },
    { ...good, preparePlanHash: false }, { recoveryRunId: good.recoveryRunId, stageHash: good.stageHash },
    { ...good, backupId: f.record.backupId }, { ...good, stagePersisted: true },
    { ...good, path: f.root }, { ...good, writer: () => {} }];
  for (const input of cases) {
    const before = registryState(f); let escaped;
    thrown(() => enter(f, intent => {
      escaped = intent.establish;
      thrown(() => intent.establish(input));
      thrown(() => intent.establish(good));
      return 'caught';
    }));
    assert.throws(() => escaped(good), invalid);
    assert.deepEqual(registryState(f), before);
    assert.deepEqual(f.registry.verify({ backupId: f.record.backupId }, context).record, f.record);
  }
});

test('original falsy callback and sink failures survive; established hold stays and lock/capabilities expire', { skip: unsupported }, async t => {
  const f = await setup(t);
  for (const failure of [null, false, 0, '', undefined]) for (const at of ['pre-hold', 'callback', 'sink']) {
    const input = triple(), before = registryState(f); let established, escaped;
    thrown(() => enter(f, intent => {
      escaped = intent.establish;
      if (at === 'pre-hold') throw failure;
      established = intent.establish(input);
      if (at === 'sink') established.copyTo(() => { throw failure; });
      else throw failure;
    }), error => error === failure);
    assert.throws(() => escaped(input), invalid);
    if (established) {
      assert.throws(() => established.copyTo(() => assert.fail('expired sink')), invalid);
      assert.deepEqual(f.registry.getHold({ holdId: established.hold.holdId }, context), { hold: established.hold, binding: established.binding, release: null });
    } else assert.deepEqual(registryState(f), before);
    assert.deepEqual(f.registry.verify({ backupId: f.record.backupId }, context).record, f.record);
    f.unchanged();
  }
});

for (const observer of [false, true]) test(`isolated returned rejection and async-prefix refusal (observer=${observer})`, { skip: unsupported, timeout: 30000 }, async t => {
  const f = await setup(t), child = f.start('rejections', { observer });
  await child.go(); const result = await child.next('complete'); const lifecycle = await child.ended();
  assert.equal(result.prefixes, 0); assert.equal(result.unhandled, 0); assert.equal(result.rejections, 2);
  t.diagnostic(JSON.stringify({ mode: 'rejections', observer, pid: child.pid, ...lifecycle }));
  f.unchanged();
});

for (const kind of ['hold', 'binding']) test(`native ${kind} directory fsync failure poisons caught establishment; new scope resyncs same hold`, { skip: unsupported, timeout: 30000 }, async t => {
  const f = await setup(t), child = f.start('durability', { kind, input: triple() });
  await child.go(); const result = await child.next('complete'); const lifecycle = await child.ended();
  assert.ok(result.failedSyncs >= 1); assert.ok(result.retrySyncs >= 1);
  assert.equal(result.copiesAfterFailure, 0); assert.equal(result.sameHold, true);
  t.diagnostic(JSON.stringify({ mode: 'durability', kind, ...result, ...lifecycle }));
  f.unchanged();
});

test('reentrant establishment during real hold publication refuses and poisons outer scope', { skip: unsupported, timeout: 30000 }, async t => {
  const f = await setup(t), child = f.start('reentrant', { input: triple() });
  await child.go(); const result = await child.next('complete'); await child.ended();
  assert.equal(result.reentered, true); assert.equal(result.escapedCopy, false);
  f.unchanged();
});

for (const v3 of [false, true]) for (const exceptional of [false, true]) test(`real ${v3 ? 'v3' : 'v4'} process lock PRE-HOLD / POST-HOLD / COPY, ${exceptional ? 'exception' : 'normal'} release`, { skip: unsupported, timeout: 55000 }, async t => {
  const f = await setup(t, { v3 }), input = triple();
  const holder = f.start('holder', { input, exceptional }); await holder.go();
  let held;
  for (const phase of ['pre-hold-verified', 'post-hold-durable', 'actual-copy-after-facade', ...(exceptional ? [] : ['final-source-verification'])]) {
    const observed = await holder.next(phase);
    if (phase === 'pre-hold-verified') assert.deepEqual(fs.readdirSync(join(f.registryRoot, 'registry/holds')), []);
    else { held ??= observed.hold; assert.deepEqual(observed.hold, held); durableEvidence(f.registryRoot, observed); }
    if (phase === 'actual-copy-after-facade') assert.ok(observed.copied > 0);
    if (phase === 'final-source-verification') assert.ok(observed.readBytes > 0);
    const contender = f.start('contender', { input }); await contender.go();
    const result = await contender.next('contender'); await contender.ended();
    assert.notEqual(result.pid, holder.pid); assert.notEqual(result.pid, process.pid);
    assert.deepEqual(Object.keys(result.results).sort(), ['checkCleanup', 'createStageHold', 'verify']);
    for (const outcome of Object.values(result.results)) assert.deepEqual(outcome, { ok: false, code: 'RECOVERY_BUSY' });
    t.diagnostic(JSON.stringify({ phase, holderPid: holder.pid, contenderPid: result.pid, results: result.results }));
    await holder.release(observed.sequence);
  }
  const complete = await holder.next('complete'); const lifecycle = await holder.ended();
  assert.equal(complete.expired, true); assert.equal(complete.exceptional, exceptional);
  const contender = f.start('contender', { input }); await contender.go();
  const released = await contender.next('contender'); await contender.ended();
  for (const outcome of Object.values(released.results)) assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.deepEqual(released.results.createStageHold.value, held);
  assert.deepEqual(released.results.checkCleanup.value, { allowed: false, reason: 'HOLD' });
  assert.deepEqual(released.results.verify.value.record, f.record);
  assert.deepEqual(fs.readdirSync(join(f.registryRoot, 'registry/holds')).sort(), [`${held.holdId}.json`, `${held.holdId}.binding.json`].sort());
  t.diagnostic(JSON.stringify({ phase: 'released', ...lifecycle }));
  f.unchanged();
});

for (const v3 of [false, true]) test(`read-only completed-retry consumer continues using withVerifiedBackup (${v3 ? 'v3' : 'v4'}) without hold/binding`, { skip: unsupported }, async t => {
  const f = await setup(t, { v3 }), before = registryState(f);
  // Models an already-completed consumer's read-only observation, not B core.
  const observed = f.registry.withVerifiedBackup({ backupId: f.record.backupId }, context, proof => {
    assert.deepEqual(proof.record, f.record); assert.deepEqual(proof.sourceEvidence, f.sourceEvidence);
    return { backupId: proof.record.backupId, fileHash: proof.record.fileHash };
  });
  assert.deepEqual(observed, { backupId: f.record.backupId, fileHash: f.record.fileHash });
  assert.deepEqual(registryState(f), before);
  assert.deepEqual(fs.readdirSync(join(f.registryRoot, 'registry/holds')), []);
  f.unchanged();
});

test('Windows native registry remains explicitly unsupported', { skip: !unsupported }, () => {
  assert.throws(() => api.createImV2BackupRegistry({ root: process.cwd() }), { code: 'RECOVERY_UNSUPPORTED' });
});
