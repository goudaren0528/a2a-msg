import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fixture, relay, cleanup, temp, sha256 } from './helpers.js';

async function client(t, url, env = {}, script = path.resolve('src/mcp.js')) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [script],
    env: { MSG_SERVER_URL: url, MSG_DEVICE_NAME: 'remark-only', MSG_DOWNLOAD_DIR: '', ...env }, stderr: 'pipe' });
  const sdk = new Client({ name: 'real-sdk-test', version: '1.0.0' });
  cleanup(t, async () => { await sdk.close(); await transport.close(); });
  await sdk.connect(transport);
  return sdk;
}
async function call(sdk, name, args = {}) {
  const res = await sdk.callTool({ name, arguments: args });
  assert.ok(!res.isError, res.content?.[0]?.text);
  return JSON.parse(res.content[0].text);
}

test('receive_attachment single-property schema survives all-required adaptation and receives into isolated package root', async t => {
  const f = await fixture(t); const root = temp(t);
  // A real copied bridge resolves its own package root, without touching production downloads.
  fs.mkdirSync(path.join(root, 'src'));
  for (const name of ['mcp.js', 'mcp-limits.js', 'attachment-save.js', 'config.js', 'url.js']) {
    fs.copyFileSync(path.join('src', name), path.join(root, 'src', name));
  }
  fs.copyFileSync('package.json', path.join(root, 'package.json'));
  const downloads = path.join(fs.realpathSync(root), 'downloads');
  const a = await client(t, await relay(t, f.url, '127.0.0.1'));
  const url = await relay(t, f.url, '127.0.0.2');
  const b = await client(t, url, {}, path.join(root, 'src/mcp.js'));
  const { tools } = await b.listTools();
  const schema = tools.find(tool => tool.name === 'receive_attachment').inputSchema;
  assert.deepEqual(Object.keys(schema.properties), ['attachment_id']);
  assert.deepEqual(schema.required, ['attachment_id']);
  t.diagnostic(`receive_attachment SDK schema: ${JSON.stringify(schema)}`);
  assert.equal(schema.additionalProperties, false);
  const adapted = { ...schema, required: Object.keys(schema.properties) };
  assert.deepEqual(adapted, schema, 'requiring every property leaves this schema unchanged');
  assert.equal(fs.existsSync(downloads), false, 'startup and listTools never create downloads');
  for (const args of [{}, { attachment_id: 0 }, { attachment_id: 1.5 }, { attachment_id: null }]) {
    assert.equal((await b.callTool({ name: 'receive_attachment', arguments: args })).isError, true);
  }
  assert.equal(fs.existsSync(downloads), false, 'invalid input does not create downloads');
  const source = path.join(root, '合成附件.md');
  const bytes = Buffer.from('isolated receive fixture 😀'); fs.writeFileSync(source, bytes);
  const sent = await call(a, 'send_file', { to: 'B', path: source, text: 'synthetic unread body' });
  const args = { attachment_id: sent.attachment.id };
  assert.ok(adapted.required.every(key => Object.hasOwn(args, key)));
  const first = await call(b, 'receive_attachment', args);
  const second = await call(b, 'receive_attachment', args);
  const results = [first, second, ...await Promise.all(Array.from({ length: 8 }, () => call(b, 'receive_attachment', args)))];
  assert.equal(new Set(results.map(r => r.path)).size, 10);
  for (const r of results) {
    assert.equal(path.dirname(r.path), downloads);
    assert.equal(r.autoNamed, true); assert.equal(r.overwritten, false);
    assert.equal(r.sha256, sha256(bytes)); assert.deepEqual(fs.readFileSync(r.path), bytes);
    assert.match(r.name, /^合成附件__A-to-B__/);
  }
  const override = temp(t);
  const overridden = await client(t, url, { MSG_DOWNLOAD_DIR: override });
  assert.equal(path.dirname((await call(overridden, 'receive_attachment', args)).path), fs.realpathSync(override));
  const broken = await client(t, url, { MSG_DOWNLOAD_DIR: path.join(root, 'missing-override') });
  assert.equal((await broken.callTool({ name: 'receive_attachment', arguments: args })).isError, true);
  assert.equal((await b.callTool({ name: 'receive_attachment', arguments: { attachment_id: 999999 } })).isError, true);
  const denied = await client(t, await relay(t, f.url, '127.0.0.3'), { MSG_DOWNLOAD_DIR: override });
  assert.equal((await denied.callTool({ name: 'receive_attachment', arguments: args })).isError, true);
  assert.equal((await call(b, 'getmsg', { unread_only: true })).messages[0].id, sent.id);
  assert.equal((await call(b, 'get_unread_summary')).total, 1, 'success and failures never mark read');
  assert.equal(fs.readdirSync(downloads).length, 10, 'no leftover staging or overwritten copies');
});

test('receive_attachment rejects corrupt download over real SDK without publishing or reading body', async t => {
  const dir = temp(t); const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ name: 'synthetic.md', data_base64: Buffer.from('corrupt').toString('base64'), sha256: sha256(Buffer.from('expected')) }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup(t, () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const sdk = await client(t, `http://127.0.0.1:${server.address().port}`, { MSG_DOWNLOAD_DIR: dir });
  const result = await sdk.callTool({ name: 'receive_attachment', arguments: { attachment_id: 1 } });
  assert.equal(result.isError, true); assert.match(result.content[0].text, /SHA-256/);
  assert.deepEqual(requests, ['/api/attachments/1'], 'no body or mark-read request');
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('SDK default inbox schema, concurrent saves and failures do not mark messages read', async t => {
  const f = await fixture(t); const dir = temp(t);
  const a = await client(t, await relay(t, f.url, '127.0.0.1'));
  const url = await relay(t, f.url, '127.0.0.2');
  const b = await client(t, url, { MSG_DOWNLOAD_DIR: dir });
  const unset = await client(t, url, { MSG_DOWNLOAD_DIR: path.join(dir, 'missing-override') });
  const schema = (await b.listTools()).tools.find(tool => tool.name === 'save_attachment').inputSchema;
  assert.deepEqual(schema.required, ['attachment_id']);
  const sent = await call(a, 'send_file', { to: 'B', path: path.resolve('package.json') });
  const args = { attachment_id: sent.attachment.id };
  assert.equal((await unset.callTool({ name: 'save_attachment', arguments: args })).isError, true);
  const results = await Promise.all(Array.from({ length: 8 }, () => call(b, 'save_attachment', { ...args, overwrite: true })));
  assert.equal(new Set(results.map(r => r.path)).size, 8);
  assert.ok(results.every(r => r.autoNamed && !r.overwritten));
  assert.equal((await call(b, 'get_unread_summary')).total, 1, 'saving never reads the empty body');
  // A directory at an explicit file target forces final publication to fail.
  assert.equal((await b.callTool({ name: 'save_attachment', arguments: { ...args, path: dir, overwrite: true } })).isError, true);
  assert.equal((await b.callTool({ name: 'save_attachment', arguments: { attachment_id: 999999 } })).isError, true);
  assert.equal((await call(b, 'get_unread_summary')).total, 1, 'download/write failures do not mark read');
  assert.equal(fs.readdirSync(dir).length, 8, 'failure staging cleaned');
  assert.equal((await call(b, 'read_message', { id: sent.id })).markedRead, true);
});

test('Real SDK stdio A/B/C via real source-bound relays, twelve tools and prefix', async t => {
  const f = await fixture(t);
  const a = await client(t, await relay(t, f.url, '127.0.0.1', '/prefix'));
  const b = await client(t, await relay(t, f.url, '127.0.0.2'));
  const c = await client(t, await relay(t, f.url, '127.0.0.3'));
  const { tools } = await a.listTools();
  assert.deepEqual(tools.map(x => x.name).sort(), ['capabilities', 'get_unread_summary', 'getmsg', 'list_peers', 'mark_read', 'read_attachment_text', 'read_message', 'receive_attachment', 'save_attachment', 'send_file', 'send_message', 'unread_metadata']);
  assert.equal(tools.length, 12, 'eleven previous tools plus capabilities');
  for (const name of ['send_message', 'getmsg', 'read_message', 'send_file', 'save_attachment', 'receive_attachment', 'read_attachment_text', 'unread_metadata']) {
    assert.match(tools.find(x => x.name === name).description, /untrusted data/);
  }
  assert.deepEqual((await call(a, 'list_peers')).map(x => x.name), ['A', 'B', 'C']);
  const { id } = await call(a, 'send_message', { to: 'B', text: '自由文本😀'.repeat(500), project: 'demo' });
  await call(a, 'send_message', { to: 'B', text: 'second', project: 'demo' });
  const page = await call(b, 'getmsg', { limit: 1, project: 'demo', unread_only: true });
  assert.equal(page.messages[0].id, id); assert.equal(page.messages[0].from, 'A'); assert.equal(page.hasMore, true);
  assert.equal((await call(b, 'getmsg', { cursor: page.nextCursor, limit: 1 })).messages.length, 1);
  // A 10-code-unit page of a long body is a partial read, so it must not mark.
  const partial = await call(b, 'read_message', { id, limit: 10 });
  assert.equal(partial.read, false);
  assert.equal(partial.markedRead, false);
  assert.equal(partial.hasMore, true);
  assert.equal((await call(b, 'getmsg', { unread_only: true })).messages.length, 2);
  assert.equal((await call(c, 'getmsg')).messages.length, 0);
  assert.equal((await c.callTool({ name: 'read_message', arguments: { id } })).isError, true);
  assert.equal((await call(c, 'mark_read', { ids: [id] })).markedCount, 0);
  assert.equal((await call(b, 'mark_read', { ids: [id] })).markedCount, 1);

  // reply_to is gone from both send tools' published schemas and from every response.
  for (const name of ['send_message', 'send_file']) {
    const schema = tools.find(x => x.name === name).inputSchema;
    assert.equal('reply_to' in (schema.properties ?? {}), false, `${name} must not publish reply_to`);
    assert.equal(JSON.stringify(schema).includes('reply_to'), false, `${name} schema mentions reply_to`);
  }
  await call(b, 'send_message', { to: 'A', text: '后续说明', project: 'demo' });
  const inboxA = (await call(a, 'getmsg')).messages[0];
  assert.equal('replyTo' in inboxA, false, 'getmsg must not return replyTo');
  assert.equal('replyTo' in (await call(a, 'read_message', { id: inboxA.id })), false, 'read_message must not return replyTo');
});

test('Real SDK stdio get_unread_summary and read-to-end auto mark', async t => {
  const f = await fixture(t);
  const a = await client(t, await relay(t, f.url, '127.0.0.1'));
  const b = await client(t, await relay(t, f.url, '127.0.0.2'));
  const c = await client(t, await relay(t, f.url, '127.0.0.3'));

  const { tools } = await b.listTools();
  const summaryTool = tools.find(x => x.name === 'get_unread_summary');
  assert.deepEqual(Object.keys(summaryTool.inputSchema.properties ?? {}), [], 'the tool takes no parameters');
  assert.match(summaryTool.description, /OVERVIEW, NOT message content/);
  assert.match(tools.find(x => x.name === 'read_message').description, /marks the message as read automatically/);
  assert.doesNotMatch(tools.find(x => x.name === 'read_message').description,
    /DOES NOT mark message as read/, 'the old no-auto-read claim is gone');

  assert.equal((await call(b, 'get_unread_summary')).total, 0);

  const long = '很长的正文😀'.repeat(300);
  const { id: longId } = await call(a, 'send_message', { to: 'B', text: long, project: 'demo' });
  await call(a, 'send_file', { to: 'B', path: path.resolve('package.json'), text: '带附件' });
  await call(c, 'send_message', { to: 'B', text: '来自 C' });

  const summary = await call(b, 'get_unread_summary');
  assert.equal(summary.total, 3);
  assert.equal(summary.attachments, 1);
  assert.deepEqual(summary.senders.map(s => s.name), ['C', 'A']);
  assert.equal(summary.senders.find(s => s.name === 'A').count, 2);
  assert.equal(JSON.stringify(summary).includes('很长的正文'), false, 'no body text in the overview');
  assert.equal(JSON.stringify(summary).includes('demo'), false, 'no project tag in the overview');

  // Each member's bridge reports only its own inbox; senders see nothing of what they sent.
  assert.equal((await call(a, 'get_unread_summary')).total, 0);
  assert.equal((await call(c, 'get_unread_summary')).total, 0);
  await call(b, 'send_message', { to: 'A', text: '回给 A' });
  assert.equal((await call(a, 'get_unread_summary')).total, 1);
  assert.deepEqual((await call(a, 'get_unread_summary')).senders.map(s => s.name), ['B']);

  // Page through the long body; only the final page marks it read.
  let offset = 0; let joined = ''; let marks = 0;
  for (;;) {
    const chunk = await call(b, 'read_message', { id: longId, offset, limit: 700 });
    joined += chunk.text;
    if (chunk.markedRead) marks++;
    if (!chunk.hasMore) { assert.equal(chunk.read, true); break; }
    assert.equal(chunk.read, false, 'intermediate pages stay unread');
    offset += chunk.limit;
  }
  assert.equal(joined, long, 'paging reproduced the body');
  assert.equal(marks, 1, 'exactly one page triggered the mark');
  assert.equal((await call(b, 'get_unread_summary')).total, 2, 'the summary updates immediately');

  // Re-reading does not mark again, and explicit mark_read finds nothing.
  assert.equal((await call(b, 'read_message', { id: longId })).markedRead, false);
  assert.equal((await call(b, 'mark_read', { ids: [longId] })).markedCount, 0);
  assert.equal((await call(b, 'get_unread_summary')).total, 2);

  // Drain the rest: the file-only message ends at an empty body, C's is one page.
  for (const message of (await call(b, 'getmsg', { unread_only: true })).messages) {
    assert.equal((await call(b, 'read_message', { id: message.id })).markedRead, true);
  }
  const drained = await call(b, 'get_unread_summary');
  assert.equal(drained.total, 0);
  assert.equal(drained.attachments, 0);
  assert.deepEqual(drained.senders, []);
});

test('Real SDK stdio file transfer: send_file to getmsg to save_attachment to read_attachment_text', async t => {
  const f = await fixture(t);
  const a = await client(t, await relay(t, f.url, '127.0.0.1'));
  const b = await client(t, await relay(t, f.url, '127.0.0.2'));
  const c = await client(t, await relay(t, f.url, '127.0.0.3'));
  const dir = temp(t);

  const contents = `# 排查记录\n${'内容行😀\n'.repeat(400)}`;
  const source = path.join(dir, '排查记录.md');
  fs.writeFileSync(source, contents, 'utf8');
  const digest = sha256(fs.readFileSync(source));

  const sent = await call(a, 'send_file', { to: 'B', path: source, title: '记录', text: '见附件', project: 'demo' });
  assert.equal(sent.attachment.name, '排查记录.md');
  assert.equal(sent.attachment.sha256, digest);

  const listed = (await call(b, 'getmsg', { unread_only: true })).messages.at(-1);
  assert.equal(listed.attachment.id, sent.attachment.id);
  assert.equal(listed.attachment.size, sent.attachment.size);
  const attachmentId = listed.attachment.id;
  assert.equal((await call(b, 'read_message', { id: sent.id, limit: 10 })).attachment.sha256, digest);

  // Sender and third party are refused through the real bridge as well.
  for (const sdk of [a, c]) {
    const denied = await sdk.callTool({ name: 'save_attachment', arguments: { attachment_id: attachmentId, path: path.join(dir, 'stolen.md') } });
    assert.equal(denied.isError, true);
    assert.equal(denied.content[0].text.includes('排查记录'), false, 'denial must not leak the file name');
    assert.equal((await sdk.callTool({ name: 'read_attachment_text', arguments: { attachment_id: attachmentId } })).isError, true);
  }
  assert.equal(fs.existsSync(path.join(dir, 'stolen.md')), false);

  const target = path.join(dir, 'saved.md');
  const saved = await call(b, 'save_attachment', { attachment_id: attachmentId, path: target });
  assert.equal(saved.sha256, digest);
  assert.equal(fs.readFileSync(target, 'utf8'), contents, 'saved file matches the source byte-for-byte');

  // Local write guards: refuse overwrite, relative path, and missing parent.
  const clash = await b.callTool({ name: 'save_attachment', arguments: { attachment_id: attachmentId, path: target } });
  assert.equal(clash.isError, true);
  assert.match(clash.content[0].text, /already exists/);
  fs.writeFileSync(target, 'sentinel', 'utf8');
  assert.equal((await b.callTool({ name: 'save_attachment', arguments: { attachment_id: attachmentId, path: target } })).isError, true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'sentinel', 'a refused save leaves the existing file untouched');
  assert.equal((await call(b, 'save_attachment', { attachment_id: attachmentId, path: target, overwrite: true })).sha256, digest);
  assert.equal(fs.readFileSync(target, 'utf8'), contents, 'explicit overwrite replaces the file');

  const relative = await b.callTool({ name: 'save_attachment', arguments: { attachment_id: attachmentId, path: 'relative.md' } });
  assert.equal(relative.isError, true);
  assert.match(relative.content[0].text, /absolute/);
  assert.equal(fs.existsSync(path.resolve('relative.md')), false);

  const missingParent = await b.callTool({ name: 'save_attachment', arguments: { attachment_id: attachmentId, path: path.join(dir, 'no-such-dir', 'x.md') } });
  assert.equal(missingParent.isError, true);
  assert.match(missingParent.content[0].text, /Parent directory does not exist/);

  let joined = ''; let offset = 0;
  for (;;) {
    const chunk = await call(b, 'read_attachment_text', { attachment_id: attachmentId, offset, limit: 900 });
    joined += chunk.text;
    if (!chunk.hasMore) break;
    offset += chunk.limit;
  }
  assert.equal(joined, contents, 'paged preview reproduces the file');

  // send_file local-side guards.
  assert.equal((await a.callTool({ name: 'send_file', arguments: { to: 'B', path: 'rel.md' } })).isError, true);
  assert.equal((await a.callTool({ name: 'send_file', arguments: { to: 'B', path: path.join(dir, 'absent.md') } })).isError, true);
  const emptyFile = path.join(dir, 'empty.md');
  fs.writeFileSync(emptyFile, '');
  assert.equal((await a.callTool({ name: 'send_file', arguments: { to: 'B', path: emptyFile } })).isError, true);

  // A file with no accompanying text still lists with the [文件] summary.
  const fileOnly = await call(a, 'send_file', { to: 'B', path: source });
  const summary = (await call(b, 'getmsg', { cursor: sent.id })).messages.find(m => m.id === fileOnly.id);
  assert.equal(summary.summary, '[文件] 排查记录.md');

  // Binary attachments are downloadable but not previewable as text.
  const binPath = path.join(dir, 'blob.bin');
  fs.writeFileSync(binPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));
  const binSent = await call(a, 'send_file', { to: 'B', path: binPath });
  assert.equal((await b.callTool({ name: 'read_attachment_text', arguments: { attachment_id: binSent.attachment.id } })).isError, true);
  const binTarget = path.join(dir, 'blob-copy.bin');
  assert.equal((await call(b, 'save_attachment', { attachment_id: binSent.attachment.id, path: binTarget })).sha256,
    sha256(fs.readFileSync(binPath)));
  assert.deepEqual(fs.readFileSync(binTarget), fs.readFileSync(binPath));
});

// Attachment downloads get 30s because a 10 MiB transfer over a slow LAN link
// can legitimately exceed 10s; text preview keeps the ordinary 10s budget.
test('Attachment downloads tolerate a slow response that text preview times out on', async t => {
  const dir = temp(t);
  const body = Buffer.from('slow but complete');
  const payload = JSON.stringify({
    id: 1, name: 'slow.md', size: body.length, mime: 'text/markdown', sha256: sha256(body),
    createdAt: new Date().toISOString(), data_base64: body.toString('base64'),
  });

  const DELAY_MS = 11_000; // between the 10s text budget and the 30s attachment budget
  const server = http.createServer((req, res) => {
    setTimeout(() => {
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(payload);
    }, DELAY_MS).unref();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup(t, () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));

  const sdk = await client(t, `http://127.0.0.1:${server.address().port}`);
  const target = path.join(dir, 'slow.md');
  const timed = async (call) => { const at = Date.now(); return { result: await call, ms: Date.now() - at }; };
  const [preview, saved] = await Promise.all([
    timed(sdk.callTool({ name: 'read_attachment_text', arguments: { attachment_id: 1 } })),
    timed(sdk.callTool({ name: 'save_attachment', arguments: { attachment_id: 1, path: target } })),
  ]);

  assert.equal(preview.result.isError, true, 'text preview aborts at the 10s budget');
  assert.ok(preview.ms < DELAY_MS, 'preview failed before the server ever replied');
  assert.ok(saved.ms >= DELAY_MS, 'the download really did wait past the 10s text budget');
  assert.ok(!saved.result.isError, saved.result.content?.[0]?.text);
  assert.equal(JSON.parse(saved.result.content[0].text).sha256, sha256(body));
  assert.deepEqual(fs.readFileSync(target), body);
});

test('Bridge refuses redirects and applies request timeout through real SDK', async t => {
  let mode = 'redirect', followed = false;
  const server = http.createServer((req, res) => {
    if (req.url === '/other') followed = true;
    if (mode === 'redirect') { res.writeHead(302, { Location: '/other' }); res.end(); }
    // Timeout case intentionally keeps response open; cleanup destroys connections.
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup(t, () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const sdk = await client(t, `http://127.0.0.1:${server.address().port}`);
  assert.equal((await sdk.callTool({ name: 'list_peers', arguments: {} })).isError, true);
  assert.equal(followed, false);
  mode = 'timeout'; const start = Date.now();
  assert.equal((await sdk.callTool({ name: 'list_peers', arguments: {} })).isError, true);
  assert.ok(Date.now() - start >= 9000); assert.ok(Date.now() - start < 20000);
});

test('SDK stream response enforces 16 MiB actual bytes, cancels body, and shortens HTTP errors', async t => {
  let mode = 'overflow';
  const server = http.createServer((req, res) => {
    if (mode === 'error') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'SECRET'.repeat(5000) }));
      return;
    }
    if (mode === 'invalid') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('PRIVATE'.repeat(5000));
      return;
    }
    // Chunked response has no trustworthy length and is larger than the response budget.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write(Buffer.alloc(16 * 1024 * 1024, 65));
    res.write(Buffer.alloc(1, 65));
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup(t, () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const sdk = await client(t, `http://127.0.0.1:${server.address().port}`);
  const overflow = await sdk.callTool({ name: 'list_peers', arguments: {} });
  assert.equal(overflow.isError, true);
  assert.match(overflow.content[0].text, /limit/);
  assert.ok(overflow.content[0].text.length < 256);
  mode = 'error';
  const error = await sdk.callTool({ name: 'list_peers', arguments: {} });
  assert.equal(error.isError, true);
  assert.ok(error.content[0].text.length <= 2055);
  mode = 'invalid';
  const invalid = await sdk.callTool({ name: 'list_peers', arguments: {} });
  assert.ok(!invalid.isError);
  assert.ok(invalid.content[0].text.length <= 2060);
});

test('SDK accepts valid 10 MiB base64 attachment under response byte budget', async t => {
  const dir = temp(t);
  const bytes = Buffer.alloc(10 * 1024 * 1024, 0x52);
  const payload = JSON.stringify({ name: 'maximum.bin', data_base64: bytes.toString('base64'), sha256: sha256(bytes) });
  assert.ok(Buffer.byteLength(payload) < 16 * 1024 * 1024);
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(payload);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup(t, () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const sdk = await client(t, `http://127.0.0.1:${server.address().port}`);
  const target = path.join(dir, 'maximum.bin');
  const saved = await call(sdk, 'save_attachment', { attachment_id: 1, path: target });
  assert.equal(saved.sha256, sha256(bytes));
  assert.equal(fs.statSync(target).size, bytes.length);
});

test('SDK send_file accepts exact upload ceiling and rejects one byte above before POST', async t => {
  const dir = temp(t);
  let uploads = 0;
  const server = http.createServer((req, res) => {
    uploads++;
    let received = 0;
    req.on('data', chunk => { received += chunk.length; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ received }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup(t, () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const sdk = await client(t, `http://127.0.0.1:${server.address().port}`);
  const file = path.join(dir, 'edge.bin');
  fs.writeFileSync(file, Buffer.alloc(10 * 1024 * 1024, 0x41));
  const success = await call(sdk, 'send_file', { to: 'B', path: file });
  assert.ok(success.received > 13 * 1024 * 1024);
  assert.equal(uploads, 1);
  fs.appendFileSync(file, Buffer.from([0x42]));
  const rejected = await sdk.callTool({ name: 'send_file', arguments: { to: 'B', path: file } });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /limit/);
  assert.equal(uploads, 1);
});

test('SDK transfer gate refuses 19th operation before I/O while lightweight calls proceed', async t => {
  const dir = temp(t);
  const file = path.join(dir, 'small.bin');
  fs.writeFileSync(file, 'a');
  const held = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/api/peers') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
      return;
    }
    req.resume();
    req.on('end', () => held.push(res));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup(t, () => {
    for (const res of held) if (!res.writableEnded) res.end('{}');
    return new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  });
  const sdk = await client(t, `http://127.0.0.1:${server.address().port}`);
  const calls = Array.from({ length: 18 }, () => sdk.callTool({ name: 'send_file', arguments: { to: 'B', path: file } }));
  try {
    // Both active operations reach HTTP; all 18 calls have already been sent over stdio.
    const started = Date.now();
    while (held.length < 2 && Date.now() - started < 3000) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(held.length, 2);
    const peers = await call(sdk, 'list_peers');
    assert.deepEqual(peers, []);
    const busy = await sdk.callTool({ name: 'send_file', arguments: { to: 'B', path: file } });
    assert.equal(busy.isError, true);
    assert.match(busy.content[0].text, /busy/i);
    assert.equal(held.length, 2, 'overflow does not touch file or network');
  } finally {
    // Drain the queue in sequence; each finish admits exactly the next waiter.
    for (let i = 0; i < 18; i++) {
      const started = Date.now();
      while (held.length <= i && Date.now() - started < 3000) await new Promise(resolve => setTimeout(resolve, 10));
      if (held[i] && !held[i].writableEnded) held[i].end('{}');
    }
    await Promise.all(calls);
  }
  assert.equal(held.length, 18);
});

test('SDK body timeout continues after headers arrive', async t => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{'); // headers have arrived, but body never finishes.
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup(t, () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const sdk = await client(t, `http://127.0.0.1:${server.address().port}`);
  const start = Date.now();
  const result = await sdk.callTool({ name: 'list_peers', arguments: {} });
  assert.equal(result.isError, true);
  assert.ok(Date.now() - start >= 9000 && Date.now() - start < 20000);
});
