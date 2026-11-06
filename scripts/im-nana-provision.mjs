import { DatabaseSync } from 'node:sqlite';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, chmodSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createImAdmin } from '../src/im/admin.js';
import { createAdminAuthority, createLocalKeystore, saveProtectedFile, WINDOWS_PERMISSION_WARNING } from '../src/im/keystore.js';
import { createImMigration } from '../src/im/migration.js';
import { initInstanceIdentity, migrateImSchemaV3 } from '../src/im/schema.js';
import { parseImConfig } from '../src/im/config.js';

const usage = 'Usage: node scripts/im-nana-provision.mjs --root <ABSOLUTE_NONEXISTENT_DIR> [--agent-a-display <name>] [--agent-b-display <name>] [--server-url <https://host:port>] [--tls-key <ABSOLUTE_FILE> --tls-cert <ABSOLUTE_FILE>] [--ca-cert <ABSOLUTE_FILE>] [--trust-windows-permissions]';
const repo = fileURLToPath(new URL('../', import.meta.url));
const fixtureCert = join(repo, 'tests/fixtures/im-tls/localhost-test-only.crt');
const fixtureKey = join(repo, 'tests/fixtures/im-tls/localhost-test-only.key');
const defaultUrl = 'https://localhost:8787';

function displayName(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 255 || /[\x00-\x1f\x7f]/.test(value))
    throw Error('display name must be 1-255 characters without control characters');
  return value;
}

function args(argv) {
  if (argv.length === 1 && argv[0] === '--help') return null;
  let root, serverUrl = defaultUrl, trustWindowsPermissions = false, tlsKey, tlsCert, caCert;
  let agentADisplay = 'nana-home', agentBDisplay = 'nana-office';
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--trust-windows-permissions') {
      if (trustWindowsPermissions) throw Error('duplicate --trust-windows-permissions');
      trustWindowsPermissions = true;
    } else if (['--root', '--agent-a-display', '--agent-b-display', '--server-url', '--tls-key', '--tls-cert', '--ca-cert'].includes(flag)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw Error(`missing value for ${flag}`);
      if (flag === '--root') {
        if (root) throw Error('duplicate --root');
        root = value;
      } else if (flag === '--agent-a-display') {
        if (agentADisplay !== 'nana-home') throw Error('duplicate --agent-a-display');
        agentADisplay = displayName(value);
      } else if (flag === '--agent-b-display') {
        if (agentBDisplay !== 'nana-office') throw Error('duplicate --agent-b-display');
        agentBDisplay = displayName(value);
      } else if (flag === '--server-url') {
        if (serverUrl !== defaultUrl) throw Error('duplicate --server-url');
        serverUrl = value;
      } else if (flag === '--tls-key') {
        if (tlsKey !== undefined) throw Error('duplicate --tls-key');
        tlsKey = value;
      } else if (flag === '--tls-cert') {
        if (tlsCert !== undefined) throw Error('duplicate --tls-cert');
        tlsCert = value;
      } else {
        if (caCert !== undefined) throw Error('duplicate --ca-cert');
        caCert = value;
      }
    } else throw Error(`unknown option: ${flag}`);
  }
  if (tlsKey && !tlsCert) throw Error('--tls-key requires --tls-cert');
  if (tlsCert && !tlsKey) throw Error('--tls-cert requires --tls-key');
  for (const [flag, path] of [['--tls-key', tlsKey], ['--tls-cert', tlsCert], ['--ca-cert', caCert]]) {
    if (path === undefined) continue;
    if (!isAbsolute(path)) throw Error(`${flag} must be an absolute path to an existing regular file (not a symlink)`);
    let regular = false;
    try { regular = lstatSync(path).isFile(); } catch { /* missing or inaccessible */ }
    if (!regular) throw Error(`${flag} must be an absolute path to an existing regular file (not a symlink)`);
  }
  if (!root || !isAbsolute(root) || existsSync(root)) throw Error('--root must be absolute and must not already exist');
  let url;
  try { url = new URL(serverUrl); } catch { throw Error('invalid --server-url'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw Error('--server-url must be a bare https origin');
  if (agentADisplay === agentBDisplay) throw Error('--agent-a-display and --agent-b-display must differ');
  if (process.platform === 'win32' && !trustWindowsPermissions)
    throw Error(`Windows protected-file checks fail closed. Pass --trust-windows-permissions only after independently verifying restrictive NTFS ACLs and protected parent directories. ${WINDOWS_PERMISSION_WARNING}`);
  return { root, serverUrl, agentADisplay, agentBDisplay, trustWindowsPermissions, tlsKey, tlsCert, caCert,
    remoteHost: !['localhost', '127.0.0.1'].includes(url.hostname.toLowerCase()) };
}

function privateRoot(root) {
  const parent = dirname(root);
  if (!existsSync(parent)) throw Error('root parent must exist');
  let current = parse(parent).root;
  for (const part of parent.slice(current.length).split(/[\\/]+/).filter(Boolean)) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw Error('root parent contains a symlink');
  }
  mkdirSync(root, { mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(root, 0o700);
}

function exclusive(path, value) {
  const fd = openSync(path, 'wx', 0o600);
  try { if (value !== undefined) { writeFileSync(fd, value); fsyncSync(fd); } } finally { closeSync(fd); }
}

function directory(path) {
  mkdirSync(path, { mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(path, 0o700);
  return path;
}

function quote(value) { return process.platform === 'win32' ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`; }

function main() {
  const input = args(process.argv.slice(2));
  if (!input) { console.log(usage); return; }
  const { root, serverUrl, agentADisplay, agentBDisplay, trustWindowsPermissions, tlsKey, tlsCert, caCert, remoteHost } = input;
  process.umask(0o077);
  privateRoot(root);
  let db;
  try {
    const dbPath = join(root, 'center-v3.sqlite');
    const secretFile = join(root, 'admin-secret');
    const credentialDirectory = directory(join(root, 'credentials'));
    const centerPath = join(root, 'center-config.json');
    let warned = false;
    const options = { trustWindowsPermissions, report: message => {
      if (!warned) {
        warned = true;
        console.error(`${message}; --trust-windows-permissions accepts UNVERIFIED NTFS ACLs, not proof of administrator authentication. Independently verify restrictive ACLs on the parent, root, and protected files.`);
      }
    } };
    const secret = createLocalKeystore({ directory: credentialDirectory, ...options }).createAdminSecret(secretFile);
    const context = { adminSecret: secret };
    const authority = createAdminAuthority({ secretFile, ...options });
    exclusive(dbPath);
    db = new DatabaseSync(dbPath);
    db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
    migrateImSchemaV3(db);
    initInstanceIdentity(db, { clock: Date.now });
    const admin = createImAdmin({ db, clock: Date.now, authorizeAdmin: authority.authorizeAdmin });
    const policy = { enabled: true, writeMode: 'enabled', transport: { mode: 'direct-tls', serverUrl },
      retention: { policy: { messageRetentionMs: 86400000, attachmentRetentionMs: 86400000,
        idempotencyRetentionMs: 172800000, safeRetryWindowMs: 60000 } },
      lease: { ttlMs: 60000, renewalMs: 10000 } };
    parseImConfig(policy);
    const agents = [agentADisplay, agentBDisplay].map((displayName, index) => {
      const agentId = admin.registerAgent({ displayName }, context).agentId;
      const issued = admin.issueCredential({ agentId, expiresAt: null }, context);
      const credentialFile = join(credentialDirectory, index === 0 ? 'agent-a-credential' : 'agent-b-credential');
      saveProtectedFile(credentialFile, `${issued.credential}\n`, options);
      return { agentId, displayName, credentialFile };
    });
    for (const [from, to] of [[agents[0], agents[1]], [agents[1], agents[0]]]) {
      admin.setContact({ agentA: from.agentId, agentB: to.agentId,
        allowed: true, reason: 'isolated Nana roundtrip contact' }, context);
    }
    const migration = createImMigration({ db, authorizeAdmin: ctx =>
      authority.authorizeAdmin(ctx) === true ? 'local-admin' : false });
    migration.setImWriteMode({ mode: 'enabled', reason: 'Nana roundtrip enabled policy', policy }, context);
    const center = { dbPath, policy, tls: { keyPath: tlsKey ?? fixtureKey, certPath: tlsCert ?? fixtureCert } };
    exclusive(centerPath, `${JSON.stringify(center, null, 2)}\n`);
    const hosts = agents.map((agent, index) => {
      const label = index === 0 ? 'host-a' : 'host-b';
      const hostRoot = directory(join(root, label));
      const attachmentDirectory = directory(join(hostRoot, 'attachments'));
      const configPath = join(hostRoot, 'nana.json');
      exclusive(configPath, `${JSON.stringify({
        serverUrl,
        agentId: agent.agentId,
        credentialFile: agent.credentialFile,
        journalPath: join(hostRoot, 'journal.sqlite'),
        attachmentDirectory,
        statePath: join(hostRoot, 'session-state.json'),
        evidencePath: join(hostRoot, 'evidence.jsonl'),
      }, null, 2)}\n`);
      return { label, configPath, hostRoot };
    });
    console.log(`Agent A (${agents[0].displayName}) agentId: ${agents[0].agentId}`);
    console.log(`Agent B (${agents[1].displayName}) agentId: ${agents[1].agentId}`);
    for (const [name, path] of Object.entries({ root, database: dbPath, adminSecret: secretFile,
      credentialDirectory, agentACredential: agents[0].credentialFile, agentBCredential: agents[1].credentialFile,
      centerConfig: centerPath, hostAConfig: hosts[0].configPath, hostBConfig: hosts[1].configPath,
      tlsKey: center.tls.keyPath, tlsCertificate: center.tls.certPath,
      ...(caCert ? { caCertificateToCopyToOtherMachine: caCert } : {}) })) console.log(`${name}: ${path}`);
    if (!tlsKey) {
      console.log('WARNING: TLS test fixture only works for localhost on this machine; it cannot be used from another machine. Supply real TLS key/certificate and a trusted CA for LAN deployment. This script does not generate certificates.');
      if (remoteHost) console.log('WARNING: --server-url is not localhost/127.0.0.1 but no --tls-key/--tls-cert were supplied; the resulting config will not be reachable from other machines.');
    }
    const trusted = caCert ?? (tlsKey ? null : fixtureCert);
    const prefix = trusted ? `NODE_EXTRA_CA_CERTS=${quote(trusted)} ` : '';
    console.log('Next commands:');
    console.log(`  node scripts/im-center.mjs ${quote(centerPath)}`);
    console.log(`  ${prefix}node scripts/im-nana-session.mjs receive --config ${quote(hosts[1].configPath)}`);
    console.log(`  ${prefix}node scripts/im-nana-session.mjs send --config ${quote(hosts[0].configPath)} --to-agent ${quote(agents[1].agentId)} --text 'hello from ${agents[0].displayName}'`);
    if (process.platform !== 'win32') console.log('POSIX root/host/credential directories: 0700; files: 0600.');
  } catch (error) {
    throw Error(`provision failed (${error.message}); retained root for inspection: ${root}`);
  } finally { db?.close(); }
}

try { main(); process.exitCode = 0; } catch (error) { console.error(`${error.message}\n${usage}`); process.exitCode = 1; }
