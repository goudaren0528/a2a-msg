import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { legacy, importOptions } from '../im-v2-schema/helpers.js';
import { migrateImSchemaV4 } from '../../../src/im/v2/migration.js';

export const unsupported = process.platform === 'win32';
export const context = Object.freeze({ actor: 'test-executor' });
export const authority = Object.freeze({ authorizeAdmin: ctx => ctx === context,
  publicationActors: () => ({ executorActorId: 'test-executor', approverActorId: 'test-approver', }) });
export const approvalAuthority = Object.freeze({ authorizeBackup: (input, ctx) => ctx === context && input.approvalRef === 'test-approved' });
export function fixture(t, { v3 = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'im-v2-backup-'));
  const registryRoot = join(root, 'new'); mkdirSync(registryRoot, { mode: 0o700 });
  const f = legacy(t, { messages: 2, attachment: true, acks: [true, false], leases: true });
  if (!v3) migrateImSchemaV4(f.db, importOptions());
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { ...f, root, registryRoot, options: { root: registryRoot, db: f.db, authority, approvalAuthority } };
}
