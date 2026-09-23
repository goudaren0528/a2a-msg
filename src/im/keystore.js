import { randomBytes, timingSafeEqual } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, writeFileSync, existsSync, fsyncSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const SECRET = /^[0-9a-f]{64}\n?$/;
const SUPPLIED_SECRET = /^[0-9a-f]{64}$/;
const CREDENTIAL = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/;
const denied = () => { throw new Error('LOCAL_AUTH_UNAVAILABLE'); };
const warning = 'WINDOWS_PERMISSION_UNVERIFIED: filesystem ACLs cannot be verified; operator trust required';

function trusted(path, { trustWindowsPermissions = false, report = console.warn } = {}) {
  if (process.platform === 'win32') {
    if (trustWindowsPermissions !== true) denied();
    report(warning);
  }
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || (process.platform !== 'win32' &&
        ((info.mode & 0o077) || info.uid !== process.geteuid() || info.nlink !== 1))) denied();
    return info;
  } catch { denied(); }
}

export function loadProtectedFile(path, options) {
  const before = trusted(path, options);
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = fstatSync(fd);
    if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino ||
        (process.platform !== 'win32' && ((info.mode & 0o077) || info.uid !== process.geteuid() || info.nlink !== 1)) || info.size > 4096) denied();
    return readFileSync(fd, 'utf8');
  } catch { denied(); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function saveProtectedFile(path, content, options = {}) {
  if (process.platform === 'win32') {
    if (options.trustWindowsPermissions !== true) denied();
    (options.report ?? console.warn)(warning);
  }
  let fd;
  let owned;
  try {
    const parent = lstatSync(dirname(path));
    if (!parent.isDirectory() || parent.isSymbolicLink() ||
        (process.platform !== 'win32' && ((parent.mode & 0o077) || parent.uid !== process.geteuid()))) denied();
    fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    owned = fstatSync(fd);
    writeFileSync(fd, content, 'utf8');
    options.fault?.('after-write');
    fsyncSync(fd);
    options.fault?.('after-flush');
    closeSync(fd);
    fd = undefined;
    const checked = trusted(path, { ...options, report: () => {} });
    options.fault?.('after-check');
    if (checked.dev !== owned.dev || checked.ino !== owned.ino || checked.size !== Buffer.byteLength(content)) denied();
    return () => {
      options.fault?.('before-cleanup');
      const current = trusted(path, { ...options, report: () => {} });
      if (current.dev !== owned.dev || current.ino !== owned.ino) denied();
      unlinkSync(path);
    };
  } catch {
    if (fd !== undefined) { try { closeSync(fd); } catch {} }
    let cleanupFailed = false;
    if (owned) {
      try {
        const current = lstatSync(path);
        if (current.dev === owned.dev && current.ino === owned.ino) {
          options.fault?.('before-cleanup');
          unlinkSync(path);
        } else cleanupFailed = true;
      } catch { cleanupFailed = true; }
    }
    if (cleanupFailed) {
      const error = new Error('LOCAL_CLEANUP_INCOMPLETE');
      error.cleanupIncomplete = true;
      throw error;
    }
    denied();
  }
}

export function createAdminAuthority({ secretFile, trustWindowsPermissions = false, report = console.warn } = {}) {
  if (typeof secretFile !== 'string' || !secretFile) denied();
  const options = { trustWindowsPermissions, report };
  return Object.freeze({
    authorizeAdmin(ctx) {
      const saved = loadProtectedFile(secretFile, options);
      if (!SECRET.test(saved)) denied();
      const supplied = ctx?.adminSecret;
      if (typeof supplied !== 'string' || !SUPPLIED_SECRET.test(supplied)) return false;
      return timingSafeEqual(Buffer.from(saved.trim(), 'hex'), Buffer.from(supplied, 'hex'));
    },
  });
}

export function createLocalKeystore({ directory, trustWindowsPermissions = false, report = console.warn, fault } = {}) {
  if (typeof directory !== 'string' || !directory) denied();
  const options = { trustWindowsPermissions, report, fault };
  const pathFor = id => {
    if (!ID.test(id)) denied();
    return join(directory, `${id}.json`);
  };
  return Object.freeze({
    createAdminSecret(path) {
      const secret = randomBytes(32).toString('hex');
      saveProtectedFile(path, `${secret}\n`, options);
      return secret;
    },
    storeCredential({ credentialId, agentId, credential }) {
      if (!ID.test(credentialId) || !ID.test(agentId) || !CREDENTIAL.test(credential) || !credential.startsWith(`${credentialId}.`)) denied();
      try { return saveProtectedFile(pathFor(credentialId), JSON.stringify({ credentialId, agentId, credential, revoked: false }), options); }
      catch (error) {
        if (error?.cleanupIncomplete) error.credentialId = credentialId;
        throw error;
      }
    },
    loadCredential(credentialId) {
      if (existsSync(join(directory, `${ID.test(credentialId) ? credentialId : denied()}.revoked`))) denied();
      let record;
      try { record = JSON.parse(loadProtectedFile(pathFor(credentialId), options)); } catch { denied(); }
      if (record.credentialId !== credentialId || !ID.test(record.agentId) ||
          !CREDENTIAL.test(record.credential) || !record.credential.startsWith(`${credentialId}.`) ||
          typeof record.revoked !== 'boolean') denied();
      if (record.revoked) denied();
      return record.credential;
    },
    recordRevocation(credentialId) {
      // A marker never contains credential material. DB revocation takes effect independently.
      saveProtectedFile(join(directory, `${ID.test(credentialId) ? credentialId : denied()}.revoked`), 'revoked\n', options);
    },
    recordRotation(oldCredentialId, newCredentialId) {
      if (!ID.test(oldCredentialId) || !ID.test(newCredentialId)) denied();
      saveProtectedFile(join(directory, `${oldCredentialId}.rotated`), `${newCredentialId}\n`, options);
    },
  });
}

export const WINDOWS_PERMISSION_WARNING = warning;
