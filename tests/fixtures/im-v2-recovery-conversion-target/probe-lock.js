import { DatabaseSync } from 'node:sqlite';

let db, acquired = false, connectionClosed = false;
try {
  db = new DatabaseSync(process.argv[2]);
  db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'); acquired = true;
  db.exec('ROLLBACK');
} catch (error) {
  if (error.sqliteCode !== 5 && error.sqliteCode !== 6 && !/locked|busy/.test(error.message)) throw error;
} finally { db?.close(); connectionClosed = db?.isOpen === false; }
process.stdout.write(JSON.stringify({ acquired, connectionClosed }));
