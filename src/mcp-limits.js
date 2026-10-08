import fs from 'node:fs/promises';

export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const ERROR_CHARS = 2048;

export function briefError(value) {
  return String(value).slice(0, ERROR_CHARS);
}

export async function readBoundedResponse(res, limit = MAX_RESPONSE_BYTES) {
  const declared = res.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > limit) {
    await res.body?.cancel();
    throw new Error(`Response exceeds ${limit} byte limit`);
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error(`Response exceeds ${limit} byte limit`);
      chunks.push(value);
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

export async function readUploadFile(filePath, limit) {
  let handle;
  try {
    handle = await fs.open(filePath, 'r');
  } catch {
    throw new Error(`File not found: ${filePath}`);
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`Not a regular file: ${filePath}`);
    if (stat.size === 0) throw new Error(`File is empty (0 bytes): ${filePath}`);
    if (stat.size > limit) throw new Error(`File is ${stat.size} bytes, exceeding the ${limit} byte limit`);
    const chunks = [];
    let size = 0;
    // Read one byte beyond the budget to detect growth after stat without ever
    // accumulating more than the allowed upload bytes.
    for (;;) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, limit - size + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > limit) throw new Error(`File exceeds the ${limit} byte limit`);
      chunks.push(buffer.subarray(0, bytesRead));
    }
    if (!size) throw new Error(`File is empty (0 bytes): ${filePath}`);
    return Buffer.concat(chunks, size);
  } finally {
    await handle.close();
  }
}

export function createTransferGate(activeLimit = 2, waitingLimit = 16) {
  let active = 0;
  const waiting = [];
  return async function gated(fn) {
    if (active >= activeLimit) {
      if (waiting.length >= waitingLimit) throw new Error('Transfer busy: queue is full');
      await new Promise(resolve => waiting.push(resolve));
    } else {
      active++;
    }
    try {
      return await fn();
    } finally {
      if (waiting.length) waiting.shift()();
      else active--;
    }
  };
}
