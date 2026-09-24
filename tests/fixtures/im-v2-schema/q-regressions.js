// Independent Q1-Q3 oracles: frozen v1 JSON fingerprint, public APIs, native SQL only.
import assert from 'node:assert/strict';
import { assertImSchemaV4 } from '../../../src/im/v2/schema.js';
import { migrateImSchemaV4 } from '../../../src/im/v2/migration.js';
import { sha, snapshot, importOptions, mismatch, maintenance, insert } from './helpers.js';

export function pinnedV1Hash(db, id) {
  const m = db.prepare('SELECT * FROM im_messages WHERE message_id=?').get(id);
  const a = db.prepare('SELECT name,mime,size,sha256 FROM im_attachments WHERE message_id=?').get(id);
  return sha(JSON.stringify(['a2a-msg.im.v1', m.conversation_id, m.recipient_id, m.client_message_id,
    m.title, m.text, a ? [a.name, a.mime, a.size, a.sha256] : null, m.in_reply_to, m.correlation]));
}

export function rejectedCandidateUnchanged(db) {
  const before = snapshot(db);
  assert.throws(() => assertImSchemaV4(db), mismatch);
  assert.deepEqual(snapshot(db), before, 'assert preserves every row and schema object');
  assert.throws(() => migrateImSchemaV4(db, importOptions()), mismatch);
  assert.deepEqual(snapshot(db), before, 'full exact retry refuses without healing or advancing');
}

export function validCandidateUnchanged(db) {
  const before = snapshot(db);
  assert.equal(assertImSchemaV4(db), true);
  assert.equal(migrateImSchemaV4(db, importOptions()).schemaVersion, 4);
  assert.deepEqual(snapshot(db), before, 'valid assert/retry preserves facts and pending progress');
}

export function expire(db, ids) {
  const run = maintenance(db, 'expire');
  for (const id of ids) assert.equal(db.prepare("UPDATE im_content_state SET state='expired',expired_at=expires_at,expiry_run_id=? WHERE message_id=?")
    .run(run, id).changes, 1);
}

export function receipt(f, result, overrides = {}) {
  return insert(f.db, 'im_expiry_receipts', { recipient_id: f.b, center_epoch: result.initialEpoch,
    stream_epoch: f.stream, seq: 2, message_id: f.messages[1], recorded_at: 7776000100, ...overrides });
}

export const retainedCorruptions = [
  ['text with original fingerprint', (db, id) => {
    const hash = db.prepare('SELECT payload_hash FROM im_send_keys WHERE message_id=?').get(id).payload_hash;
    assert.equal(db.prepare('UPDATE im_messages SET text=? WHERE message_id=?').run('changed text', id).changes, 1);
    assert.equal(db.prepare('SELECT payload_hash FROM im_send_keys WHERE message_id=?').get(id).payload_hash, hash);
    assert.notEqual(pinnedV1Hash(db, id), hash);
  }],
  ['equal-length BLOB with original SHA and size', (db, id) => {
    const before = db.prepare('SELECT size,sha256 FROM im_attachments WHERE message_id=?').get(id);
    const bytes = Buffer.from('changed attachment');
    assert.equal(bytes.length, 18); assert.equal(before.size, 18);
    assert.notEqual(sha(bytes), before.sha256);
    assert.equal(db.prepare('UPDATE im_attachments SET data=? WHERE message_id=?').run(bytes, id).changes, 1);
    assert.deepEqual(db.prepare('SELECT size,sha256 FROM im_attachments WHERE message_id=?').get(id), before);
    assert.equal(db.prepare('SELECT payload_hash FROM im_send_keys WHERE message_id=?').get(id).payload_hash, pinnedV1Hash(db, id),
      'old fingerprint still matches metadata: rejection must verify actual bytes');
  }],
  ['stored fingerprint zeroed', (db, id) => {
    assert.notEqual(pinnedV1Hash(db, id), '0'.repeat(64));
    assert.equal(db.prepare('UPDATE im_send_keys SET payload_hash=? WHERE message_id=?').run('0'.repeat(64), id).changes, 1);
  }],
  ['over-limit title with independently correct fingerprint', (db, id) => {
    assert.equal(db.prepare('UPDATE im_messages SET title=? WHERE message_id=?').run('t'.repeat(101), id).changes, 1);
    const hash = pinnedV1Hash(db, id);
    assert.equal(db.prepare('UPDATE im_send_keys SET payload_hash=? WHERE message_id=?').run(hash, id).changes, 1);
    assert.equal(db.prepare('SELECT payload_hash FROM im_send_keys WHERE message_id=?').get(id).payload_hash, hash);
  }],
];
