import { promises as fs } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

// Native methods are wrapped before product import, in this child only. All
// writes/faults are limited to this invocation's private store and chosen file.
const input = await new Promise(resolveInput => process.once('message', resolveInput));
const { directory, partition, messageId, attachment, mode, finalPath } = input;
const root = resolve(directory), target = resolve(finalPath);
if (dirname(target) !== root || process.platform === 'win32') throw new Error('invalid native fixture scope');
const original = Object.fromEntries(['open', 'link', 'unlink', 'opendir'].map(key => [key, fs[key]]));
const restores = [], events = [];
const bytes = Buffer.from(input.bytes, 'base64');
let faultHits = 0, downloadCalls = 0, tempUnlinked = false;
const scannedNames = new Set();
const asPath = value => typeof value === 'string' ? resolve(value) : '';
const ownedTemp = path => dirname(path) === root && basename(path).startsWith(`${basename(target)}.`) && path.endsWith('.tmp');
const send = message => new Promise((resolveSend, reject) => process.send(message, e => e ? reject(e) : resolveSend()));
async function phase(name, extra = {}) {
  const continued = new Promise(resolveContinue => {
    const listener = message => {
      if (message.type === 'continue' && message.phase === name) {
        process.off('message', listener); resolveContinue();
      }
    };
    process.on('message', listener);
  });
  await send({ type: 'phase', phase: name, ...extra });
  await continued;
}
function fail(code) {
  faultHits++;
  throw Object.assign(new Error(`isolated native ${code}`), { code });
}
function wrap(object, key, replacement) {
  const method = object[key];
  object[key] = replacement(method);
  restores.push(() => { object[key] = method; });
}
fs.open = async function (path, ...args) {
  const handle = await original.open.call(fs, path, ...args), name = asPath(path);
  const kind = name === root ? 'directory' : name === target ? 'final' : ownedTemp(name) ? 'temp' : null;
  if (!kind) return handle;
  for (const method of ['write', 'writeFile', 'writev']) {
    wrap(handle, method, native => async function (...values) {
      if (kind === 'temp' && !faultHits && mode === 'write-enospc') fail('ENOSPC');
      if (kind === 'temp' && !faultHits && mode === 'mutate-buffer') {
        faultHits++;
        await phase('before-native-write');
        bytes.fill(0x58);
      }
      const result = await native.apply(this, values);
      events.push({ operation: method, kind, path: name });
      return result;
    });
  }
  wrap(handle, 'sync', native => async function (...values) {
    const shouldFail = !faultHits && (
      (mode === 'temp-sync-fail' && kind === 'temp') ||
      (mode === 'reuse-file-sync-fail' && kind === 'final') ||
      (mode === 'reuse-dir-sync-fail' && kind === 'directory') ||
      (mode === 'post-unlink-dir-sync-fail' && kind === 'directory' && tempUnlinked));
    if (shouldFail) fail('EIO');
    const result = await native.apply(this, values);
    events.push({ operation: 'sync', kind, path: name });
    return result;
  });
  return handle;
};
fs.link = async function (from, to) {
  const result = await original.link.call(fs, from, to);
  if (asPath(to) === target && ownedTemp(asPath(from))) {
    events.push({ operation: 'link', from: asPath(from), path: target });
    if (mode === 'crash-after-link') {
      await phase('linked-before-unlink', { tempPath: asPath(from), finalPath: target });
      process.exit(73);
    }
  }
  return result;
};
fs.unlink = async function (path) {
  const result = await original.unlink.call(fs, path);
  if (ownedTemp(asPath(path))) {
    tempUnlinked = true;
    events.push({ operation: 'unlink', kind: 'temp', path: asPath(path) });
  }
  return result;
};
fs.opendir = async function (path, ...args) {
  const dir = await original.opendir.call(fs, path, ...args);
  if (asPath(path) !== root) return dir;
  // Record both supported native consumption APIs, without manufacturing entries.
  wrap(dir, 'read', native => async function (...values) {
    const entry = await native.apply(this, values);
    if (entry) scannedNames.add(entry.name);
    return entry;
  });
  wrap(dir, Symbol.asyncIterator, native => async function* () {
    for await (const entry of native.call(this)) { scannedNames.add(entry.name); yield entry; }
  });
  return dir;
};
let outcome;
try {
  const { createImV2AttachmentStore } = await import('../../../src/im/v2/client-files.js');
  const store = createImV2AttachmentStore({ directory, durability: 'strict' });
  const receipt = await store.save({ partition, messageId, attachment, download: async () => {
    downloadCalls++;
    return bytes;
  } });
  outcome = { ok: true, receipt };
} catch (e) {
  outcome = { ok: false, error: { name: e.name, code: e.code, message: e.message } };
} finally {
  for (const restore of restores.reverse()) restore();
  Object.assign(fs, original);
}
await send({ type: 'result', ...outcome, faultHits, downloadCalls, scanReads: scannedNames.size, events });
process.disconnect();
