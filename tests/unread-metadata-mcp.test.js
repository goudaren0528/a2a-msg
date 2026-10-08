import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fixture, relay, cleanup, temp, sha256 } from './helpers.js';

// Same real-SDK pattern as recipient-isolation: distinct relay loopback sources
// give distinct members A/B/C; identity comes from the socket, not the client.
async function client(t, url, deviceName) {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.resolve('src/mcp.js')],
    env: { MSG_SERVER_URL: url, MSG_DEVICE_NAME: deviceName, MSG_DOWNLOAD_DIR: temp(t) }, stderr: 'pipe',
  });
  const sdk = new Client({ name: 'unread-metadata-test', version: '1.0.0' });
  cleanup(t, async () => { await sdk.close(); await transport.close(); });
  await sdk.connect(transport);
  return sdk;
}

async function call(sdk, name, args = {}) {
  const result = await sdk.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
}

// Every object key anywhere in a JSON payload, for metadata-only shape checks.
function collectKeys(node, keys = []) {
  if (Array.isArray(node)) node.forEach(item => collectKeys(item, keys));
  else if (node && typeof node === 'object') {
    keys.push(...Object.keys(node));
    Object.values(node).forEach(value => collectKeys(value, keys));
  }
  return keys;
}

test('unread_metadata is registered as a real MCP tool', async t => {
  const f = await fixture(t);
  const sdk = await client(t, await relay(t, f.url, '127.0.0.1'), 'A');
  const { tools } = await sdk.listTools();
  assert.equal(tools.some(tool => tool.name === 'unread_metadata'), true);
});

test('unread_metadata returns metadata-only shape, never reads or marks read', async t => {
  const f = await fixture(t);
  const a = await client(t, await relay(t, f.url, '127.0.0.1'), 'A');
  const b = await client(t, await relay(t, f.url, '127.0.0.2'), 'B');
  assert.deepEqual((await call(b, 'list_peers')).map(peer => peer.name), ['A', 'B', 'C']);

  const file = path.join(temp(t), 'spec-sample.txt');
  fs.writeFileSync(file, 'attachment bytes');
  const textMessage = await call(a, 'send_message', { to: 'B', title: 'synthetic title', text: 'PRIVATE_BODY_123', project: 'PRIVATE_PROJECT' });
  const fileMessage = await call(a, 'send_file', { to: 'B', path: file });

  const summaryBefore = await call(b, 'get_unread_summary');
  assert.equal(summaryBefore.total, 2);
  const page = await call(b, 'unread_metadata');
  assert.deepEqual(page.messages.map(m => m.id), [textMessage.id, fileMessage.id]);
  assert.equal(page.hasMore, false);
  assert.equal(page.nextCursor, null);
  for (const forbidden of ['text', 'summary', 'read', 'project']) {
    assert.equal(collectKeys(page).includes(forbidden), false, `response must not expose a ${forbidden} key`);
  }
  for (const message of page.messages) {
    assert.deepEqual(Object.keys(message).sort(), ['attachment', 'from', 'id', 'time', 'title']);
    assert.equal(message.from, 'A');
    assert.match(message.time, /^\d{4}-\d{2}-\d{2}T/);
  }
  const json = JSON.stringify(page);
  for (const secret of ['PRIVATE_BODY_123', 'PRIVATE_PROJECT', 'attachment bytes']) {
    assert.equal(json.includes(secret), false, `metadata must not contain ${secret}`);
  }
  assert.equal(page.messages[0].title, 'synthetic title');
  assert.equal(page.messages[0].attachment, null);
  assert.deepEqual(Object.keys(page.messages[1].attachment).sort(), ['id', 'mime', 'name', 'sha256', 'size']);
  assert.equal(page.messages[1].attachment.id, fileMessage.attachment.id);
  assert.equal(page.messages[1].attachment.name, 'spec-sample.txt');
  assert.equal(page.messages[1].attachment.size, fs.readFileSync(file).length);
  assert.equal(page.messages[1].attachment.sha256, sha256(fs.readFileSync(file)));

  // Read-state invariance: listing neither consumes nor changes unread state.
  const summaryAfter = await call(b, 'get_unread_summary');
  assert.deepEqual({ total: summaryAfter.total, attachments: summaryAfter.attachments, senders: summaryAfter.senders },
    { total: summaryBefore.total, attachments: summaryBefore.attachments, senders: summaryBefore.senders },
    'listing does not change unread state');
  assert.deepEqual((await call(b, 'getmsg', { unread_only: true })).messages.map(m => m.id), [textMessage.id, fileMessage.id]);
  const marked = await call(b, 'read_message', { id: textMessage.id });
  assert.equal(marked.markedRead, true, 'message was still unread after listing');

  // Unread-only: a message read to the end disappears from the index.
  const remaining = await call(b, 'unread_metadata');
  assert.deepEqual(remaining.messages.map(m => m.id), [fileMessage.id]);
  const rest = await call(b, 'read_message', { id: fileMessage.id });
  assert.equal(rest.hasMore, false);
  assert.deepEqual((await call(b, 'unread_metadata')).messages, []);
});

test('unread_metadata filters by sender and pages ascending with exact hasMore', async t => {
  const f = await fixture(t);
  const a = await client(t, await relay(t, f.url, '127.0.0.1'), 'A');
  const b = await client(t, await relay(t, f.url, '127.0.0.2'), 'B');
  const c = await client(t, await relay(t, f.url, '127.0.0.3'), 'C');
  assert.deepEqual((await call(b, 'list_peers')).map(peer => peer.name), ['A', 'B', 'C']);
  const fromA = await call(a, 'send_message', { to: 'B', text: 'first from A' });
  const fromC = await call(c, 'send_message', { to: 'B', text: 'first from C' });

  // from filter returns only that sender's unread rows.
  const filtered = await call(b, 'unread_metadata', { from: 'A' });
  assert.deepEqual(filtered.messages.map(m => m.id), [fromA.id]);
  assert.ok(filtered.messages.every(m => m.from === 'A'));

  // cursor/limit pagination walks ascending unique ids.
  const first = await call(b, 'unread_metadata', { limit: 1 });
  assert.deepEqual(first.messages.map(m => m.id), [fromA.id]);
  assert.equal(first.hasMore, true);
  assert.equal(first.nextCursor, fromA.id);
  const second = await call(b, 'unread_metadata', { cursor: first.nextCursor, limit: 1 });
  assert.deepEqual(second.messages.map(m => m.id), [fromC.id]);
  assert.equal(second.hasMore, false);
  assert.equal(second.nextCursor, null);
});

test('unread_metadata stays inside the caller inbox and ignores identity override fields', async t => {
  const f = await fixture(t);
  const a = await client(t, await relay(t, f.url, '127.0.0.1'), 'A');
  const b = await client(t, await relay(t, f.url, '127.0.0.2'), 'B');
  const c = await client(t, await relay(t, f.url, '127.0.0.3'), 'C');
  assert.deepEqual((await call(b, 'list_peers')).map(peer => peer.name), ['A', 'B', 'C']);
  const toB = await call(a, 'send_message', { to: 'B', title: 'synthetic title', text: 'B-only private body' });
  const toC = await call(a, 'send_message', { to: 'C', text: 'C-only private body' });

  // C's own inbox excludes B's unread rows, even with caller-controlled identity fields.
  const own = await call(c, 'unread_metadata');
  assert.deepEqual(own.messages.map(m => m.id), [toC.id]);
  const override = await call(c, 'unread_metadata', { to: 'B', recipient: 'B', member: 'B', user: 'B' });
  assert.deepEqual(override.messages.map(m => m.id), [toC.id]);
  for (const response of [own, override]) {
    const json = JSON.stringify(response);
    for (const secret of ['synthetic title', 'B-only private body']) {
      assert.equal(json.includes(secret), false, 'must not leak B inbox metadata');
    }
  }

  // Mirrored: B's override toward C keeps B's own inbox.
  assert.deepEqual((await call(b, 'unread_metadata')).messages.map(m => m.id), [toB.id]);
  const bOverride = await call(b, 'unread_metadata', { to: 'C', recipient: 'C', member: 'C', user: 'C' });
  assert.deepEqual(bOverride.messages.map(m => m.id), [toB.id]);
  assert.equal(JSON.stringify(bOverride).includes('C-only private body'), false, 'must not leak C inbox metadata');
});

test('unread_metadata titles distinguish different-ticket work orders without body reads', async t => {
  const f = await fixture(t);
  const a = await client(t, await relay(t, f.url, '127.0.0.1'), 'A');
  const b = await client(t, await relay(t, f.url, '127.0.0.2'), 'B');
  const exportTicket = await call(a, 'send_message', { to: 'B', title: '[WORK:v1][FIX][TEST][A-9001] export timeout', text: 'SENTINEL_BODY_EXPORT_9001' });
  const loginTicket = await call(a, 'send_message', { to: 'B', title: '[WORK:v1][QA][BUGFIX][A-9002] login regression', text: 'SENTINEL_BODY_LOGIN_9002' });

  const page = await call(b, 'unread_metadata');
  assert.deepEqual(page.messages.map(m => m.id), [exportTicket.id, loginTicket.id]);
  assert.deepEqual(page.messages.map(m => m.title), [
    '[WORK:v1][FIX][TEST][A-9001] export timeout', '[WORK:v1][QA][BUGFIX][A-9002] login regression',
  ]);
  const payload = JSON.stringify(page);
  for (const sentinel of ['SENTINEL_BODY_EXPORT_9001', 'SENTINEL_BODY_LOGIN_9002']) {
    assert.equal(payload.includes(sentinel), false, `first-layer dedup needs no body read: ${sentinel}`);
  }

  // Unread state intact: title-driven routing read and marked nothing.
  assert.deepEqual((await call(b, 'getmsg', { unread_only: true })).messages.map(m => m.id), [exportTicket.id, loginTicket.id]);
});