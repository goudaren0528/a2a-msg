import { DatabaseSync } from 'node:sqlite';
let db, acquired = false, sqliteCode = null, connectionClosed = false;
try {
  db = new DatabaseSync(process.argv[2]); db.exec('PRAGMA busy_timeout=0');
  db.exec('BEGIN IMMEDIATE'); acquired = true; db.exec('ROLLBACK');
} catch (error) {
  sqliteCode = error.errcode ?? error.sqliteCode;
  if (sqliteCode !== 5) throw error; // Exact SQLITE_BUSY, not a message regex.
} finally { if (db) { db.close(); connectionClosed = !db.isOpen; } }
process.stdout.write(JSON.stringify({ acquired, sqliteCode, connectionClosed }));
