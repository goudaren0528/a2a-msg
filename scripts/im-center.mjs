import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { parseImConfig } from '../src/im/config.js';
import { renderJoinPage } from '../src/im/join-page.js';
import { createImMcpHttp } from '../src/im/mcp-http.js';
import { createImCenter } from '../src/im/server.js';
import { assertImSchema } from '../src/im/schema.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));
const BUILD_COMMIT = /^[0-9a-f]{40}$/;

// The `/join` page must pin `npx` to the exact commit it was deployed from, never
// a branch or a moving tag. Precedence: explicit center config `build.commit`
// (deployment injection), then `A2A_MSG_BUILD_COMMIT`, then the checked-out HEAD
// of this repository (a git-based deploy updates it on every redeploy). Anything
// invalid refuses startup instead of silently serving a wrong ref.
function buildCommit(settings) {
  if (settings.build !== undefined) {
    if (!settings.build || typeof settings.build !== 'object' || Array.isArray(settings.build) ||
        Object.keys(settings.build).some(key => key !== 'commit') ||
        typeof settings.build.commit !== 'string' || !BUILD_COMMIT.test(settings.build.commit)) {
      throw Error('Invalid build commit');
    }
    return settings.build.commit;
  }
  const fromEnvironment = process.env.A2A_MSG_BUILD_COMMIT;
  if (fromEnvironment !== undefined && fromEnvironment !== '') {
    if (!BUILD_COMMIT.test(fromEnvironment)) throw Error('Invalid build commit');
    return fromEnvironment;
  }
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPOSITORY_ROOT, encoding: 'utf8',
      timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return BUILD_COMMIT.test(head) ? head : null;
  } catch { return null; }
}

function existingFile(path) {
  // Require literal absolute filesystem paths, not SQLite pseudo-paths, URIs,
  // symlinks, directories, device files, or Windows alternate data streams.
  if (typeof path !== 'string' || !path || path.includes('\0') ||
      !isAbsolute(path) || path.startsWith('\\\\') || path.startsWith('\\\\?\\') ||
      (process.platform === 'win32' && /:/.test(path.slice(2))) ||
      !lstatSync(path).isFile()) throw Error('Expected an existing regular file at an absolute path');
  return path;
}

// Explicit, pre-existing config only. Never migrate, initialize, or write config.
// JSON: {"dbPath":"...","policy":{"enabled":false,"writeMode":"paused"},
// "tls":{"keyPath":"...","certPath":"..."}}.
const configPath = process.argv[2];
if (!configPath || process.argv.length !== 3) {
  console.error('Usage: node scripts/im-center.mjs <existing-config.json>');
  process.exitCode = 1;
} else {
  let db, center, server, mcp;
  try {
    const settings = JSON.parse(readFileSync(existingFile(configPath), 'utf8'));
    if (!settings || typeof settings !== 'object' || Array.isArray(settings) ||
        typeof settings.dbPath !== 'string' || !settings.dbPath || !settings.policy ||
        Object.keys(settings).some(key => !['dbPath', 'policy', 'tls', 'build'].includes(key))) throw Error('Invalid configuration');
    const servedCommit = buildCommit(settings);
    const policy = parseImConfig(settings.policy);
    // Missing policy or transport never silently starts a network listener.
    if (!policy.transport || typeof policy.transport.serverUrl !== 'string' ||
        typeof policy.transport.bindUrl !== 'string' ||
        !['direct-tls', 'local-test'].includes(policy.transport.mode)) throw Error('Transport not configured');
    // `serverUrl` is the public origin clients and responses keep using;
    // `bindUrl` (defaulted to `serverUrl` by the policy parser) is only where
    // this process listens, so a reverse proxy can front a loopback listener.
    const publicUrl = new URL(policy.transport.serverUrl);
    const listenUrl = new URL(policy.transport.bindUrl);
    for (const url of [publicUrl, listenUrl]) {
      if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
          (policy.transport.mode === 'direct-tls' && url.protocol !== 'https:')) throw Error('Invalid transport URL');
    }
    const publicHost = publicUrl.hostname.replace(/^\[|\]$/g, '');
    const host = listenUrl.hostname.replace(/^\[|\]$/g, '');
    const port = Number(listenUrl.port || (listenUrl.protocol === 'https:' ? 443 : 80));
    if (policy.transport.mode === 'direct-tls') {
      if (typeof settings.tls?.keyPath !== 'string' || !settings.tls.keyPath ||
          typeof settings.tls?.certPath !== 'string' || !settings.tls.certPath ||
          Object.keys(settings.tls).some(key => !['keyPath', 'certPath', 'caCertPath'].includes(key)) ||
          (settings.tls.caCertPath !== undefined &&
            (typeof settings.tls.caCertPath !== 'string' || !settings.tls.caCertPath))) {
        throw Error('TLS files not configured');
      }
    } else if (settings.tls !== undefined || publicUrl.protocol !== 'http:' || listenUrl.protocol !== 'http:' ||
        !['localhost', '127.0.0.1', '::1'].includes(publicHost) ||
        !['localhost', '127.0.0.1', '::1'].includes(host)) {
      throw Error('Unsupported transport configuration');
    }
    const dbPath = existingFile(settings.dbPath);
    const keyPath = policy.transport.mode === 'direct-tls' ? existingFile(settings.tls.keyPath) : null;
    const certPath = policy.transport.mode === 'direct-tls' ? existingFile(settings.tls.certPath) : null;
    // The optional CA bundle is published as-is on GET /ca.pem, so it may only
    // contain certificate blocks: refuse anything else (keys included) at start.
    const caCertPath = policy.transport.mode === 'direct-tls' && settings.tls.caCertPath !== undefined
      ? existingFile(settings.tls.caCertPath) : null;
    const caPem = caCertPath === null ? null : readFileSync(caCertPath);
    if (caPem && !(caPem.length > 0 && caPem.length <= 1024 * 1024 &&
        /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/.test(caPem.toString('latin1')) &&
        !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(caPem.toString('latin1')))) {
      throw Error('Invalid CA certificate file');
    }
    // Probe the existing schema read-only before any writable open. Protected
    // directory ownership must prevent replacement between these two opens.
    const probe = new DatabaseSync(dbPath, { readOnly: true });
    try {
      probe.exec('PRAGMA foreign_keys=ON');
      assertImSchema(probe);
    } finally { probe.close(); }
    db = new DatabaseSync(dbPath);
    db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
    center = createImCenter({ db, policy });
    mcp = createImMcpHttp({ ...center.modules, policy });
    // Both public routes are static: the pinned npx ref is resolved once at
    // startup, so a redeploy changes the page with the commit, not per request.
    const joinPage = Buffer.from(renderJoinPage({ commit: servedCommit }), 'utf8');
    if (servedCommit === null) {
      console.error('IM center: build commit unknown; GET /join cannot pin an npx ref (set build.commit or A2A_MSG_BUILD_COMMIT)');
    }
    const listener = async (req, res) => {
      try {
        // The only public HTML route: a static page that turns the browser-side
        // join fragment into a prompt. It carries no invite code, no data and no
        // external resource; the fragment never reaches this server.
        if (req.method === 'GET' && req.url === '/join') {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.setHeader('Content-Length', joinPage.length);
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.setHeader('Referrer-Policy', 'no-referrer');
          // No external script, font or image; nothing can leave the page.
          // The page may call only its own origin, for one-time enrollment. It
          // still cannot load external scripts/fonts/images or navigate away.
          res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; connect-src 'self'");
          res.end(joinPage);
          return;
        }
        // The other public route: the center CA bundle, served
        // byte-for-byte so a join link's sha256 fingerprint pins it. Absent
        // config, other methods and other paths stay unresolvable (404).
        if (caPem !== null && req.method === 'GET' && req.url === '/ca.pem') {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/x-pem-file');
          res.setHeader('Content-Length', caPem.length);
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.end(caPem);
          return;
        }
        // A remote MCP session requires HTTPS, a Bearer credential and an exact
        // `/mcp` path. The handler declines every other path so `/api/v1`,
        // `/join` and `/ca.pem` keep their existing dispatch behavior.
        if (await mcp.handle(req, res)) return;
        if (!await center.handler.handle(req, res)) {
          res.statusCode = 404;
          res.setHeader('Cache-Control', 'no-store');
          res.end();
        }
      } catch {
        if (!res.headersSent) { res.statusCode = 503; res.end(); }
        else res.destroy();
      }
    };
    server = policy.transport.mode === 'direct-tls'
      ? https.createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath), maxHeaderSize: 8192 }, listener)
      : http.createServer({ maxHeaderSize: 8192 }, listener);
    server.maxHeadersCount = 64;
    server.headersTimeout = 10000;
    server.requestTimeout = 30000;
    server.maxConnections = policy.limits.maxConnections;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
    console.log('IM center listening');
    const shutdown = async () => {
      await mcp.close();
      center.close();
      server.close(() => { db.close(); process.exitCode = 0; });
    };
    process.once('SIGINT', () => { void shutdown(); });
    process.once('SIGTERM', () => { void shutdown(); });
  } catch {
    await mcp?.close();
    center?.close();
    if (server?.listening) server.close();
    db?.close();
    console.error('IM center failed to start: invalid configuration or storage');
    process.exitCode = 1;
  }
}
