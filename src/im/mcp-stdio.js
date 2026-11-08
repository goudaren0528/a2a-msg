import { lstatSync, mkdirSync, readFileSync } from 'node:fs';
import https from 'node:https';
import { dirname, isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ImError, MAX_ATTACHMENT_BYTES } from './contracts.js';
import { createImJournal } from './journal.js';
import { createImMcpAdapter, imMcpToolSchemas } from './mcp-adapter.js';
import { localFileToolSchemas, sendLocalFile, SEND_FILE_DESCRIPTION } from './mcp-local-files.js';
import { defaultAttachmentDirectory, normalizeOrigin, parseNanaConfig } from '../nana/config.js';

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

// `--download-dir` overrides `nana.json`. The default directory is created on
// demand; explicitly configured directories must already exist, so a missing or
// unwritable directory fails closed before any receive path can ACK.
function resolveAttachmentDirectory(config, downloadDirectory) {
  if (downloadDirectory !== undefined) {
    if (typeof downloadDirectory !== 'string' || !isAbsolute(downloadDirectory) ||
        downloadDirectory.includes('\0')) fail('INVALID_REQUEST');
    return requireDirectory(downloadDirectory);
  }
  const directory = config.attachmentDirectory;
  if (directory === defaultAttachmentDirectory(config.serverUrl)) {
    try { mkdirSync(directory, { recursive: true, mode: 0o700 }); } catch { fail('INVALID_REQUEST'); }
  }
  return requireDirectory(directory);
}

const textEnvelope = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
function errorEnvelope(error) {
  const e = error instanceof ImError ? error : new ImError('STORAGE_UNAVAILABLE');
  return { content: [{ type: 'text', text: JSON.stringify({
    error: { code: e.code, message: e.message, retryable: e.retryable } }) }], isError: true };
}

// The local-file tool delegates to the adapter's envelope API; unwrap it back to
// data so `sendLocalFile` can compose the exact `im_v1_send` request.
function unwrap(response) {
  let value;
  try { value = JSON.parse(response?.content?.[0]?.text); } catch { fail('STORAGE_UNAVAILABLE'); }
  if (response.isError) {
    let error;
    try { error = new ImError(value?.error?.code); } catch { error = new ImError('STORAGE_UNAVAILABLE'); }
    throw error;
  }
  return value;
}

/**
 * Mount the IM v1 MCP adapter for a stdio host.
 * Only `register(server)` / `call()` expose tools: there is no polling, watcher or
 * background worker, and every network request is made inside a tool call.
 */
export function createImMcpStdio({ config: rawConfig, downloadDirectory } = {}) {
  const config = parseNanaConfig(rawConfig);
  const origin = normalizeOrigin(config.serverUrl);
  const attachmentDirectory = resolveAttachmentDirectory(config, downloadDirectory);
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
      attachmentDirectory,
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

  // `im_v1_send_file` belongs to the stdio entry, not the shared adapter factory:
  // it is the only tool that touches a host-local path.
  async function call(name, input = {}) {
    if (name !== 'im_v1_send_file') return adapter.call(name, input);
    try {
      return textEnvelope(await sendLocalFile({ input,
        send: async (tool, request) => unwrap(await adapter.call(tool, request)) }));
    } catch (error) { return errorEnvelope(error); }
  }
  function register(server) {
    adapter.register(server);
    for (const [name, schema] of Object.entries(localFileToolSchemas)) {
      server.tool(name, SEND_FILE_DESCRIPTION, schema.shape, params => call(name, params));
    }
    return server;
  }

  return Object.freeze({
    serverUrl: origin,
    agentId: config.agentId,
    attachmentDirectory,
    tools: Object.freeze([...Object.keys(imMcpToolSchemas), ...Object.keys(localFileToolSchemas)]),
    register,
    call,
    close,
  });
}
