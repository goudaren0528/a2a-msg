import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { createTrustedImV2BackupServices } from '../../../src/im/v2/backup-registry.js';
import { fixture, context } from '../im-v2-backup/helpers.js';
import { legacyPublished } from '../im-v2-backup/legacy-published.js';
import { processes } from './processes.js';

export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const triple = () => ({ recoveryRunId: randomUUID(), stageHash: 'a'.repeat(64), preparePlanHash: 'b'.repeat(64) });
export function thrown(callback, matches = () => true) {
  let failed = false, failure;
  try { callback(); } catch (error) { failed = true; failure = error; }
  assert.equal(failed, true, 'operation must fail, including when the thrown value is falsy');
  assert.equal(matches(failure), true, `unexpected failure: ${String(failure)}`);
  return failure;
}
export function deeplyFrozen(value) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) {
    // Function capability identity/expiry is checked separately from data freezing.
    if (typeof child !== 'function') deeplyFrozen(child);
  }
}
export function directoryState(root) {
  const entries = [];
  const visit = (path, relative) => {
    for (const name of fs.readdirSync(path).sort()) {
      const next = join(path, name), rel = relative ? `${relative}/${name}` : name;
      const info = fs.lstatSync(next);
      entries.push([rel, info.isDirectory() ? 'directory' : hash(fs.readFileSync(next))]);
      if (info.isDirectory()) visit(next, rel);
    }
  };
  visit(root, '');
  return entries;
}
export function durableJson(path, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  const fd = fs.openSync(path, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const dir = fs.openSync(dirname(path), 'r');
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  assert.deepEqual(fs.readFileSync(path), bytes);
  return hash(bytes);
}
// Test-owned composition only: these are real durable test artifacts, not a
// candidate B writer, production record schema, or evidence of B-core acceptance.
export function stageBeforeEstablish(root, proof, recoveryRunId) {
  const path = join(root, `test-stage-${recoveryRunId}`);
  fs.mkdirSync(path, { mode: 0o700 });
  const parent = fs.openSync(root, 'r');
  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
  const sourceProofHash = durableJson(join(path, 'proof.json'), { record: proof.record, sourceEvidence: proof.sourceEvidence });
  const locatorHash = durableJson(join(path, 'locator.json'), { recoveryRunId, backupId: proof.record.backupId, sourceProofHash });
  const stageHash = durableJson(join(path, 'stage.json'), { recoveryRunId, backupId: proof.record.backupId, sourceProofHash, locatorHash });
  const preparePlanHash = durableJson(join(path, 'plan.json'), { recoveryRunId, stageHash, operation: 'test-only-independent-copy' });
  return { path, input: { recoveryRunId, stageHash, preparePlanHash } };
}
export function durableEvidence(root, result) {
  const holds = join(root, 'registry/holds');
  assert.deepEqual(JSON.parse(fs.readFileSync(join(holds, `${result.hold.holdId}.json`))), result.hold);
  const binding = join(holds, `${result.hold.holdId}.binding.json`);
  if (result.binding) assert.deepEqual(JSON.parse(fs.readFileSync(binding)), result.binding);
  else assert.equal(fs.existsSync(binding), false);
}
export async function setup(t, { v3 = false } = {}) {
  const cleanups = [], lifecycle = { after: callback => cleanups.push(callback) };
  const children = processes();
  t.after(async () => {
    await children.stop(); // Never remove fixtures until every owned child has exited AND closed.
    for (const cleanup of cleanups) await cleanup();
  });
  const f = fixture(lifecycle, { v3 });
  const services = createTrustedImV2BackupServices(f.options);
  let publication;
  if (v3) {
    const old = await legacyPublished(lifecycle, f);
    publication = services.publisher.importRegisteredV3({ sourceRegistry: old.old.registry, backupId: old.output.backupId }, context);
  } else {
    publication = await services.publisher.publish({ approvalRef: 'test-approved' }, context);
    await services.publisher.drain();
  }
  const record = publication.record;
  const artifact = join(f.registryRoot, record.artifactReference);
  const manifest = join(f.registryRoot, 'registry/artifacts', `${record.backupId}.manifest.json`);
  const before = [hash(fs.readFileSync(artifact)), hash(fs.readFileSync(manifest))];
  assert.deepEqual(before, [record.fileHash, record.manifestHash]);
  return { ...f, ...services, ...publication, artifact, manifest, children,
    unchanged() { assert.deepEqual([hash(fs.readFileSync(artifact)), hash(fs.readFileSync(manifest))], before); },
    start(mode, extra = {}) { return children.start({ mode, root: f.registryRoot, backupId: record.backupId,
      target: join(f.root, `${randomUUID()}.sqlite`), ...extra }); },
  };
}
