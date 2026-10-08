import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { saveAttachment } from '../src/attachment-save.js';
import { temp, sha256 } from './helpers.js';

test('event loop advances while asynchronous staging readback is pending', async t => {
  const dir = temp(t);
  const bytes = Buffer.from('attachment');
  const meta = { name: 'file.txt', from: 'A', to: 'B', data_base64: bytes.toString('base64'), sha256: sha256(bytes) };
  let entered;
  const reading = new Promise(resolve => { entered = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const readFile = fs.readFile;
  t.mock.method(fs, 'readFile', async (...args) => {
    entered();
    await gate;
    return readFile(...args);
  });
  const pending = saveAttachment({ path: path.join(dir, 'saved.txt') }, async () => meta);
  try {
    await reading;
    let advanced = false;
    await new Promise(resolve => setImmediate(() => { advanced = true; resolve(); }));
    assert.equal(advanced, true);
  } finally { release(); }
  const saved = await pending;
  assert.equal(saved.sha256, meta.sha256);
});
