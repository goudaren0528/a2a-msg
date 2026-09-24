import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrustedMigrationServices } from '../src/im/migration-services.js';

test('production composition rejects all override switches before registry construction', () => {
  for (const key of ['platform', 'writer', 'resolver', 'provenanceResolver', 'backup', 'timeGuard', 'fault', 'probe', 'sourceId'])
    assert.throws(() => createTrustedMigrationServices({ [key]: {} }), { code: 'MIGRATION_INVALID' }, key);
  assert.throws(() => createTrustedMigrationServices({ [Symbol('inject')]: true }), { code: 'MIGRATION_INVALID' });
});
