import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fixture, relay, cleanup, temp } from './helpers.js';

async function client(t, url, deviceName) {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.resolve('src/mcp.js')],
    env: { MSG_SERVER_URL: url, MSG_DEVICE_NAME: deviceName, MSG_DOWNLOAD_DIR: temp(t) }, stderr: 'pipe',
  });
  const sdk = new Client({ name: 'recipient-isolation-test', version: '1.0.0' });
  cleanup(t, async () => { await sdk.close(); await transport.close(); });
  await sdk.connect(transport);
  return sdk;
}

async function call(sdk, name, args = {}) {
  const result = await sdk.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
}

test('real SDK selector candidates and direct reads stay within the socket-bound recipient', async t => {
  // One ephemeral real server/DB; each byte-forwarding relay uses a distinct real
  // upstream loopback source. Stdio itself has no independently identifiable LAN IP.
  const f = await fixture(t);
  const a = await client(t, await relay(t, f.url, '127.0.0.1'), 'C');
  const b = await client(t, await relay(t, f.url, '127.0.0.2'), 'C');
  const c = await client(t, await relay(t, f.url, '127.0.0.3'), 'B');
  assert.deepEqual((await call(b, 'list_peers')).map(peer => peer.name), ['A', 'B', 'C']);

  const dir = temp(t);
  const file = path.join(dir, 'fictional-private-attachment.md');
  fs.writeFileSync(file, 'fictional private file contents');
  const bFirst = await call(a, 'send_message', { to: 'B', title: 'same synthetic title', text: 'B-only private body alpha' });
  const cFirst = await call(a, 'send_message', { to: 'C', title: 'same synthetic title', text: 'C-only private body alpha' });
  const bUntitled = await call(a, 'send_message', { to: 'B', text: 'B-only untitled body' });
  const cUntitled = await call(a, 'send_message', { to: 'C', text: 'C-only untitled body' });
  const bFile = await call(a, 'send_file', { to: 'B', title: 'same synthetic title', text: 'B-only file body', path: file });
  const cFile = await call(a, 'send_file', { to: 'C', title: 'same synthetic title', text: 'C-only file body', path: file });
  const ids = { B: [bFirst.id, bUntitled.id, bFile.id], C: [cFirst.id, cUntitled.id, cFile.id] };

  // Mix read and unread records in each inbox before testing selector upstream.
  assert.equal((await call(b, 'read_message', { id: bFirst.id })).markedRead, true);
  assert.equal((await call(c, 'read_message', { id: cFirst.id })).markedRead, true);
  const fields = (await call(b, 'getmsg', { limit: 1 })).messages[0];
  t.diagnostic(`actual MCP getmsg candidate keys: ${JSON.stringify(Object.keys(fields).sort())}; identity fields present: ${JSON.stringify(Object.keys(fields).filter(key => /^(to|recipient|identity|member)$/i.test(key)))}`);

  for (const [member, sdk, other] of [['B', b, 'C'], ['C', c, 'B']]) {
    const owned = ids[member];
    const otherIds = ids[other];
    for (const args of [
      {}, { unread_only: false }, { unread_only: true }, { from: 'A' },
      { from: other }, { from: 'A', unread_only: true },
      // Extra caller-controlled identity fields cannot select another inbox.
      { to: other, recipient: other, member: other, user: other },
    ]) {
      const page = await call(sdk, 'getmsg', args);
      const expected = args.from === other ? [] : args.unread_only === true ? owned.slice(1) : owned;
      assert.deepEqual(page.messages.map(m => m.id), expected, `${member} selector ${JSON.stringify(args)}`);
      assert.ok(page.messages.every(m => m.from === 'A'));
      assert.ok(page.messages.every(m => !otherIds.includes(m.id)));
    }
    const first = await call(sdk, 'getmsg', { limit: 1 });
    assert.deepEqual(first.messages.map(m => m.id), owned.slice(0, 1));
    assert.equal(first.hasMore, true);
    const second = await call(sdk, 'getmsg', { cursor: first.nextCursor, limit: 1 });
    assert.deepEqual(second.messages.map(m => m.id), owned.slice(1, 2));
    assert.equal(second.hasMore, true);
    const last = await call(sdk, 'getmsg', { cursor: second.nextCursor, limit: 1 });
    assert.deepEqual(last.messages.map(m => m.id), owned.slice(2));
    assert.equal(last.hasMore, false);

    for (const id of otherIds) {
      const denied = await sdk.callTool({ name: 'read_message', arguments: { id, member: other, user: other } });
      assert.equal(denied.isError, true);
      for (const secret of ['same synthetic title', `${other}-only`, 'fictional-private-attachment.md']) {
        assert.equal(denied.content[0].text.includes(secret), false, 'denial must not leak other inbox metadata or content');
      }
    }
    const attachment = other === 'B' ? bFile.attachment.id : cFile.attachment.id;
    const denied = await sdk.callTool({ name: 'receive_attachment', arguments: { attachment_id: attachment } });
    assert.equal(denied.isError, true);
    for (const secret of ['same synthetic title', `${other}-only`, 'fictional-private-attachment.md']) {
      assert.equal(denied.content[0].text.includes(secret), false);
    }
    assert.deepEqual((await call(sdk, 'getmsg', { unread_only: true })).messages.map(m => m.id), owned.slice(1),
      'denied cross-recipient reads/downloads must not change read state');
  }
  assert.deepEqual((await call(a, 'getmsg')).messages, [], 'sender cannot see either recipient inbox');
});
