import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {JOURNAL_DDL, JOURNAL_CHECKSUM} from '../src/im/v2/journal-schema.js';
import {createImV2Journal} from '../src/im/v2/journal.js';
import {TABLES, INDEXES} from './fixtures/im-v2-journal/contract.js';
import {environment} from './fixtures/im-v2-journal/native.js';

// Literal, reviewed disk-format oracle; never construct the expected DDL from
// the implementation under test. JSON object insertion order is checksum input.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/im-v2-journal/exact-ddl.json', import.meta.url), 'utf8'));
const APPROVED = '301df7fed057182c71e5262d127208752acfb034bc122311469db082c8903469';
const digest = ddl => createHash('sha256').update(JSON.stringify(ddl), 'utf8').digest('hex');

test('journal version 2 exact literal DDL and ordered-object checksum are frozen', () => {
  assert.deepEqual(Object.keys(fixture), ['version', 'checksum', 'ddl']);
  assert.equal(fixture.version, 2);
  assert.equal(fixture.checksum, APPROVED);
  assert.deepEqual(Object.keys(fixture.ddl), [...Object.keys(TABLES), ...Object.keys(INDEXES)]);
  assert.equal(Object.keys(fixture.ddl).length, 10);
  assert.deepEqual(Object.keys(JOURNAL_DDL), Object.keys(fixture.ddl), 'declaration order is format-significant');
  for (const [name, literalSql] of Object.entries(fixture.ddl)) {
    assert.equal(JOURNAL_DDL[name], literalSql, `${name}: exact SQL text`);
  }
  assert.equal(digest(fixture.ddl), APPROVED, 'SHA256 UTF8(JSON.stringify(literal ordered DDL object))');
  assert.equal(digest(JOURNAL_DDL), APPROVED);
  assert.equal(JOURNAL_CHECKSUM, APPROVED);
});

test('fresh file-backed native SQLite has exactly the ten literal application objects', t => {
  const env = environment(t);
  const db = env.open(); // Fixture opens a real file with FK=ON and synchronous=FULL.
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.equal(db.prepare('PRAGMA synchronous').get().synchronous, 2);
  createImV2Journal({db});

  // sqlite_autoindex_* is SQLite-generated PK/UNIQUE machinery, not an
  // application object; retain all other tables/indexes/views/triggers.
  const actual = db.prepare("SELECT name,type,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_autoindex_*' ORDER BY name").all();
  const expectedNames = Object.keys(fixture.ddl).sort();
  assert.deepEqual(actual.map(row => row.name), expectedNames);
  for (const row of actual) {
    assert.equal(row.type, Object.hasOwn(TABLES, row.name) ? 'table' : 'index', `${row.name}: object type`);
    assert.equal(row.sql, fixture.ddl[row.name], `${row.name}: native sqlite_master SQL bytes`);
  }
  assert.deepEqual({...db.prepare('SELECT singleton,version,checksum FROM im_v2_client_meta').get()},
    {singleton:1, version:2, checksum:APPROVED});
  env.close(); // Explicitly close native connection before fixture after-hook removes its directory.
});
