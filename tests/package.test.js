import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { nodeVersionError } from '../bin/a2a-msg.mjs';

const ROOT = resolve('.');
const BIN = resolve('bin/a2a-msg.mjs');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

function runBin(args, options = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 60000, ...options,
  });
}

function runNpm(args, options = {}) {
  return spawnSync(NPM, args, { cwd: ROOT, encoding: 'utf8', timeout: 120000, ...options });
}

// Every regular file under a top-level directory, as posix-style package paths.
function listFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...listFiles(relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

function packedFiles(result) {
  assert.equal(result.status, 0, `npm pack failed: ${result.stderr}`);
  const [pack] = JSON.parse(result.stdout);
  return { pack, paths: new Set(pack.files.map(file => file.path)) };
}

test('package.json maps the a2a-msg bin and packages bin/, src/ and scripts/', () => {
  assert.deepEqual(pkg.bin, { 'a2a-msg': 'bin/a2a-msg.mjs' });
  for (const entry of ['bin/', 'scripts/', 'src/']) {
    assert.ok(pkg.files.includes(entry), `files must include ${entry}`);
  }
  assert.equal(pkg.engines.node, '>=24 <25');
  assert.equal(pkg.private, true, 'the package is distributed from git/tarball, not npm');

  const info = statSync(BIN);
  assert.ok(info.isFile());
  assert.ok((info.mode & 0o111) !== 0, 'bin/a2a-msg.mjs must be executable');
  assert.equal(readFileSync(BIN, 'utf8').split('\n')[0], '#!/usr/bin/env node');
});

test('help commands print usage and exit 0', () => {
  for (const args of [['--help'], ['-h'], ['mcp', '--help'], ['register', '--help'], ['join', '--help'],
    ['invite', '--help']]) {
    const result = runBin(args);
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
    assert.match(result.stdout, /Usage:/);
    assert.equal(result.stderr, '');
  }
  assert.match(runBin(['--help']).stdout, /a2a-msg mcp --config/);
  assert.match(runBin(['--help']).stdout, /a2a-msg register --center/);
  assert.match(runBin(['--help']).stdout, /a2a-msg join </);
  assert.match(runBin(['mcp', '--help']).stdout, /--download-dir/);
  assert.match(runBin(['register', '--help']).stdout, /--state-dir/);
  assert.match(runBin(['register', '--help']).stdout, /--ca-url/);
  assert.match(runBin(['join', '--help']).stdout, /#invite=/);
  assert.match(runBin(['join', '--help']).stdout, /--state-dir/);
  assert.match(runBin(['--help']).stdout, /a2a-msg invite --config/);
  assert.match(runBin(['invite', '--help']).stdout, /--config/);
  assert.match(runBin(['invite', '--help']).stdout, /--revoke/);
});

test('mcp, register, join and invite forward to the existing scripts', () => {
  const mcp = runBin(['mcp']);
  assert.equal(mcp.status, 1, 'missing --config must fail');
  assert.match(mcp.stderr, /"code":"INVALID_REQUEST"/);

  const register = runBin(['register']);
  assert.equal(register.status, 1, 'missing required flags must fail');
  assert.match(register.stderr, /"code":"INVALID_ARGUMENTS"/);
  assert.match(register.stderr, /scripts\/im-register\.mjs/);

  const join = runBin(['join']);
  assert.equal(join.status, 1, 'missing link must fail');
  assert.match(join.stderr, /"code":"INVALID_ARGUMENTS"/);
  assert.match(join.stderr, /--join/);

  const unpinned = runBin(['join', 'https://localhost:8787/join#invite=' + 'a'.repeat(43)]);
  assert.equal(unpinned.status, 1, 'a join link without a CA fingerprint must fail');
  assert.match(unpinned.stderr, /"code":"INVALID_JOIN_LINK"/);

  const invite = runBin(['invite']);
  assert.equal(invite.status, 1, 'missing --config must fail');
  assert.match(invite.stderr, /"code":"INVALID_ARGUMENTS"/);
  assert.match(invite.stderr, /scripts\/im-invite\.mjs/);

  const badRevoke = runBin(['invite', '--config', '/nonexistent/nana.json', '--revoke', 'not-a-uuid']);
  assert.equal(badRevoke.status, 1);
  assert.match(badRevoke.stderr, /"code":"INVALID_ARGUMENTS"/);
});

test('unknown or missing subcommands fail with a fixed code', () => {
  for (const args of [[], ['bogus'], ['mcp', '--help', 'extra']]) {
    const result = runBin(args);
    if (args[0] === 'mcp') {
      // Extra arguments are forwarded; the stdio entry reports its own fixed code.
      assert.equal(result.status, 1);
      continue;
    }
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.stderr, /"code":"INVALID_ARGUMENTS"/);
    assert.match(result.stderr, /Usage:/);
  }
});

test('the Node version gate requires the 24.x line', () => {
  assert.equal(nodeVersionError('24.0.0'), null);
  assert.equal(nodeVersionError('v24.22.2'), null);
  for (const version of ['22.11.0', '23.9.0', '25.0.0', 'v20.1.2', 'not-a-version']) {
    assert.equal(nodeVersionError(version), 'NODE_VERSION_UNSUPPORTED', version);
  }
});

test('npm pack --dry-run includes every bin/, src/ and scripts/ file', () => {
  const { paths } = packedFiles(runNpm(['pack', '--dry-run', '--json']));
  for (const required of ['package.json', 'bin/a2a-msg.mjs', 'docs/install-npx.md']) {
    assert.ok(paths.has(required), `tarball must include ${required}`);
  }
  for (const directory of ['bin', 'src', 'scripts']) {
    const expected = listFiles(directory);
    assert.ok(expected.length > 0, `${directory}/ should not be empty`);
    for (const file of expected) assert.ok(paths.has(file), `tarball must include ${file}`);
  }
  // Local evidence is gitignored but still lives under docs/; it must not ship.
  for (const path of paths) {
    assert.ok(!/^docs\/delivery\/[^/]+\/(evidence|shots)\//.test(path), `must not pack ${path}`);
    assert.ok(!path.endsWith('.log'), `must not pack ${path}`);
  }
});

test('a packed tarball runs mcp --help without node_modules', () => {
  const temp = mkdtempSync(join(tmpdir(), 'a2a-msg-package-'));
  try {
    const { pack } = packedFiles(runNpm(['pack', '--json', '--pack-destination', temp]));
    const tarball = join(temp, pack.filename);
    const extract = join(temp, 'extract');
    mkdirSync(extract);
    const untar = spawnSync('tar', ['-xzf', tarball, '-C', extract], { encoding: 'utf8', timeout: 60000 });
    assert.equal(untar.status, 0, untar.stderr);

    const packed = join(extract, 'package');
    const packedBin = join(packed, 'bin', 'a2a-msg.mjs');
    assert.ok(existsSync(packedBin), 'tarball must contain bin/a2a-msg.mjs');
    assert.ok(!existsSync(join(packed, 'node_modules')), 'the tarball must not bundle node_modules');

    for (const args of [['--help'], ['mcp', '--help'], ['register', '--help'], ['join', '--help'],
      ['invite', '--help']]) {
      const result = spawnSync(process.execPath, [packedBin, ...args], {
        cwd: extract, encoding: 'utf8', timeout: 60000,
      });
      assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
      assert.match(result.stdout, /Usage:/);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
