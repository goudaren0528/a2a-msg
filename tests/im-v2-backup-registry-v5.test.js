import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTrustedImV2BackupServices, createImV2BackupRegistry, withRecoverySource } from '../src/im/v2/backup-registry.js';
import { fixture as oldFixture, context as oldContext } from './fixtures/im-v2-backup/helpers.js';
import { legacyPublished } from './fixtures/im-v2-backup/legacy-published.js';
import { createImV2Backup } from '../src/im/v2/backup.js';
import { fixture, context, unsupported, mismatch, busy, uncertain, assertChain, paths, fileState,
  inventory, readChain, canonical, sha, frozen, wrapFs } from './fixtures/im-v2-backup-v5/helpers.js';
import { start } from './fixtures/im-v2-backup-v5/children.js';

async function published(t) {
  const f = fixture(t), services = createTrustedImV2BackupServices(f.options);
  const result = await services.publisher.publish({ approvalRef: 'b2-approved' }, context); await services.publisher.drain();
  return { ...f, ...services, ...result, chain: assertChain(f, result) };
}

test('B2 native5 genuine reopened facade/proof/copy and expiry; no public registration capability', { skip: unsupported }, async t => {
  const f = await published(t), registry = createImV2BackupRegistry(f.options), input = { backupId: f.record.backupId };
  assert.deepEqual(Object.keys(registry).sort(), ['bindPrepareHold', 'checkCleanup', 'createStageHold', 'getHold', 'verify', 'withVerifiedBackup']);
  assert.deepEqual(registry.verify(input, context), { record: f.record, sourceEvidence: f.sourceEvidence });
  let stale; const chunks = [];
  registry.withVerifiedBackup(input, context, proof => {
    frozen(proof); stale = proof.copyTo;
    assert.equal(Object.hasOwn(proof, 'path'), false);
    proof.copyTo(chunk => { chunks.push(Buffer.from(chunk)); assert.throws(() => f.registry.verify(input, context), busy); });
  });
  assert.equal(sha(Buffer.concat(chunks)), f.record.fileHash);
  assert.deepEqual(Buffer.concat(chunks), fs.readFileSync(f.chain.paths.artifact));
  assert.throws(() => stale(() => {}), { code: 'RECOVERY_INVALID' });
  assert.deepEqual(registry.checkCleanup(input, context), { allowed: false, reason: 'DISABLED' });
});

test('B2 primitive canonical hash cannot mint provenance or cause verify to fill missing registration', { skip: unsupported }, async t => {
  const f = fixture(t), primitive = createImV2Backup(f.options), registry = createImV2BackupRegistry(f.options);
  const result = await primitive.publish({ approvalRef: 'b2-approved' }, context); await primitive.drain();
  const before = inventory(join(f.registryRoot, 'registry'));
  assert.throws(() => registry.verify({ backupId: result.manifest.backupId }, context), mismatch);
  assert.deepEqual(inventory(join(f.registryRoot, 'registry')), before);
  assert.deepEqual(fs.readdirSync(join(f.registryRoot, 'registry/records')), []);
});

test('B2 actual second publication crosslink rejects despite independently correct source hash', { skip: unsupported }, async t => {
  const f = await published(t), second = await f.publisher.publish({ approvalRef: 'b2-approved' }, context); await f.publisher.drain();
  const first = f.chain, other = readChain(f.registryRoot, second.record.backupId);
  // Both sides are genuine publications. Replace first source with second's
  // actual canonical proof and update its outer hash, preserving valid syntax.
  const bytes = fs.readFileSync(other.paths.source); fs.writeFileSync(first.paths.source, bytes);
  first.record.sourceEvidenceHash = sha(bytes); fs.writeFileSync(first.paths.record, canonical('record', first.record));
  assert.throws(() => createImV2BackupRegistry(f.options).verify({ backupId: f.record.backupId }, context), mismatch);
  assert.deepEqual(f.registry.verify({ backupId: second.record.backupId }, context), second);
});

for (const [kind, field, wrong] of [['manifest', 'formatVersion', 2], ['manifest', 'toolVersion', 'im-v2-backup-1'],
  ['record', 'recordVersion', 3], ['record', 'publicationKind', 'native-v4'], ['record', 'publicationKind', 'native-v99'],
  ['source', 'version', 1], ['source', 'registryFormat', 3]]) {
  test(`B2 mixed family ${kind}.${field}=${wrong}: exact EVIDENCE_MISMATCH without legacy fallback`, { skip: unsupported }, async t => {
    const f = await published(t), c = f.chain;
    c[kind][field] = wrong;
    fs.writeFileSync(c.paths[kind], canonical(kind, c[kind]));
    if (kind === 'manifest') {
      c.source.manifestHash = sha(fs.readFileSync(c.paths.manifest)); c.record.manifestHash = c.source.manifestHash;
      fs.writeFileSync(c.paths.source, canonical('source', c.source));
    }
    if (kind !== 'record') { c.record.sourceEvidenceHash = sha(fs.readFileSync(c.paths.source)); fs.writeFileSync(c.paths.record, canonical('record', c.record)); }
    assert.throws(() => f.registry.verify({ backupId: f.record.backupId }, context), mismatch);
  });
}

test('B2 async prefixes zero; legitimate sync copy survives known-async refusal; caught returned-Promise expires capability', { skip: unsupported }, async t => {
  const f = await published(t), input = { backupId: f.record.backupId }; let calls = 0, stale;
  const unhandled = [], observer = error => unhandled.push(error);
  process.on('unhandledRejection', observer); t.after(() => process.off('unhandledRejection', observer));
  assert.throws(() => f.registry.withVerifiedBackup(input, context, async () => { calls++; }), mismatch);
  let bytes = 0, innerCaught = false, innerCode, expiredCaught = false, expiredCode;
  assert.throws(() => f.registry.withVerifiedBackup(input, context, proof => {
    stale = proof.copyTo;
    assert.throws(() => proof.copyTo(async () => { calls++; }), mismatch); assert.equal(calls, 0);
    proof.copyTo(chunk => { bytes += chunk.length; });
    try { proof.copyTo(() => Promise.reject(Error('test-only B2 rejected sink'))); }
    catch (error) { innerCaught = true; innerCode = error.code; }
    try { proof.copyTo(() => {}); } catch (error) { expiredCaught = true; expiredCode = error.code; }
  }), mismatch);
  assert.equal(innerCaught, true); assert.equal(innerCode, 'RECOVERY_EVIDENCE_MISMATCH');
  assert.equal(expiredCaught, true); assert.equal(expiredCode, 'RECOVERY_INVALID');
  assert.equal(calls, 0); assert.ok(bytes > 0);
  assert.throws(() => stale(() => {}), { code: 'RECOVERY_INVALID' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(unhandled, []);
  assert.deepEqual(f.registry.verify(input, context), { record: f.record, sourceEvidence: f.sourceEvidence });
});

for (const family of ['native-v4', 'imported-registered-v3', 'native-v5']) for (const scope of ['withVerifiedBackup', 'withRecoverySource']) {
  test(`B2 A ${family} ${scope}: local original identity, escaping identity, later consumer exception and real postcheck`, { skip: unsupported, timeout: 60000 }, async t => {
    const cleanups = [], lifecycle = { after: fn => cleanups.push(fn) };
    t.after(async () => { for (const fn of cleanups.reverse()) await fn(); });
    const f = family === 'native-v5' ? fixture(lifecycle) : oldFixture(lifecycle, { v3: family === 'imported-registered-v3' });
    const ctx = family === 'native-v5' ? context : oldContext, services = createTrustedImV2BackupServices(f.options);
    let result;
    if (family === 'imported-registered-v3') {
      const legacy = await legacyPublished(lifecycle, f);
      result = services.publisher.importRegisteredV3({ sourceRegistry: legacy.old.registry, backupId: legacy.output.backupId }, ctx);
    } else result = await services.publisher.publish({ approvalRef: family === 'native-v5' ? 'b2-approved' : 'test-approved' }, ctx);
    await services.publisher.drain(); assert.equal(result.record.publicationKind, family);
    const input = { backupId: result.record.backupId }, artifact = paths(f.registryRoot, result.record.backupId).artifact;
    const before = fileState(artifact), expectedBytes = before.bytes;
    const holdInput = { ...input, recoveryRunId: randomUUID(), stageHash: 'a'.repeat(64), preparePlanHash: 'b'.repeat(64) };
    const enter = cb => scope === 'withVerifiedBackup' ? services.registry.withVerifiedBackup(input, ctx, cb) : withRecoverySource(services.registry, holdInput, ctx, cb);
    const values = [new Error('B2 original synchronous sink'), null, false, 0, '', undefined];
    for (const [index, original] of values.entries()) {
      let caught = false, observed, stale, held, callbackReturned = false, postReads = 0;
      const chunks = [];
      const restore = wrapFs({ readSync: real => (fd, ...args) => {
        const n = real(fd, ...args), st = fs.fstatSync(fd);
        if (callbackReturned && n > 0 && st.dev === before.dev && st.ino === before.ino) postReads++;
        return n;
      } });
      let answer;
      try {
        answer = enter(proof => {
          stale = proof.copyTo; held = proof.hold;
          try { proof.copyTo(() => { throw original; }); } catch (error) { caught = true; observed = error; }
          proof.copyTo(chunk => chunks.push(Buffer.from(chunk)));
          callbackReturned = true; return 'normal-consumer-return';
        });
      } finally { restore(); }
      assert.equal(caught, true, `explicit catch flag for value ${index}`); assert.strictEqual(observed, original);
      assert.equal(answer, 'normal-consumer-return'); assert.deepEqual(Buffer.concat(chunks), expectedBytes);
      assert.ok(postReads > 0, 'actual artifact read after callback return proves final verification');
      assert.throws(() => stale(() => {}), { code: 'RECOVERY_INVALID' });
      assert.deepEqual(services.registry.verify(input, ctx), result);
      if (held) {
        const receipt = services.registry.getHold({ holdId: held.holdId }, ctx);
        assert.deepEqual(receipt.hold, held); assert.equal(receipt.binding.preparePlanHash, holdInput.preparePlanHash);
      }
      for (const later of [false, true]) {
        const consumerError = new Error(`different later consumer ${index}`);
        let outerCaught = false, outerValue, localCaught = false, localValue;
        try {
          enter(proof => {
            stale = proof.copyTo;
            if (later) {
              try { proof.copyTo(() => { throw original; }); } catch (error) { localCaught = true; localValue = error; }
              throw consumerError;
            }
            proof.copyTo(() => { throw original; });
          });
        } catch (error) { outerCaught = true; outerValue = error; }
        assert.equal(outerCaught, true); assert.strictEqual(outerValue, later ? consumerError : original);
        if (later) { assert.equal(localCaught, true); assert.strictEqual(localValue, original); }
        assert.throws(() => stale(() => {}), { code: 'RECOVERY_INVALID' });
        assert.deepEqual(services.registry.verify(input, ctx), result, 'next real lock acquisition');
      }
      assert.deepEqual(fileState(artifact), before);
    }
    t.diagnostic(JSON.stringify({ criterion: 'A', family, scope, values: 6, localNormalReturns: 6, escapingOriginals: 6, differentConsumerErrors: 6, postchecks: 6 }));
  });
}

for (const kind of ['artifact', 'manifest', 'source', 'record']) for (const position of ['before-native', 'after-native']) {
  test(`B2 ${kind} publication directory-fsync ${position}: visible incomplete or complete chain is retained and never assumed durable`,
    { skip: unsupported, timeout: 60000 }, async t => {
      const f = fixture(t), services = createTrustedImV2BackupServices(f.options);
      let lastKind, target, fired = false;
      const classify = path => path.endsWith('.sqlite') ? 'artifact' : path.endsWith('.manifest.json') ? 'manifest' : path.endsWith('.source.json') ? 'source' : /registry[\\/]records[\\/][0-9a-f-]{36}\.json$/.test(path) ? 'record' : null;
      const restore = wrapFs({
        linkSync: real => (from, to) => { const result = real(from, to); const value = classify(to); if (value) { lastKind = value; target = to; } return result; },
        fsyncSync: real => fd => {
          const st = fs.fstatSync(fd), selected = !fired && st.isDirectory() && lastKind === kind;
          if (selected && position === 'before-native') { fired = true; throw Error(`B2 ${kind} before-native directory fsync`); }
          const result = real(fd);
          if (selected) { fired = true; throw Error(`B2 ${kind} after-native directory fsync`); }
          return result;
        },
      });
      try { await assert.rejects(services.publisher.publish({ approvalRef: 'b2-approved' }, context), uncertain); await services.publisher.drain(); }
      finally { await services.publisher.drain(); restore(); }
      assert.equal(fired, true, 'labelled native boundary was actually reached');
      assert.ok(fs.existsSync(target), 'linked final remains visible');
      const id = /([0-9a-f-]{36})/.exec(target)[1], p = paths(f.registryRoot, id);
      const before = inventory(join(f.registryRoot, 'registry'));
      if (kind !== 'record') {
        assert.equal(fs.existsSync(p.record), false, 'incomplete chain has no commit record');
        const child = start({ own: f.own, diagnostic: value => t.diagnostic(value) }, { mode: 'verify', root: f.registryRoot, backupId: id });
        const result = await child.done(); assert.equal(result.code, 'RECOVERY_EVIDENCE_MISMATCH');
        assert.deepEqual(inventory(join(f.registryRoot, 'registry')), before, 'no adoption/deletion/metadata fabrication');
      } else {
        assert.ok(fs.existsSync(p.record), 'complete visible chain despite failed sync');
        for (const directory of [false, true]) {
          const child = start({ own: f.own, diagnostic: value => t.diagnostic(value) }, { mode: 'verify', root: f.registryRoot, backupId: id, failKind: kind, directory, position });
          const result = await child.done(); assert.equal(result.code, 'RECOVERY_DURABILITY_UNCERTAIN');
          assert.deepEqual(inventory(join(f.registryRoot, 'registry')), before);
        }
        const child = start({ own: f.own, diagnostic: value => t.diagnostic(value) }, { mode: 'verify', root: f.registryRoot, backupId: id });
        const result = await child.done(); assert.equal(result.code, null); assert.equal(result.backupId, id);
        for (const path of [...Object.values(p), ...new Set(Object.values(p).map(dirname))]) {
          assert.ok(result.syncs.some(value => value.path === path), `reopened proof resyncs ${path}`);
        }
        assert.deepEqual(inventory(join(f.registryRoot, 'registry')), before, 'resync preserves exact bytes/inodes/times');
      }
      t.diagnostic(JSON.stringify({ kind, position, reached: fired, complete: kind === 'record' }));
    });
}

for (const kind of ['artifact', 'manifest', 'source', 'record']) for (const directory of [false, true]) {
  test(`B2 reopened native5 proof requires actual ${kind} ${directory ? 'directory' : 'file'} resync before return`, { skip: unsupported, timeout: 45000 }, async t => {
    const f = await published(t), before = inventory(join(f.registryRoot, 'registry'));
    const child = start({ own: f.own, diagnostic: value => t.diagnostic(value) }, { mode: 'verify', root: f.registryRoot, backupId: f.record.backupId, failKind: kind, directory, position: 'before-native' });
    assert.equal((await child.done()).code, 'RECOVERY_DURABILITY_UNCERTAIN');
    assert.deepEqual(inventory(join(f.registryRoot, 'registry')), before);
  });
}

for (const kind of ['artifact', 'manifest', 'source', 'record']) for (const position of ['before-native', 'after-native']) {
  test(`B2 ${kind} owned-pending FILE fsync ${position}: no completed record and no pending adoption`, { skip: unsupported }, async t => {
    const f = fixture(t), services = createTrustedImV2BackupServices(f.options); let fired = false, pending;
    const restore = wrapFs({ fsyncSync: real => fd => {
      const st = fs.fstatSync(fd); let actual;
      if (st.isFile()) {
        const path = fs.readlinkSync(`/proc/self/fd/${fd}`);
        if (path.startsWith(join(f.registryRoot, 'registry')) && path.endsWith('.pending')) {
          const bytes = fs.readFileSync(path);
          if (bytes.subarray(0, 16).toString('binary') === 'SQLite format 3\0') actual = 'artifact';
          else {
            try { const value = JSON.parse(bytes); actual = value.formatVersion ? 'manifest' : value.recordVersion ? 'record' : value.kind === 'registered-backup' ? 'source' : null; } catch { /* still-empty pending is not this boundary */ }
          }
          if (actual === kind) pending = path;
        }
      }
      const selected = !fired && actual === kind;
      if (selected && position === 'before-native') { fired = true; throw Error(`B2 ${kind} before-native FILE fsync`); }
      const result = real(fd);
      if (selected) { fired = true; throw Error(`B2 ${kind} after-native FILE fsync`); }
      return result;
    } });
    try { await assert.rejects(services.publisher.publish({ approvalRef: 'b2-approved' }, context), uncertain); await services.publisher.drain(); }
    finally { await services.publisher.drain(); restore(); }
    assert.equal(fired, true); assert.ok(fs.existsSync(pending), 'owned pending retained after actual labelled file boundary');
    assert.equal(fs.readdirSync(join(f.registryRoot, 'registry/records')).some(name => /^[0-9a-f-]{36}\.json$/.test(name)), false);
    const before = inventory(join(f.registryRoot, 'registry'));
    const manifests = fs.readdirSync(join(f.registryRoot, 'registry/artifacts')).filter(name => name.endsWith('.manifest.json'));
    for (const name of manifests) assert.throws(() => createImV2BackupRegistry(f.options).verify({ backupId: name.slice(0, 36) }, context), mismatch);
    assert.deepEqual(inventory(join(f.registryRoot, 'registry')), before);
  });
}

for (const [mode, phase] of [['held-copy', 'copy-held'], ['source-postverify', 'source-postverify-held'], ['resync-held', 'resync-held']]) {
  test(`B2 independent process contender is exactly RECOVERY_BUSY during ${mode}`, { skip: unsupported, timeout: 45000 }, async t => {
    const f = await published(t), input = { backupId: f.record.backupId }, before = fileState(f.chain.paths.artifact);
    const child = start({ own: f.own, diagnostic: value => t.diagnostic(value) }, { mode, root: f.registryRoot, backupId: f.record.backupId, runId: randomUUID() });
    try {
      await child.next(phase);
      assert.throws(() => createImV2BackupRegistry(f.options).verify(input, context), busy);
      assert.throws(() => f.registry.checkCleanup(input, context), busy);
      child.release(); assert.equal((await child.done()).code, null);
    } finally { await child.stop(); }
    assert.deepEqual(fileState(f.chain.paths.artifact), before);
    assert.deepEqual(f.registry.verify(input, context), { record: f.record, sourceEvidence: f.sourceEvidence });
  });
}

test('B2 D true POST-CALLBACK native5 revalidation holds coordinator during actual artifact read', { skip: unsupported, timeout: 45000 }, async t => {
  const f = await published(t), input = { backupId: f.record.backupId }, before = fileState(f.chain.paths.artifact);
  const child = start({ own: f.own, diagnostic: value => t.diagnostic(value) }, { mode: 'true-postcallback', root: f.registryRoot, backupId: f.record.backupId, runId: randomUUID() });
  try {
    const reached = await child.next('postcallback-held');
    assert.equal(reached.callbackReturned, true); assert.equal(reached.operation.callbackDepth, 0);
    assert.equal(reached.operation.nativeCompleted, true); assert.ok(reached.operation.bytes > 0);
    assert.equal(reached.operation.target, f.chain.paths.artifact);
    assert.equal(reached.operation.dev, before.dev); assert.equal(reached.operation.ino, before.ino);
    assert.throws(() => createImV2BackupRegistry(f.options).verify(input, context), busy);
    child.release(); const result = await child.done(); assert.equal(result.code, null); assert.equal(result.callbackReturned, true);
  } finally { await child.stop(); }
  assert.deepEqual(createImV2BackupRegistry(f.options).verify(input, context), { record: f.record, sourceEvidence: f.sourceEvidence });
  assert.deepEqual(fileState(f.chain.paths.artifact), before);
});
