import { lstatSync, readFileSync } from 'node:fs';
import https from 'node:https';
import { dirname, isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ImError, MAX_ATTACHMENT_BYTES } from './contracts.js';
import { createImJournal } from './journal.js';
import { createImMcpAdapter, imMcpToolSchemas } from './mcp-adapter.js';
import { normalizeOrigin, parseNanaConfig } from '../nana/config.js';

const MAX_JSON = 16 * 1024 * 1024;
const REQUEST_DEADLINE_MS = 30000;
const CREDENTIAL = /^[A-Za-z0-9._-]{1,128}$/;
const fail = code => { throw new ImError(code); };

function requireDirectory(path) {
  let info;
  try { info = lstatSync(path); } catch { fail('INVALID_REQUEST'); }
  if (!info.isDirectory() || info.isSymbolicLink()) fail('INVALID_REQUEST');
  return path;
}

function requireRegularFile(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) fail('INVALID_REQUEST');
  let info;
  try { info = lstatSync(path); } catch { fail('INVALID_REQUEST'); }
  if (!info.isFile() || info.isSymbolicLink()) fail('INVALID_REQUEST');
  return path;
}

/**
 * Read the installer-provided `nana.json`. Same strict schema as the session adapter
 * (`src/nana/config.js`): unknown fields, relative paths and non-https origins are
 * rejected, so one host config file can serve both entries.
 */
export function readNanaConfigFile(filePath) {
  const path = requireRegularFile(filePath);
  let value;
  try { value = JSON.parse(readFileSync(path, 'utf8')); } catch { fail('INVALID_REQUEST'); }
  return parseNanaConfig(value);
}

// Re-read the session-bound credential on every request so rotations and revocations
// take effect without restarting the host. Missing, unreadable or group/world-visible
// credential files fail closed with a fixed code and never echo file contents.
function readCredential(config) {
  let info;
  try { info = lstatSync(config.credentialFile); } catch { fail('AUTH_REQUIRED'); }
  if (!info.isFile() || info.isSymbolicLink()) fail('AUTH_REQUIRED');
  // POSIX owner-only (0600 or stricter). Windows has no POSIX mode bits; the installer
  // must protect the file with NTFS ACLs instead.
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) fail('AUTH_REQUIRED');
  let value;
  try { value = readFileSync(config.credentialFile, 'utf8').trim(); } catch { fail('AUTH_REQUIRED'); }
  if (!CREDENTIAL.test(value)) fail('AUTH_REQUIRED');
  return value;
}

// The default adapter transport drops request bodies and extra headers, so the stdio
// entry installs its own verified HTTPS transport: bearer-only auth, no redirects,
// bounded bodies, verified chain and hostname. CA trust comes from the host process
// (e.g. NODE_EXTRA_CA_CERTS); no CA path is accepted from tool input.
function httpsTransport(origin, active) {
  return ({ method, path, credential, body, headers = {}, binary }) => new Promise((resolve, reject) => {
    let settled = false;
    const chunks = [];
    let size = 0;
    let deadline;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      active.delete(req);
      if (error) { chunks.length = 0; if (!req.destroyed) req.destroy(); reject(error); } else resolve(value);
    };
    const req = https.request(new URL(path, origin), { method, rejectUnauthorized: true, timeout: REQUEST_DEADLINE_MS,
      headers: { Authorization: `Bearer ${credential}`, ...headers,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) } }, res => {
      res.on('data', chunk => {
        if (settled) return;
        size += chunk.length;
        if (size > (binary ? MAX_ATTACHMENT_BYTES : MAX_JSON)) finish(new ImError('PAYLOAD_TOO_LARGE'));
        else chunks.push(chunk);
      });
      res.on('end', () => finish(null, { status: res.statusCode, body: Buffer.concat(chunks, size) }));
      res.on('aborted', () => finish(new ImError('STORAGE_UNAVAILABLE')));
      res.on('close', () => { if (!res.complete) finish(new ImError('STORAGE_UNAVAILABLE')); });
      res.on('error', () => finish(new ImError('STORAGE_UNAVAILABLE')));
    });
    active.add(req);
    deadline = setTimeout(() => finish(new ImError('STORAGE_UNAVAILABLE')), REQUEST_DEADLINE_MS);
    req.on('close', () => finish(new ImError('STORAGE_UNAVAILABLE')));
    req.on('timeout', () => finish(new ImError('STORAGE_UNAVAILABLE')));
    req.on('error', () => finish(new ImError('STORAGE_UNAVAILABLE')));
    req.end(body);
  });
}

/**
 * Mount the IM v1 MCP adapter for a stdio host.
 * Only `register(server)` / `call()` expose tools: there is no polling, watcher or
 * background worker, and every network request is made inside a tool call.
 */
export function createImMcpStdio({ config: rawConfig } = {}) {
  const config = parseNanaConfig(rawConfig);
  const origin = normalizeOrigin(config.serverUrl);
  requireDirectory(config.attachmentDirectory);
  requireDirectory(dirname(config.journalPath));
  readCredential(config); // fail closed before any tool is exposed

  const active = new Set();
  const db = new DatabaseSync(config.journalPath);
  try { db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL'); }
  catch (error) { try { db.close(); } catch { /* ignore */ } throw error; }

  let adapter;
  try {
    adapter = createImMcpAdapter({
      serverUrl: origin,
      agentId: config.agentId,
      getCredential: async () => readCredential(config),
      journal: scope => createImJournal({ db, ...scope }),
      attachmentDirectory: config.attachmentDirectory,
      transport: httpsTransport(origin, active),
    });
  } catch (error) {
    try { db.close(); } catch { /* ignore */ }
    throw error;
  }

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    try { adapter.close(); } catch { /* ignore */ }
    for (const request of active) request.destroy();
    active.clear();
    try { db.close(); } catch { /* already closed */ }
  }

  return Object.freeze({
    serverUrl: origin,
    agentId: config.agentId,
    tools: Object.freeze(Object.keys(imMcpToolSchemas)),
    register: server => adapter.register(server),
    call: (name, input) => adapter.call(name, input),
    close,
  });
}
