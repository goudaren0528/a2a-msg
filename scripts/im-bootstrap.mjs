import { DatabaseSync } from 'node:sqlite';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, chmodSync, writeFileSync, fsyncSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createImAdmin } from '../src/im/admin.js';
import { createAdminAuthority, createLocalKeystore, saveProtectedFile, WINDOWS_PERMISSION_WARNING } from '../src/im/keystore.js';
import { createImMigration } from '../src/im/migration.js';
import { initInstanceIdentity, migrateImSchemaV3 } from '../src/im/schema.js';
import { parseImConfig } from '../src/im/config.js';
import { createBridgeConfig, PROJECT_KEY } from '../src/bridge/config.js';

const usage = 'Usage: node scripts/im-bootstrap.mjs --root <ABSOLUTE_NONEXISTENT_DIR> [--server-url <https://host:port>] --project <key>=<absolute-dir>[|<description>] [--project ...] [--trust-windows-permissions] (quote --project; | separates optional description, never :)';
const repo = fileURLToPath(new URL('../', import.meta.url));
const fixtureCert = join(repo, 'tests/fixtures/im-tls/localhost-test-only.crt');
const fixtureKey = join(repo, 'tests/fixtures/im-tls/localhost-test-only.key');
const defaultUrl = 'https://localhost:8787';

function args(argv) {
  if (argv.length === 1 && argv[0] === '--help') return null;
  let root, serverUrl = defaultUrl, trustWindowsPermissions = false;
  const projects = [], keys = new Set(), directories = new Set();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--trust-windows-permissions') {
      if (trustWindowsPermissions) throw Error('duplicate --trust-windows-permissions');
      trustWindowsPermissions = true;
    } else if (flag === '--root' || flag === '--server-url' || flag === '--project') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw Error(`missing value for ${flag}`);
      if (flag === '--root') {
        if (root) throw Error('duplicate --root');
        root = value;
      } else if (flag === '--server-url') {
        if (serverUrl !== defaultUrl) throw Error('duplicate --server-url');
        serverUrl = value;
      } else {
        const equal = value.indexOf('=');
        if (equal < 1) throw Error('invalid --project: expected key=absolute-dir[|description]');
        const projectKey = value.slice(0, equal);
        const raw = value.slice(equal + 1);
        const separator = raw.indexOf('|');
        const directory = separator < 0 ? raw : raw.slice(0, separator);
        const description = separator < 0 ? undefined : raw.slice(separator + 1);
        if (!PROJECT_KEY.test(projectKey)) throw Error('invalid --project key: expected ASCII letter followed by up to 63 letters, digits, _ or -');
        if (!isAbsolute(directory) || /[\x00-\x1f\x7f|]/.test(directory) || directory.length > 4096)
          throw Error('invalid --project directory: expected an absolute path; use | for the optional description (not :)');
        if (description !== undefined && (description.length > 200 || !description || /[\x00-\x1f\x7f|]/.test(description)))
          throw Error('invalid --project description: expected 1–200 characters without | or control characters');
        const directoryKey = process.platform === 'win32' ? resolve(directory).toLowerCase() : resolve(directory);
        if (keys.has(projectKey)) throw Error('duplicate --project key');
        if (directories.has(directoryKey)) throw Error('duplicate --project directory');
        keys.add(projectKey); directories.add(directoryKey);
        projects.push(description === undefined ? { projectKey, directory } : { projectKey, directory, description });
      }
    } else throw Error(`unknown option: ${flag}`);
  }
  if (!root || !isAbsolute(root) || existsSync(root)) throw Error('--root must be absolute and must not already exist');
  if (!projects.length) throw Error('at least one --project is required (bridge configuration cannot have empty projects)');
  let url;
  try { url = new URL(serverUrl); } catch { throw Error('invalid --server-url'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw Error('--server-url must be a bare https origin');
  if (process.platform === 'win32' && !trustWindowsPermissions)
    throw Error(`Windows protected-file checks fail closed. Pass --trust-windows-permissions only after independently verifying restrictive NTFS ACLs and protected parent directories. ${WINDOWS_PERMISSION_WARNING}`);
  return { root, serverUrl, projects, trustWindowsPermissions };
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
  try { if (value !== undefined) {
    writeFileSync(fd, value); fsyncSync(fd);
  } } finally { closeSync(fd); }
}

function quote(value) { return process.platform === 'win32' ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`; }

function main() {
  const input = args(process.argv.slice(2));
  if (!input) { console.log(usage); return; }
  const { root, serverUrl, projects, trustWindowsPermissions } = input;
  process.umask(0o077);
  privateRoot(root);
  let db;
  try {
    const dbPath = join(root, 'center-v3.sqlite');
    const secretFile = join(root, 'admin-secret');
    const credentialDirectory = join(root, 'credentials');
    const centerPath = join(root, 'center-config.json');
    const bridgePath = join(root, 'bridge.json');
    mkdirSync(credentialDirectory, { mode: 0o700 });
    if (process.platform !== 'win32') chmodSync(credentialDirectory, 0o700);
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
    const agents = ['Upstream dispatcher', 'IM bridge'].map((displayName, index) => {
      const agentId = admin.registerAgent({ displayName }, context).agentId;
      const issued = admin.issueCredential({ agentId, expiresAt: null }, context);
      const credentialFile = join(credentialDirectory, index === 0 ? 'upstream-credential' : 'bridge-credential');
      saveProtectedFile(credentialFile, `${issued.credential}\n`, options);
      return { agentId, credentialFile };
    });
    admin.setContact({ agentA: agents[0].agentId, agentB: agents[1].agentId,
      allowed: true, reason: 'bootstrap dispatcher/bridge contact' }, context);
    const migration = createImMigration({ db, authorizeAdmin: ctx =>
      authority.authorizeAdmin(ctx) === true ? 'local-admin' : false });
    migration.setImWriteMode({ mode: 'enabled', reason: 'bootstrap enabled policy', policy }, context);
    const center = { dbPath, policy, tls: { keyPath: fixtureKey, certPath: fixtureCert } };
    const bridge = { agentId: agents[1].agentId, serverUrl,
      credentialFile: agents[1].credentialFile, journalPath: join(root, 'bridge-journal.sqlite'),
      statePath: join(root, 'bridge-tasks.sqlite'), allowedSenders: [agents[0].agentId], projects };
    createBridgeConfig(bridge);
    exclusive(centerPath, `${JSON.stringify(center, null, 2)}\n`);
    exclusive(bridgePath, `${JSON.stringify(bridge, null, 2)}\n`);
    console.log(`Upstream dispatcher agentId: ${agents[0].agentId}`);
    console.log(`Bridge agentId: ${agents[1].agentId}`);
    for (const [name, path] of Object.entries({ database: dbPath, adminSecret: secretFile,
      credentialDirectory, upstreamCredential: agents[0].credentialFile,
      bridgeCredential: agents[1].credentialFile, centerConfig: centerPath, bridgeConfig: bridgePath,
      tlsTestOnlyKey: fixtureKey, tlsTestOnlyCertificate: fixtureCert })) console.log(`${name}: ${path}`);
    console.log('TLS fixture is TEST-ONLY, never production. Supply real TLS key/certificate and trusted CA for deployment; this script does not generate certificates.');
    console.log('Next commands (local test only; requires OpenCode service before bridge):');
    console.log(`node scripts/im-center.mjs ${quote(centerPath)}`);
    console.log(process.platform === 'win32'
      ? `$env:NODE_EXTRA_CA_CERTS = ${quote(fixtureCert)}; node src/bridge/run.mjs ${quote(bridgePath)}`
      : `NODE_EXTRA_CA_CERTS=${quote(fixtureCert)} node src/bridge/run.mjs ${quote(bridgePath)}`);
    if (process.platform !== 'win32') console.log('POSIX root/credential directory: 0700; files: 0600.');
  } catch (error) {
    throw Error(`bootstrap failed (${error.message}); retained root for inspection: ${root}`);
  } finally { db?.close(); }
}

try { main(); process.exitCode = 0; } catch (error) { console.error(`${error.message}\n${usage}`); process.exitCode = 1; }
