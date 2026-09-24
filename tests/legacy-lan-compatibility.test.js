import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { lane, server, mcp, call, request, relay, snapshot, events, bounded, readServerUrl } from './fixtures/legacy-lan-compatibility/harness.js';

// Acceptance evidence must be run in an isolated committed-tree snapshot plus
// these new files. Do not certify a dirty bridge/saver using this test's result.
const toolNames = ['get_unread_summary', 'getmsg', 'list_peers', 'mark_read',
  'read_attachment_text', 'read_message', 'receive_attachment', 'save_attachment', 'send_file', 'send_message'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const recipientError = { error: 'Forbidden: access restricted to message recipient' };

test('readiness byte ceiling and post-ready stdout draining', async () => {
  const overflow = new PassThrough();
  const rejected = readServerUrl(overflow, 8);
  overflow.write(Buffer.from('😀😀😀'));
  await assert.rejects(rejected, /readiness stdout byte limit exceeded/);
  overflow.destroy();

  const stdout = new PassThrough({ highWaterMark: 16 });
  const ready = readServerUrl(stdout, 128);
  stdout.write('team-mailbox server listening at http://127.0.0.1:12345\n');
  assert.equal(await ready, 'http://127.0.0.1:12345');
  for (let i = 0; i < 64; i++) assert.equal(stdout.write(Buffer.alloc(1024)), true,
    'stdout continues draining without retaining post-ready bytes');
  stdout.destroy();
});

test('readiness overflow closes the owned CLI before fixture removal', { timeout: 10_000 }, async t => {
  const f = lane(t);
  await assert.rejects(server(f, t, 1), /readiness stdout byte limit exceeded/);
  assert.equal(fs.existsSync(f.dir), true, 'cleanup only removes fixture after child close');
});

test('HTTP and SSE oversized payloads cancel their transport', { timeout: 10_000 }, async t => {
  let httpClosed = false;
  let sseClosed = false;
  const fixture = { cleanup: fn => t.after(fn) };
  const mock = http.createServer((req, res) => {
    res.on('close', () => {
      if (req.url === '/http') httpClosed = true;
      else sseClosed = true;
    });
    if (req.url === '/http') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write(Buffer.alloc(4096, 65));
    } else {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + '😀'.repeat(1024));
    }
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    mock.closeAllConnections();
    await new Promise((resolve, reject) => mock.close(error => error ? reject(error) : resolve()));
  });
  const url = `http://127.0.0.1:${mock.address().port}`;
  await assert.rejects(request(`${url}/http`, '127.0.0.1', 'GET', undefined, {}, 64),
    /HTTP response byte limit exceeded/);
  const stream = await events(fixture, url, 64);
  await assert.rejects(stream.next(), /SSE frame byte limit exceeded/);
  await bounded(new Promise((resolve, reject) => {
    const check = () => httpClosed && sseClosed ? resolve() : setTimeout(check, 10);
    check();
  }), 'oversized transport closure');
});

test('standalone legacy CLI + real MCP: old tools, SSE and database survive restart without IM setup', { timeout: 60_000 }, async t => {
  const f = lane(t);
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts.start, 'node src/server.js');
  assert.equal(pkg.scripts.mcp, 'node src/mcp.js');
  assert.equal(fs.existsSync(f.dbPath), false);
  let app = await server(f, t);
  assert.deepEqual(snapshot(f.dbPath), { messages: [], attachments: [] });
  const health = await request(`${app.url}/health`);
  assert.equal(health.status, 200, 'plain HTTP + source-IP config; no bearer/TLS/IM enrollment');
  assert.equal(health.data.service, 'team-mailbox');
  assert.equal(health.data.member.name, 'LegacyA');
  assert.deepEqual(await request(`${app.url}/not-a-route`), { status: 404, data: { error: 'Not Found' } });
  assert.deepEqual(await request(`${app.url}/api/messages/999999`), { status: 404, data: { error: 'Message not found' } });
  assert.deepEqual(await request(`${app.url}/api/unread-events?unexpected=1`), {
    status: 400, data: { error: 'Query parameters are not supported' },
  });
  assert.deepEqual(await request(`${app.url}/api/messages`, '127.0.0.1', 'POST', { to: 'MissingSynthetic', text: 'test' }), {
    status: 404, data: { error: 'Recipient "MissingSynthetic" is not in current access configuration' },
  });

  let bridge = await mcp(f, t, app.url);
  assert.deepEqual((await bridge.sdk.listTools()).tools.map(tool => tool.name).sort(), toolNames);
  assert.deepEqual((await call(bridge.sdk, 'list_peers')).map(peer => peer.name), ['LegacyA', 'LegacyB', 'LegacyC']);
  const stream = await events(f, app.url);
  const initial = await stream.next();
  assert.equal(initial.reason, 'snapshot'); assert.equal(initial.summary.total, 0);
  const body = 'Synthetic legacy body 😀\n'.repeat(80);
  const text = await call(bridge.sdk, 'send_message', { to: 'LegacyA', text: body, project: 'compat-fixture' });
  const notification = await stream.next();
  assert.equal(notification.reason, 'message');
  assert.equal(notification.summary.total, 1);
  assert.notEqual(notification.cursor, initial.cursor);
  assert.equal(JSON.stringify(notification).includes('Synthetic legacy body'), false);
  await stream.stop();

  const bytes = Buffer.from('Synthetic attachment bytes — inert text 😀\n');
  const source = path.join(f.dir, 'synthetic.txt');
  fs.writeFileSync(source, bytes, { mode: 0o600 });
  const file = await call(bridge.sdk, 'send_file', { to: 'LegacyA', path: source, text: 'attachment body' });
  assert.equal(file.attachment.sha256, sha256(bytes));
  const inbox = await call(bridge.sdk, 'getmsg', { unread_only: true });
  assert.deepEqual(inbox.messages.map(message => message.id), [text.id, file.id]);
  assert.equal(inbox.hasMore, false);
  assert.equal((await call(bridge.sdk, 'get_unread_summary')).total, 2);
  assert.equal((await call(bridge.sdk, 'read_attachment_text', { attachment_id: file.attachment.id })).text, bytes.toString());

  await t.test('legacy attachment receive/save publishes exact bytes in an existing private directory', async sub => {
    const probe = path.join(f.dir, 'hardlink-probe');
    try { fs.linkSync(source, probe); fs.unlinkSync(probe); }
    catch (error) {
      if (['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EACCES'].includes(error.code)) {
        sub.skip(`Filesystem cannot publish legacy hard links (${error.code}); download/save not certified`); return;
      }
      throw error;
    }
    for (const name of ['receive_attachment', 'save_attachment']) {
      const args = { attachment_id: file.attachment.id };
      if (name === 'save_attachment') args.path = path.join(f.dir, 'explicit-copy.txt');
      const saved = await call(bridge.sdk, name, args);
      assert.equal(path.dirname(saved.path), fs.realpathSync(f.dir));
      assert.equal(saved.sha256, sha256(bytes));
      assert.deepEqual(fs.readFileSync(saved.path), bytes);
    }
    assert.equal((await call(bridge.sdk, 'get_unread_summary')).total, 2, 'saving never marks the body read');
  });

  let joined = '', offset = 0, marks = 0;
  do {
    const chunk = await call(bridge.sdk, 'read_message', { id: text.id, offset, limit: 700 });
    joined += chunk.text; offset += chunk.limit;
    if (chunk.markedRead) marks++;
    assert.equal(chunk.read, !chunk.hasMore, 'legacy final-chunk auto-read, not explicit-ACK semantics');
    if (!chunk.hasMore) break;
    assert.equal(chunk.markedRead, false);
  } while (offset <= body.length);
  assert.equal(joined, body); assert.equal(marks, 1);
  assert.equal((await call(bridge.sdk, 'mark_read', { ids: [file.id] })).markedCount, 1);
  const retained = await call(bridge.sdk, 'send_message', { to: 'LegacyA', text: 'retained unread incoming fixture' });
  const before = snapshot(f.dbPath);
  assert.ok(before.messages.find(row => row.id === text.id).read_at);
  assert.ok(before.messages.find(row => row.id === file.id).read_at);
  assert.equal(before.messages.find(row => row.id === retained.id).read_at, null);
  assert.equal(before.attachments[0].data, bytes.toString('base64'));
  await bridge.stop(); await app.stop();
  app = await server(f, t);
  assert.deepEqual(snapshot(f.dbPath), before, 'IDs, timestamps/read_at, bodies and attachment BLOBs retained exactly');
  bridge = await mcp(f, t, app.url);
  assert.deepEqual((await call(bridge.sdk, 'getmsg')).messages.map(row => row.id), [text.id, file.id, retained.id]);
  assert.deepEqual((await call(bridge.sdk, 'getmsg', { unread_only: true })).messages.map(row => row.id), [retained.id]);
  assert.equal((await call(bridge.sdk, 'get_unread_summary')).total, 1);
  const reread = await call(bridge.sdk, 'read_message', { id: text.id, limit: 4000 });
  assert.equal(reread.text, body); assert.equal(reread.markedRead, false);
  const download = await request(`${app.url}/api/attachments/${file.attachment.id}`);
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(download.data.data_base64, 'base64'), bytes);
  const next = await call(bridge.sdk, 'send_message', { to: 'LegacyA', text: 'post-restart fixture' });
  assert.ok(next.id > retained.id, 'legacy ID sequence continues');
  snapshot(f.dbPath);
});

test('legacy recipient-only ACL uses genuine source-bound MCP clients and ignores impersonation headers', { timeout: 60_000 }, async t => {
  const f = lane(t);
  let app = await server(f, t);
  for (const [ip, name] of [['127.0.0.2', 'LegacyB'], ['127.0.0.3', 'LegacyC'], ['127.0.0.4', null]]) {
    let probe;
    try { probe = await request(`${app.url}/health`, ip); }
    catch (error) {
      if (['EADDRNOTAVAIL', 'EAFNOSUPPORT', 'EPROTONOSUPPORT', 'ENETUNREACH'].includes(error.code)) {
        t.skip(`Genuine loopback source ${ip} unavailable (${error.code}); recipient isolation not certified`); return;
      }
      throw error;
    }
    if (name) { assert.equal(probe.status, 200); assert.equal(probe.data.member.name, name); }
    else assert.deepEqual(probe, { status: 403, data: { error: 'Forbidden: source IP is not allowed and mapped' } });
  }
  const a = await mcp(f, t, app.url);
  let b = await mcp(f, t, await relay(f, app.url, '127.0.0.2'));
  const c = await mcp(f, t, await relay(f, app.url, '127.0.0.3'));
  const source = path.join(f.dir, 'recipient-only.txt');
  fs.writeFileSync(source, 'synthetic recipient-only bytes', { mode: 0o600 });
  const sent = await call(a.sdk, 'send_file', { to: 'LegacyB', path: source, text: 'synthetic recipient-only body' });
  assert.deepEqual((await call(b.sdk, 'getmsg')).messages.map(row => row.id), [sent.id]);
  assert.equal((await call(b.sdk, 'get_unread_summary')).total, 1);
  for (const [client, ip] of [[a.sdk, '127.0.0.1'], [c.sdk, '127.0.0.3']]) {
    assert.deepEqual((await call(client, 'getmsg')).messages, []);
    assert.equal((await call(client, 'get_unread_summary')).total, 0);
    assert.equal((await call(client, 'mark_read', { ids: [sent.id] })).markedCount, 0);
    for (const [name, args] of [['read_message', { id: sent.id }], ['read_attachment_text', { attachment_id: sent.attachment.id }]]) {
      const denied = await bounded(client.callTool({ name, arguments: args }), `denied ${name}`);
      assert.equal(denied.isError, true);
      assert.equal(denied.content[0].text, `Error: ${recipientError.error}`);
    }
    for (const route of [`/api/messages/${sent.id}`, `/api/attachments/${sent.attachment.id}`]) {
      assert.deepEqual(await request(`${app.url}${route}`, ip, 'GET', undefined, {
        'X-Forwarded-For': '127.0.0.2', 'X-Real-IP': '127.0.0.2', 'X-Device-Name': 'LegacyB',
      }), { status: 403, data: recipientError });
    }
  }
  assert.equal(snapshot(f.dbPath).messages[0].read_at, null, 'denied reads/marks do not consume recipient unread state');
  const incoming = snapshot(f.dbPath);
  await a.stop(); await b.stop(); await c.stop(); await app.stop();
  app = await server(f, t);
  assert.deepEqual(snapshot(f.dbPath), incoming, 'a different sender\'s incoming message and attachment survive restart');
  b = await mcp(f, t, await relay(f, app.url, '127.0.0.2'));
  assert.deepEqual((await call(b.sdk, 'getmsg', { unread_only: true })).messages.map(row => row.id), [sent.id]);
  assert.equal((await call(b.sdk, 'read_attachment_text', { attachment_id: sent.attachment.id })).text, fs.readFileSync(source, 'utf8'));
  const body = await call(b.sdk, 'read_message', { id: sent.id });
  assert.equal(body.from, 'LegacyA'); assert.equal(body.to, 'LegacyB'); assert.equal(body.markedRead, true);
  assert.equal((await call(b.sdk, 'get_unread_summary')).total, 0);
});
