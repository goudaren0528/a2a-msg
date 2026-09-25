import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { createTrustedBackupServices } from '../../../src/im/backup-registry.js';
import { addMessage } from '../im-v2-schema/helpers.js';
import { authority, context } from './helpers.js';

export async function legacyPublished(t, f, { wal = false } = {}) {
  const oldRoot = join(f.root, 'old');
  mkdirSync(oldRoot, { mode: 0o700 }); mkdirSync(join(oldRoot, 'artifacts'), { mode: 0o700 });
  const source = join(f.root, 'old-source.sqlite');
  await backup(f.db, source); chmodSync(source, 0o600);
  const db = new DatabaseSync(source); t.after(() => db.close());
  db.exec('PRAGMA foreign_keys=ON');
  let committedMessage;
  if (wal) {
    assert.equal(db.prepare('PRAGMA journal_mode=WAL').get().journal_mode, 'wal');
    db.exec('PRAGMA wal_autocheckpoint=0; BEGIN IMMEDIATE');
    committedMessage = addMessage({ ...f, db, messages: [...f.messages] }, { text: 'committed only after WAL enabled', ack: false });
    db.exec('COMMIT');
    assert.ok(lstatSync(`${source}-wal`).size > 0, 'genuine committed source WAL must exist at publication');
  }
  const oldAuthority = { ...authority, publicationActors: () => ({ executorActorId: 'test-executor', backupApproverId: 'test-approver' }) };
  const old = createTrustedBackupServices({ db, dir: oldRoot, authority: oldAuthority });
  const output = await old.publisher.publish({ approvalId: 'test-approved', adminContext: context });
  return { old, oldRoot, oldAuthority, source, db, output, committedMessage,
    artifact: join(oldRoot, output.artifactReference) };
}
