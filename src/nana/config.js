import { isAbsolute } from 'node:path';
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
  attachmentDirectory: absolutePath,
  statePath: absolutePath,
  evidencePath: absolutePath.optional(),
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

export function parseNanaConfig(input) {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ImError('INVALID_REQUEST');
  const config = parsed.data;
  normalizeOrigin(config.serverUrl);
  return Object.freeze(config);
}
