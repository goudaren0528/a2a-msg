import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { ImError } from '../im/contracts.js';

const uuid = z.string().regex(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
const absolutePath = z.string().min(1).max(4096)
  .refine(value => isAbsolute(value) && !value.includes('\0'), 'expected an absolute path');

const schema = z.object({
  serverUrl: z.string().min(1).max(2048),
  agentId: uuid,
  credentialFile: absolutePath,
  journalPath: absolutePath,
  attachmentDirectory: absolutePath.optional(),
  statePath: absolutePath,
  evidencePath: absolutePath.optional(),
  caFile: absolutePath.optional(),
}).strict();

// Same origin rule as the IM client/journal: https, bare origin, no userinfo/query/fragment.
export function normalizeOrigin(serverUrl) {
  let url;
  try { url = new URL(serverUrl); } catch { throw new ImError('INVALID_REQUEST'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password ||
      url.search || url.hash || url.pathname !== '/' ||
      serverUrl !== url.origin && serverUrl !== `${url.origin}/`) throw new ImError('INVALID_REQUEST');
  return url.origin;
}

/**
 * Predictable per-center download directory for configs that omit
 * `attachmentDirectory` (the npx entry must never download into its cache).
 * The center host is reduced to a filesystem-safe label; an explicit port is
 * appended so two local centers do not share a directory.
 */
export function defaultAttachmentDirectory(serverUrl) {
  const origin = normalizeOrigin(serverUrl);
  const url = new URL(origin);
  const host = url.hostname.replace(/[^A-Za-z0-9.-]/g, '_') || '_';
  const port = url.port ? `_${url.port}` : '';
  return join(homedir(), 'Downloads', 'a2a-msg', `${host}${port}`);
}

// Read one owner-controlled PEM bundle used as the private CA for this center.
// Same rules as the center's publishable bundle: a regular, non-symlinked file
// of at most 1 MiB containing at least one certificate block and no private key.
// The bytes are passed to `https.request({ca})`, so chain and hostname
// verification stay enabled; this only replaces NODE_EXTRA_CA_CERTS.
export function readNanaCaFile(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw new ImError('INVALID_REQUEST');
  let info;
  try { info = lstatSync(path); } catch { throw new ImError('INVALID_REQUEST'); }
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 1024 * 1024) {
    throw new ImError('INVALID_REQUEST');
  }
  if (process.platform !== 'win32' && (info.mode & 0o077)) throw new ImError('INVALID_REQUEST');
  let pem;
  try { pem = readFileSync(path); } catch { throw new ImError('INVALID_REQUEST'); }
  const text = pem.toString('latin1');
  if (!/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/.test(text) ||
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) throw new ImError('INVALID_REQUEST');
  return pem;
}

export function parseNanaConfig(input) {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ImError('INVALID_REQUEST');
  const config = parsed.data;
  normalizeOrigin(config.serverUrl);
  // Always expose a concrete directory so every consumer (session CLI, MCP entry,
  // client) keeps the same shape; the MCP entry creates this default on demand.
  return Object.freeze({ ...config,
    attachmentDirectory: config.attachmentDirectory ?? defaultAttachmentDirectory(config.serverUrl) });
}
