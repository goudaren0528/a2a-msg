import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { legacy, policy, snapshot } from '../im-v2-schema/helpers.js';
import { authority, approvalAuthority, context } from '../im-v2-backup/helpers.js';
import { legacyPublished } from '../im-v2-backup/legacy-published.js';
import { createCoreFixture } from '../im-v2-core/helpers.js';
import { rowsDigest, header, assertChain } from '../im-v2-recovery-normalization/helpers.js';
import { createImJournal } from '../../../src/im/journal.js';
import { createImV2Auth } from '../../../src/im/v2/auth.js';
import { createImV2Acl } from '../../../src/im/v2/acl.js';
import { createImV2Messages } from '../../../src/im/v2/messages.js';
import { createImV2Delivery } from '../../../src/im/v2/delivery.js';
import { createTrustedImV2BackupServices, createImV2BackupRegistry } from '../../../src/im/v2/backup-registry.js';
import { createBackupRegistry } from '../../../src/im/backup-registry.js';
import { createClosedV3Source, createImV2RecoveryServices } from '../../../src/im/v2/recovery.js';
export { context, authority, policy, snapshot, rowsDigest, header, assertChain };
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const json = path => JSON.parse(fs.readFileSync(path, 'utf8'));
export const hashFile = path => sha(fs.readFileSync(path));
export function query(path, callback) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return callback(db); } finally { db.close(); }
}
export function tree(root) {
  if (!fs.existsSync(root)) return {};
  const result = {};
  for (const name of fs.readdirSync(root, { recursive: true }).sort()) {
    const path = join(root, name), st = fs.lstatSync(path);
    result[name] = st.isDirectory() ? { directory: true, mode: st.mode } : {
      hash: st.isSymbolicLink() ? sha(fs.readlinkSync(path)) : hashFile(path), size: st.size,
      ino: st.ino, mode: st.mode, nlink: st.nlink, mtimeMs: st.mtimeMs, symlink: st.isSymbolicLink(),
    };
  }
  return result;
}
export function retainFiles(before, after, label) {
  for (const [name, fact] of Object.entries(before)) assert.deepEqual(after[name], fact, `${label}/${name} retained`);
}
const mkdir = path => { fs.mkdirSync(path, { mode: 0o700 }); return path; };
const write = (path, value) => fs.writeFileSync(path, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
function oldJournal(path) {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
    const a = randomUUID(), b = randomUUID(), conversationId = randomUUID(), clientMessageId = randomUUID(), messageId = randomUUID();
    const journal = createImJournal({ db, centerId: 'https://p5d.invalid', agentId: a });
    journal.stageOutgoing({ protocol: 'a2a-msg.im.v1', conversationId, recipientAgentId: b, clientMessageId, text: 'test-only retained outgoing' });
    journal.markAccepted(clientMessageId, { messageId, acceptedAt: 100 });
    journal.recordReceived({ streamEpoch: randomUUID(), seq: 1, message: { messageId: randomUUID(), conversationId,
      senderAgentId: b, recipientAgentId: a, clientMessageId: randomUUID(), title: null, text: 'test-only pending ACK',
      inReplyTo: null, correlation: null, acceptedAt: 101, attachment: null } });
    assert.equal(journal.listPendingAcks().length, 1);
    return rowsDigest(db);
  } finally { db.close(); fs.chmodSync(path, 0o600); }
}
function business(db) {
  return Object.fromEntries(['im_messages', 'im_send_keys', 'im_deliveries', 'im_credentials', 'im_attachments',
    'im_receive_state', 'im_contacts'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
      .map(row => JSON.stringify(row, (_, value) => value instanceof Uint8Array ? [...value] : value))]));
}
export async function setup(scenario) {
  const root = fs.mkdtempSync(join(process.env.P5D_CASE_ROOT ?? tmpdir(), `p5d-${scenario.id}-`));
  fs.chmodSync(root, 0o700);
  const cleanup = [], lifecycle = { after: fn => cleanup.push(fn) };
  const d = { version: 1, caseId: scenario.id, root, workspace: mkdir(join(root, 'workspace')),
    registryRoot: mkdir(join(root, 'new')), route: scenario.route, now: Date.now() + 60000,
    source: join(root, 'source.sqlite'), scenario };
  const journal = join(root, 'legacy-journal.sqlite'), journalFacts = oldJournal(journal);
  let sourceDb, old, services, core, post, beforeBackup, sourceBusiness, sourceRows;
  try {
    if (scenario.route === 'snapshot') {
      core = createCoreFixture(lifecycle);
      await backup(core.native, d.source); fs.chmodSync(d.source, 0o600);
      sourceDb = new DatabaseSync(d.source); cleanup.push(() => sourceDb.close());
      sourceDb.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
      const clock = () => d.now - 1000;
      const auth = createImV2Auth({ db: sourceDb, policy: core.policy, clock });
      const acl = createImV2Acl({ db: sourceDb, auth, clock });
      const composition = { db: sourceDb, auth, acl, policy: core.policy, clock };
      const messages = createImV2Messages(composition), delivery = createImV2Delivery(composition);
      const a = auth.authenticate(core.credentials[0]), b = auth.authenticate(core.credentials[1]);
      const request = () => ({ originEpoch: core.centerEpoch, clientMessageId: randomUUID(), conversationId: core.conversationId,
        recipientAgentId: core.b, text: 'P5-D isolated source business' });
      messages.send(a, core.scope, request());
      beforeBackup = business(sourceDb);
      // Native-v4 publication always produces DELETE. A's producer remains DELETE too.
      services = createTrustedImV2BackupServices({ root: d.registryRoot, db: sourceDb, authority, approvalAuthority, clock: () => d.now });
      if (scenario.operation !== 'publish') {
        const published = await services.publisher.publish({ approvalRef: 'test-approved' }, context);
        await services.publisher.drain(); d.backupId = published.record.backupId;
      }
      if (scenario.id === 'F4') {
        sourceDb.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
        post = request(); const accepted = messages.send(a, core.scope, post);
        const lease = delivery.acquire(b, core.scope, { instanceId: randomUUID(), requestId: randomUUID() });
        const streamEpoch = sourceDb.prepare('SELECT stream_epoch FROM im_receive_state WHERE agent_id=?').get(core.b).stream_epoch;
        delivery.ack(b, core.scope, { instanceId: lease.instanceId, generation: lease.generation, streamEpoch,
          items: sourceDb.prepare('SELECT seq,message_id FROM im_deliveries WHERE recipient_id=?').all(core.b)
            .map(row => ({ seq: row.seq, messageId: row.message_id })) });
        messages.markRead(b, core.scope, { messageId: accepted.message.messageId });
        // Trusted source credential provisioning, committed in actual source WAL.
        sourceDb.exec('BEGIN IMMEDIATE');
        sourceDb.prepare('UPDATE im_credentials SET secret_hash=? WHERE agent_id=?').run(sha(randomBytes(32)), core.outsider);
        sourceDb.exec('COMMIT');
        assert.ok(fs.statSync(d.source + '-wal').size > 32);
        assert.notDeepEqual(business(sourceDb), beforeBackup);
      }
    } else if (scenario.route.includes('v3')) {
      const seed = legacy(lifecycle, { messages: 2, attachment: true, acks: [true, false], leases: true });
      if (scenario.enabled || scenario.route === 'registered-v3') seed.db.exec("UPDATE im_settings SET write_mode='enabled'");
      if (scenario.route === 'registered-v3') {
        old = await legacyPublished(lifecycle, { ...seed, root }, { wal: scenario.wal ?? true });
        d.oldRoot = old.oldRoot; d.oldBackupId = old.output.backupId; d.source = old.source; sourceDb = old.db;
        services = createTrustedImV2BackupServices({ root: d.registryRoot, db: seed.db, authority, approvalAuthority, clock: () => d.now });
        if (scenario.operation !== 'publish') d.backupId = services.publisher.importRegisteredV3({ sourceRegistry: old.old.registry, backupId: old.output.backupId }, context).record.backupId;
      } else {
        const live = join(root, 'closed-source-origin.sqlite');
        await backup(seed.db, live); fs.chmodSync(live, 0o600);
        sourceDb = new DatabaseSync(live); cleanup.push(() => sourceDb.close());
        sourceDb.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
        if (scenario.wal) {
          sourceDb.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; BEGIN IMMEDIATE');
          sourceDb.exec("UPDATE im_agents SET display_name=display_name || ' committed WAL'"); sourceDb.exec('COMMIT');
          assert.ok(fs.statSync(live + '-wal').size > 32);
        }
        await backup(sourceDb, d.source); fs.chmodSync(d.source, 0o600);
        assert.deepEqual(header(d.source), scenario.wal ? [2, 2] : [1, 1]);
      }
    }
    d.stageInput = { requestRef: `p5d-${scenario.id}`, candidateKind: d.route === 'fresh' ? 'fresh_bootstrap' : d.route.includes('v3') ? 'v3_import' : 'snapshot_recovery',
      sourceRef: d.route === 'fresh' ? null : 'source', isolationAckRef: d.route === 'fresh' ? null : 'isolated' };
    d.journal = journal;
    const descriptor = join(root, 'descriptor.json'); write(descriptor, d);
    sourceBusiness = sourceDb ? business(sourceDb) : null;
    sourceRows = sourceDb ? rowsDigest(sourceDb) : null;
    const originals = {};
    for (const [name, fact] of Object.entries(tree(root))) {
      if (fact.directory || name === 'descriptor.json' || name.startsWith('workspace/') || name.startsWith('new/')) continue;
      originals[name] = fact;
    }
    const registryOriginal = tree(join(d.registryRoot, 'registry'));
    write(join(root, 'fixture-before.json'), { originals, registryOriginal, sourceRows, journalFacts,
      sourceBusinessHash: sourceBusiness && sha(JSON.stringify(sourceBusiness)), backupBusinessHash: beforeBackup && sha(JSON.stringify(beforeBackup)) });
    return { d, descriptor, root, old, core, post, beforeBackup, sourceBusiness, sourceRows, sourceDb, journalFacts,
      registryOriginal, originals,
      unchanged() {
        retainFiles(originals, tree(root), 'source/old/journal');
        // Holds/releases are intended additions; artifact/manifest/record evidence is immutable.
        retainFiles(registryOriginal, tree(join(d.registryRoot, 'registry')), 'registered originals');
        assert.deepEqual(query(journal, rowsDigest), journalFacts);
        if (sourceDb) { assert.deepEqual(business(sourceDb), sourceBusiness); assert.deepEqual(rowsDigest(sourceDb), sourceRows); }
      },
      async close(success) {
        write(join(root, 'fixture-after.json'), { originals: Object.fromEntries(Object.keys(originals).map(name => [name, tree(root)[name]])),
          registry: tree(join(d.registryRoot, 'registry')), journalFacts: query(journal, rowsDigest),
          sourceRows: sourceDb ? rowsDigest(sourceDb) : null, sourceBusinessHash: sourceDb ? sha(JSON.stringify(business(sourceDb))) : null });
        // Native close may checkpoint a live source WAL. Retain exact pre-close
        // evidence independently, especially after a failing assertion.
        const preserved = mkdir(join(root, 'source-evidence-before-close'));
        for (const name of Object.keys(originals)) {
          const destination = join(preserved, name); fs.mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
          fs.copyFileSync(join(root, name), destination, fs.constants.COPYFILE_EXCL);
        }
        for (const fn of cleanup.reverse()) await fn();
        // Evidence retention is deliberate even on success; the external supervisor owns it.
        write(join(root, 'lifecycle.json'), { success, retained: true });
      },
    };
  } catch (error) {
    for (const fn of cleanup.reverse()) { try { await fn(); } catch { /* retain setup evidence */ } }
    throw Object.assign(error, { evidenceRoot: root });
  }
}

// Called only with the parent-owned descriptor path, never with public-operation paths.
export function open(d, { noClock = false, advance = 0 } = {}) {
  let clocks = 0;
  const clock = () => { clocks++; assert.equal(noClock, false, 'completed retry must not sample clock'); return d.now + advance; };
  const approvals = [];
  const approval = { authorizeApproval: (input, ctx) => {
    approvals.push(input); return ctx === context && (input.kind === 'activate'
      ? ['activate-ok', 'activate-ok-after-anchor'].includes(input.approvalRef)
      : ({ prepare: 'prepare-ok', 'release-hold': 'release-ok' })[input.kind] === input.approvalRef);
  } };
  const evidenceAuthority = {
    assertSourceIsolation: (sourceRef, isolationAckRef, ctx) => ctx === context && sourceRef === 'source' && isolationAckRef === 'isolated',
    getSourceClosedEvidence: binding => ({ version: 1, evidenceRef: 'test-only-closure', ...binding, issuedAt: d.now }),
    authorizeSourceClosedEvidence: (proof, ctx) => ctx === context && proof.evidenceRef === 'test-only-closure',
    assertAuthReview: (input, ctx) => ctx === context && input.authReviewRef === 'review',
  };
  const sourceCatalog = {};
  let registry;
  if (d.route === 'closed-v3') sourceCatalog.source = { kind: 'closed-v3', source: createClosedV3Source({ path: d.source, sourceRef: 'source', evidenceAuthority }) };
  else if (d.route !== 'fresh') {
    registry = createImV2BackupRegistry({ root: d.registryRoot, authority, clock });
    sourceCatalog.source = { kind: 'registered-backup', registry, backupId: d.backupId };
  }
  return { api: createImV2RecoveryServices({ root: d.workspace, sourceCatalog, policy: policy(), clock, authority,
    approvalAuthority: approval, evidenceAuthority }), registry, approvals, clocks: () => clocks };
}
export function locate(d) {
  const requests = join(d.workspace, 'requests');
  if (!fs.existsSync(requests)) return null;
  const files = fs.readdirSync(requests).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
  assert.ok(files.length <= 1); return files.length ? json(join(requests, files[0])) : null;
}
export function saved(d) {
  const locator = locate(d); if (!locator) return {};
  const dir = join(d.workspace, 'runs', locator.runId), records = {};
  if (fs.existsSync(dir)) for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.json')) records[name] = json(join(dir, name));
  }
  const prepareName = Object.keys(records).find(name => /^prepare-[a-f0-9]{64}\.json$/.test(name));
  const activationName = Object.keys(records).find(name => /^activation-[a-f0-9]{64}\.json$/.test(name));
  const sealDir = join(dir, 'seals');
  const sealName = fs.existsSync(sealDir) ? fs.readdirSync(sealDir).filter(name => name.endsWith('.json')).sort().at(-1) : null;
  return { locator, dir, path: join(dir, 'candidate.sqlite'), records, prepareName, activationName,
    preparePlanHash: prepareName?.slice(8, -5), activationPlanHash: activationName?.slice(11, -5),
    sealReference: sealName ? `runs/${locator.runId}/seals/${sealName}` : null };
}
export function inputFor(d, operation) {
  if (operation === 'stage') return d.stageInput;
  const s = saved(d), runId = s.locator.runId;
  if (operation === 'preview' || operation === 'status') return { runId };
  if (operation === 'prepare') return { runId, preparePlanHash: s.preparePlanHash, approvalRef: 'prepare-ok' };
  if (operation === 'verify') return { runId, preparePlanHash: s.preparePlanHash };
  if (operation === 'activation-preview') return { runId, sealReference: s.sealReference, authReviewRef: 'review',
    isolationAckRef: d.stageInput.isolationAckRef, activationRef: 'activation' };
  if (operation === 'activate') return { runId, activationPlanHash: s.activationPlanHash, activationApprovalRef: 'activate-ok',
    sealReference: `runs/${runId}/seals/${s.records[s.activationName].sealHash}.json` };
  if (operation === 'release') {
    const completion = s.records['activation-complete.json'], hold = s.records['hold.json'];
    const releasePlan = { version: 1, runId, holdId: hold.holdId, backupId: hold.backupId, stageHash: hold.stageHash,
      preparePlanHash: s.preparePlanHash, activationCompletionHash: sha(JSON.stringify(completion)), terminalState: 'active',
      candidateReference: s.locator.stage.candidateReference, newEpoch: completion.newEpoch };
    return { runId, holdId: hold.holdId, releasePlanHash: sha(JSON.stringify(releasePlan)), approvalRef: 'release-ok' };
  }
  throw Error(`unknown operation ${operation}`);
}
export const methods = Object.freeze({ stage: 'stageCandidate', preview: 'previewRecovery', prepare: 'prepareRecovery',
  verify: 'verifyRecovery', 'activation-preview': 'previewActivation', activate: 'activateRecovery', release: 'releaseRecoveryHold', status: 'getRecoveryStatus' });
export async function publish(d) {
  const db = new DatabaseSync(d.source, { readOnly: true });
  const services = createTrustedImV2BackupServices({ root: d.registryRoot, db, authority, approvalAuthority, clock: () => d.now });
  try {
    if (d.route === 'registered-v3') {
      const sourceRegistry = createBackupRegistry({ dir: d.oldRoot, authority });
      return services.publisher.importRegisteredV3({ sourceRegistry, backupId: d.oldBackupId }, context);
    }
    return await services.publisher.publish({ approvalRef: 'test-approved' }, context);
  } finally { await services.publisher.drain(); db.close(); }
}
export function candidateBusiness(path) { return query(path, business); }
export function semanticUnknown(f, candidate) {
  // Semantic reads anchor clocks. This disposable copy is never terminal authority.
  const path = join(f.root, 'disposable-semantic-read.sqlite');
  fs.copyFileSync(candidate, path, fs.constants.COPYFILE_EXCL); fs.chmodSync(path, 0o600);
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
    const clock = () => f.d.now + 1000, policy = f.core.policy;
    const auth = createImV2Auth({ db, policy, clock }), acl = createImV2Acl({ db, auth, clock });
    const messages = createImV2Messages({ db, auth, acl, policy, clock });
    const principal = auth.authenticate(f.core.credentials[0]);
    const centerEpoch = db.prepare('SELECT center_epoch FROM im_center_state').get().center_epoch;
    let posts = 0;
    const transport = { get: () => messages.getSendResult(principal, { protocol: 'a2a-msg.im.v2', centerEpoch },
      { originEpoch: f.post.originEpoch, clientMessageId: f.post.clientMessageId }), post: () => { posts++; assert.fail('old absent operation must not POST'); } };
    assert.throws(transport.get, { code: 'SEND_OUTCOME_UNKNOWN' }); assert.equal(posts, 0);
    return { code: 'SEND_OUTCOME_UNKNOWN', posts, disposable: true };
  } finally { db.close(); }
}
