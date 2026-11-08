#!/usr/bin/env node
import { lstatSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import ipaddr from 'ipaddr.js';
import { createLocalKeystore, saveProtectedFile } from '../src/im/keystore.js';
import { INVITE_CODE_PATTERN } from '../src/im/enrollment.js';

const fail = code => Object.assign(new Error(code), { code });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CREDENTIAL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/;
const usage = 'Usage: node scripts/im-register.mjs --center <url> --invite <code> --display-name <name> [--state-dir <absolute-path>]';

function parse(argv) {
  const allowed = ['center', 'invite', 'display-name', 'state-dir'];
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!flag?.startsWith('--') || !allowed.includes(flag.slice(2)) || values[flag.slice(2)] !== undefined ||
        argv[i + 1] === undefined || argv[i + 1] === '') throw fail('INVALID_ARGUMENTS');
    values[flag.slice(2)] = argv[i + 1];
  }
  if (!values.center || !values.invite || !values['display-name']) throw fail('INVALID_ARGUMENTS');
  if (!INVITE_CODE_PATTERN.test(values.invite)) throw fail('INVALID_INVITE');
  if (typeof values['display-name'] !== 'string' || values['display-name'].length > 255 ||
      !values['display-name'].length || /[\x00-\x1f\x7f]/.test(values['display-name'])) throw fail('INVALID_ARGUMENTS');
  return values;
}

function centerUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw fail('INVALID_CENTER'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw fail('INVALID_CENTER');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || (ipaddr.isValid(host) && ipaddr.parse(host).range() === 'loopback');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw fail('TLS_REQUIRED');
  return url.origin;
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

async function enroll({ center, invite, displayName }) {
  let response;
  try {
    response = await fetch(`${center}/api/v1/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inviteCode: invite, displayName }),
      signal: AbortSignal.timeout(30000),
    });
  } catch { throw fail('CENTER_UNAVAILABLE'); }
  let body;
  try { body = JSON.parse(await response.text()); } catch { throw fail('ENROLLMENT_FAILED'); }
  if (!response.ok) {
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

async function main() {
  if (Number(process.versions.node.split('.')[0]) !== 24) throw fail('NODE_VERSION_UNSUPPORTED');
  const values = parse(process.argv.slice(2));
  const center = centerUrl(values.center);
  const state = stateDirectory(values['state-dir']);
  if (existsSync(state.identityFile)) throw fail('IDENTITY_EXISTS');
  const enrolled = await enroll({ center, invite: values.invite, displayName: values['display-name'] });
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
