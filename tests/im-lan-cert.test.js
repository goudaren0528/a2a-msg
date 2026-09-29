import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { createServer, get } from 'node:https';
import { bitString, integer, time, runGenerator, verifyTlsHandshake } from '../scripts/im-lan-cert.mjs';

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

test('adversarial full-length serials encode as minimal positive INTEGERs', () => {
  for (const [value, expected] of [
    ['0001' + '00'.repeat(14), '020f01' + '00'.repeat(14)],
    ['000001' + '00'.repeat(13), '020e01' + '00'.repeat(13)],
    ['80' + '00'.repeat(15), '02110080' + '00'.repeat(15)],
    ['7f' + '00'.repeat(15), '02107f' + '00'.repeat(15)],
    ['00'.repeat(16), '020100'],
    ['01', '020101'], // minimum serial length
    ['ff'.repeat(16), '021100' + 'ff'.repeat(16)], // maximum serial length including sign byte
  ]) {
    assert.equal(integer(Buffer.from(value, 'hex')).toString('hex'), expected, value);
  }
});

test('BIT STRING always prefixes unused-bit count and rejects nonzero padding', () => {
  assert.equal(bitString(0, Buffer.from('308180', 'hex')).toString('hex'), '030400308180');
  assert.equal(bitString(1, Buffer.from('06', 'hex')).toString('hex'), '03020106');
  assert.equal(bitString(7, Buffer.from('80', 'hex')).toString('hex'), '03020780');
  assert.throws(() => bitString(1, Buffer.from('07', 'hex')), /padding/);
  assert.throws(() => bitString(7, Buffer.from('81', 'hex')), /padding/);
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

test('happy path writes exactly four files after its TLS self-check', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'im-lan-test-'));
  try {
    const out = join(dir, 'certs');
    let checks = 0;
    await runGenerator({ out, days: 7, hosts: ['127.0.0.1'] }, {
      handshake: async (pair, host) => {
        assert.equal(existsSync(out), false, 'no files before handshake');
        await verifyTlsHandshake(pair, host);
        checks++;
      }
    });
    assert.equal(checks, 1);
    assert.deepEqual(readdirSync(out).sort(), ['ca-cert.pem', 'ca-key.pem', 'server-cert.pem', 'server-key.pem']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('three failed self-checks write no files and preserve the last error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'im-lan-test-'));
  try {
    const out = join(dir, 'certs');
    let checks = 0;
    await assert.rejects(runGenerator({ out, days: 7, hosts: ['localhost'] }, {
      handshake: async () => {
        assert.equal(existsSync(out), false);
        throw new Error(`probe failure ${++checks}`);
      }
    }), /probe failure 3/);
    assert.equal(checks, 3);
    assert.equal(existsSync(out), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('retry note with underlying error goes to stderr, never stdout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'im-lan-test-'));
  const stderr = [];
  const stdout = [];
  const originalLog = console.log;
  try {
    console.log = (...args) => stdout.push(args.join(' '));
    let attempts = 0;
    await runGenerator({ out: join(dir, 'certs'), days: 7, hosts: ['localhost'] }, {
      stderr: { write: message => stderr.push(message) },
      handshake: async (pair, host) => {
        attempts++;
        if (attempts === 1) throw new Error('injected rare failure');
        await verifyTlsHandshake(pair, host);
      }
    });
    assert.equal(attempts, 2);
    assert.match(stderr.join(''), /Attempt 1 failed: injected rare failure/);
    assert.match(stderr.join(''), /passed verification and TLS handshake on attempt 2/);
    assert.doesNotMatch(stdout.join('\n'), /Attempt 1|injected rare failure/);
  } finally { console.log = originalLog; rmSync(dir, { recursive: true, force: true }); }
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
