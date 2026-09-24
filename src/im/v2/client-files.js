import { createHash, randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { attachmentSchema, ImV2Error, MAX_ATTACHMENT_BYTES } from './contracts.js';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const OWN_TEMP = /^\.([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.tmp$/;
const MAX_RECOVERY_SCAN_ENTRIES = 10000;
const invalid = () => { throw new ImV2Error('INVALID_ATTACHMENT'); };
const unavailable = () => { throw new ImV2Error('STORAGE_UNAVAILABLE'); };

// All four identity components are mandatory. An optional supplied partitionId is
// an assertion, never an alternative authority for the file's scope.
function scope(partition) {
  if (!partition || typeof partition !== 'object') invalid();
  const { centerOrigin, stableInstanceId, agentId, centerEpoch, partitionId: suppliedId } = partition;
  if (typeof stableInstanceId !== 'string' || !UUID.test(stableInstanceId) ||
      typeof agentId !== 'string' || !UUID.test(agentId) ||
      typeof centerEpoch !== 'string' || !UUID.test(centerEpoch)) invalid();
  let url;
  try { url = new URL(centerOrigin); } catch { invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' ||
      url.search || url.hash || url.origin !== centerOrigin) invalid();
  const partitionId = createHash('sha256').update(JSON.stringify([
    url.origin, stableInstanceId, agentId, centerEpoch,
  ])).digest('hex');
  if (suppliedId !== undefined && suppliedId !== partitionId) invalid();
  return partitionId;
}

function target(directory, partition, messageId, attachmentId) {
  if (!UUID.test(messageId) || !UUID.test(attachmentId)) invalid();
  const relativeName = `${scope(partition)}-${messageId}-${attachmentId}.bin`;
  return { relativeName, path: join(directory, relativeName) };
}

function identity(a, b) { return a.dev === b.dev && a.ino === b.ino; }
function safeFile(st, links = 1) {
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== links || st.size < 0 ||
      st.size > MAX_ATTACHMENT_BYTES || st.uid !== process.geteuid() || (st.mode & 0o777) !== 0o600) invalid();
}

async function directoryCheck(directory) {
  // The supplied final directory must itself be private and owned by this
  // effective identity; ancestors may be root-owned but not untrusted-writable.
  let current = directory;
  let final = true;
  while (true) {
    const st = await fs.lstat(current);
    if (!st.isDirectory() || st.isSymbolicLink()) unavailable();
    if (final ? (st.uid !== process.geteuid() || (st.mode & 0o077) !== 0) :
      ((st.uid !== process.geteuid() && st.uid !== 0) || (st.mode & 0o022) !== 0)) unavailable();
    final = false;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (await fs.realpath(directory) !== directory) unavailable();
  return fs.lstat(directory);
}

async function sameDirectory(directory, before) {
  const after = await directoryCheck(directory);
  if (!identity(before, after)) unavailable();
}

async function inspect(path, attachment, directory, root, links = 1, flush = false) {
  const before = await fs.lstat(path);
  safeFile(before, links);
  const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await file.stat();
    safeFile(st, links);
    if (!identity(before, st) || st.size !== attachment.size) invalid();
    const hash = createHash('sha256');
    const block = Buffer.allocUnsafe(65536);
    let count = 0;
    while (true) {
      const { bytesRead } = await file.read(block, 0, block.length, null);
      if (!bytesRead) break;
      count += bytesRead;
      if (count > MAX_ATTACHMENT_BYTES) invalid();
      hash.update(block.subarray(0, bytesRead));
    }
    if (count !== attachment.size || hash.digest('hex') !== attachment.sha256) invalid();
    if (flush) await file.sync();
    const finalStat = await file.stat();
    if (!identity(st, finalStat) || finalStat.size !== st.size ||
        finalStat.mtimeMs !== st.mtimeMs || finalStat.ctimeMs !== st.ctimeMs) invalid();
    const after = await fs.lstat(path);
    safeFile(after, links);
    if (!identity(st, after) || after.size !== st.size) invalid();
    await sameDirectory(directory, root);
    return st;
  } finally { await file.close(); }
}

async function syncDirectory(directory, root) {
  await sameDirectory(directory, root);
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    if (!identity(await handle.stat(), root)) unavailable();
    await handle.sync();
  } finally { await handle.close(); }
  await sameDirectory(directory, root);
}

function metadata(messageId, attachment) {
  if (typeof messageId !== 'string' || !UUID.test(messageId)) invalid();
  const parsed = attachmentSchema.safeParse(attachment);
  if (!parsed.success) invalid();
  return Object.freeze(parsed.data);
}

function receiptFor(relativeName, attachment) {
  return Object.freeze({ relativeName, sha256: attachment.sha256, size: attachment.size, durability: 'durable' });
}

function asError(error) {
  if (error instanceof ImV2Error) return error;
  return new ImV2Error('STORAGE_UNAVAILABLE');
}

export function createImV2AttachmentStore({ directory, durability = 'strict' } = {}) {
  if (typeof directory !== 'string' || !isAbsolute(directory) || resolve(directory) !== directory ||
      basename(directory) === '.' || directory === parse(directory).root || durability !== 'strict') invalid();
  // No Windows directory fsync proof or trustworthy POSIX owner/mode/no-follow.
  // pathFor remains pure, but no save or verify may claim durability here.
  const supported = process.platform !== 'win32' && typeof process.getuid === 'function' &&
    Number.isInteger(constants.O_NOFOLLOW) && Number.isInteger(constants.O_DIRECTORY);
  const capable = () => { if (!supported) unavailable(); };

  async function reconcile(path, attachment, directory, root) {
    const st = await fs.lstat(path);
    if (st.nlink === 1) return inspect(path, attachment, directory, root, 1, true);
    safeFile(st, 2);
    // A two-link final is only recoverable when exactly one matching, module-
    // owned temporary name points to the same inode. Do not sweep other files.
    const prefix = `${basename(path)}.`;
    let candidate, scanned = 0;
    const handle = await fs.opendir(directory);
    try {
      let entry;
      while ((entry = await handle.read()) !== null) {
        if (++scanned > MAX_RECOVERY_SCAN_ENTRIES) unavailable();
        if (entry.name.startsWith(prefix) && OWN_TEMP.test(entry.name.slice(basename(path).length))) {
          if (candidate !== undefined) invalid();
          candidate = entry.name;
        }
      }
    } finally { await handle.close(); }
    if (candidate === undefined) invalid();
    const temp = join(directory, candidate);
    const tempSt = await fs.lstat(temp);
    safeFile(tempSt, 2);
    if (!identity(st, tempSt)) invalid();
    await inspect(path, attachment, directory, root, 2);
    const now = await fs.lstat(temp);
    const finalNow = await fs.lstat(path);
    if (!identity(st, now) || !identity(st, finalNow) || now.nlink !== 2 || finalNow.nlink !== 2) invalid();
    await sameDirectory(directory, root);
    await fs.unlink(temp);
    await syncDirectory(directory, root);
    return inspect(path, attachment, directory, root, 1, true);
  }

  async function verified(path, attachment, root) {
    try { return await reconcile(path, attachment, directory, root); }
    catch (error) { if (error.code === 'ENOENT') throw error; throw asError(error); }
  }

  async function verify({ partition, messageId, attachment, receipt }) {
    capable();
    const expected = metadata(messageId, attachment);
    const { path, relativeName } = target(directory, partition, messageId, expected.attachmentId);
    if (!receipt || typeof receipt !== 'object') invalid();
    const received = { ...receipt };
    if (Object.keys(received).length !== 4 || received.relativeName !== relativeName ||
        received.sha256 !== expected.sha256 || received.size !== expected.size || received.durability !== 'durable') invalid();
    try {
      const root = await directoryCheck(directory);
      // Verify never mutates the directory: unfinished hardlinks require save
      // reconciliation, not a receipt assertion.
      await inspect(path, expected, directory, root);
      return true;
    } catch (error) { throw asError(error); }
  }

  async function save({ partition, messageId, attachment, download }) {
    capable();
    const expected = metadata(messageId, attachment);
    if (typeof download !== 'function') invalid();
    const { path, relativeName } = target(directory, partition, messageId, expected.attachmentId);
    const receipt = receiptFor(relativeName, expected);
    let temp, tempStat, published = false;
    let root;
    try {
      root = await directoryCheck(directory);
      try { await verified(path, expected, root); await syncDirectory(directory, root); return receipt; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      // The callback returns a Buffer; its allocation before return is the
      // callback's responsibility. Only its bounded result is copied here.
      const supplied = await download();
      if (!Buffer.isBuffer(supplied) || supplied.length !== expected.size || supplied.length > MAX_ATTACHMENT_BYTES) invalid();
      const bytes = Buffer.from(supplied);
      if (createHash('sha256').update(bytes).digest('hex') !== expected.sha256) invalid();
      await sameDirectory(directory, root);
      temp = `${path}.${randomUUID()}.tmp`;
      const file = await fs.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        tempStat = await file.stat();
        safeFile(tempStat);
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesWritten } = await file.write(bytes, offset, Math.min(65536, bytes.length - offset), offset);
          if (!bytesWritten) unavailable();
          offset += bytesWritten;
        }
        await file.sync();
      } finally { await file.close(); }
      await sameDirectory(directory, root);
      if (!identity(await fs.lstat(temp), tempStat)) invalid();
      await inspect(temp, expected, directory, root);
      try { await fs.link(temp, path); published = true; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        await verified(path, expected, root);
        await sameDirectory(directory, root);
        if (!identity(await fs.lstat(temp), tempStat)) invalid();
        await fs.unlink(temp);
        temp = undefined;
        await syncDirectory(directory, root);
        return receipt;
      }
      if (!identity(await fs.lstat(path), tempStat)) invalid();
      await sameDirectory(directory, root);
      await fs.unlink(temp);
      temp = undefined;
      await syncDirectory(directory, root);
      await inspect(path, expected, directory, root);
      return receipt;
    } catch (error) { throw asError(error); }
    finally {
      if (temp && tempStat) {
        // Only unlink our private, still-identical inode. After publication,
        // preserve ambiguous links for a later exact-name reconciliation.
        try {
          const current = await fs.lstat(temp);
          if (!published && root && identity(current, tempStat)) {
            await sameDirectory(directory, root);
            await fs.unlink(temp);
          }
        } catch { /* failure remains non-durable; preserve evidence */ }
      }
    }
  }

  return Object.freeze({ pathFor(partition, messageId, attachmentId) {
    return target(directory, partition, messageId, attachmentId).path;
  }, save, verify });
}
