import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createTransferGate, readBoundedResponse, readUploadFile } from '../src/mcp-limits.js';

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

test('bounded response measures streamed bytes, not claimed length, and cancels excess', async () => {
  for (const header of [undefined, '2']) {
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(5)); },
      cancel() { cancelled = true; },
    });
    const response = new Response(body, { headers: header ? { 'Content-Length': header } : {} });
    await assert.rejects(readBoundedResponse(response, 4), /exceeds 4 byte limit/);
    assert.equal(cancelled, true);
  }
  let read = false; let cancelled = false;
  const body = new ReadableStream({ pull() { read = true; }, cancel() { cancelled = true; } });
  await assert.rejects(readBoundedResponse(new Response(body, { headers: { 'Content-Length': '5' } }), 4), /limit/);
  assert.equal(read, false, 'oversized declared length rejected before reading');
  assert.equal(cancelled, true);
});

test('gate bounds 2 active and 16 waiting, rejects excess before side effects, FIFO and error release', async () => {
  const gate = createTransferGate();
  const locks = Array.from({ length: 18 }, deferred);
  const started = [];
  const jobs = locks.map((lock, i) => gate(async () => {
    started.push(i);
    await lock.promise;
    if (i === 0) throw new Error('failure');
    return i;
  }));
  assert.deepEqual(started, [0, 1]);
  let effects = 0;
  await assert.rejects(gate(() => { effects++; }), /busy/i);
  assert.equal(effects, 0);
  locks[0].resolve();
  await assert.rejects(jobs[0], /failure/);
  for (let i = 2; i < 18; i++) {
    assert.deepEqual(started, Array.from({ length: i + 1 }, (_, n) => n).slice(0, i + 1));
    locks[i - 1].resolve();
    await jobs[i - 1];
    // The next waiter is resumed on the next microtask.
    await new Promise(resolve => setImmediate(resolve));
  }
  locks[17].resolve();
  await jobs[17];
  assert.equal(await gate(async () => 'released'), 'released');
});

test('upload reader enforces actual size after stat, exact budget, nonempty regular file and closes handle', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-limits-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'file.bin');
  fs.writeFileSync(file, 'abcd');
  assert.equal((await readUploadFile(file, 4)).toString(), 'abcd');
  await assert.rejects(readUploadFile(file, 3), /limit/);
  await assert.rejects(readUploadFile(dir, 4), /regular file/);
  fs.writeFileSync(file, '');
  await assert.rejects(readUploadFile(file, 4), /empty/);
  const fsPromises = await import('node:fs/promises');
  const original = fsPromises.default.open;
  let closed = false;
  fsPromises.default.open = async (...args) => {
    const handle = await original(...args);
    return {
      stat: () => handle.stat(),
      read: (...readArgs) => handle.read(...readArgs),
      close: async () => { closed = true; await handle.close(); },
    };
  };
  try {
    fs.writeFileSync(file, 'abcd');
    // Simulate growth between handle.stat() and first read().
    fsPromises.default.open = async (...args) => {
      const handle = await original(...args);
      return {
        stat: async () => { const s = await handle.stat(); fs.appendFileSync(file, 'e'); return s; },
        read: (...readArgs) => handle.read(...readArgs),
        close: async () => { closed = true; await handle.close(); },
      };
    };
    await assert.rejects(readUploadFile(file, 4), /limit/);
    assert.equal(closed, true);
  } finally {
    fsPromises.default.open = original;
  }
});
