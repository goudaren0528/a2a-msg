#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import https from 'node:https';
import { dirname, join } from 'node:path';
import { readNanaConfigFile, readNanaCredential } from '../src/im/mcp-stdio.js';
import { readNanaCaFile } from '../src/nana/config.js';
import { INVITE_CODE_PATTERN } from '../src/im/enrollment.js';

const fail = code => Object.assign(new Error(code), { code });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TIMEOUT_MS = 30000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
// Only these center-side codes are surfaced; anything else is STORAGE_UNAVAILABLE.
const REMOTE_CODES = new Set(['INVALID_REQUEST', 'AUTH_REQUIRED', 'INVALID_CREDENTIAL', 'TLS_REQUIRED',
  'OPERATION_FORBIDDEN', 'RESOURCE_NOT_FOUND', 'POLICY_NOT_CONFIGURED', 'IM_DISABLED', 'NEW_WRITES_DISABLED',
  'ENROLLMENT_DISABLED', 'AGENT_INVITES_DISABLED', 'INVITE_LIMIT_REACHED', 'INVITE_NOT_FOUND',
  'RATE_LIMITED', 'STORAGE_UNAVAILABLE', 'CLOCK_UNSAFE']);
const usage = [
  'Usage: node scripts/im-invite.mjs --config <ABSOLUTE_EXISTING_JSON>',
  '       node scripts/im-invite.mjs --config <ABSOLUTE_EXISTING_JSON> --revoke <INVITE_ID>',
  '',
  'Creates a one-time join link bound to the Agent in nana.json, or revokes one of',
  'its unused invites. The link uses the caller\'s own `serverUrl` plus the sha256',
  'fingerprint of the local ca.pem (`nana.json.caFile`, or ca.pem next to the',
  'config). Printed once: the invite code is never stored locally, and the',
  'credential is never printed.',
].join('\n');

function parse(argv) {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) return null;
  const allowed = new Set(['config', 'revoke']);
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i], value = argv[i + 1];
    if (typeof flag !== 'string' || !flag.startsWith('--') || value === undefined || value === '') throw fail('INVALID_ARGUMENTS');
    const name = flag.slice(2);
    if (!allowed.has(name) || Object.hasOwn(values, name)) throw fail('INVALID_ARGUMENTS');
    values[name] = value;
  }
  if (values.config === undefined) throw fail('INVALID_ARGUMENTS');
  if (values.revoke !== undefined && !UUID.test(values.revoke)) throw fail('INVALID_ARGUMENTS');
  return values;
}

function request(origin, path, credential, ca, body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    let settled = false;
    const done = (error, value) => { if (!settled) { settled = true; error ? reject(error) : resolve(value); } };
    const req = https.request(new URL(path, origin), {
      method: 'POST', agent: false, rejectUnauthorized: true, ca: [ca],
      headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json',
        'Content-Length': payload.length },
    }, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) { done(fail('PAYLOAD_TOO_LARGE')); req.destroy(); return; }
        chunks.push(chunk);
      });
      response.on('end', () => done(null, { status: response.statusCode, body: Buffer.concat(chunks, size) }));
      response.on('aborted', () => done(fail('CENTER_UNAVAILABLE')));
      response.on('error', () => done(fail('CENTER_UNAVAILABLE')));
    });
    req.setTimeout(TIMEOUT_MS, () => { req.destroy(); done(fail('CENTER_UNAVAILABLE')); });
    req.on('error', () => done(fail('CENTER_UNAVAILABLE')));
    req.end(payload);
  });
}

function interpret(response) {
  let value;
  try { value = JSON.parse(response.body.toString('utf8')); } catch { throw fail('STORAGE_UNAVAILABLE'); }
  if (response.status >= 400 || response.status < 200 || response.status > 299) {
    const code = value?.error?.code;
    throw fail(REMOTE_CODES.has(code) ? code : 'STORAGE_UNAVAILABLE');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw fail('STORAGE_UNAVAILABLE');
  return value;
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) !== 24) throw fail('NODE_VERSION_UNSUPPORTED');
  const values = parse(process.argv.slice(2));
  if (values === null) { process.stdout.write(`${usage}\n`); return; }
  const config = readNanaConfigFile(values.config);
  const credential = readNanaCredential(config);
  const origin = new URL(config.serverUrl).origin;
  // The link must carry the caller's own public `serverUrl` (never the center's
  // internal transport URL) and the device-local CA it trusts.
  const caFile = config.caFile ?? (existsSync(join(dirname(values.config), 'ca.pem'))
    ? join(dirname(values.config), 'ca.pem') : undefined);
  if (caFile === undefined) throw fail('CA_NOT_CONFIGURED');
  let ca;
  try { ca = readNanaCaFile(caFile); } catch { throw fail('CA_INVALID'); }
  if (values.revoke !== undefined) {
    const result = interpret(await request(origin, `/api/v1/invites/${values.revoke}/revoke`, credential, ca, {}));
    if (result.inviteId !== values.revoke || !Number.isSafeInteger(result.revokedAt)) throw fail('STORAGE_UNAVAILABLE');
    process.stdout.write(`${JSON.stringify({ inviteId: result.inviteId, revokedAt: result.revokedAt })}\n`);
    return;
  }
  const result = interpret(await request(origin, '/api/v1/invites', credential, ca, {}));
  if (!UUID.test(result.inviteId ?? '') || !INVITE_CODE_PATTERN.test(result.code ?? '') ||
      !Number.isSafeInteger(result.expiresAt) || !Number.isSafeInteger(result.ttlMs)) throw fail('STORAGE_UNAVAILABLE');
  const caFingerprint = `sha256:${createHash('sha256').update(ca).digest('hex')}`;
  const joinUrl = `${origin}/join#invite=${result.code}&ca=${caFingerprint}`;
  process.stdout.write(`${JSON.stringify({ inviteId: result.inviteId, code: result.code,
    expiresAt: result.expiresAt, ttlMs: result.ttlMs, serverUrl: origin, caFingerprint, joinUrl })}\n`);
}

process.umask(0o077);
main().catch(error => {
  const code = typeof error?.code === 'string' ? error.code : 'INVITE_FAILED';
  process.stderr.write(`${JSON.stringify({ error: { code } })}\n`);
  if (code === 'INVALID_ARGUMENTS') process.stderr.write(`${usage}\n`);
  process.exitCode = 1;
});
