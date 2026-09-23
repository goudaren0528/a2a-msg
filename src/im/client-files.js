import { createHash, randomUUID } from 'node:crypto';
import { promises as fs, constants } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { ImError, MAX_ATTACHMENT_BYTES } from './contracts.js';

const fail = code => { throw new ImError(code); };
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const HEX = /^[0-9a-f]{64}$/;
const FLAGS = constants.O_NOFOLLOW | constants.O_RDONLY;
const TEMP_SUFFIX = /^\.([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\.tmp$/;

export function attachmentPath(directory, center, agent, messageId, attachmentId) {
  if (!isAbsolute(directory) || !UUID.test(agent) || !UUID.test(messageId) || !UUID.test(attachmentId)) fail('INVALID_REQUEST');
  const scope = createHash('sha256').update(JSON.stringify([center, agent])).digest('hex');
  return join(resolve(directory), `${scope}-${messageId}-${attachmentId}.bin`);
}

async function directoryCheck(directory) {
  if (!isAbsolute(directory)) fail('INVALID_REQUEST');
  if (await fs.realpath(directory) !== resolve(directory)) fail('INVALID_ATTACHMENT');
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('INVALID_ATTACHMENT');
}

async function recoverPublished(path, attachment, directory) {
  const stat = await fs.lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink === 1) return;
  if (stat.nlink !== 2) fail('INVALID_ATTACHMENT');
  const names = await fs.readdir(directory);
  const matches = names.filter(name => name.startsWith(`${path.split(/[\\/]/).at(-1)}.`) &&
    TEMP_SUFFIX.test(name.slice(path.split(/[\\/]/).at(-1).length)));
  if (matches.length !== 1) fail('INVALID_ATTACHMENT');
  const temp = join(directory, matches[0]);
  const t = await fs.lstat(temp);
  if (!t.isFile() || t.isSymbolicLink() || t.dev !== stat.dev || t.ino !== stat.ino ||
      t.nlink !== 2 || t.size !== attachment.size) fail('INVALID_ATTACHMENT');
  // Verify bytes before touching either link; the temporary link is owned by this exact scope.
  await verifyAttachment(path, attachment, directory, true);
  const current = await fs.lstat(path), currentTemp = await fs.lstat(temp);
  if (current.dev !== stat.dev || current.ino !== stat.ino || currentTemp.dev !== stat.dev || currentTemp.ino !== stat.ino) fail('INVALID_ATTACHMENT');
  await fs.unlink(temp);
}

export async function verifyAttachment(path, attachment, directory, recovering = false) {
  try {
    await directoryCheck(directory);
    if (resolve(path) !== join(resolve(directory), path.split(/[\\/]/).at(-1)) ||
        !HEX.test(attachment.sha256) || !Number.isSafeInteger(attachment.size) ||
        attachment.size < 1 || attachment.size > MAX_ATTACHMENT_BYTES) fail('INVALID_ATTACHMENT');
    const before = await fs.lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || await fs.realpath(path) !== resolve(path)) fail('INVALID_ATTACHMENT');
    const file = await fs.open(path, FLAGS);
    try {
      const st = await file.stat();
      if (!st.isFile() || st.dev !== before.dev || st.ino !== before.ino ||
          st.nlink !== (recovering ? 2 : 1) || st.size !== attachment.size ||
          (await fs.lstat(path)).ino !== st.ino || await fs.realpath(path) !== resolve(path)) fail('INVALID_ATTACHMENT');
      const hash = createHash('sha256');
      const chunk = Buffer.allocUnsafe(65536);
      let total = 0, size;
      while ((size = (await file.read(chunk, 0, chunk.length, null)).bytesRead)) {
        total += size;
        if (total > MAX_ATTACHMENT_BYTES) fail('INVALID_ATTACHMENT');
        hash.update(chunk.subarray(0, size));
      }
      const after = await fs.lstat(path);
      if (total !== attachment.size || hash.digest('hex') !== attachment.sha256 ||
          after.dev !== st.dev || after.ino !== st.ino || after.isSymbolicLink() ||
          await fs.realpath(path) !== resolve(path)) fail('INVALID_ATTACHMENT');
    } finally { await file.close(); }
  } catch (e) { if (e instanceof ImError) throw e; fail('INVALID_ATTACHMENT'); }
}

export async function saveAttachment({ directory, center, agent, messageId, attachment, download }) {
  const path = attachmentPath(directory, center, agent, messageId, attachment.attachmentId);
  try {
    await directoryCheck(directory);
    try { await fs.lstat(path); await recoverPublished(path, attachment, directory); await verifyAttachment(path, attachment, directory); return { path, sha256: attachment.sha256, size: attachment.size }; }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    const bytes = await download();
    if (!Buffer.isBuffer(bytes) || bytes.length !== attachment.size || bytes.length > MAX_ATTACHMENT_BYTES ||
        createHash('sha256').update(bytes).digest('hex') !== attachment.sha256) fail('INVALID_ATTACHMENT');
    const temp = `${path}.${randomUUID()}.tmp`;
    let created = false;
    try {
      const f = await fs.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      created = true;
      try { await f.writeFile(bytes); await f.sync(); } finally { await f.close(); }
      // Exclusive hard-link publication prevents overwriting another process's file.
      try { await fs.link(temp, path); }
      catch (e) { if (e.code !== 'EEXIST') throw e; }
      // Directory fsync is unavailable on some platforms (notably Windows).
      try {
        const dir = await fs.open(directory, constants.O_RDONLY);
        try { await dir.sync(); } finally { await dir.close(); }
      } catch (e) { if (!['EINVAL','EISDIR','EPERM','EACCES'].includes(e.code)) throw e; }
      await fs.unlink(temp);
      created = false;
      await verifyAttachment(path, attachment, directory);
      return { path, sha256: attachment.sha256, size: attachment.size };
    } finally { if (created) await fs.unlink(temp).catch(() => {}); }
  } catch (e) { if (e instanceof ImError) throw e; fail('INVALID_ATTACHMENT'); }
}
