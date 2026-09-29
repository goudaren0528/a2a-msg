import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { createServer, get } from 'node:https';
import { integer, time } from '../scripts/im-lan-cert.mjs';

const script = resolve('scripts/im-lan-cert.mjs');
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

test('DER INTEGER uses minimal positive encoding at sign and zero boundaries', () => {
  for (const [input, expected] of [
    ['01', '020101'], // small positive value
    ['7f', '02017f'], // last one-byte positive value
    ['80', '02020080'], // high bit requires a sign-protection 00
    ['0080', '02020080'], // existing leading zero must not be duplicated
    ['000001', '020101'], // redundant leading zeros removed
    ['00', '020100'], // zero is one content octet
    ['ff', '020200ff'],
  ]) {
    assert.equal(integer(Buffer.from(input, 'hex')).toString('hex'), expected, input);
  }
});

test('RFC 5280 UTCTime/GeneralizedTime encoding at the 2050 boundary', () => {
  for (const [date, tag, value] of [
    ['2049-12-31T23:59:59.000Z', 0x17, '491231235959Z'],
    ['2050-01-01T00:00:00.000Z', 0x18, '20500101000000Z'],
    ['2026-09-29T01:02:03.999Z', 0x17, '260929010203Z'],
  ]) {
    const encoded = time(new Date(date));
    assert.equal(encoded[0], tag, date);
    assert.equal(encoded[1], value.length, date);
    assert.equal(encoded.subarray(2).toString('ascii'), value, date);
  }
});

function assertValidity(cert, days = 90) {
  const now = Date.now();
  assert.ok(cert.validFromDate instanceof Date);
  assert.ok(cert.validToDate instanceof Date);
  assert.ok(Number.isFinite(cert.validFromDate.getTime()));
  assert.ok(Number.isFinite(cert.validToDate.getTime()));
  assert.ok(cert.validFromDate.getTime() <= now);
  assert.ok(cert.validToDate.getTime() >= now);
  assert.ok(Math.abs(cert.validToDate.getTime() - now - days * 86_400_000) < 60_000);
}

test('--help succeeds', () => {
  const result = run('--help');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--out.*--host/);
});

test('missing and invalid hosts are rejected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'im-lan-test-'));
  try {
    for (const hosts of [[], ['0.0.0.0'], ['bad\nname'], [''], ['bad..example']]) {
      const result = run('--out', join(dir, 'certs'), ...hosts.flatMap(host => ['--host', host]));
      assert.notEqual(result.status, 0, `Accepted ${JSON.stringify(hosts)}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('existing nonempty output directory is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'im-lan-test-'));
  try {
    writeFileSync(join(dir, 'keep'), 'unchanged');
    const result = run('--out', dir, '--host', 'localhost');
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(join(dir, 'keep'), 'utf8'), 'unchanged');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('issued certificates verify with IP and DNS SANs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'im-lan-test-'));
  try {
    const out = join(dir, 'certs');
    const stdout = execFileSync(process.execPath, [script, '--out', out,
      '--host', '192.168.11.40', '--host', 'localhost'], { encoding: 'utf8' });
    const ca = new X509Certificate(readFileSync(join(out, 'ca-cert.pem')));
    const server = new X509Certificate(readFileSync(join(out, 'server-cert.pem')));
    assertValidity(ca);
    assertValidity(server);
    assert.equal(server.checkIP('192.168.11.40'), '192.168.11.40');
    assert.equal(server.checkHost('localhost'), 'localhost');
    assert.equal(server.verify(ca.publicKey), true);
    assert.equal(ca.ca, true);
    assert.equal(server.ca, false);
    assert.match(server.subjectAltName, /IP Address:192\.168\.11\.40/);
    assert.match(server.subjectAltName, /DNS:localhost/);
    assert.doesNotMatch(stdout, /-----BEGIN (?:EC |RSA |)PRIVATE KEY-----/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('generated key/cert and CA complete a real HTTPS handshake', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'im-lan-test-'));
  let server;
  try {
    const out = join(dir, 'certs');
    execFileSync(process.execPath, [script, '--out', out, '--host', '127.0.0.1', '--days', '7']);
    const key = readFileSync(join(out, 'server-key.pem'));
    const cert = readFileSync(join(out, 'server-cert.pem'));
    const ca = readFileSync(join(out, 'ca-cert.pem'));
    assertValidity(new X509Certificate(cert), 7);
    assertValidity(new X509Certificate(ca), 7);
    server = createServer({ key, cert }, (_request, response) => response.end('TLS_OK'));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const body = await new Promise((resolve, reject) => {
      get(`https://127.0.0.1:${server.address().port}/`, { ca, agent: false }, response => {
        let data = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { data += chunk; });
        response.on('end', () => resolve(data));
        response.on('error', reject);
      }).on('error', reject);
    });
    assert.equal(body, 'TLS_OK');
  } finally {
    if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('30 independently issued CA/server pairs all parse and verify', () => {
  const dir = mkdtempSync(join(tmpdir(), 'im-lan-test-'));
  try {
    for (let i = 0; i < 30; i++) {
      const out = join(dir, `certs-${i}`);
      const result = run('--out', out, '--host', '192.168.11.40', '--host', 'localhost');
      assert.equal(result.status, 0, `iteration ${i}: ${result.stderr}`);
      const ca = new X509Certificate(readFileSync(join(out, 'ca-cert.pem')));
      const server = new X509Certificate(readFileSync(join(out, 'server-cert.pem')));
      assertValidity(ca);
      assertValidity(server);
      assert.equal(ca.verify(ca.publicKey), true, `iteration ${i} CA`);
      assert.equal(server.verify(ca.publicKey), true, `iteration ${i} server`);
      assert.equal(ca.ca, true, `iteration ${i} CA basicConstraints`);
      assert.equal(server.ca, false, `iteration ${i} server basicConstraints`);
      assert.equal(server.checkIP('192.168.11.40'), '192.168.11.40', `iteration ${i} IP`);
      assert.equal(server.checkHost('localhost'), 'localhost', `iteration ${i} DNS`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
