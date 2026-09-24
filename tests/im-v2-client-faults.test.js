import test from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, native, cert, attachment, acquireArgs, bounded, lockHeld,
  inspectJournal, journalRows } from './fixtures/im-v2-client-process/harness.js';

test('CA-trusted wrong hostname fails real default HTTPS before any HTTP/credential disclosure', native, async t => {
  const f = await fixture(t), certificate = new X509Certificate(cert);
  assert.equal(certificate.checkHost('localhost'), 'localhost');
  assert.equal(certificate.checkIP('127.0.0.1'), '127.0.0.1');
  assert.equal(certificate.checkHost('wrong-name.test'), undefined);
  // Positive control establishes this exact CA/cert is trusted by the same
  // default client HTTPS path. Negative differs only in independently named DNS.
  const positive = await f.start(f.provision(), { operation: 'connect' });
  await positive.next('result'); await positive.finish();
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].path, '/api/v2/me');
  const before = f.inspect(db => ({ messages: db.prepare('SELECT * FROM im_messages').all(),
    audit: db.prepare('SELECT * FROM im_audit').all() }));
  const tlsError = new Promise(resolve => f.server.once('tlsClientError', error => resolve(error.code)));
  const storage = f.provision();
  const child = await f.start(storage, { operation: 'hostname',
    serverUrl: `https://wrong-name.test:${f.server.address().port}` });
  assert.equal((await child.next('result')).refused, true); await child.finish();
  assert.ok(await bounded(tlsError, 'hostname TLS failure'));
  assert.equal(f.requests.length, 1, 'no HTTP request means no Authorization header delivered to server business handler');
  assert.deepEqual(f.inspect(db => ({ messages: db.prepare('SELECT * FROM im_messages').all(),
    audit: db.prepare('SELECT * FROM im_audit').all() })), before);
  assert.equal(inspectJournal(storage, db => db.prepare('SELECT count(*) n FROM im_v2_client_partitions').get().n), 0);
  t.diagnostic(`SAN=${certificate.subjectAltName}; localhost positive control succeeds; wrong-name.test reaches loopback TLS but no HTTP handler`);
});

for (const fault of ['both-before', 'close-before', 'rollback-after']) test(`native owner uncertain release ${fault}: rejected close, data retained, explicit cleanup policy`, native, async t => {
  const f = await fixture(t), storage = f.provision();
  // Persist a real received file/fact/batch first; uncertainty must preserve
  // substantive journal evidence, not merely an empty schema.
  f.directSend({ attachment: attachment() });
  const x = f.client(storage); await x.c.acquire(acquireArgs()); await x.c.receiveOnce(); await x.c.close(); x.db.close();
  const before = inspectJournal(storage, journalRows);
  const fact = before.im_v2_client_received[0], receipt = JSON.parse(fact.attachment_receipt_json);
  const file = join(storage.files, receipt.relativeName), bytes = readFileSync(file);
  const child = await f.start(storage, { operation: 'release-fault', fault });
  const phase = await child.next('phase'); assert.equal(phase.phase, 'uncertain-release');
  assert.deepEqual(phase.evidence.hits, ['sidecar-rollback', 'sidecar-close']);
  assert.equal(phase.evidence.dataIntact, true); assert.equal(phase.evidence.memoizedRejectedClose, true);
  assert.equal(phase.evidence.sideOpen, fault !== 'rollback-after');
  assert.equal(phase.evidence.sideTransaction, fault === 'both-before');
  if (fault === 'both-before') lockHeld(storage);
  else {
    const side = new DatabaseSync(`${storage.path}.owner.sqlite`, { timeout: 0 });
    try { side.exec('BEGIN IMMEDIATE'); side.exec('ROLLBACK'); } finally { side.close(); }
  }
  assert.deepEqual(inspectJournal(storage, journalRows), before); assert.deepEqual(readFileSync(file), bytes);
  await child.go(phase);
  const clean = await child.next('phase'); assert.equal(clean.phase, 'fault-restored-cleanup');
  assert.equal(clean.evidence.sideOpen, false); assert.equal(clean.evidence.dataIntact, true);
  assert.equal(clean.evidence.residualReservation, fault !== 'rollback-after');
  assert.deepEqual(inspectJournal(storage, journalRows), before);
  await child.go(clean); await child.finish();
  // The memoized rejected promise is never relabelled clean. A NEW process can
  // acquire after actual child exit/close; same-process residual owner maps are
  // intentionally not bypassed or cleared by the test.
  const fresh = await f.start(storage, { operation: 'connect' }); await fresh.next('result'); await fresh.finish();
  assert.deepEqual(inspectJournal(storage, journalRows), before); assert.deepEqual(readFileSync(file), bytes);
  t.diagnostic(`${fault}: native sidecar release hit, close remains rejected; residual reservation=${clean.evidence.residualReservation}; explicit sidecar cleanup then process exit permits fresh owner`);
});

test('successful close during real in-flight file save waits before native owner release', native, async t => {
  const f = await fixture(t), storage = f.provision(); f.directSend({ attachment: attachment() });
  const child = await f.start(storage, { operation: 'close-file', acquire: acquireArgs() }); await child.next('leased');
  const waiting = await child.next('file-close-wait'); assert.equal(waiting.closed, false);
  lockHeld(storage); assert.equal(f.count('/acks'), 0);
  assert.equal(inspectJournal(storage, db => db.prepare('SELECT count(*) n FROM im_v2_client_received').get().n), 0);
  assert.ok(readFileSync(join(storage.files, waiting.receipt.relativeName)).length);
  await child.send({ type: 'release-file' }); assert.equal((await child.next('result')).closed, true); await child.finish();
  const fresh = await f.start(storage, { operation: 'connect' }); await fresh.next('result'); await fresh.finish();
  assert.equal(f.count('/acks'), 0);
});
