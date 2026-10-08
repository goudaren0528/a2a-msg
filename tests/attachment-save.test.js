import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { buildTraceableName, saveAttachment, MAX_NAME_ATTEMPTS, MAX_RECEIVED_ATTACHMENT_BYTES } from '../src/attachment-save.js';
import { temp, sha256 } from './helpers.js';

const bytes = Buffer.from('完整内容😀');
const meta = { name: 'notes.md', from: 'A', to: 'B', data_base64: bytes.toString('base64'), sha256: sha256(bytes) };

test('module-root downloads is lazy and independent of caller cwd; packaging excludes received files', async t => {
  const root = temp(t); const elsewhere = temp(t);
  fs.mkdirSync(path.join(root, 'src'));
  fs.copyFileSync('src/attachment-save.js', path.join(root, 'src/attachment-save.mjs'));
  const moduleUrl = pathToFileURL(path.join(root, 'src/attachment-save.mjs')).href;
  const probe = source => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd: elsewhere, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return result.stdout;
  };
  probe(`await import(${JSON.stringify(moduleUrl)});`);
  assert.equal(fs.existsSync(path.join(root, 'downloads')), false, 'import does not mkdir');
  const source = `const {saveAttachment}=await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify(await saveAttachment({},async()=>(${JSON.stringify(meta)}))));`;
  const first = JSON.parse(probe(source)); const second = JSON.parse(probe(source));
  assert.equal(path.dirname(first.path), path.join(fs.realpathSync(root), 'downloads'));
  assert.notEqual(first.path, second.path);
  assert.equal(fs.existsSync(path.join(elsewhere, 'downloads')), false);
  assert.deepEqual(fs.readFileSync(first.path), bytes);
  const ignored = spawnSync('git', ['check-ignore', '--no-index', 'downloads/synthetic-fixture.bin'], { encoding: 'utf8' });
  assert.equal(ignored.status, 0, ignored.stderr);
  assert.match(fs.readFileSync('.dockerignore', 'utf8'), /^downloads\/$/m);
  // Run npm's actual pack selection in an isolated fake checkout, never use real attachments.
  fs.copyFileSync('package.json', path.join(root, 'package.json'));
  const npm = process.env.npm_execpath;
  const pack = npm
    ? spawnSync(process.execPath, [npm, 'pack', '--dry-run', '--json', '--ignore-scripts', '--cache', path.join(root, '.cache')], { cwd: root, encoding: 'utf8' })
    : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' });
  assert.equal(pack.status, 0, pack.stderr);
  assert.ok(!JSON.parse(pack.stdout)[0].files.some(file => file.path.startsWith('downloads/')));
});

test('default downloads refuses file/junction, create denial and leaves only owned failure artifacts cleaned', async t => {
  const root = temp(t); const outside = temp(t); const directory = path.join(root, 'downloads');
  const download = async () => { assert.fail('preflight must fail before download'); };
  fs.writeFileSync(directory, 'sentinel');
  await assert.rejects(saveAttachment({}, download, '', root), /real directory/);
  assert.equal(fs.readFileSync(directory, 'utf8'), 'sentinel'); fs.unlinkSync(directory);
  fs.symlinkSync(outside, directory, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(saveAttachment({}, download, '', root), /symlink/);
  assert.deepEqual(fs.readdirSync(outside), []); fs.unlinkSync(directory);
  t.mock.method(fsp, 'mkdir', async () => { throw Object.assign(new Error('create denied'), { code: 'EACCES' }); });
  try { await assert.rejects(saveAttachment({}, download, '', root), /create denied/); }
  finally { t.mock.restoreAll(); }
  await assert.rejects(saveAttachment({}, async () => { throw new Error('network failed'); }, '', root), /network failed/);
  assert.deepEqual(fs.readdirSync(directory), [], 'lazy directory remains, staging is removed');
  const explicit = path.join(root, 'missing', 'file.md');
  await assert.rejects(saveAttachment({ path: explicit }, download, '', root), /Parent directory/);
  assert.equal(fs.existsSync(path.dirname(explicit)), false, 'explicit paths never mkdir');
});

test('download directory preflight fails before network and preserves explicit path', async t => {
  const dir = temp(t); let downloads = 0;
  const download = async () => { downloads++; return meta; };
  for (const config of ['relative', path.join(dir, 'absent')]) {
    await assert.rejects(saveAttachment({}, download, config));
  }
  const file = path.join(dir, 'existing'); fs.writeFileSync(file, 'sentinel');
  await assert.rejects(saveAttachment({}, download, file), /directory/);
  await assert.rejects(saveAttachment({ path: '' }, download, dir), /absolute/);
  assert.equal(downloads, 0);
  const target = path.join(dir, 'explicit.md');
  assert.equal((await saveAttachment({ path: target }, download, 'bad')).path, target);
  await assert.rejects(saveAttachment({ path: target }, download, dir), /already exists/);
  await saveAttachment({ path: target, overwrite: true }, download);
  assert.deepEqual(fs.readFileSync(target), bytes);
});

test('default directory forces safe flags; concurrent same-name saves never overwrite', async t => {
  const dir = temp(t);
  const results = await Promise.all(Array.from({ length: 20 }, () =>
    saveAttachment({ overwrite: true, auto_name: false }, async () => meta, dir)));
  assert.equal(new Set(results.map(r => r.path)).size, 20);
  assert.ok(results.some(r => /-\d+\.md$/.test(r.name)), 'same-second collisions received retry suffixes');
  for (const r of results) {
    assert.equal(r.autoNamed, true); assert.equal(r.overwritten, false);
    assert.deepEqual(fs.readFileSync(r.path), bytes);
  }
  assert.equal(fs.readdirSync(dir).length, 20, 'no staging artifacts');
});

test('Unicode, long extensions and Windows device names stay safe and byte bounded', () => {
  const from = '中'.repeat(32); const to = '文'.repeat(32);
  const long = buildTraceableName({ name: '😀'.repeat(100) + '.md', from, to }, new Date(), 99);
  assert.ok(long.includes(`__${from}-to-${to}__`), 'valid full member names survive');
  assert.ok(Buffer.byteLength(long) <= 255); assert.ok(long.isWellFormed());
  for (const name of ['中😀'.repeat(200) + '.md', 'x.' + '😀'.repeat(200), 'CON.backup.txt', '../bad:*.md', '\ud800.md']) {
    const value = buildTraceableName({ name, from: '中'.repeat(32), to: '😀'.repeat(32) }, new Date(), 99);
    assert.ok(Buffer.byteLength(value) <= 255);
    assert.ok(value.isWellFormed());
    assert.doesNotMatch(value, /[<>:"/\\|?*\u0000-\u001f]/);
    assert.doesNotMatch(value, /^CON\./i);
    assert.match(value, /-to-/);
  }
});

test('download, hash, partial write and publication failures clean only owned staging', async t => {
  const dir = temp(t); const target = path.join(dir, 'keep.md'); fs.writeFileSync(target, 'sentinel');
  const params = { path: target, overwrite: true };
  await assert.rejects(saveAttachment(params, async () => { throw new Error('download failed'); }), /download failed/);
  await assert.rejects(saveAttachment(params, async () => ({ ...meta, sha256: 'bad' })), /SHA-256/);
  const open = fsp.open;
  t.mock.method(fsp, 'open', async (...args) => {
    const fd = await open(...args);
    const write = fd.writeFile.bind(fd);
    fd.writeFile = async data => { await write(data.subarray(0, 2)); throw new Error('disk full'); };
    return fd;
  });
  await assert.rejects(saveAttachment(params, async () => meta), /disk full/);
  t.mock.restoreAll();
  t.mock.method(fsp, 'rename', async () => { throw new Error('publish denied'); });
  await assert.rejects(saveAttachment(params, async () => meta), /publish denied/);
  t.mock.restoreAll();
  assert.equal(fs.readFileSync(target, 'utf8'), 'sentinel');
  assert.deepEqual(fs.readdirSync(dir), ['keep.md']);
});

for (const overwrite of [false, true]) {
  test(`${overwrite ? 'rename' : 'hardlink'} publication stays successful when staging cleanup fails`, async t => {
    const dir = temp(t);
    const target = path.join(dir, 'saved.md');
    if (overwrite) fs.writeFileSync(target, 'previous');
    let downloads = 0;
    t.mock.method(fsp, 'rm', async () => { throw new Error(`cleanup denied: ${dir}/private-staging`); });
    try {
      const saved = await saveAttachment({ path: target, overwrite }, async () => { downloads++; return meta; });
      assert.equal(saved.path, target);
      assert.equal(saved.sha256, meta.sha256);
      assert.equal(saved.overwritten, overwrite);
      assert.deepEqual(fs.readFileSync(target), bytes);
      assert.equal(downloads, 1);
      // MCP serializes the result directly, so the warning survives its JSON boundary.
      const wire = JSON.parse(JSON.stringify(saved));
      assert.match(wire.cleanupWarning, /saved and verified successfully/);
      assert.match(wire.cleanupWarning, /Do not download again/);
      assert.ok(!wire.cleanupWarning.includes(dir));
      assert.ok(!wire.cleanupWarning.includes('private-staging'));
      assert.ok(fs.readdirSync(dir).some(name => name.startsWith('.team-mailbox-')));
    } finally {
      t.mock.restoreAll();
      // Fault injection intentionally leaves staging; remove only this test's fixture.
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('partial write failure remains the original error when staging cleanup also fails', async t => {
  const dir = temp(t); const target = path.join(dir, 'keep.md');
  fs.writeFileSync(target, 'sentinel');
  const original = Object.assign(new Error('original write failure'), { code: 'ENOSPC' });
  const open = fsp.open;
  t.mock.method(fsp, 'open', async (...args) => {
    const fd = await open(...args);
    const write = fd.writeFile.bind(fd);
    fd.writeFile = async data => { await write(data.subarray(0, 2)); throw original; };
    return fd;
  });
  t.mock.method(fsp, 'rm', async () => { throw new Error('secondary cleanup failure'); });
  try {
    await assert.rejects(saveAttachment({ path: target, overwrite: true }, async () => meta), err => {
      assert.equal(err, original);
      assert.equal(err.code, 'ENOSPC');
      assert.equal(err.message, 'original write failure');
      return true;
    });
    assert.equal(fs.readFileSync(target, 'utf8'), 'sentinel');
  } finally {
    t.mock.restoreAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('exclusive publication retries are bounded; permission failures precede downloads', async t => {
  const dir = temp(t); let calls = 0;
  t.mock.method(fsp, 'link', async () => { calls++; throw Object.assign(new Error('occupied'), { code: 'EEXIST' }); });
  await assert.rejects(saveAttachment({}, async () => meta, dir), /100 attempts/);
  assert.equal(calls, MAX_NAME_ATTEMPTS); assert.deepEqual(fs.readdirSync(dir), []);
  t.mock.restoreAll();
  t.mock.method(fsp, 'access', async () => { throw new Error('permission denied'); });
  await assert.rejects(saveAttachment({}, async () => { assert.fail('must not download'); }, dir), /permission denied/);
});

test('rejects oversized, malformed or inconsistent downloaded bytes before writing', async t => {
  const dir = temp(t); const target = path.join(dir, 'sentinel.md'); fs.writeFileSync(target, 'sentinel');
  const invalid = [null, [], 'text', {}, { ...meta, data_base64: 5 },
    { ...meta, data_base64: 'A'.repeat(4 * Math.ceil(MAX_RECEIVED_ATTACHMENT_BYTES / 3) + 1) },
    { ...meta, data_base64: '!!!' }, { ...meta, data_base64: 'YQ' },
    { ...meta, data_base64: 'YQ==\n' }, { ...meta, size: -1 },
    { ...meta, size: 1.5 }, { ...meta, size: bytes.length + 1 },
    { ...meta, data_base64: Buffer.alloc(MAX_RECEIVED_ATTACHMENT_BYTES + 1).toString('base64') }];
  for (const value of invalid) {
    await assert.rejects(saveAttachment({ path: target, overwrite: true }, async () => value));
    assert.equal(fs.readFileSync(target, 'utf8'), 'sentinel');
    assert.deepEqual(fs.readdirSync(dir), ['sentinel.md']);
  }
  const result = await saveAttachment({ path: target, overwrite: true }, async () => ({ ...meta, size: bytes.length }));
  assert.equal(result.size, bytes.length);
});

test('open, fsync, close, readback, verification and publish failures preserve existing destination', async t => {
  const dir = temp(t); const target = path.join(dir, 'sentinel.md');
  fs.writeFileSync(target, 'sentinel');
  const params = { path: target, overwrite: true };
  for (const stage of ['open', 'sync', 'close', 'readFile', 'hash', 'rename']) {
    const original = new Error(`${stage} failed`);
    if (stage === 'open') t.mock.method(fsp, 'open', async () => { throw original; });
    else if (stage === 'readFile') t.mock.method(fsp, 'readFile', async () => { throw original; });
    else if (stage === 'hash') t.mock.method(fsp, 'readFile', async () => Buffer.from('altered'));
    else if (stage === 'rename') t.mock.method(fsp, 'rename', async () => { throw original; });
    else {
      const open = fsp.open;
      t.mock.method(fsp, 'open', async (...args) => {
        const fd = await open(...args);
        if (stage === 'close') {
          const close = fd.close.bind(fd);
          fd.close = async () => { await close(); throw original; };
        } else fd[stage] = async () => { throw original; };
        return fd;
      });
    }
    try {
      await assert.rejects(saveAttachment(params, async () => meta), stage === 'hash' ? /Written file failed SHA-256/ : err => err === original);
      assert.equal(fs.readFileSync(target, 'utf8'), 'sentinel', stage);
      assert.deepEqual(fs.readdirSync(dir), ['sentinel.md'], stage);
    } finally { t.mock.restoreAll(); }
  }
});

test('hardlink failures never fall back to copying or disturb target', async t => {
  const dir = temp(t); const target = path.join(dir, 'sentinel.md'); fs.writeFileSync(target, 'sentinel');
  const error = Object.assign(new Error('links unavailable'), { code: 'EPERM' });
  t.mock.method(fsp, 'link', async () => { throw error; });
  await assert.rejects(saveAttachment({ path: path.join(dir, 'new.md') }, async () => meta), err => err === error);
  assert.equal(fs.readFileSync(target, 'utf8'), 'sentinel');
  assert.deepEqual(fs.readdirSync(dir), ['sentinel.md']);
});

test('exactly 10 MiB is accepted and persisted with matching bytes and SHA-256', async t => {
  const dir = temp(t);
  const data = Buffer.allocUnsafe(MAX_RECEIVED_ATTACHMENT_BYTES);
  for (let index = 0; index < data.length; index++) data[index] = index % 251;
  const expectedHash = sha256(data);
  const target = path.join(dir, 'limit.bin');
  const saved = await saveAttachment({ path: target }, async () => ({
    name: 'limit.bin', from: 'A', to: 'B', data_base64: data.toString('base64'),
    size: MAX_RECEIVED_ATTACHMENT_BYTES, sha256: expectedHash,
  }));
  assert.equal(saved.size, MAX_RECEIVED_ATTACHMENT_BYTES);
  assert.equal(saved.sha256, expectedHash);
  assert.equal((await fsp.stat(target)).size, MAX_RECEIVED_ATTACHMENT_BYTES);
  assert.deepEqual(await fsp.readFile(target), data);
});

test('close and cleanup errors cannot mask the original write failure', async t => {
  const dir = temp(t); const target = path.join(dir, 'sentinel.md');
  fs.writeFileSync(target, 'sentinel');
  const original = new Error('original write failure');
  const open = fsp.open;
  t.mock.method(fsp, 'open', async (...args) => {
    const fd = await open(...args);
    const close = fd.close.bind(fd);
    fd.writeFile = async () => { throw original; };
    fd.close = async () => { await close(); throw new Error('secondary close failure'); };
    return fd;
  });
  t.mock.method(fsp, 'rm', async () => { throw new Error('secondary cleanup failure'); });
  try {
    await assert.rejects(saveAttachment({ path: target, overwrite: true }, async () => meta), err => err === original);
    assert.equal(fs.readFileSync(target, 'utf8'), 'sentinel');
  } finally {
    t.mock.restoreAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('OpenCode skill/command installation contract and workflow guardrails (static, not UI)', () => {
  const skill = fs.readFileSync('integrations/opencode/skills/team-mailbox-read/SKILL.md', 'utf8');
  const command = fs.readFileSync('integrations/opencode/commands/team-mailbox-read.md', 'utf8');
  assert.match(skill, /^---\r?\nname: team-mailbox-read\r?\ndescription: .+\r?\n---/);
  assert.match(command, /^---\r?\ndescription: .+\r?\n---/);
  assert.match(command, /`team-mailbox-read` skill through the skill tool/);
  assert.match(command, /\$ARGUMENTS/);
  assert.match(skill, /call receive_attachment with only attachment_id/);
  assert.match(skill, /update\/reconnect the client bridge/);
  assert.match(skill, /successful result with cleanupWarning remains successful/);
  assert.doesNotMatch(skill, /call save_attachment with only attachment_id/);
  for (const term of ['multiple=false', 'limit=10', 'RejectedError', 'MSG_DOWNLOAD_DIR', 'hasMore=false',
    'nextCursor/hasMore', 'Do not silently summarize', 'retry only read_message', 'not runtime enforcement']) {
    assert.ok(skill.includes(term), term);
  }
});

test('OpenCode reading guidance preserves routing, selection boundaries and honest UI limits (static, not UI)', () => {
  const skill = fs.readFileSync('integrations/opencode/skills/team-mailbox-read/SKILL.md', 'utf8');
  const command = fs.readFileSync('integrations/opencode/commands/team-mailbox-read.md', 'utf8');
  const mcp = fs.readFileSync('src/mcp.js', 'utf8');
  const normalized = text => text.replace(/\s+/g, ' ');
  for (const [name, text] of Object.entries({ skill, command, mcp })) {
    for (const phrase of ['查看消息', '读消息', '查看某人的消息', 'native question',
      'direct-read intent', 'no redundant selection', 'not runtime enforcement']) {
      assert.ok(normalized(text).includes(phrase), `${name}: ${phrase}`);
    }
    assert.match(text, /TEST.*keywords/, `${name}: TEST alone must not route reading to dispatch`);
  }
  const flow = normalized(skill);
  assert.match(flow, /Browsing multiple messages must use native question before reading or receiving/);
  assert.match(flow, /Do not print candidate messages as an assistant Markdown list or table/);
  assert.match(flow, /unavailable\/disabled when selection is needed, explain the limitation and ask which alternative/);
  assert.match(flow, /Never silently switch to a Markdown message list/);
  assert.match(flow, /Raw getmsg JSON may still be visible/);
  assert.match(flow, /cannot hide it or guarantee collapsed-tool privacy/);
  assert.match(flow, /use getmsg metadata to resolve that exact ID and its attachment.id without reading the body/);
  assert.match(flow, /Do not substitute another message/);
  assert.match(flow, /Never use read_message just to discover attachments/);
  assert.match(flow, /Navigation only calls getmsg/);
  assert.match(flow, /Do not infer IDs from numbers, custom prose, partial titles or unknown answers/);
  assert.match(flow, /Cancel or RejectedError ends cleanly: no read_message, receive_attachment, save_attachment or mark_read/);
  assert.match(flow, /before any read_message call/);
  const entry = normalized(command);
  assert.match(entry, /Browsing multiple messages requires native question, not an assistant Markdown candidate list or table/);
  assert.match(entry, /If question is unavailable, explain the limitation and ask which alternative/);
  assert.match(entry, /never silently downgrade/);
  assert.match(entry, /Raw tool JSON may remain visible.*do not promise to hide it/);
  const guidance = mcp.match(/const READING_GUIDANCE = '([^']+)';/);
  assert.ok(guidance, 'shared reading description exists');
  for (const phrase of ['load team-mailbox-read by name', 'TEST keywords alone do not route reading to dispatch',
    'Browsing multiple messages requires native question before reading or receiving',
    'do not print candidate messages as an assistant Markdown list or table',
    'If question is unavailable, explain the limitation and ask which alternative', 'never silently downgrade',
    'resolve exact-ID attachment metadata via getmsg, then save attachments before reading the body',
    'Navigation/cancel must not read bodies, download attachments or mark read',
    'ambiguous custom answers must not be guessed as IDs', 'Raw tool JSON may remain visible']) {
    assert.ok(guidance[1].includes(phrase), phrase);
  }
  for (const name of ['getmsg', 'get_unread_summary', 'read_message', 'receive_attachment', 'save_attachment', 'read_attachment_text']) {
    const registration = mcp.split(`'${name}',`)[1]?.split('mcpServer.tool(')[0];
    assert.ok(registration?.includes('${READING_GUIDANCE}'), `${name}: shared description required`);
  }
  const receive = mcp.split("'receive_attachment',")[1];
  const schema = receive.match(/\n    \{([\s\S]*?)\n    \},/);
  assert.ok(schema, 'receive_attachment schema exists');
  assert.deepEqual([...schema[1].matchAll(/^\s+(\w+):/gm)].map(match => match[1]), ['attachment_id']);
});
