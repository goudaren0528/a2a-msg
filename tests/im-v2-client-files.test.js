import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, basename } from 'node:path';
import { test } from 'node:test';
import { createImV2AttachmentStore } from '../src/im/v2/client-files.js';
import { createChildHarness } from './fixtures/im-v2-client-files/child-harness.js';

const uuid = () => randomUUID();
const partition = () => ({ centerOrigin: 'https://example.test', stableInstanceId: uuid(), agentId: uuid(), centerEpoch: uuid() });
function fixture(bytes = Buffer.from('attachment')) {
  return { attachmentId: uuid(), name: 'remote.txt', mime: null, size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') };
}
const error = code => e => e?.name === 'ImV2Error' && e.code === code;
const unix = (name, fn) => test(name, { skip: process.platform === 'win32' ? 'native Unix filesystem required' : false }, fn);

async function environment(t) {
  const parent = process.platform === 'win32' ? tmpdir() : homedir();
  const directory = await fs.mkdtemp(join(parent, 'im-v2-files-'));
  t.after(async () => { await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, store: createImV2AttachmentStore({ directory, durability: 'strict' }), partition: partition(), messageId: uuid() };
}

test('scope and filenames cannot be selected by remote metadata or arbitrary partitionId', async t => {
  const { directory, store, partition: p, messageId } = await environment(t);
  const a = fixture();
  assert.equal(Object.isFrozen(store), true);
  assert.deepEqual(Object.keys(store).sort(), ['pathFor', 'save', 'verify']);
  const path = store.pathFor(p, messageId, a.attachmentId);
  assert.equal(path.startsWith(directory), true);
  assert.match(basename(path), /^[0-9a-f]{64}-[0-9a-f-]{36}-[0-9a-f-]{36}\.bin$/);
  assert.notEqual(path, store.pathFor({ ...p, centerEpoch: uuid() }, messageId, a.attachmentId));
  assert.notEqual(path, store.pathFor({ ...p, stableInstanceId: uuid() }, messageId, a.attachmentId));
  assert.throws(() => store.pathFor({ ...p, partitionId: '0'.repeat(64) }, messageId, a.attachmentId), error('INVALID_ATTACHMENT'));
  assert.throws(() => store.pathFor({ ...p, centerOrigin: 'https://example.test/' }, messageId, a.attachmentId), error('INVALID_ATTACHMENT'));
  assert.throws(() => store.pathFor(p, '../bad', a.attachmentId), error('INVALID_ATTACHMENT'));
  assert.throws(() => createImV2AttachmentStore({ directory, durability: 'best-effort' }), error('INVALID_ATTACHMENT'));
});

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function assertReceiptOnDisk(directory, path, attachment, receipt) {
  assert.deepEqual(receipt, {
    relativeName: basename(path), sha256: attachment.sha256,
    size: attachment.size, durability: 'durable',
  });
  const reopened = await fs.readFile(join(directory, receipt.relativeName));
  assert.equal(reopened.length, receipt.size);
  assert.equal(digest(reopened), receipt.sha256);
  const stat = await fs.lstat(path);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.nlink, 1);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal(stat.uid, process.geteuid());
}

async function childEnvironment(t) {
  const directory = await fs.mkdtemp(join(homedir(), 'im-v2-files-fault-'));
  const harness = createChildHarness(evidence => t.diagnostic(JSON.stringify(evidence)));
  t.after(async () => {
    // A failed settle deliberately skips deletion of possibly live-child data.
    await harness.settle();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const p = partition(), messageId = uuid(), bytes = Buffer.from('owned attachment bytes');
  const attachment = fixture(bytes);
  const store = createImV2AttachmentStore({ directory, durability: 'strict' });
  const finalPath = store.pathFor(p, messageId, attachment.attachmentId);
  const input = { directory, partition: p, messageId, attachment, finalPath, bytes: bytes.toString('base64') };
  const sentinel = join(directory, 'unrelated-preexisting.bin');
  const sentinelBytes = Buffer.from('never change or delete this preexisting file');
  await fs.writeFile(sentinel, sentinelBytes, { mode: 0o600 });
  return { directory, harness, input, store, bytes, sentinel,
    async sentinelUnchanged() { assert.equal(digest(await fs.readFile(sentinel)), digest(sentinelBytes)); } };
}

function assertStorageFailure(result) {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.receipt, undefined);
  assert.equal(result.error.name, 'ImV2Error');
  assert.equal(result.error.code, 'STORAGE_UNAVAILABLE');
  assert.equal(result.faultHits, 1, 'one native fault must actually have been reached');
}

function assertResynced(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.downloadCalls, 0, 'recovery must reuse existing verified bytes');
  const file = result.events.findIndex(e => e.operation === 'sync' && e.kind === 'final');
  const directory = result.events.findIndex((e, i) => i > file && e.operation === 'sync' && e.kind === 'directory');
  assert.ok(file >= 0, 'existing bytes must be file-synced');
  assert.ok(directory > file, 'store directory must be synced after file');
}

unix('store itself must be 0700: 0755 and 0711 rejected without chmod; safe ordinary ancestors allowed', async t => {
  const { directory, partition: p, messageId } = await environment(t);
  const ancestor = join(directory, 'ordinary-ancestor');
  await fs.mkdir(ancestor, { mode: 0o755 });
  await fs.chmod(ancestor, 0o755);
  for (const mode of [0o755, 0o711, 0o700]) {
    const leaf = join(ancestor, mode.toString(8));
    await fs.mkdir(leaf, { mode });
    await fs.chmod(leaf, mode);
    const store = createImV2AttachmentStore({ directory: leaf, durability: 'strict' });
    const bytes = Buffer.from('private'), attachment = fixture(bytes);
    const sentinel = join(leaf, 'existing');
    await fs.writeFile(sentinel, bytes, { mode: 0o600 });
    const saving = store.save({ partition: p, messageId, attachment, download: async () => bytes });
    if (mode !== 0o700) {
      await assert.rejects(saving, error('STORAGE_UNAVAILABLE'));
      await assert.rejects(fs.lstat(store.pathFor(p, messageId, attachment.attachmentId)), { code: 'ENOENT' });
    } else {
      await assertReceiptOnDisk(leaf, store.pathFor(p, messageId, attachment.attachmentId), attachment, await saving);
    }
    assert.equal((await fs.lstat(leaf)).mode & 0o777, mode, 'must not repair caller permissions');
    assert.equal(digest(await fs.readFile(sentinel)), digest(bytes));
    assert.equal((await fs.lstat(ancestor)).mode & 0o777, 0o755);
  }
});

unix('awaited download snapshots caller attachment and every partition identity field', async t => {
  const { directory, store, partition: p, messageId } = await environment(t);
  const bytes = Buffer.from('original metadata bytes'), attachment = fixture(bytes);
  const originalAttachment = { ...attachment }, originalPartition = { ...p };
  const originalPath = store.pathFor(p, messageId, attachment.attachmentId);
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  const saving = store.save({ partition: p, messageId, attachment, download: async () => {
    entered(); await barrier; return bytes;
  } });
  // Race against completion as well, so an unexpected early failure cannot hang.
  await Promise.race([ready, saving.then(() => { throw Error('save skipped download'); })]);
  Object.assign(p, { ...partition(), centerOrigin: 'https://changed.test' });
  Object.assign(attachment, fixture(Buffer.from('different')));
  attachment.name = 'changed.txt';
  release();
  const receipt = await saving;
  await assertReceiptOnDisk(directory, originalPath, originalAttachment, receipt);
  assert.equal(await store.verify({ partition: originalPartition, messageId, attachment: originalAttachment, receipt }), true);
  await assert.rejects(fs.lstat(store.pathFor(p, messageId, attachment.attachmentId)), { code: 'ENOENT' });
});

unix('partition path binds each complete identity field independently', async t => {
  const { store, partition: p, messageId } = await environment(t);
  const attachment = fixture(), path = store.pathFor(p, messageId, attachment.attachmentId);
  for (const field of ['centerOrigin', 'stableInstanceId', 'agentId', 'centerEpoch']) {
    const value = field === 'centerOrigin' ? 'https://other.test' : uuid();
    assert.notEqual(store.pathFor({ ...p, [field]: value }, messageId, attachment.attachmentId), path, field);
  }
});

unix('write-phase caller Buffer mutation never receives a durable receipt for wrong bytes', async t => {
  const env = await childEnvironment(t);
  const { result, phases } = await env.harness.run({ ...env.input, mode: 'mutate-buffer' });
  assert.equal(result.faultHits, 1, 'mutation must occur immediately before a real native write');
  assert.equal(phases.some(p => p.phase === 'before-native-write'), true);
  if (result.ok) {
    await assertReceiptOnDisk(env.directory, env.input.finalPath, env.input.attachment, result.receipt);
  } else {
    assert.equal(result.receipt, undefined);
    assert.equal(result.error.name, 'ImV2Error');
    assert.ok(['INVALID_ATTACHMENT', 'STORAGE_UNAVAILABLE'].includes(result.error.code));
  }
  await env.sentinelUnchanged();
});

for (const mode of ['write-enospc', 'temp-sync-fail']) {
  unix(`${mode}: native temporary-file failure cannot publish or alter preexisting bytes`, async t => {
    const env = await childEnvironment(t);
    // A separate, valid final file is also protected against accidental replacement.
    const otherAttachment = fixture(env.bytes);
    const otherPath = env.store.pathFor(env.input.partition, env.input.messageId, otherAttachment.attachmentId);
    await fs.writeFile(otherPath, env.bytes, { mode: 0o600 });
    const before = digest(await fs.readFile(otherPath));
    const { result } = await env.harness.run({ ...env.input, mode });
    assertStorageFailure(result);
    assert.equal(result.events.some(e => e.operation === 'link'), false);
    await assert.rejects(fs.lstat(env.input.finalPath), { code: 'ENOENT' });
    assert.equal(digest(await fs.readFile(otherPath)), before);
    await env.sentinelUnchanged();
  });
}

unix('existing exact final is reused without a temporary write or replacement', async t => {
  const env = await childEnvironment(t);
  await fs.writeFile(env.input.finalPath, env.bytes, { mode: 0o600 });
  const before = await fs.lstat(env.input.finalPath);
  const beforeHash = digest(await fs.readFile(env.input.finalPath));
  const { result } = await env.harness.run({ ...env.input, mode: 'write-enospc' });
  assertResynced(result);
  assert.equal(result.faultHits, 0, 'valid existing final must not need a temporary write');
  assert.equal(result.events.some(e => e.operation === 'link'), false);
  assert.equal(digest(await fs.readFile(env.input.finalPath)), beforeHash);
  const after = await fs.lstat(env.input.finalPath);
  assert.equal(after.ino, before.ino);
  assert.equal(after.dev, before.dev);
  await assertReceiptOnDisk(env.directory, env.input.finalPath, env.input.attachment, result.receipt);
  await env.sentinelUnchanged();
});

unix('actual process exit after hardlink leaves exact inode pair; fresh process reconciles and resyncs', async t => {
  const env = await childEnvironment(t);
  let tempPath;
  await env.harness.run({ ...env.input, mode: 'crash-after-link' }, { crash: true, onPhase: async phase => {
    tempPath = phase.tempPath;
    const [temp, final] = await Promise.all([fs.lstat(tempPath), fs.lstat(env.input.finalPath)]);
    assert.equal(temp.dev, final.dev); assert.equal(temp.ino, final.ino);
    assert.equal(final.nlink, 2);
    assert.equal(digest(await fs.readFile(tempPath)), env.input.attachment.sha256);
  } });
  assert.equal((await fs.lstat(tempPath)).nlink, 2, 'pair must still exist after confirmed exit');
  const { result } = await env.harness.run({ ...env.input, mode: 'observe' });
  assertResynced(result);
  assert.ok(result.events.some(e => e.operation === 'unlink' && e.path === tempPath));
  const unlinkIndex = result.events.findIndex(e => e.operation === 'unlink' && e.path === tempPath);
  assert.ok(result.events.some((e, i) => i > unlinkIndex && e.operation === 'sync' && e.kind === 'directory'));
  await assert.rejects(fs.lstat(tempPath), { code: 'ENOENT' });
  await assertReceiptOnDisk(env.directory, env.input.finalPath, env.input.attachment, result.receipt);
  await env.sentinelUnchanged();
});

unix('post-unlink directory fsync failure rejects; fresh save resyncs retained final before durable receipt', async t => {
  const env = await childEnvironment(t);
  const failed = await env.harness.run({ ...env.input, mode: 'post-unlink-dir-sync-fail' });
  assertStorageFailure(failed.result);
  assert.ok(failed.result.events.some(e => e.operation === 'unlink' && e.kind === 'temp'));
  assert.equal(digest(await fs.readFile(env.input.finalPath)), env.input.attachment.sha256);
  const { result } = await env.harness.run({ ...env.input, mode: 'observe' });
  assertResynced(result);
  await assertReceiptOnDisk(env.directory, env.input.finalPath, env.input.attachment, result.receipt);
  await env.sentinelUnchanged();
});

for (const mode of ['reuse-file-sync-fail', 'reuse-dir-sync-fail']) {
  unix(`${mode}: identical final reuse cannot report durability after native fsync failure`, async t => {
    const env = await childEnvironment(t);
    await fs.writeFile(env.input.finalPath, env.bytes, { mode: 0o600 });
    const before = digest(await fs.readFile(env.input.finalPath));
    const { result } = await env.harness.run({ ...env.input, mode });
    assertStorageFailure(result);
    assert.equal(digest(await fs.readFile(env.input.finalPath)), before);
    await env.sentinelUnchanged();
  });
}

unix('unrelated temp and ambiguous inode candidates survive refused reconciliation byte-for-byte', async t => {
  const env = await childEnvironment(t);
  const temp = `${env.input.finalPath}.${uuid()}.tmp`;
  const ambiguous = `${env.input.finalPath}.unowned`;
  const unrelated = `${env.input.finalPath}.${uuid()}.tmp`;
  await fs.writeFile(temp, env.bytes, { mode: 0o600 });
  await fs.link(temp, env.input.finalPath);
  await fs.link(temp, ambiguous);
  await fs.writeFile(unrelated, 'unrelated candidate bytes', { mode: 0o600 });
  const paths = [temp, env.input.finalPath, ambiguous, unrelated];
  const before = await Promise.all(paths.map(async path => ({ hash: digest(await fs.readFile(path)), stat: await fs.lstat(path) })));
  const { result } = await env.harness.run({ ...env.input, mode: 'observe' });
  assert.equal(result.ok, false);
  assert.equal(result.receipt, undefined);
  assert.equal(result.error.name, 'ImV2Error');
  for (const [index, path] of paths.entries()) {
    assert.equal(digest(await fs.readFile(path)), before[index].hash);
    const after = await fs.lstat(path);
    assert.equal(after.ino, before[index].stat.ino);
    assert.equal(after.nlink, before[index].stat.nlink);
  }
  await env.sentinelUnchanged();
});

unix('native opendir budget exhaustion refuses reconciliation and retains every preexisting file', async t => {
  const env = await childEnvironment(t);
  // Real entries, not a forged iterator. 10,001 entries is this regression's
  // explicit probe ceiling, not a claim about a frozen numeric API limit.
  const names = Array.from({ length: 10001 }, (_, i) => `preexisting-${String(i).padStart(5, '0')}`);
  for (let start = 0; start < names.length; start += 64) {
    await Promise.all(names.slice(start, start + 64).map(name => fs.writeFile(join(env.directory, name), name, { mode: 0o600 })));
  }
  const temp = `${env.input.finalPath}.${uuid()}.tmp`;
  await fs.writeFile(temp, env.bytes, { mode: 0o600 });
  await fs.link(temp, env.input.finalPath);
  const beforeNames = (await fs.readdir(env.directory)).sort();
  const { result } = await env.harness.run({ ...env.input, mode: 'observe' });
  assert.equal(result.ok, false, 'exhausted native scan must fail closed');
  assert.equal(result.receipt, undefined);
  assert.equal(result.error.name, 'ImV2Error');
  assert.ok(result.scanReads > 0 && result.scanReads <= 10002, `native scan must be bounded: ${result.scanReads}`);
  assert.deepEqual((await fs.readdir(env.directory)).sort(), beforeNames);
  for (let start = 0; start < names.length; start += 64) {
    await Promise.all(names.slice(start, start + 64).map(async name => {
      assert.equal(digest(await fs.readFile(join(env.directory, name))), digest(Buffer.from(name)), name);
    }));
  }
  assert.equal(digest(await fs.readFile(temp)), env.input.attachment.sha256);
  assert.equal(digest(await fs.readFile(env.input.finalPath)), env.input.attachment.sha256);
  assert.equal((await fs.lstat(temp)).nlink, 2);
  await env.sentinelUnchanged();
});

unix('a UUID-shaped unrelated temp cannot authorize deletion of an ambiguous final hardlink', async t => {
  const env = await childEnvironment(t);
  const ambiguous = `${env.input.finalPath}.not-an-owned-temp`;
  const unrelated = `${env.input.finalPath}.${uuid()}.tmp`;
  await fs.writeFile(ambiguous, env.bytes, { mode: 0o600 });
  await fs.link(ambiguous, env.input.finalPath);
  await fs.writeFile(unrelated, env.bytes, { mode: 0o600 });
  const files = [ambiguous, env.input.finalPath, unrelated];
  const before = await Promise.all(files.map(async path => ({
    hash: digest(await fs.readFile(path)), stat: await fs.lstat(path),
  })));
  assert.notEqual(before[0].stat.ino, before[2].stat.ino);
  const { result } = await env.harness.run({ ...env.input, mode: 'observe' });
  assert.equal(result.ok, false);
  assert.equal(result.receipt, undefined);
  assert.equal(result.error.name, 'ImV2Error');
  assert.ok(result.scanReads > 0, 'refusal must actually traverse the native directory');
  for (const [index, path] of files.entries()) {
    assert.equal(digest(await fs.readFile(path)), before[index].hash);
    const stat = await fs.lstat(path);
    assert.equal(stat.ino, before[index].stat.ino);
    assert.equal(stat.nlink, before[index].stat.nlink);
  }
  await env.sentinelUnchanged();
});

unix('same-inode extra-prefix UUID temp is refused intact; exact UUID temp still recovers', async t => {
  const env = await childEnvironment(t);
  const extraPrefix = `${env.input.finalPath}.not-module-owned.${uuid()}.tmp`;
  await fs.writeFile(extraPrefix, env.bytes, { mode: 0o600 });
  await fs.link(extraPrefix, env.input.finalPath);
  const paths = [extraPrefix, env.input.finalPath];
  const before = await Promise.all(paths.map(async path => ({
    hash: digest(await fs.readFile(path)), stat: await fs.lstat(path),
  })));
  assert.equal(before[0].stat.dev, before[1].stat.dev);
  assert.equal(before[0].stat.ino, before[1].stat.ino);
  assert.equal(before[0].stat.nlink, 2);
  const refused = await env.harness.run({ ...env.input, mode: 'observe' });
  assert.equal(refused.result.ok, false);
  assert.equal(refused.result.receipt, undefined);
  assert.equal(refused.result.error.name, 'ImV2Error');
  assert.equal(refused.result.error.code, 'INVALID_ATTACHMENT');
  assert.ok(refused.result.scanReads > 0, 'native directory scan must be exercised');
  assert.equal(refused.result.events.some(e => e.operation === 'unlink'), false);
  for (const [index, path] of paths.entries()) {
    assert.equal(digest(await fs.readFile(path)), before[index].hash);
    const stat = await fs.lstat(path);
    assert.equal(stat.dev, before[index].stat.dev);
    assert.equal(stat.ino, before[index].stat.ino);
    assert.equal(stat.nlink, 2);
  }
  await env.sentinelUnchanged();

  // A separate pair provides the positive control without renaming or deleting
  // the refused pair: only the exact module-owned suffix permits recovery.
  const attachment = fixture(env.bytes);
  const finalPath = env.store.pathFor(env.input.partition, env.input.messageId, attachment.attachmentId);
  const exactTemp = `${finalPath}.${uuid()}.tmp`;
  await fs.writeFile(exactTemp, env.bytes, { mode: 0o600 });
  await fs.link(exactTemp, finalPath);
  const recovered = await env.harness.run({ ...env.input, attachment, finalPath, mode: 'observe' });
  assertResynced(recovered.result);
  assert.ok(recovered.result.events.some(e => e.operation === 'unlink' && e.path === exactTemp));
  await assert.rejects(fs.lstat(exactTemp), { code: 'ENOENT' });
  await assertReceiptOnDisk(env.directory, finalPath, attachment, recovered.result.receipt);
  for (const [index, path] of paths.entries()) {
    assert.equal(digest(await fs.readFile(path)), before[index].hash);
    const stat = await fs.lstat(path);
    assert.equal(stat.ino, before[index].stat.ino);
    assert.equal(stat.nlink, 2);
  }
  await env.sentinelUnchanged();
});

test('native Windows cannot assert strict durable save/verify', async t => {
  if (process.platform !== 'win32') return t.skip('Windows-specific strict fail-closed test');
  const { directory, store, partition: p, messageId } = await environment(t);
  const a = fixture();
  await assert.rejects(store.save({ partition: p, messageId, attachment: a, download: async () => Buffer.from('attachment') }), error('STORAGE_UNAVAILABLE'));
  await assert.rejects(store.verify({ partition: p, messageId, attachment: a, receipt: {} }), error('STORAGE_UNAVAILABLE'));
  // Unknown options may be ignored or rejected, but may never enable strict
  // writes by pretending that this real Windows process runs on Linux.
  let spoofed;
  try { spoofed = createImV2AttachmentStore({ directory, durability: 'strict', platform: 'linux' }); }
  catch (e) { assert.equal(error('INVALID_ATTACHMENT')(e), true); return; }
  await assert.rejects(spoofed.save({ partition: p, messageId, attachment: a, download: async () => Buffer.from('attachment') }), error('STORAGE_UNAVAILABLE'));
  await assert.rejects(spoofed.verify({ partition: p, messageId, attachment: a, receipt: {} }), error('STORAGE_UNAVAILABLE'));
});

unix('strict save, identical reuse, restart verification and corruption/missing detection', async t => {
  const { directory, store, partition: p, messageId } = await environment(t);
  const bytes = Buffer.from('attachment'), a = fixture(bytes);
  const input = { partition: p, messageId, attachment: a };
  const receipt = await store.save({ ...input, download: async () => bytes });
  assert.deepEqual(receipt, { relativeName: basename(store.pathFor(p, messageId, a.attachmentId)), sha256: a.sha256, size: a.size, durability: 'durable' });
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(await createImV2AttachmentStore({ directory }).verify({ ...input, receipt }), true);
  let downloaded = false;
  assert.deepEqual(await store.save({ ...input, download: async () => { downloaded = true; return bytes; } }), receipt);
  assert.equal(downloaded, false);
  await assert.rejects(store.verify({ ...input, receipt: { ...receipt, relativeName: '../escape' } }), error('INVALID_ATTACHMENT'));
  await assert.rejects(store.verify({ ...input, receipt: { ...receipt, other: 1 } }), error('INVALID_ATTACHMENT'));
  const path = store.pathFor(p, messageId, a.attachmentId);
  await fs.writeFile(path, 'ATTACHMENT');
  const corruptHash = digest(await fs.readFile(path));
  await assert.rejects(store.verify({ ...input, receipt }), error('INVALID_ATTACHMENT'));
  await assert.rejects(store.save({ ...input, download: async () => bytes }), error('INVALID_ATTACHMENT'));
  assert.equal(digest(await fs.readFile(path)), corruptHash);
  await fs.unlink(path);
  await assert.rejects(store.verify({ ...input, receipt }), error('STORAGE_UNAVAILABLE'));
});

unix('exact 10MiB accepted; oversize, wrong hash and invalid metadata never publish', async t => {
  const { store, partition: p, messageId } = await environment(t);
  const bytes = Buffer.alloc(10485760, 42), a = fixture(bytes);
  const input = { partition: p, messageId, attachment: a };
  const receipt = await store.save({ ...input, download: async () => bytes });
  assert.equal(await store.verify({ ...input, receipt }), true);
  const b = fixture(Buffer.from('small'));
  await assert.rejects(store.save({ partition: p, messageId, attachment: b, download: async () => new Uint8Array(Buffer.from('small')) }), error('INVALID_ATTACHMENT'));
  const wrong = Buffer.alloc(10485761);
  await assert.rejects(store.save({ partition: p, messageId, attachment: b, download: async () => wrong }), error('INVALID_ATTACHMENT'));
  await assert.rejects(store.save({ partition: p, messageId, attachment: { ...b, sha256: '0'.repeat(64) }, download: async () => Buffer.from('small') }), error('INVALID_ATTACHMENT'));
  await assert.rejects(store.save({ partition: p, messageId, attachment: { ...b, size: 10485761 }, download: async () => Buffer.from('small') }), error('INVALID_ATTACHMENT'));
  await assert.rejects(fs.lstat(store.pathFor(p, messageId, b.attachmentId)), { code: 'ENOENT' });
});

unix('symlink, hardlink, mode and incompatible existing bytes are rejected', async t => {
  const { directory, store, partition: p, messageId } = await environment(t);
  const bytes = Buffer.from('attachment'), a = fixture(bytes);
  const input = { partition: p, messageId, attachment: a };
  const path = store.pathFor(p, messageId, a.attachmentId);
  const other = join(directory, 'other');
  await fs.writeFile(other, bytes, { mode: 0o600 });
  await fs.symlink(other, path);
  await assert.rejects(store.save({ ...input, download: async () => bytes }), error('INVALID_ATTACHMENT'));
  await fs.unlink(path);
  await fs.link(other, path);
  await assert.rejects(store.save({ ...input, download: async () => bytes }), error('INVALID_ATTACHMENT'));
  await fs.unlink(path);
  await fs.writeFile(path, bytes, { mode: 0o640 });
  await fs.chmod(path, 0o640);
  const forbiddenMode = (await fs.lstat(path)).mode & 0o777;
  assert.equal(forbiddenMode, 0o640, 'existing file must actually have forbidden mode');
  t.diagnostic(`existing file forbidden mode: ${forbiddenMode.toString(8)}`);
  await assert.rejects(store.save({ ...input, download: async () => bytes }), error('INVALID_ATTACHMENT'));
  await fs.chmod(path, 0o600);
  assert.equal((await fs.lstat(path)).mode & 0o777, 0o600, 'valid existing file mode control');
  await fs.writeFile(path, 'wrongbytes');
  await assert.rejects(store.save({ ...input, download: async () => bytes }), error('INVALID_ATTACHMENT'));
});

unix('exact owned crash hardlink is reconciled, ambiguity retains both links', async t => {
  const { directory, store, partition: p, messageId } = await environment(t);
  const bytes = Buffer.from('attachment'), a = fixture(bytes), input = { partition: p, messageId, attachment: a };
  const path = store.pathFor(p, messageId, a.attachmentId), temp = `${path}.${uuid()}.tmp`;
  await fs.writeFile(temp, bytes, { mode: 0o600 });
  await fs.link(temp, path);
  const receipt = await store.save({ ...input, download: async () => { throw Error('unexpected download'); } });
  assert.equal(receipt.durability, 'durable');
  await assert.rejects(fs.lstat(temp), { code: 'ENOENT' });
  await fs.unlink(path);
  await fs.link(await (async () => { await fs.writeFile(temp, bytes, { mode: 0o600 }); return temp; })(), path);
  await fs.rename(temp, `${path}.ambiguous`);
  await assert.rejects(store.save({ ...input, download: async () => bytes }), error('INVALID_ATTACHMENT'));
  assert.equal((await fs.lstat(path)).nlink, 2);
});

unix('unprotected ancestor and symlink directory reject strict storage', async t => {
  const { directory, partition: p, messageId } = await environment(t);
  const a = fixture(), bytes = Buffer.from('attachment');
  const alias = `${directory}-alias`;
  await fs.symlink(directory, alias);
  t.after(async () => { await fs.unlink(alias); });
  const aliasStore = createImV2AttachmentStore({ directory: alias });
  await assert.rejects(aliasStore.save({ partition: p, messageId, attachment: a, download: async () => bytes }), error('STORAGE_UNAVAILABLE'));
  const writable = join(directory, 'writable');
  await fs.mkdir(writable, { mode: 0o777 });
  await fs.chmod(writable, 0o777);
  assert.equal((await fs.lstat(writable)).mode & 0o777, 0o777, 'directory must actually be writable by others');
  await assert.rejects(createImV2AttachmentStore({ directory: writable }).save({ partition: p, messageId, attachment: a, download: async () => bytes }), error('STORAGE_UNAVAILABLE'));
});
