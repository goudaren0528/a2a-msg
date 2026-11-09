#!/usr/bin/env node
// Thin npx entry for a2a-msg. It only dispatches to the existing scripts:
// `scripts/im-mcp.mjs` (IM v1 MCP stdio adapter) and `scripts/im-register.mjs`
// (one-time invite redemption). No business logic is duplicated here, and both
// legacy entries keep working (`node src/mcp.js`, `node scripts/im-mcp.mjs`).
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MODULE_PATH = fileURLToPath(import.meta.url);
const REQUIRED_NODE_MAJOR = 24;
const NODE_RANGE = '>=24 <25';

const globalUsage = [
  'Usage:',
  '  a2a-msg mcp --config <ABSOLUTE_EXISTING_JSON> [--download-dir <ABSOLUTE_EXISTING_DIR>]',
  '  a2a-msg register --center <URL> --invite <CODE> [--display-name <NAME>] [--state-dir <ABSOLUTE_PATH>]',
  '                   [--ca-url <URL> --ca-sha256 sha256:<HEX>]',
  '  a2a-msg join <https://CENTER/join#invite=CODE&ca=sha256:HEX>',
  '               [--display-name <NAME>] [--state-dir <ABSOLUTE_PATH>]',
  '  a2a-msg invite --config <ABSOLUTE_EXISTING_JSON> [--revoke <INVITE_ID>]',
  '  a2a-msg --help',
  '',
  'Commands:',
  '  mcp       Start the IM v1 MCP stdio adapter. The host spawns it on demand;',
  '            there is no daemon and no polling.',
  '  register  Redeem a one-time invite and store this device\'s identity under',
  '            the state directory (default ~/.a2a-msg). The credential is never',
  '            printed.',
  '  join      One command from a join link: fetch the center CA, verify its',
  '            sha256 fingerprint, then redeem the invite in the link fragment.',
  '            The fragment is never sent to the server. Writes identity.json,',
  '            ca.pem and a strict nana.json (plus attachments/) under --state-dir,',
  '            and prints the MCP host snippet.',
  '  invite    As the Agent in nana.json, create a one-time join link bound to it',
  '            (POST /api/v1/invites), or --revoke one of its unused invites.',
  '            The link uses the config serverUrl and the local ca.pem fingerprint.',
  '',
  'All commands forward to scripts/im-mcp.mjs, scripts/im-register.mjs and',
  'scripts/im-invite.mjs.',
  `Run "a2a-msg <command> --help" for the full option list. Requires Node.js ${NODE_RANGE}.`,
].join('\n');

const mcpUsage = [
  'Usage: a2a-msg mcp --config <ABSOLUTE_EXISTING_JSON> [--download-dir <ABSOLUTE_EXISTING_DIR>]',
  '',
  'Starts the IM v1 MCP stdio adapter over stdin/stdout. The config is the strict',
  '`nana.json` shared with scripts/im-nana-session.mjs; the credential is read only',
  'from the configured owner-only (0600) file, never from tool input.',
  '--download-dir overrides nana.json attachmentDirectory for received files.',
  'Trust a private CA through the host environment (e.g. NODE_EXTRA_CA_CERTS).',
].join('\n');

const registerUsage = [
  'Usage: a2a-msg register --center <URL> --invite <CODE> [--display-name <NAME>] [--state-dir <ABSOLUTE_PATH>]',
  '                        [--ca-url <URL> --ca-sha256 sha256:<HEX>]',
  '',
  'Redeems one invitation at an IM v1 center and writes the credential (0600) and',
  'identity.json (0600) under --state-dir (default ~/.a2a-msg). Accepts HTTPS, or',
  'plain HTTP only for a loopback center; a private CA is trusted through',
  'NODE_EXTRA_CA_CERTS. --display-name defaults to the sanitized system hostname.',
  '--ca-url fetches the center CA first trust and requires --ca-sha256 to pin it',
  '(sha256 of the served PEM bytes) before any TLS use; a mismatch stops.',
  'Prints agentId/displayName/centerUrl/paths, never the credential. Refuses to',
  'overwrite an existing identity.json.',
].join('\n');

const inviteUsage = [
  'Usage: a2a-msg invite --config <ABSOLUTE_EXISTING_JSON> [--revoke <INVITE_ID>]',
  '',
  'Creates a one-time `https://<serverUrl>/join#invite=CODE&ca=sha256:HEX` link bound',
  'to the Agent in the strict nana.json (the serverUrl it contains, never the',
  'center transport URL). The CA fingerprint is the sha256 of the device-local',
  'ca.pem (nana.json `caFile`, or ca.pem next to the config). Center limits apply:',
  '24h TTL, a daily cap per Agent, and revocation by the creator. Prints the invite',
  'code and link once; never prints the credential.',
].join('\n');

const joinUsage = [
  'Usage: a2a-msg join <https://CENTER/join#invite=CODE&ca=sha256:HEX>',
  '                    [--display-name <NAME>] [--state-dir <ABSOLUTE_PATH>]',
  '',
  'One command: reads the invite code and CA fingerprint from the link fragment',
  '(never sent to the server), fetches <CENTER>/ca.pem, verifies its sha256',
  'fingerprint, then redeems the invite with the pinned CA and writes identity.json',
  'and the credential (0600) under --state-dir (default ~/.a2a-msg).',
  'If the fingerprint does not match, stop: the link or the center is not the one',
  'you expected. --display-name defaults to the sanitized system hostname.',
].join('\n');

/**
 * Returns a fixed error code when the running Node.js major is outside
 * `engines` (24.x), otherwise null. Exported so the version gate is testable
 * without another Node installation.
 */
export function nodeVersionError(version = process.versions.node) {
  const match = /^v?(\d+)\.\d+\.\d+/.exec(String(version));
  if (!match) return 'NODE_VERSION_UNSUPPORTED';
  return Number(match[1]) === REQUIRED_NODE_MAJOR ? null : 'NODE_VERSION_UNSUPPORTED';
}

function writeError(code) {
  process.stderr.write(`${JSON.stringify({ error: { code } })}\n`);
}

function writeErrorWithMessage(code, message) {
  process.stderr.write(`${JSON.stringify({ error: { code, message } })}\n`);
}

function isHelp(argv) {
  return argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h');
}

function scriptPath(name) {
  return fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));
}

// stdio is inherited so the MCP protocol (or the register CLI output) goes
// straight to the host. Signals are forwarded because a host may kill only
// this wrapper; the exit code is preserved so hosts see failures.
function runScript(script, args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [script, ...args], { stdio: 'inherit' });
    const forward = signal => {
      try { child.kill(signal); } catch { /* already gone */ }
    };
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);
    const finish = code => {
      process.off('SIGINT', forward);
      process.off('SIGTERM', forward);
      resolve(code);
    };
    child.once('error', () => { writeError('STORAGE_UNAVAILABLE'); finish(1); });
    child.once('exit', (code, signal) => finish(signal ? 1 : (code ?? 1)));
  });
}

export async function main(argv) {
  const unsupported = nodeVersionError();
  if (unsupported) {
    writeErrorWithMessage(unsupported,
      `a2a-msg requires Node.js ${NODE_RANGE}; found v${process.versions.node}`);
    return 1;
  }

  const [command, ...rest] = argv;
  if (command === '--help' || command === '-h') {
    process.stdout.write(`${globalUsage}\n`);
    return 0;
  }
  if (command === 'mcp') {
    if (isHelp(rest)) { process.stdout.write(`${mcpUsage}\n`); return 0; }
    return runScript(scriptPath('im-mcp.mjs'), rest);
  }
  if (command === 'register') {
    if (isHelp(rest)) { process.stdout.write(`${registerUsage}\n`); return 0; }
    return runScript(scriptPath('im-register.mjs'), rest);
  }
  if (command === 'join') {
    if (isHelp(rest)) { process.stdout.write(`${joinUsage}\n`); return 0; }
    // Link parsing and CA pinning live in the register script; the wrapper only
    // forwards `<link>` plus the optional --display-name/--state-dir flags.
    return runScript(scriptPath('im-register.mjs'), ['--join', ...rest]);
  }
  if (command === 'invite') {
    if (isHelp(rest)) { process.stdout.write(`${inviteUsage}\n`); return 0; }
    return runScript(scriptPath('im-invite.mjs'), rest);
  }
  writeError('INVALID_ARGUMENTS');
  process.stderr.write(`${globalUsage}\n`);
  return 1;
}

function isMainModule() {
  if (typeof process.argv[1] !== 'string') return false;
  try { return realpathSync(process.argv[1]) === realpathSync(MODULE_PATH); } catch { return false; }
}

if (isMainModule()) {
  process.exitCode = await main(process.argv.slice(2));
}
