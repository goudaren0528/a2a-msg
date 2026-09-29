#!/usr/bin/env node
import { generateKeyPairSync, createSign, randomBytes, X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import { isAbsolute, join } from 'node:path';
import { existsSync, lstatSync, readdirSync, mkdirSync, chmodSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const usage = 'Usage: node scripts/im-lan-cert.mjs --out <ABSOLUTE_DIR> --host <ip-or-dns> [--host ...] [--days N]';

function length(n) {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('Invalid DER length');
  if (n < 128) return Buffer.from([n]);
  const bytes = [];
  while (n) { bytes.unshift(n & 255); n = Math.floor(n / 256); }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
function der(tag, ...parts) {
  const value = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), length(value.length), value]);
}
const seq = (...parts) => der(0x30, ...parts);
const oid = (...bytes) => der(0x06, Buffer.from(bytes));
export function integer(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new TypeError('DER INTEGER requires nonempty bytes');
  let first = 0;
  while (first < bytes.length - 1 && bytes[first] === 0) first++;
  const unsigned = bytes.subarray(first);
  return der(0x02, ...(unsigned[0] & 0x80 ? [Buffer.from([0])] : []), unsigned);
}
const bitString = (unused, bytes) => der(0x03, Buffer.from([unused]), bytes);
const sha256Ecdsa = seq(oid(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02));
const cn = (text) => seq(der(0x31, seq(oid(0x55, 0x04, 0x03), der(0x0c, Buffer.from(text, 'utf8')))));
export function time(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new TypeError('Invalid certificate time');
  const year = date.getUTCFullYear();
  if (year < 1950 || year > 9999) throw new RangeError('Certificate time outside RFC 5280 range');
  const two = value => String(value).padStart(2, '0');
  const utc = year < 2050;
  const stamp = `${utc ? two(year % 100) : String(year).padStart(4, '0')}` +
    `${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}` +
    `${two(date.getUTCHours())}${two(date.getUTCMinutes())}${two(date.getUTCSeconds())}Z`;
  return der(utc ? 0x17 : 0x18, Buffer.from(stamp, 'ascii'));
}
function extension(id, value, critical = false) {
  return seq(oid(...id), ...(critical ? [der(0x01, Buffer.from([0xff]))] : []), der(0x04, value));
}
const basicConstraints = [0x55, 0x1d, 0x13];
const keyUsage = [0x55, 0x1d, 0x0f];
const subjectAltName = [0x55, 0x1d, 0x11];
const extendedKeyUsage = [0x55, 0x1d, 0x25];

function ipBytes(host) {
  if (isIP(host) === 4) return Buffer.from(host.split('.').map(Number));
  // Expand :: and optional dotted IPv4 tail to the eight 16-bit IPv6 words.
  let address = host;
  const dotted = address.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const bytes = dotted[1].split('.').map(Number);
    address = address.slice(0, -dotted[1].length) +
      ((bytes[0] << 8) | bytes[1]).toString(16) + ':' +
      ((bytes[2] << 8) | bytes[3]).toString(16);
  }
  const halves = address.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const words = halves.length === 2
    ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
    : left;
  if (words.length !== 8) throw new Error(`Invalid IPv6 address: ${host}`);
  const result = Buffer.alloc(16);
  words.forEach((word, i) => result.writeUInt16BE(parseInt(word, 16), 2 * i));
  return result;
}

function validateHost(host) {
  if (!host || /[\x00-\x20\x7f]/.test(host) || host === '0.0.0.0') throw new Error(`Invalid --host: ${JSON.stringify(host)}`);
  if (isIP(host)) return;
  if (host.length > 253 || !host.includes('.') && host.toLowerCase() !== 'localhost' ||
    !host.split('.').every(label => label.length <= 63 && /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label))) {
    throw new Error(`Invalid --host: ${JSON.stringify(host)}`);
  }
}

function issue({ subject, issuer, publicKey, signingKey, start, end, extensions }) {
  const serial = randomBytes(16);
  serial[15] |= 1; // Ensure the positive serial is never zero.
  const tbs = seq(
    der(0xa0, integer(Buffer.from([0x02]))), integer(serial), sha256Ecdsa,
    issuer, seq(time(start), time(end)), subject,
    publicKey.export({ type: 'spki', format: 'der' }), der(0xa3, seq(...extensions))
  );
  const signer = createSign('SHA256');
  signer.update(tbs);
  signer.end();
  const signature = signer.sign(signingKey); // ECDSA DER signature (the Node default).
  const bytes = seq(tbs, sha256Ecdsa, bitString(0, signature));
  const base64 = bytes.toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n`;
}

function parseArgs(args) {
  let out;
  let days = 90;
  const hosts = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' && args.length === 1) return { help: true };
    if (!['--out', '--host', '--days'].includes(arg) || i + 1 >= args.length || args[i + 1].startsWith('--')) {
      throw new Error(`Invalid argument: ${arg}\n${usage}`);
    }
    const value = args[++i];
    if (arg === '--out') { if (out !== undefined) throw new Error('Duplicate --out'); out = value; }
    if (arg === '--host') { validateHost(value); hosts.push(value); }
    if (arg === '--days') {
      if (!/^[1-9]\d*$/.test(value) || Number(value) > 397) throw new Error('--days must be an integer from 1 to 397');
      days = Number(value);
    }
  }
  if (!out || !isAbsolute(out)) throw new Error('--out must be an absolute directory path');
  if (!hosts.length) throw new Error('At least one --host is required');
  return { out, days, hosts: [...new Set(hosts)] };
}

function main() {
try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage);
  } else {
    const { out, days, hosts } = options;
    if (existsSync(out)) {
      if (!lstatSync(out).isDirectory() || readdirSync(out).length) throw new Error('--out must be nonexistent or an empty directory');
    }
    const caKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const serverKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const caName = cn('IM LAN test CA');
    const serverName = cn(hosts[0]);
    const start = new Date(Date.now() - 5 * 60_000);
    const end = new Date(Date.now() + days * 86_400_000);
    const caPem = issue({ subject: caName, issuer: caName, publicKey: caKeys.publicKey,
      signingKey: caKeys.privateKey, start, end, extensions: [
        extension(basicConstraints, seq(der(0x01, Buffer.from([0xff])), integer(Buffer.from([0]))), true),
        extension(keyUsage, bitString(1, Buffer.from([0x06])), true)
      ] });
    const serverPem = issue({ subject: serverName, issuer: caName, publicKey: serverKeys.publicKey,
      signingKey: caKeys.privateKey, start, end, extensions: [
        extension(basicConstraints, seq(), true), // cA defaults to FALSE in DER.
        extension(keyUsage, bitString(7, Buffer.from([0x80])), true),
        extension(extendedKeyUsage, seq(oid(0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x01))),
        extension(subjectAltName, seq(...hosts.map(host => isIP(host)
          ? der(0x87, ipBytes(host)) : der(0x82, Buffer.from(host, 'ascii')))))
      ] });
    const ca = new X509Certificate(caPem);
    const server = new X509Certificate(serverPem);
    const now = Date.now();
    const validDates = cert => cert.validFromDate instanceof Date &&
      cert.validToDate instanceof Date &&
      Number.isFinite(cert.validFromDate.getTime()) &&
      Number.isFinite(cert.validToDate.getTime()) &&
      cert.validFromDate.getTime() <= now && cert.validToDate.getTime() > now;
    if (!validDates(ca) || !validDates(server) ||
      !ca.ca || server.ca || !ca.verify(ca.publicKey) || !server.verify(ca.publicKey) ||
      !server.checkIssued(ca) ||
      hosts.some(host => isIP(host) ? server.checkIP(host) !== host : !server.checkHost(host))) {
      throw new Error('Generated certificates failed X.509 verification');
    }
    if (!existsSync(out)) mkdirSync(out, { mode: 0o700 });
    if (process.platform !== 'win32') chmodSync(out, 0o700);
    const files = { 'ca-key.pem': caKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      'ca-cert.pem': caPem,
      'server-key.pem': serverKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      'server-cert.pem': serverPem };
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(out, name), content, { mode: name.includes('-key') ? 0o600 : 0o644, flag: 'wx' });
    }
    console.log(`CA certificate to copy to OTHER machine: ${join(out, 'ca-cert.pem')}`);
    console.log(`IM center TLS key: ${join(out, 'server-key.pem')}`);
    console.log(`IM center TLS certificate: ${join(out, 'server-cert.pem')}`);
    console.log(`Verified SAN hosts: ${hosts.join(', ')}`);
    console.log('WARNING: The CA private key (ca-key.pem) must NEVER leave this machine.');
    if (process.platform === 'win32') console.log('Windows: mode bits are not ACLs; restrict access to the keys and directory with Windows ACLs.');
  }
} catch (error) {
  console.error(`Certificate generation failed: ${error.message}`);
  process.exitCode = 1;
}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
