import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { V3_DDL } from '../src/im/v2/schema-history.js';
import { V4_DDL, projectCandidateBudget } from '../src/im/v2/schema-internal.js';

// Test-only isolation of the actual private function: no production export or
// bypassed production projection. The public stage path checks physical file
// length first, so a low logical cap there would test the wrong rejection phase.
const source = readFileSync(new URL('../src/im/v2/recovery-candidate.js', import.meta.url), 'utf8');
const start = source.indexOf('const quote = name =>');
const end = source.indexOf('\nfunction normalizeCandidate(', start);
assert.ok(start >= 0 && end > start);
const logicalDigest = runInNewContext(`${source.slice(start, end)}\nlogicalDigest`, {
  Buffer, Uint8Array, createHash, projectCandidateBudget, V3_DDL, V4_DDL,
  fail: code => Object.assign(new Error(code), { code }),
});

// Independent literal framing oracle: include every prefix and row marker,
// rather than comparing against the production byte counter or source regexes.
function oracle(db) {
  const hash = createHash('sha256');
  let framed = 0, payload = 0;
  const raw = chunk => { framed += chunk.length; hash.update(chunk); };
  const field = (tag, data) => {
    const bytes = data instanceof Uint8Array ? Buffer.from(data) : Buffer.from(String(data), 'utf8');
    raw(Buffer.from(tag + ':' + bytes.length + ':', 'utf8'));
    raw(bytes); payload += bytes.length;
  };
  for (const pragma of ['user_version', 'application_id', 'encoding']) {
    field('pragma', pragma);
    const fact = db.prepare(`PRAGMA ${pragma}`).get()[pragma];
    field(typeof fact === 'number' ? 'integer' : 'text', fact);
  }
  const objects = db.prepare('SELECT type,name,tbl_name,rootpage,sql FROM sqlite_schema ORDER BY name').all();
  for (const object of objects) {
    for (const key of ['type', 'name', 'tbl_name', 'sql']) field(object[key] === null ? 'null' : 'text', object[key] ?? '');
    if (object.type !== 'table') continue;
    field('table', object.name);
    const columns = db.prepare(`PRAGMA table_info("${object.name}")`).all().map(c => c.name);
    const selection = columns.map((col, i) => `CASE typeof("${col}") WHEN 'text' THEN CAST("${col}" AS BLOB) ELSE "${col}" END AS v${i},typeof("${col}") AS t${i}`).join(',');
    const statement = db.prepare(`SELECT rowid AS logicalRowId,${selection} FROM "${object.name}" ORDER BY rowid`);
    statement.setReadBigInts(true);
    let count = 0;
    for (const row of statement.iterate()) {
      ++count; raw(Buffer.from('row:', 'utf8')); field('integer', row.logicalRowId);
      for (let i = 0; i < columns.length; ++i) {
        const type = row[`t${i}`], value = row[`v${i}`];
        if (type === 'null') field('null', '');
        else if (type === 'real') { const bits = Buffer.alloc(8); bits.writeDoubleBE(value); field(type, bits); }
        else field(type, value);
      }
    }
    field('rows', count);
  }
  return { framed, payload, digest: hash.digest('hex') };
}

test('logical digest charges PRAGMA/schema/value prefixes and row markers at exact boundary', t => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(V3_DDL.join(';') + ';');
    db.prepare('INSERT INTO im_agents VALUES (?,?,?,?,?)').run('agent-one', '雪', 'active', 42, null);
    db.prepare('INSERT INTO im_credentials VALUES (?,?,?,?,?,?)').run('credential-one', 'agent-one', 'hash', 43, null, null);
    db.prepare('INSERT INTO im_settings VALUES (?,?)').run(1, 'paused');
    db.prepare('INSERT INTO im_clock VALUES (?,?)').run(1, 0);
    const rawSnow = db.prepare("SELECT CAST(display_name AS BLOB) AS value FROM im_agents WHERE agent_id='agent-one'").get().value;
    assert.ok(rawSnow instanceof Uint8Array);
    assert.equal(Buffer.from(rawSnow).toString('hex'), 'e99baa');
    const expected = oracle(db);
    assert.ok(expected.framed > expected.payload);
    const before = db.prepare('SELECT total_changes() AS n').get().n;
    const limits = { maxMessages: 10, maxVerifiedContentBytes: 1024, maxOtherRecords: 100,
      maxMetadataEntries: 100, maxElapsedMs: 10000, maxFileBytes: expected.framed };
    const budget = maxFileBytes => {
      const started = Date.now();
      return { limits: { ...limits, maxFileBytes }, tick() {
        if (Date.now() - started > limits.maxElapsedMs) throw Error('test elapsed budget exceeded');
      } };
    };
    assert.equal(logicalDigest(db, budget(expected.framed), 3), expected.digest);
    assert.throws(() => logicalDigest(db, budget(expected.framed - 1), 3), { code: 'RECOVERY_BUSY' });
    // Previously payload-only accounting would accept this cap. This is a
    // logicalDigest-phase refusal, not the outer physical-file precheck.
    assert.throws(() => logicalDigest(db, budget(expected.payload), 3), { code: 'RECOVERY_BUSY' });
    assert.equal(db.prepare('SELECT total_changes() AS n').get().n, before);
    t.diagnostic(JSON.stringify({ rawSnow: Buffer.from(rawSnow).toString('hex'), framed: expected.framed,
      payload: expected.payload, digest: expected.digest, exactBoundary: expected.framed,
      refusedBoundary: expected.framed - 1, refusedPayloadCap: expected.payload }));
  } finally { db.close(); }
});
