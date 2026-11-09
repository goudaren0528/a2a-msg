#!/usr/bin/env node
import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { homedir, hostname } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import ipaddr from 'ipaddr.js';
import { createLocalKeystore, saveProtectedFile } from '../src/im/keystore.js';
import { INVITE_CODE_PATTERN, defaultDisplayName } from '../src/im/enrollment.js';

const fail = code => Object.assign(new Error(code), { code });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CREDENTIAL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/;
// A join link pins the CA bundle by the SHA-256 of the exact PEM bytes the
// center serves on GET /ca.pem (`sha256sum ca.pem` / `shasum -a 256 ca.pem`).
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/;
const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/;
const TIMEOUT_MS = 30000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const usage = [
  'Usage: node scripts/im-register.mjs --center <url> --invite <code> [--display-name <name>] [--state-dir <absolute-path>]',
  '         [--ca-url <url> --ca-sha256 sha256:<hex>]',
  '       node scripts/im-register.mjs --join <https://center/join#invite=<code>&ca=sha256:<hex>>',
  '         [--display-name <name>] [--state-dir <absolute-path>]',
  '--display-name defaults to the sanitized system hostname; --ca-url and --ca-sha256 must be given together.',
].join('\n');

const loopbackHost = url => {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return host === 'localhost' || (ipaddr.isValid(host) && ipaddr.parse(host).range() === 'loopback');
};
const httpsOrLoopback = url => url.protocol === 'https:' || (url.protocol === 'http:' && loopbackHost(url));
const validDisplayName = value => typeof value === 'string' && value.length >= 1 && value.length <= 255 &&
  !/[\x00-\x1f\x7f]/.test(value);

function parse(argv) {
  const allowed = ['center', 'invite', 'display-name', 'state-dir', 'ca-url', 'ca-sha256', 'join'];
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!flag?.startsWith('--') || !allowed.includes(flag.slice(2)) || values[flag.slice(2)] !== undefined ||
        argv[i + 1] === undefined || argv[i + 1] === '') throw fail('INVALID_ARGUMENTS');
    values[flag.slice(2)] = argv[i + 1];
  }
  if (values.join !== undefined) {
    // A join link carries center, invite and CA fingerprint; mixing it with the
    // explicit forms would leave two sources of truth.
    if (['center', 'invite', 'ca-url', 'ca-sha256'].some(key => values[key] !== undefined)) {
      throw fail('INVALID_ARGUMENTS');
    }
  } else {
    if (!values.center || !values.invite) throw fail('INVALID_ARGUMENTS');
    if (!INVITE_CODE_PATTERN.test(values.invite)) throw fail('INVALID_INVITE');
    // First trust must be pinned: a CA URL without a fingerprint (or the
    // reverse) is rejected instead of silently trusting whatever is served.
    if ((values['ca-url'] === undefined) !== (values['ca-sha256'] === undefined)) throw fail('INVALID_ARGUMENTS');
    if (values['ca-sha256'] !== undefined && !FINGERPRINT.test(values['ca-sha256'])) throw fail('INVALID_ARGUMENTS');
  }
  if (values['display-name'] !== undefined && !validDisplayName(values['display-name'])) throw fail('INVALID_ARGUMENTS');
  return values;
}

function centerUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw fail('INVALID_CENTER'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw fail('INVALID_CENTER');
  if (!httpsOrLoopback(url)) throw fail('TLS_REQUIRED');
  return url.origin;
}

function joinLink(raw) {
  let url;
  try { url = new URL(raw); } catch { throw fail('INVALID_JOIN_LINK'); }
  if (url.username || url.password || url.search || url.pathname !== '/join') throw fail('INVALID_JOIN_LINK');
  if (!httpsOrLoopback(url)) throw fail('TLS_REQUIRED');
  // The fragment never reaches the server; it only carries the invite code and
  // the CA fingerprint (`invite=<code>&ca=sha256:<hex>`, either order).
  let params;
  try { params = new URLSearchParams(url.hash.replace(/^#/, '')); } catch { throw fail('INVALID_JOIN_LINK'); }
  const keys = [...params.keys()];
  if (params.getAll('invite').length !== 1 || params.getAll('ca').length !== 1 ||
      keys.some(key => !['invite', 'ca'].includes(key))) throw fail('INVALID_JOIN_LINK');
  const invite = params.get('invite'), ca = params.get('ca');
  if (!INVITE_CODE_PATTERN.test(invite) || !FINGERPRINT.test(ca)) throw fail('INVALID_JOIN_LINK');
  return { center: url.origin, invite, caUrl: `${url.origin}/ca.pem`, caSha256: ca };
}

function caTarget(raw) {
  let url;
  try { url = new URL(raw); } catch { throw fail('INVALID_ARGUMENTS'); }
  if (url.username || url.password || url.search || url.hash || !httpsOrLoopback(url)) throw fail('TLS_REQUIRED');
  return url;
}

function stateDirectory(raw) {
  if (raw !== undefined && !isAbsolute(raw)) throw fail('INVALID_ARGUMENTS');
  const directory = raw === undefined ? join(homedir(), '.a2a-msg') : resolve(raw);
  if (!isAbsolute(directory)) throw fail('INVALID_ARGUMENTS');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() ||
      (process.platform !== 'win32' && ((info.mode & 0o077) || info.uid !== process.geteuid()))) {
    throw fail('STATE_DIR_UNSAFE');
  }
  const credentials = join(directory, 'credentials');
  mkdirSync(credentials, { recursive: true, mode: 0o700 });
  const credentialInfo = lstatSync(credentials);
  if (!credentialInfo.isDirectory() || credentialInfo.isSymbolicLink() ||
      (process.platform !== 'win32' && ((credentialInfo.mode & 0o077) || credentialInfo.uid !== process.geteuid()))) {
    throw fail('STATE_DIR_UNSAFE');
  }
  return { directory, credentials, identityFile: join(directory, 'identity.json') };
}

// One buffered HTTP(S) exchange with a hard timeout and no redirect following
// and no keep-alive agent (the CLI must exit as soon as the work is done).
function exchange(url, { method, headers = {}, body, ca, rejectUnauthorized } = {}) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const options = { method, headers, agent: false, signal: AbortSignal.timeout(TIMEOUT_MS) };
    if (url.protocol === 'https:') {
      if (rejectUnauthorized === false) options.rejectUnauthorized = false;
      else if (ca) options.ca = [ca];
    }
    let settled = false;
    const done = (error, value) => { if (!settled) { settled = true; error ? reject(error) : resolve(value); } };
    const request = client.request(url, options, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) { request.destroy(); done(fail('PAYLOAD_TOO_LARGE')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => done(null, { status: response.statusCode,
        headers: response.headers, body: Buffer.concat(chunks, size) }));
      response.on('error', done);
    });
    request.on('error', done);
    request.end(body);
  });
}

// First trust (TOFU): the certificate chain is deliberately not validated here,
// because the only anchor available yet is the fingerprint carried inside the
// join link / --ca-sha256. A wrong or unknown chain can never pass the next step.
async function fetchCa(url) {
  let response;
  try {
    response = await exchange(url, { method: 'GET', rejectUnauthorized: false });
  } catch {
    throw fail('CA_FETCH_FAILED');
  }
  if (response.status !== 200) throw fail('CA_FETCH_FAILED');
  const pem = response.body;
  if (!pem.length || !PEM_CERTIFICATE.test(pem.toString('latin1'))) throw fail('CA_INVALID');
  return pem;
}

function verifyFingerprint(pem, expected) {
  const actual = `sha256:${createHash('sha256').update(pem).digest('hex')}`;
  const left = Buffer.from(actual), right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) throw fail('CA_FINGERPRINT_MISMATCH');
}

const tlsFailure = error => typeof error?.code === 'string' &&
  /^(ERR_TLS|ERR_SSL|DEPTH_|SELF_SIGNED_|UNABLE_TO_|CERT_|HOSTNAME_MISMATCH|EPROTO)/.test(error.code);

function interpretEnrollment(status, text) {
  let body;
  try { body = JSON.parse(text); } catch { throw fail('ENROLLMENT_FAILED'); }
  if (status < 200 || status >= 300) {
    // Only fixed IM error codes are surfaced; response bodies are never echoed.
    const code = typeof body?.error?.code === 'string' && /^[A-Z]{1,64}$/.test(body.error.code)
      ? body.error.code : 'ENROLLMENT_FAILED';
    throw fail(code);
  }
  if (!UUID.test(body?.agentId ?? '') || !CREDENTIAL.test(body?.credential ?? '') ||
      body.credential.slice(0, 36) !== body.credentialId || typeof body.displayName !== 'string') {
    throw fail('ENROLLMENT_FAILED');
  }
  return body;
}

async function enroll({ center, invite, displayName, ca }) {
  const payload = JSON.stringify({ inviteCode: invite, displayName });
  // Without a pinned CA, behavior is unchanged: global fetch plus whatever the
  // host trusts (e.g. NODE_EXTRA_CA_CERTS).
  if (!ca) {
    let response;
    try {
      response = await fetch(`${center}/api/v1/enroll`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch { throw fail('CENTER_UNAVAILABLE'); }
    let text;
    try { text = await response.text(); } catch { throw fail('CENTER_UNAVAILABLE'); }
    return interpretEnrollment(response.status, text);
  }
  let response;
  try {
    response = await exchange(new URL(`${center}/api/v1/enroll`), {
      method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      body: payload, ca,
    });
  } catch (error) {
    // The pinned CA did not verify the center certificate (wrong issuer, wrong
    // hostname, expired): fail closed instead of falling back to plain HTTP.
    throw fail(tlsFailure(error) ? 'CA_NOT_TRUSTED' : 'CENTER_UNAVAILABLE');
  }
  return interpretEnrollment(response.status, response.body.toString('utf8'));
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) !== 24) throw fail('NODE_VERSION_UNSUPPORTED');
  const values = parse(process.argv.slice(2));
  const link = values.join === undefined ? null : joinLink(values.join);
  const center = link ? link.center : centerUrl(values.center);
  const invite = link ? link.invite : values.invite;
  const caUrl = link ? link.caUrl : values['ca-url'];
  const caSha256 = link ? link.caSha256 : values['ca-sha256'];
  const displayName = values['display-name'] === undefined ? defaultDisplayName(hostname()) : values['display-name'];
  if (!validDisplayName(displayName)) throw fail('INVALID_ARGUMENTS');
  const state = stateDirectory(values['state-dir']);
  if (existsSync(state.identityFile)) throw fail('IDENTITY_EXISTS');
  // Fetch and pin the CA before any identity artifact is written; a failed
  // fetch, a non-PEM body or a fingerprint mismatch leaves the state dir empty.
  let ca;
  if (caUrl !== undefined) {
    ca = await fetchCa(caTarget(caUrl));
    verifyFingerprint(ca, caSha256);
  }
  const enrolled = await enroll({ center, invite, displayName, ca });
  const store = createLocalKeystore({ directory: state.credentials, report: () => {} });
  const remove = store.storeCredential({ credentialId: enrolled.credentialId,
    agentId: enrolled.agentId, credential: enrolled.credential });
  const credentialFile = join(state.credentials, `${enrolled.credentialId}.json`);
  try {
    saveProtectedFile(state.identityFile, `${JSON.stringify({
      agentId: enrolled.agentId,
      displayName: enrolled.displayName,
      centerUrl: center,
      credentialId: enrolled.credentialId,
      credentialFile,
    })}\n`, { report: () => {} });
  } catch {
    try { remove(); } catch { /* no DB credential exists if the identity artifact failed */ }
    throw fail('STATE_WRITE_FAILED');
  }
  process.stdout.write(`${JSON.stringify({ agentId: enrolled.agentId, displayName: enrolled.displayName,
    centerUrl: center, credentialFile, identityFile: state.identityFile })}\n`);
}

main().catch(error => {
  const code = typeof error?.code === 'string' ? error.code : 'REGISTRATION_FAILED';
  process.stderr.write(`${JSON.stringify({ error: { code } })}\n`);
  if (code === 'INVALID_ARGUMENTS') process.stderr.write(`${usage}\n`);
  process.exitCode = 1;
});
