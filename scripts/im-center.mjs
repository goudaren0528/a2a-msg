import { lstatSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseImConfig } from '../src/im/config.js';
import { createImCenter } from '../src/im/server.js';
import { assertImSchema } from '../src/im/schema.js';

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
  let db, center, server;
  try {
    const settings = JSON.parse(readFileSync(existingFile(configPath), 'utf8'));
    if (!settings || typeof settings !== 'object' || Array.isArray(settings) ||
        typeof settings.dbPath !== 'string' || !settings.dbPath || !settings.policy ||
        Object.keys(settings).some(key => !['dbPath', 'policy', 'tls'].includes(key))) throw Error('Invalid configuration');
    const policy = parseImConfig(settings.policy);
    // Missing policy or transport never silently starts a network listener.
    if (!policy.transport || typeof policy.transport.serverUrl !== 'string' ||
        !['direct-tls', 'local-test'].includes(policy.transport.mode)) throw Error('Transport not configured');
    const url = new URL(policy.transport.serverUrl);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
        (policy.transport.mode === 'direct-tls' && url.protocol !== 'https:')) throw Error('Invalid transport URL');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    if (policy.transport.mode === 'direct-tls') {
      if (typeof settings.tls?.keyPath !== 'string' || !settings.tls.keyPath ||
          typeof settings.tls?.certPath !== 'string' || !settings.tls.certPath ||
          Object.keys(settings.tls).some(key => !['keyPath', 'certPath'].includes(key))) throw Error('TLS files not configured');
    } else if (settings.tls !== undefined || url.protocol !== 'http:' ||
        !['localhost', '127.0.0.1', '::1'].includes(host)) {
      throw Error('Unsupported transport configuration');
    }
    const dbPath = existingFile(settings.dbPath);
    const keyPath = policy.transport.mode === 'direct-tls' ? existingFile(settings.tls.keyPath) : null;
    const certPath = policy.transport.mode === 'direct-tls' ? existingFile(settings.tls.certPath) : null;
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
    const listener = async (req, res) => {
      try {
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
    const shutdown = () => {
      center.close();
      server.close(() => { db.close(); process.exitCode = 0; });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch {
    center?.close();
    if (server?.listening) server.close();
    db?.close();
    console.error('IM center failed to start: invalid configuration or storage');
    process.exitCode = 1;
  }
}
