// TEST ONLY: all publication, migration, recovery, journal and file writes finish
// before the borrowed read-target is constructed or its zero-write baseline taken.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { setup, context } from '../im-v2-recovery-activate/helpers.js';
import { assertImSchemaV4 } from '../../../src/im/v2/schema.js';
import { createImV2Journal } from '../../../src/im/v2/journal.js';
import { identity, message, U } from '../im-v2-journal/contract.js';

function location(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'maintenance-legal-'));
  fs.chmodSync(dir, 0o700);
  const databasePath = join(dir, 'candidate.db');
  let db;
  const beforeClose = [];
  t.after(() => { for (const release of beforeClose) release(); if (db?.isOpen) db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, databasePath, beforeClose, open() { db = new DatabaseSync(databasePath); return db; } };
}

export async function activeFixture(t, kind, mode) {
  const s = await setup(t, kind === 'v3_import' ? 'closed-v3' : 'snapshot');
  const seal = s.api.verifyRecovery(s.verifyInput, context);
  const plan = s.api.previewActivation(s.previewInput(seal), context);
  assert.equal(s.api.activateRecovery(s.activateInput(seal, plan), context).status, 'active');
  // Recovery has closed the candidate. A distinct, test-owned offline copy is
  // opened exactly once at its protected canonical path and remains exclusive.
  const f = location(t);
  fs.copyFileSync(s.path, f.databasePath); fs.chmodSync(f.databasePath, 0o600);
  const db = f.open();
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE');
  db.prepare('UPDATE im_settings SET write_mode=?').run(mode);
  // Committed recovery fixtures retain their valid historical effectiveAt=0
  // policy. Register a complete current effectiveAt=1 policy before observation;
  // enabled config explicitly requires positive effectiveAt. Preserve the old
  // policy, preparation input hash and all migrated content-policy references.
  const historical = JSON.parse(db.prepare('SELECT canonical_json FROM im_retention_policies').get().canonical_json);
  const policy = { ...historical, effectiveAt: 1 };
  const policyHash = createHash('sha256').update(JSON.stringify(policy)).digest('hex');
  db.prepare('INSERT INTO im_retention_policies VALUES (?,?,?,?,?,?,?,?)').run(policyHash, 2, policy.effectiveAt,
    policy.messageRetentionMs, policy.attachmentRetentionMs, policy.safeRetryWindowMs,
    policy.auditRetentionMs, JSON.stringify(policy));
  assert.equal(assertImSchemaV4(db), true);
  const state = db.prepare('SELECT * FROM im_center_state').get();
  const run = db.prepare('SELECT * FROM im_recovery_runs WHERE run_id=?').get(state.recovery_run_id);
  const epoch = db.prepare('SELECT * FROM im_center_epochs WHERE center_epoch=?').get(state.center_epoch);
  assert.equal(run.candidate_kind, kind); assert.equal(run.status, 'active');
  assert.equal(run.new_epoch, state.center_epoch); assert.equal(run.activation_ref, state.activation_ref);
  assert.equal(epoch.recovery_counter, state.recovery_counter);
  assert.ok(run.auth_review_ref && run.activation_plan_hash && run.activation_approval_ref);
  assert.ok(run.isolation_ack_ref && run.rpo_report_json);
  assert.equal(db.prepare('SELECT count(*) n FROM im_receive_state').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) n FROM im_messages').get().n, 2);
  const progress = db.prepare('SELECT * FROM im_sync_progress WHERE center_epoch=?').get(state.center_epoch);
  const receiver = db.prepare('SELECT * FROM im_receive_state').get();
  assert.equal(progress.center_epoch, state.center_epoch); assert.equal(progress.stream_epoch, receiver.stream_epoch);
  assert.equal(progress.handled_through, 1);
  if (kind === 'v3_import') {
    const prep = db.prepare('SELECT * FROM im_schema_preparations WHERE preparation_ref=?').get(run.preparation_ref);
    assert.equal(prep.kind, kind); assert.equal(prep.initial_epoch, state.center_epoch);
    assert.equal(prep.source_version, 3); assert.notEqual(prep.import_epoch, prep.initial_epoch);
    assert.equal(epoch.origin, 'v3_import');
  } else {
    assert.equal(run.preparation_ref, null); assert.notEqual(run.old_epoch, run.new_epoch);
    assert.ok(run.backup_id && run.backup_file_hash && run.manifest_hash && run.candidate_base_hash);
    assert.equal(epoch.origin, 'recovery'); assert.ok(epoch.recovery_counter > 0);
    assert.equal(db.prepare('SELECT count(*) n FROM im_sync_progress WHERE center_epoch=?').get(run.old_epoch).n, 1,
      'snapshot recovery retains historical receiver progress alongside the new epoch');
  }
  return { ...f, db, policy, state, run };
}

export function journalFixture(t) {
  const f = location(t), writer = f.open();
  writer.exec('PRAGMA journal_mode=DELETE');
  const journal = createImV2Journal({ db: writer, clock: () => 1000 });
  const partition = journal.bindIdentity(identity());
  journal.recordMessage(partition, { streamEpoch: U(9), seq: 1, message: message(1), receipt: null });
  assert.equal(writer.prepare('SELECT version FROM im_v2_client_meta').get().version, 2);
  writer.close();
  const db = f.open();
  assert.equal(db.prepare('SELECT count(*) n FROM im_v2_client_received').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) n FROM im_v2_client_partitions').get().n, 1);
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_schema WHERE type='table' AND name='im_schema'").get().n, 0);
  fs.chmodSync(f.databasePath, 0o600);
  return { ...f, db };
}
