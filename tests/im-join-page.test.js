import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  buildJoinPrompt, parseJoinFragment, renderJoinPage, validateJoinDisplayName,
} from '../src/im/join-page.js';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const INVITE = 'Ab9_-'.padEnd(43, 'x');
const HEX = 'f'.repeat(64);
const FRAGMENT = `#invite=${INVITE}&ca=sha256:${HEX}`;
const LINK = `https://center.example/join${FRAGMENT}`;

// ---- fragment parsing (same rules as scripts/im-register.mjs#joinLink) ----

test('join fragment accepts invite+ca in either order and encoded colons', () => {
  assert.deepEqual(parseJoinFragment(FRAGMENT), { ok: true, invite: INVITE, ca: `sha256:${HEX}` });
  assert.deepEqual(parseJoinFragment(`#ca=sha256:${HEX}&invite=${INVITE}`),
    { ok: true, invite: INVITE, ca: `sha256:${HEX}` });
  assert.deepEqual(parseJoinFragment(`#invite=${INVITE}&ca=sha256%3A${HEX}`),
    { ok: true, invite: INVITE, ca: `sha256:${HEX}` });
});

test('join fragment rejects missing, malformed, duplicated and unknown parameters as untrusted input', () => {
  const cases = [
    ['', 'FRAGMENT_MISSING'],
    ['#', 'FRAGMENT_MISSING'],
    [undefined, 'FRAGMENT_MISSING'],
    [`#invite=${INVITE}`, 'FRAGMENT_INVALID'],
    [`#ca=sha256:${HEX}`, 'FRAGMENT_INVALID'],
    [`#ca=sha256:${HEX}&ca=sha256:${HEX}&invite=${INVITE}`, 'FRAGMENT_INVALID'],
    [`#invite=${INVITE}&invite=${INVITE}&ca=sha256:${HEX}`, 'FRAGMENT_INVALID'],
    [`#invite=${INVITE}&ca=sha256:${HEX}&file=x`, 'FRAGMENT_INVALID'],
    ['#invite=' + 'a'.repeat(42) + `&ca=sha256:${HEX}`, 'FRAGMENT_INVALID'],
    [`#invite=${INVITE}&ca=sha256:${HEX.toUpperCase()}`, 'FRAGMENT_INVALID'],
    [`#invite=${INVITE}&ca=md5:${HEX}`, 'FRAGMENT_INVALID'],
    [`#invite=${INVITE}&ca=sha256:${HEX.slice(1)}`, 'FRAGMENT_INVALID'],
    ['#invite=%3Cimg+src%3Dx+onerror%3Dalert(1)%3E&ca=sha256:' + HEX, 'FRAGMENT_INVALID'],
    ['#invite=' + 'a'.repeat(4000) + `&ca=sha256:${HEX}`, 'FRAGMENT_INVALID'],
  ];
  for (const [hash, code] of cases) {
    const parsed = parseJoinFragment(hash);
    assert.equal(parsed.ok, false, String(hash).slice(0, 60));
    assert.equal(parsed.code, code, String(hash).slice(0, 60));
    assert.equal(typeof parsed.message, 'string');
    // The page only ever prints these fixed messages: no input is echoed back.
    assert.equal(/[<>]/.test(parsed.message), false, 'message never echoes fragment markup');
  }
});

// ---- display name (AC-J6) ----

test('display name validation matches the CLI rule: 1–255 characters, no control characters, no default', () => {
  assert.deepEqual(validateJoinDisplayName('office-mac'), { ok: true, code: 'OK', message: '' });
  assert.deepEqual(validateJoinDisplayName('n'.repeat(255)), { ok: true, code: 'OK', message: '' });
  for (const [value, code] of [['', 'EMPTY'], [undefined, 'EMPTY'], ['n'.repeat(256), 'TOO_LONG'],
    ['office\nmac', 'CONTROL'], ['office\u0000mac', 'CONTROL'], ['office\u007f', 'CONTROL']]) {
    const checked = validateJoinDisplayName(value);
    assert.equal(checked.ok, false, String(value));
    assert.equal(checked.code, code, String(value));
  }
  assert.equal(validateJoinDisplayName('带 空格 的名字').ok, true);
});

// ---- prompt ----

test('prompt pins the deployed commit, quotes the whole link and covers every step', () => {
  const prompt = buildJoinPrompt({ commit: COMMIT, link: LINK, displayName: 'office-mac' });
  assert.equal(prompt.includes(`github:goudaren0528/a2a-msg#${COMMIT}`), true);
  assert.equal(prompt.includes(`join "${LINK}"`), true, 'the whole link is quoted');
  assert.equal(prompt.includes(`--display-name 'office-mac'`), true);
  for (const needle of ['node --version', 'v24.x', 'join "', 'shasum -a 256', 'sha256sum',
    `ca=sha256:${HEX}`, 'ca.pem', 'nana.json', 'caFile', 'mcp', '--config', 'im_v1_me', 'im_v1_acquire_lease', 'im_v1_sync', 'im_v1_release_lease',
    'journal-before-ACK', 'CA_FINGERPRINT_MISMATCH', 'CA_NOT_TRUSTED', '不符必须停', 'NODE_EXTRA_CA_CERTS']) {
    assert.equal(prompt.includes(needle), true, `prompt mentions ${needle}`);
  }
  // Never a branch or a moving tag: every npx ref is the exact 40-hex commit.
  for (const match of prompt.matchAll(/a2a-msg#(\S{0,40})/g)) assert.equal(match[1].slice(0, 40), COMMIT);
  assert.equal(/#(?:main|master|develop|feat\/)/.test(prompt), false);
  assert.equal(prompt.includes('<hostname>'), false);
});

test('prompt asks im_v1_me for agentId only and keeps displayName in identity.json', () => {
  const prompt = buildJoinPrompt({ commit: COMMIT, link: LINK, displayName: 'office-mac' });
  const lines = prompt.split('\n');
  const at = lines.findIndex(text => text.includes('im_v1_me'));
  assert.notEqual(at, -1, 'the prompt mentions im_v1_me');
  const step = lines.slice(at, at + 2).join('\n');
  assert.equal(step.includes('只返回 {"agentId"'), true, 'im_v1_me only returns {agentId}');
  assert.equal(step.includes('只有 agentId'), true);
  assert.equal(step.includes('不包含 displayName'), true);
  assert.equal(step.includes('identity.json'), true, 'displayName is read from identity.json');
  // The tool result has no displayName; asking for it would make the agent stop.
  assert.equal(step.includes('displayName 是 office-mac'), false);
});

test('prompt shell-quotes a display name that contains a single quote', () => {
  const prompt = buildJoinPrompt({ commit: COMMIT, link: LINK, displayName: "office-o'ffice" });
  assert.equal(prompt.includes(`--display-name 'office-o'\\''ffice'`), true);
});

test('prompt builder refuses an unpinned, malformed or empty input', () => {
  assert.throws(() => buildJoinPrompt({ commit: 'main', link: LINK, displayName: 'a' }), /INVALID_BUILD_COMMIT/);
  assert.throws(() => buildJoinPrompt({ commit: COMMIT, link: 'https://center.example/join#invite=x', displayName: 'a' }),
    /INVALID_JOIN_LINK/);
  assert.throws(() => buildJoinPrompt({ commit: COMMIT, link: LINK.replace('/join#', '/enroll#'), displayName: 'a' }),
    /INVALID_JOIN_LINK/);
  assert.throws(() => buildJoinPrompt({ commit: COMMIT, link: LINK, displayName: '' }), /INVALID_DISPLAY_NAME/);
  assert.throws(() => buildJoinPrompt({ commit: COMMIT, link: LINK, displayName: 'a\nb' }), /INVALID_DISPLAY_NAME/);
});

// ---- rendered page ----

const scriptOf = html => {
  const matched = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(matched, 'page has one inline script');
  return matched[1];
};

test('page is self-contained, mobile ready and never redirects', () => {
  const html = renderJoinPage({ commit: COMMIT });
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(html, /<meta name="referrer" content="no-referrer">/);
  assert.equal(html.includes(COMMIT), true, 'footer shows the deployed commit');
  assert.equal(html.includes('id="name"'), true, 'name input is on the page');
  for (const external of [/<script[^>]+src=/i, /<link\b/i, /@import/i, /url\(/i, /<img\b/i, /<iframe\b/i]) {
    assert.equal(external.test(html), false, `no external resource: ${external}`);
  }
  const script = scriptOf(html);
  for (const forbidden of [/innerHTML/, /insertAdjacentHTML/, /document\.write/,
    /location\.(?:href\s*=|assign|replace)/, /window\.open/, /history\.(?:push|replace)State/,
    /\bfetch\(/, /XMLHttpRequest/, /sendBeacon/, /new WebSocket/]) {
    assert.equal(forbidden.test(script), false, `page never uses ${forbidden}`);
  }
  assert.equal(script.includes(parseJoinFragment.toString()), true, 'ships the tested parser');
  assert.equal(script.includes(validateJoinDisplayName.toString()), true, 'ships the tested name rule');
  assert.equal(script.includes(buildJoinPrompt.toString()), true, 'ships the tested prompt builder');
  assert.equal(html.includes('placeholder="例如 office-mac"'), true, 'the name field has no default value');
  assert.equal(script.includes('getRandomValues'), false, 'no random default name');
  assert.equal(script.includes('localStorage'), true);
  assert.equal(script.includes('navigator.clipboard'), true);
  assert.equal(script.includes("execCommand('copy')"), true, 'clipboard fallback keeps selection');
  assert.doesNotThrow(() => new Function(script), 'inline script parses');
});

test('page without an injected commit explains the manual path instead of printing a ref', () => {
  const html = renderJoinPage({ commit: null });
  assert.equal(html.includes('未注入'), true);
  assert.equal(/var BUILD_COMMIT = null;/.test(html), true);
  assert.equal(html.includes('&lt;部署提交&gt;'), true, 'manual steps keep an escaped placeholder ref');
  assert.equal(/<[\u4e00-\u9fff]/.test(html), false, 'no placeholder leaks into the markup as a tag');
  assert.equal(/#(?:main|master|develop)/.test(html), false);
  assert.throws(() => renderJoinPage({ commit: 'v1.0.0' }), /INVALID_BUILD_COMMIT/);
  assert.throws(() => renderJoinPage({ commit: '' }), /INVALID_BUILD_COMMIT/);
});

// ---- behaviour in a minimal DOM (no browser needed) ----

const ELEMENT_IDS = ['status', 'prompt-block', 'prompt', 'copy', 'copy-status',
  'name', 'name-status', 'error', 'error-detail'];
const HIDDEN_AT_LOAD = new Set(['prompt-block', 'error']);

function createPage({ hash = FRAGMENT, commit = COMMIT, storage = new Map(), storageThrows = false,
  clipboard = true, execCommandResult = false } = {}) {
  const html = renderJoinPage({ commit });
  const script = scriptOf(html);
  const elements = new Map(ELEMENT_IDS.map(id => [id, {
    id, hidden: HIDDEN_AT_LOAD.has(id), disabled: false, value: '', textContent: '', className: '',
    listeners: {}, selected: false,
    addEventListener(type, handler) { this.listeners[type] = handler; },
    focus() {}, select() { this.selected = true; }, setSelectionRange() {},
  }]));
  const copied = [];
  const sandbox = {
    document: {
      getElementById: id => elements.get(id),
      execCommand: command => (command === 'copy' ? execCommandResult : false),
    },
    location: { origin: 'https://center.example', hash },
    navigator: clipboard ? { clipboard: { writeText: text => { copied.push(text); return Promise.resolve(); } } } : {},
    localStorage: {
      getItem: key => (storageThrows ? (() => { throw new Error('denied'); })() : (storage.has(key) ? storage.get(key) : null)),
      setItem: (key, value) => {
        if (storageThrows) throw new Error('denied');
        storage.set(key, value);
      },
    },
    URLSearchParams,
    crypto: { getRandomValues: bytes => { for (let i = 0; i < bytes.length; i += 1) bytes[i] = i === 0 ? 0x7f : 0x3a; return bytes; } },
    console,
  };
  vm.runInNewContext(script, sandbox);
  const element = id => elements.get(id);
  return { element, copied, storage,
    type(value) { element('name').value = value; element('name').listeners.input(); },
    clickCopy() { return element('copy').listeners.click(); },
  };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

test('valid fragment + name renders the complete prompt and enables copying', async () => {
  const page = createPage({ storage: new Map([['a2a-msg.join.display-name', 'office-mac']]) });
  assert.equal(page.element('error').hidden, true);
  assert.equal(page.element('prompt-block').hidden, false);
  assert.equal(page.element('copy').disabled, false);
  assert.equal(page.element('name').value, 'office-mac', 'a stored name is restored');
  const prompt = page.element('prompt').value;
  assert.equal(prompt.includes(`join "${LINK}"`), true);
  assert.equal(prompt.includes(`a2a-msg#${COMMIT}`), true);
  assert.equal(prompt.includes(`--display-name 'office-mac'`), true);
  assert.match(page.element('status').textContent, /提示词已生成/);

  await page.clickCopy();
  await flush();
  assert.deepEqual(page.copied, [prompt], 'clipboard receives the whole prompt including the name');
  assert.match(page.element('copy-status').textContent, /已复制/);
});

test('editing the name regenerates the prompt and refresh keeps it', async () => {
  const storage = new Map();
  const page = createPage({ storage });
  page.type('office-mac');
  assert.equal(page.element('prompt').value.includes(`--display-name 'office-mac'`), true);
  assert.equal(storage.get('a2a-msg.join.display-name'), 'office-mac');

  const reloaded = createPage({ storage });
  assert.equal(reloaded.element('name').value, 'office-mac', 'input survives a refresh');
  assert.equal(reloaded.element('prompt').value.includes(`--display-name 'office-mac'`), true);
  assert.equal(reloaded.element('copy').disabled, false);
});

test('the name field starts empty and copying stays disabled until a valid name is typed', () => {
  const page = createPage();
  assert.equal(page.element('name').value, '', 'no default name');
  assert.equal(page.element('prompt').value, '');
  assert.equal(page.element('copy').disabled, true, 'empty name disables copying');
  assert.equal(page.element('name-status').className.includes('warn'), false, 'empty is a neutral hint');
  assert.match(page.element('prompt').value, /^$/);
  page.type('office-mac');
  assert.equal(page.element('copy').disabled, false);
  assert.equal(page.element('prompt').value.includes('--display-name'), true);
  page.type('');
  assert.equal(page.element('copy').disabled, true, 'clearing the name disables copying again');
});

test('empty or control-character names disable copying and explain why', () => {
  const page = createPage();
  for (const [bad, pattern, warn] of [['', /不能为空/, false], ['office\u0007', /控制字符/, true]]) {
    page.type(bad);
    assert.equal(page.element('copy').disabled, true, JSON.stringify(bad));
    assert.equal(page.element('prompt').value, '');
    assert.equal(page.element('name-status').className.includes('warn'), warn);
    assert.match(page.element('name-status').textContent, pattern);
  }
  page.type('office-mac');
  assert.equal(page.element('copy').disabled, false);
  assert.equal(page.element('name-status').className.includes('warn'), false);
});

test('clipboard failure falls back to a full selection instead of losing the prompt', async () => {
  const page = createPage({ clipboard: false, execCommandResult: false });
  page.type('office-mac');
  await page.clickCopy();
  await flush();
  assert.equal(page.element('prompt').selected, true, 'the whole text is selected for ⌘C/Ctrl+C');
  assert.match(page.element('copy-status').textContent, /已选中全部文本/);
  assert.equal(page.element('prompt').value.includes(`--display-name 'office-mac'`), true);
});

test('clipboard fallback still copies when execCommand succeeds', async () => {
  const page = createPage({ clipboard: false, execCommandResult: true });
  page.type('office-mac');
  await page.clickCopy();
  await flush();
  assert.match(page.element('copy-status').textContent, /已复制/);
});

test('unavailable localStorage does not break the page', async () => {
  const page = createPage({ storageThrows: true });
  assert.equal(page.element('name').value, '', 'no stored name without storage');
  assert.equal(page.element('copy').disabled, true);
  page.type('office-mac');
  assert.equal(page.element('copy').disabled, false);
  await page.clickCopy();
  await flush();
  assert.equal(page.copied.length, 1);
});

test('missing or invalid fragment and missing commit show errors plus manual steps', () => {
  for (const [options, pattern] of [
    [{ hash: '' }, /没有 #invite/],
    [{ hash: `#invite=${INVITE}` }, /缺少 invite/],
    [{ hash: `#invite=${INVITE}&ca=sha256:${'0'.repeat(63)}` }, /CA 指纹格式不对/],
    [{ commit: null }, /没有注入部署提交号/],
  ]) {
    const page = createPage(options);
    assert.equal(page.element('prompt-block').hidden, true);
    assert.equal(page.element('error').hidden, false);
    assert.match(page.element('error-detail').textContent, pattern);
    assert.match(page.element('status').className, /warn/);
    assert.equal(page.element('status').textContent.includes('手工步骤'), true);
  }
  // Manual steps ship with the page itself (works with or without JavaScript).
  const html = renderJoinPage({ commit: COMMIT });
  for (const needle of ['手工步骤', '指纹不符必须停', 'register --center', '/ca.pem', 'invite --config']) {
    assert.equal(html.includes(needle), true, `manual steps mention ${needle}`);
  }
});
