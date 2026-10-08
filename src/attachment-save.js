import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Resolve the installed bridge's package, never the caller's working directory.
export const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));

export async function defaultDownloadDirectory(packageRoot = PACKAGE_ROOT) {
  const root = await fs.realpath(packageRoot);
  const directory = path.join(root, 'downloads');
  const check = async () => {
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Default downloads must be a real directory, not a file or symlink/junction');
    if (await fs.realpath(directory) !== directory) throw new Error('Default downloads resolves outside its package directory');
  };
  try { await check(); } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    try { await fs.mkdir(directory); } catch (createErr) { if (createErr.code !== 'EEXIST') throw createErr; }
    await check();
  }
  return directory;
}

export const MAX_NAME_ATTEMPTS = 100;
export const MAX_RECEIVED_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_BASE64_LENGTH = 4 * Math.ceil(MAX_RECEIVED_ATTACHMENT_BYTES / 3);
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const unsafe = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;

function segment(value, fallback) {
  const clean = String(value ?? '').toWellFormed().replace(unsafe, '_').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  return clean || fallback;
}

function truncateBytes(value, budget) {
  let result = '';
  for (const char of value) {
    if (Buffer.byteLength(result + char) > budget) break;
    result += char;
  }
  return result;
}

export function buildTraceableName(meta, now = new Date(), attempt = 0) {
  const original = segment(meta.name, 'attachment');
  const rawExt = path.extname(original);
  let stem = segment(rawExt ? original.slice(0, -rawExt.length) : original, 'attachment');
  // A dotted stem such as CON.backup must not become a Windows device path.
  if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(stem)) stem = `_${stem}`;
  // Valid member names are at most 32 UTF-16 units (96 UTF-8 bytes).
  const from = truncateBytes(segment(meta.from, 'unknown'), 96);
  const to = truncateBytes(segment(meta.to, 'unknown'), 96);
  const pad = n => String(n).padStart(2, '0');
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const trace = `__${from}-to-${to}__${timestamp}${attempt ? `-${attempt}` : ''}`;
  const ext = truncateBytes(rawExt, Math.min(40, 255 - Buffer.byteLength(trace) - 10)).replace(/[. ]+$/, '');
  const suffix = trace + ext;
  return truncateBytes(stem, 255 - Buffer.byteLength(suffix)) + suffix;
}

/** Stages verified bytes locally, then publishes atomically. Never unlinks a destination. */
export async function saveAttachment(params, download, downloadDir, packageRoot = PACKAGE_ROOT) {
  const useDefault = params.path === undefined;
  const filePath = useDefault ? (downloadDir || await defaultDownloadDirectory(packageRoot)) : params.path;
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('Path must be absolute');
  const autoName = useDefault || params.auto_name === true;
  const overwrite = !useDefault && params.overwrite === true;
  const target = path.resolve(filePath);
  const directory = autoName ? target : path.dirname(target);
  let stat;
  try { stat = await fs.stat(directory); } catch { throw new Error(`Parent directory does not exist: ${directory}`); }
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${directory}`);
  await fs.access(directory, constants.W_OK | constants.X_OK);
  if (!autoName && !overwrite) {
    try { await fs.lstat(target); throw new Error(`Destination already exists: ${target}`); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
  }

  // Exclusive local staging also checks effective create permission before downloading.
  const staging = await fs.mkdtemp(path.join(directory, '.team-mailbox-'));
  const temporary = path.join(staging, 'payload');
  let saved;
  try {
    const meta = await download();
    if (!meta || typeof meta !== 'object' || Array.isArray(meta) ||
        typeof meta.data_base64 !== 'string' || meta.data_base64.length > MAX_BASE64_LENGTH)
      throw new Error('Invalid downloaded attachment metadata or encoding');
    if (meta.size !== undefined && (!Number.isSafeInteger(meta.size) || meta.size < 0))
      throw new Error('Invalid downloaded attachment size');
    const data = Buffer.from(meta.data_base64, 'base64');
    if (data.length > MAX_RECEIVED_ATTACHMENT_BYTES || data.toString('base64') !== meta.data_base64)
      throw new Error('Invalid downloaded attachment encoding or size');
    if (meta.size !== undefined && meta.size !== data.length)
      throw new Error('Downloaded attachment size mismatch');
    const sha256 = hash(data);
    if (sha256 !== meta.sha256) throw new Error('Downloaded attachment failed SHA-256 verification; not written');
    const fd = await fs.open(temporary, 'wx', 0o600);
    let writeError;
    try {
      await fd.writeFile(data);
      await fd.sync();
    } catch (err) { writeError = err; }
    try { await fd.close(); } catch (err) { if (!writeError) writeError = err; }
    if (writeError) throw writeError;
    if (hash(await fs.readFile(temporary)) !== meta.sha256) throw new Error('Written file failed SHA-256 verification');

    const now = new Date();
    for (let attempt = 0; attempt < (autoName && !overwrite ? MAX_NAME_ATTEMPTS : 1); attempt++) {
      const resolved = autoName ? path.join(directory, buildTraceableName(meta, now, attempt)) : target;
      try {
        if (overwrite) await fs.rename(temporary, resolved);
        else await fs.link(temporary, resolved); // Atomic exclusive publication; EEXIST cannot overwrite.
      } catch (err) {
        if (err.code === 'EEXIST' && autoName && !overwrite) continue;
        if (err.code === 'EEXIST') throw new Error(`Destination already exists: ${resolved}`);
        throw err; // No unsafe copy/unlink fallback on filesystems without hard links.
      }
      saved = { path: resolved, name: path.basename(resolved), originalName: meta.name,
        size: data.length, sha256, overwritten: overwrite, autoNamed: autoName };
      return saved;
    }
    throw new Error(`Unable to allocate a unique filename after ${MAX_NAME_ATTEMPTS} attempts`);
  } finally {
    // Only this operation's exclusive staging directory is removed, never a final/user file.
    try {
      await fs.rm(staging, { recursive: true, force: true });
    } catch {
      // Cleanup must neither undo published success nor mask the original failure.
      // Do not expose the cleanup exception (it may contain temporary paths).
      if (saved) saved.cleanupWarning = 'Attachment saved and verified successfully; temporary cleanup failed. Do not download again. Temporary artifacts may remain.';
    }
  }
}
