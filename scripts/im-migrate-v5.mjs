#!/usr/bin/env node
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrateImSchemaV5 } from '../src/im/schema.js';

const fail = code => Object.assign(new Error(code), { code });
const usage = 'Usage: node scripts/im-migrate-v5.mjs <existing-center-config.json>';

function existingFile(path) {
  if (typeof path !== 'string' || !path || path.includes('\0') || !isAbsolute(path) ||
      path.startsWith('\\\\') || path.startsWith('\\\\?\\') ||
      (process.platform === 'win32' && /:/.test(path.slice(2))) || !lstatSync(path).isFile()) {
    throw fail('MIGRATION_INVALID');
  }
  return path;
}

function main() {
  const configPath = process.argv[2];
  if (!configPath || process.argv.length !== 3) throw fail('MIGRATION_INVALID');
  let settings;
  try { settings = JSON.parse(readFileSync(existingFile(configPath), 'utf8')); }
  catch { throw fail('MIGRATION_INVALID'); }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) ||
      typeof settings.dbPath !== 'string' || !settings.dbPath ||
      Object.keys(settings).some(key => !['dbPath', 'policy', 'tls'].includes(key))) {
    throw fail('MIGRATION_INVALID');
  }
  const dbPath = existingFile(settings.dbPath);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
    const before = db.prepare('SELECT version FROM im_schema').get()?.version;
    if (before !== 4 && before !== 5) throw fail('MIGRATION_STALE');
    migrateImSchemaV5(db);
    const after = db.prepare('SELECT version,migration_checksum FROM im_schema').get();
    process.stdout.write(`${JSON.stringify({ status: 'migrated', from: before, to: after.version,
      schemaChecksum: after.migration_checksum })}\n`);
  } finally { db.close(); }
}

try { main(); }
catch (error) {
  process.stderr.write(`${JSON.stringify({ error: { code: typeof error?.code === 'string' ? error.code : 'MIGRATION_FAILED' } })}\n`);
  if (!process.argv[2] || process.argv.length !== 3) process.stderr.write(`${usage}\n`);
  process.exitCode = 1;
}
