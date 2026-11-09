import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  buildJoinPrompt, buildRemoteMcpConfig, enrollDirect, enrollmentErrorMessage,
  parseJoinFragment, renderJoinPage, validateJoinDisplayName,
} from '../src/im/join-page.js';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const INVITE = 'Ab9_-'.padEnd(43, 'x');
const HEX = 'f'.repeat(64);
const FRAGMENT = `#invite=${INVITE}&ca=sha256:${HEX}`;
const LINK = `https://center.example/join${FRAGMENT}`;
const AGENT_ID = '01234567-89ab-4def-8123-456789abcdef';
const CREDENTIAL_ID = '89abcdef-0123-4567-89ab-cdef01234567';
const CREDENTIAL = `${CREDENTIAL_ID}.${'A'.repeat(43)}`;

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

// ---- direct enrollment (AC-M3) ----

test('remote MCP snippets cover Claude Code, Codex TOML and compact generic JSON', () => {
  const config = buildRemoteMcpConfig({ origin: 'https://center.example', credential: CREDENTIAL });
  assert.equal(config.url, 'https://center.example/mcp');
  assert.equal(config.claude,
    `claude mcp add --transport http a2a-msg https://center.example/mcp --header "Authorization: Bearer ${CREDENTIAL}"`);
  assert.equal(config.codex,
    '[mcp_servers.a2a-msg]\nurl = "https://center.example/mcp"\nhttp_headers = { Authorization = "Bearer ' +
    CREDENTIAL + '" }');
  assert.equal(config.codex.split('\n').length, 3, 'Codex TOML stays within the three-line code block');
  assert.equal(config.json.includes('\n'), false, 'generic JSON is one horizontally scrollable line');
  const generic = JSON.parse(config.json);
  assert.deepEqual(generic, { mcpServers: { 'a2a-msg': { type: 'http', url: 'https://center.example/mcp',
    headers: { Authorization: `Bearer ${CREDENTIAL}` } } } });
  assert.throws(() => buildRemoteMcpConfig({ origin: 'http://center.example', credential: CREDENTIAL }), /INSECURE_ORIGIN/);
  assert.throws(() => buildRemoteMcpConfig({ origin: 'https://center.example', credential: 'bad' }), /INVALID_CREDENTIAL/);
});

test('direct enrollment uses same-origin /api/v1/enroll and returns fixed error codes', async () => {
  const calls = [];
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      calls.push({ url, options });
      return { status: 201, json: async () => ({ agentId: AGENT_ID, credential: CREDENTIAL }) };
    };
    const enrolled = await enrollDirect({ origin: 'https://center.example', invite: INVITE, displayName: 'office-mac' });
    assert.equal(enrolled.ok, true);
    assert.equal(enrolled.agentId, AGENT_ID);
    assert.equal(enrolled.config.claude.includes(CREDENTIAL), true);
    assert.equal(enrolled.config.codex.includes('[mcp_servers.a2a-msg]'), true);
    assert.equal(enrolled.config.codex.includes(CREDENTIAL), true);
    assert.equal(enrolled.config.json.includes(CREDENTIAL), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://center.example/api/v1/enroll');
    assert.equal(calls[0].options.method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].options.body), { inviteCode: INVITE, displayName: 'office-mac' });
    assert.equal(calls[0].options.credentials, 'omit');
    assert.equal(calls[0].options.redirect, 'error');

    for (const [status, code] of [[409, 'INVITE_ALREADY_USED'], [410, 'INVITE_EXPIRED'],
      [404, 'INVITE_NOT_FOUND'], [403, 'INVITE_REVOKED'], [429, 'RATE_LIMITED']]) {
      globalThis.fetch = async () => ({ status, json: async () => ({ error: { code, message: 'server text' } }) });
      const failed = await enrollDirect({ origin: 'https://center.example', invite: INVITE, displayName: 'office-mac' });
      assert.equal(failed.ok, false);
      assert.equal(failed.code, code);
      assert.equal(JSON.stringify(failed).includes('server text'), false, 'server messages are not echoed');
      assert.equal(enrollmentErrorMessage(code).code, code);
    }
    globalThis.fetch = async () => { throw new Error('offline'); };
    assert.equal((await enrollDirect({ origin: 'https://center.example', invite: INVITE,
      displayName: 'office-mac' })).code, 'NETWORK_ERROR');
    globalThis.fetch = async () => ({ status: 201, json: async () => ({ agentId: AGENT_ID }) });
    assert.equal((await enrollDirect({ origin: 'https://center.example', invite: INVITE,
      displayName: 'office-mac' })).code, 'INVALID_RESPONSE');
    assert.equal((await enrollDirect({ origin: 'http://center.example', invite: INVITE,
      displayName: 'office-mac' })).code, 'INSECURE_ORIGIN');
  } finally { globalThis.fetch = original; }
});

// ---- rendered page ----

const scriptOf = html => {
  const matched = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(matched, 'page has one inline script');
  return matched[1];
};

test('page is compact, mobile ready and has only one primary copy area after registration', () => {
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
    /XMLHttpRequest/, /sendBeacon/, /new WebSocket/]) {
    assert.equal(forbidden.test(script), false, `page never uses ${forbidden}`);
  }
  assert.equal(script.includes(parseJoinFragment.toString()), true, 'ships the tested parser');
  assert.equal(script.includes(validateJoinDisplayName.toString()), true, 'ships the tested name rule');
  assert.equal(script.includes(buildJoinPrompt.toString()), true, 'ships the tested prompt builder');
  assert.equal(script.includes(enrollDirect.toString()), true, 'ships the tested direct-enrollment call');
  assert.equal(script.includes(buildRemoteMcpConfig.toString()), true, 'ships the tested MCP snippets');
  assert.equal(script.includes("origin + '/api/v1/enroll'"), true, 'the only network call is same-origin enrollment');
  assert.equal(script.includes("credentials: 'omit'"), true, 'enrollment does not send cookies');
  assert.equal(script.includes("redirect: 'error'"), true, 'enrollment never follows a redirect');
  assert.equal(html.includes('placeholder="例如 office-mac"'), true, 'the name field has no default value');
  assert.equal(script.includes('getRandomValues'), false, 'no random default name');
  assert.equal(script.includes('localStorage'), true);
  assert.equal(script.includes('navigator.clipboard'), true);
  assert.equal(script.includes("execCommand('copy')"), true, 'clipboard fallback keeps selection');
  assert.doesNotThrow(() => new Function(script), 'inline script parses');

  for (const step of ['1 填名字', '2 直接注册', '3 复制配置', '4 粘进宿主'])
    assert.equal(html.includes(step), true, `step bar shows ${step}`);
  assert.equal(html.includes('<details class="more" id="other-ways">'), true, 'other ways starts closed');
  assert.equal(html.includes('<details class="more" id="manual">'), true, 'manual steps start closed');
  assert.equal(html.includes('<textarea id="config" class="config" rows="3" wrap="off"'), true,
    'the primary config is a three-line horizontally scrolling block');
  assert.equal(html.includes('<code id="agent-id">'), true, 'agentId is a single-line code element');
  assert.equal(html.includes('<textarea id="agent-id"'), false, 'agentId no longer occupies a textarea');
  assert.equal(html.includes('min-height:46vh'), false, 'the old tall prompt box is gone');
  assert.equal(html.includes('id="copy-config"'), true);
  assert.equal(html.includes('id="copy-claude"'), false, 'no second Claude copy button');
  assert.equal(html.includes('id="copy-json"'), false, 'no second JSON copy button');
  assert.equal(html.includes('id="copy"'), true, 'the prompt fallback copy stays available');
  assert.equal(html.includes('Windows 请直接用上面的「直接注册」'), true, 'Windows prefers direct registration');
  assert.equal(html.indexOf('直接注册') < html.indexOf('本地 CLI 提示词'), true,
    'the direct path is presented before the npx fallback');
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

const ELEMENT_IDS = ['status', 'name-block', 'name', 'name-status', 'register-block', 'register',
  'register-status', 'result-block', 'agent-id', 'config', 'host-hint', 'copy-config', 'copy-status',
  'host-claude', 'host-codex', 'host-json', 'error', 'error-title', 'error-detail', 'other-ways', 'prompt-block',
  'prompt', 'copy', 'prompt-copy-status', 'manual', 'step-1', 'step-2', 'step-3', 'step-4', 'build-commit'];
const HIDDEN_AT_LOAD = new Set(['result-block', 'error']);

function createPage({ hash = FRAGMENT, commit = COMMIT, storage = new Map(), storageThrows = false,
  clipboard = true, execCommandResult = false, fetchImpl = null, origin = 'https://center.example' } = {}) {
  const html = renderJoinPage({ commit });
  const script = scriptOf(html);
  const elements = new Map(ELEMENT_IDS.map(id => [id, {
    id, hidden: HIDDEN_AT_LOAD.has(id), disabled: id === 'register' || id === 'copy', open: false,
    value: '', textContent: '', className: '', title: '', attributes: {}, listeners: {}, selected: false,
    addEventListener(type, handler) { this.listeners[type] = handler; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    removeAttribute(name) { delete this.attributes[name]; },
    focus() {}, select() { this.selected = true; }, setSelectionRange() {},
  }]));
  const copied = [];
  const fetchCalls = [];
  const fetch = fetchImpl === null ? undefined : async (url, options) => {
    fetchCalls.push({ url, options });
    return fetchImpl(url, options);
  };
  const sandbox = {
    document: {
      getElementById: id => elements.get(id),
      execCommand: command => (command === 'copy' ? execCommandResult : false),
    },
    location: { origin, hash },
    navigator: clipboard ? { clipboard: { writeText: text => { copied.push(text); return Promise.resolve(); } } } : {},
    localStorage: {
      getItem: key => (storageThrows ? (() => { throw new Error('denied'); })() : (storage.has(key) ? storage.get(key) : null)),
      setItem: (key, value) => {
        if (storageThrows) throw new Error('denied');
        storage.set(key, value);
      },
      removeItem: key => {
        if (storageThrows) throw new Error('denied');
        storage.delete(key);
      },
    },
    URLSearchParams,
    crypto: { getRandomValues: bytes => { for (let i = 0; i < bytes.length; i += 1) bytes[i] = i === 0 ? 0x7f : 0x3a; return bytes; } },
    ...(fetch === undefined ? {} : { fetch }),
    console,
  };
  vm.runInNewContext(script, sandbox);
  const element = id => elements.get(id);
  return { element, copied, storage, fetchCalls,
    type(value) { element('name').value = value; element('name').listeners.input(); },
    clickCopy() { return element('copy').listeners.click(); },
    clickRegister() { return element('register').listeners.click(); },
    clickConfigCopy() { return element('copy-config').listeners.click(); },
    clickHost(name) { return element('host-' + name).listeners.click(); },
  };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const activeStep = page => [1, 2, 3, 4].find(step => page.element(`step-${step}`).className.includes('active'));
const expectHost = (page, name) => {
  for (const host of ['claude', 'codex', 'json'])
    assert.equal(page.element(`host-${host}`).attributes['aria-pressed'], host === name ? 'true' : 'false', host);
};

test('valid fragment + name advances to step 2 and keeps the prompt in the closed fallback', async () => {
  const page = createPage({ storage: new Map([['a2a-msg.join.display-name', 'office-mac']]) });
  assert.equal(page.element('error').hidden, true);
  assert.equal(page.element('prompt-block').hidden, false);
  assert.equal(page.element('other-ways').open, false, 'prompt path stays collapsed');
  assert.equal(page.element('copy').disabled, false);
  assert.equal(page.element('name').value, 'office-mac', 'a stored name is restored');
  assert.equal(activeStep(page), 2);
  const prompt = page.element('prompt').value;
  assert.equal(prompt.includes(`join "${LINK}"`), true);
  assert.equal(prompt.includes(`a2a-msg#${COMMIT}`), true);
  assert.equal(prompt.includes(`--display-name 'office-mac'`), true);
  assert.match(page.element('status').textContent, /名字已填好/);

  await page.clickCopy();
  await flush();
  assert.deepEqual(page.copied, [prompt], 'clipboard receives the whole prompt including the name');
  assert.match(page.element('prompt-copy-status').textContent, /已复制/);
});

test('editing the name regenerates the prompt and refresh keeps it', () => {
  const storage = new Map();
  const page = createPage({ storage });
  page.type('office-mac');
  assert.equal(page.element('prompt').value.includes(`--display-name 'office-mac'`), true);
  assert.equal(storage.get('a2a-msg.join.display-name'), 'office-mac');
  assert.equal(activeStep(page), 2);

  const reloaded = createPage({ storage });
  assert.equal(reloaded.element('name').value, 'office-mac', 'input survives a refresh');
  assert.equal(reloaded.element('prompt').value.includes(`--display-name 'office-mac'`), true);
  assert.equal(reloaded.element('register').disabled, false);
  assert.equal(activeStep(reloaded), 2);
});

test('the name field starts empty and step 1/2 follow a valid name', () => {
  const page = createPage();
  assert.equal(page.element('name').value, '', 'no default name');
  assert.equal(page.element('prompt').value, '');
  assert.equal(page.element('prompt-block').hidden, true);
  assert.equal(page.element('copy').disabled, true, 'empty name disables prompt copying');
  assert.equal(page.element('register').disabled, true, 'empty name disables registration');
  assert.equal(page.element('name-status').className.includes('warn'), false, 'empty is a neutral hint');
  assert.equal(activeStep(page), 1);
  assert.equal(page.element('step-1').attributes['aria-current'], 'step');

  page.type('office-mac');
  assert.equal(page.element('register').disabled, false);
  assert.equal(page.element('copy').disabled, false);
  assert.equal(page.element('prompt').value.includes('--display-name'), true);
  assert.equal(activeStep(page), 2);
  assert.equal(page.element('step-1').className.includes('done'), true);

  page.type('');
  assert.equal(page.element('register').disabled, true);
  assert.equal(page.element('copy').disabled, true);
  assert.equal(page.element('prompt').value, '');
  assert.equal(activeStep(page), 1);
});

test('empty or control-character names disable both paths and explain why', () => {
  const page = createPage();
  for (const [bad, pattern, warn] of [['', /不能为空/, false], ['office\u0007', /控制字符/, true]]) {
    page.type(bad);
    assert.equal(page.element('register').disabled, true, JSON.stringify(bad));
    assert.equal(page.element('copy').disabled, true, JSON.stringify(bad));
    assert.equal(page.element('prompt').value, '');
    assert.equal(page.element('name-status').className.includes('warn'), warn);
    assert.match(page.element('name-status').textContent, pattern);
    assert.equal(activeStep(page), 1);
  }
  page.type('office-mac');
  assert.equal(page.element('register').disabled, false);
  assert.equal(page.element('name-status').className.includes('warn'), false);
});

test('clipboard failure falls back to a full selection instead of losing the prompt', async () => {
  const page = createPage({ clipboard: false, execCommandResult: false });
  page.type('office-mac');
  await page.clickCopy();
  await flush();
  assert.equal(page.element('prompt').selected, true, 'the whole text is selected for ⌘C/Ctrl+C');
  assert.match(page.element('prompt-copy-status').textContent, /已选中全部文本/);
  assert.equal(page.element('prompt').value.includes(`--display-name 'office-mac'`), true);
});

test('clipboard fallback still copies when execCommand succeeds', async () => {
  const page = createPage({ clipboard: false, execCommandResult: true });
  page.type('office-mac');
  await page.clickCopy();
  await flush();
  assert.match(page.element('prompt-copy-status').textContent, /已复制/);
});

test('unavailable localStorage does not break the page', async () => {
  const page = createPage({ storageThrows: true });
  assert.equal(page.element('name').value, '', 'no stored name without storage');
  assert.equal(page.element('register').disabled, true);
  page.type('office-mac');
  assert.equal(page.element('register').disabled, false);
  await page.clickCopy();
  await flush();
  assert.equal(page.copied.length, 1);
});

test('direct registration shows one primary config, advances steps and switches hosts', async () => {
  const storage = new Map([['a2a-msg.join.display-name', 'office-mac']]);
  const page = createPage({ storage, fetchImpl: async () => ({ status: 201,
    json: async () => ({ agentId: AGENT_ID, credential: CREDENTIAL }) }) });
  assert.equal(page.element('register').disabled, false);
  assert.equal(activeStep(page), 2);
  await page.clickRegister();
  await flush();
  await flush();

  assert.equal(page.fetchCalls.length, 1);
  assert.equal(page.fetchCalls[0].url, 'https://center.example/api/v1/enroll');
  assert.deepEqual(JSON.parse(page.fetchCalls[0].options.body), { inviteCode: INVITE, displayName: 'office-mac' });
  assert.equal(page.fetchCalls[0].url.includes(CREDENTIAL), false, 'the token is never in a URL');
  assert.equal(page.element('name-block').hidden, true, 'the name form is gone after registration');
  assert.equal(page.element('register-block').hidden, true, 'the register button is gone after registration');
  assert.equal(page.element('result-block').hidden, false);
  assert.equal(page.element('error').hidden, true);
  assert.equal(page.element('agent-id').textContent, AGENT_ID);
  assert.equal(page.element('agent-id').title, AGENT_ID);
  assert.equal(page.element('agent-id').value, '', 'agentId is not a textarea value');
  assert.equal(page.element('config').value,
    `claude mcp add --transport http a2a-msg https://center.example/mcp --header "Authorization: Bearer ${CREDENTIAL}"`);
  assert.match(page.element('host-hint').textContent, /Claude Code/);
  assert.equal(page.element('register-status').textContent, '');
  assert.equal(activeStep(page), 3);
  assert.equal(page.element('step-2').className.includes('done'), true);
  assert.equal(page.element('other-ways').open, false, 'the CLI fallback stays collapsed');
  assert.equal(page.element('manual').open, false, 'manual steps stay collapsed');
  expectHost(page, 'claude');

  page.clickHost('codex');
  assert.equal(page.element('config').value.split('\n').length, 3);
  assert.equal(page.element('config').value.includes('[mcp_servers.a2a-msg]'), true);
  assert.equal(page.element('config').value.includes('http_headers = { Authorization = "Bearer ' + CREDENTIAL + '" }'), true);
  assert.match(page.element('host-hint').textContent, /Codex/);
  expectHost(page, 'codex');
  assert.equal(activeStep(page), 3);
  assert.equal(page.element('copy-status').textContent, '');

  page.clickHost('json');
  const generic = JSON.parse(page.element('config').value);
  assert.deepEqual(generic, { mcpServers: { 'a2a-msg': { type: 'http', url: 'https://center.example/mcp',
    headers: { Authorization: `Bearer ${CREDENTIAL}` } } } });
  assert.equal(page.element('config').value.includes('\n'), false, 'generic JSON is one line');
  assert.match(page.element('host-hint').textContent, /JSON/);
  expectHost(page, 'json');

  const copiedConfig = page.element('config').value;
  await page.clickConfigCopy();
  await flush();
  assert.equal(page.copied.at(-1), copiedConfig, 'copy takes the currently selected host config');
  assert.match(page.element('copy-status').textContent, /已复制/);
  assert.equal(activeStep(page), 4);
  assert.equal(page.element('step-3').className.includes('done'), true);

  page.clickHost('claude');
  assert.equal(activeStep(page), 3, 'switching host resets the copy step');
  assert.equal(page.element('step-4').className, 'step');
  assert.equal(page.element('copy-status').textContent, '');

  for (const value of storage.values()) {
    assert.equal(String(value).includes(CREDENTIAL), false, 'localStorage never contains the token');
    assert.equal(String(value).includes('Bearer'), false);
  }
  assert.equal(page.element('agent-id').textContent.includes('Bearer'), false);

  await page.clickRegister();
  assert.equal(page.fetchCalls.length, 1, 'a successful registration cannot be submitted twice from the same page');

  const reloaded = createPage({ storage, fetchImpl: async () => ({ status: 201,
    json: async () => ({ agentId: AGENT_ID, credential: CREDENTIAL }) }) });
  assert.equal(reloaded.element('result-block').hidden, true, 'refresh hides the one-time token panel');
  assert.equal(reloaded.element('agent-id').textContent, '');
  assert.equal(reloaded.element('config').value, '');
  assert.equal(reloaded.element('name-block').hidden, false, 'the form is back after refresh');
  assert.equal(reloaded.element('register').disabled, false);
  assert.equal(activeStep(reloaded), 2);
});

test('direct registration displays fixed invite errors and keeps the token panel hidden', async () => {
  for (const [status, code] of [[404, 'INVITE_NOT_FOUND'], [409, 'INVITE_ALREADY_USED'],
    [410, 'INVITE_EXPIRED'], [403, 'INVITE_REVOKED'], [429, 'RATE_LIMITED']]) {
    const page = createPage({ storage: new Map([['a2a-msg.join.display-name', 'office-mac']]),
      fetchImpl: async () => ({ status, json: async () => ({ error: { code, message: 'raw server detail' } }) }) });
    await page.clickRegister();
    await flush();
    await flush();
    assert.equal(page.element('result-block').hidden, true);
    assert.match(page.element('register-status').textContent, new RegExp(code));
    assert.equal(page.element('register-status').textContent.includes('raw server detail'), false);
    assert.equal(page.element('register').disabled, false, 'a failed registration stays retryable');
    assert.equal(activeStep(page), 2);
  }
});

test('direct registration is disabled without a valid HTTPS page, invite or name', () => {
  const page = createPage();
  assert.equal(page.element('register').disabled, true, 'no default name means no registration');
  page.clickRegister();
  assert.equal(page.fetchCalls.length, 0);
  page.type('office-mac');
  assert.equal(page.element('register').disabled, false);

  const invalid = createPage({ hash: '' });
  assert.equal(invalid.element('register').disabled, true);
  const http = createPage({ origin: 'http://center.example' });
  assert.equal(http.element('register').disabled, true);
  assert.match(http.element('register-status').textContent, /HTTPS/);
});

test('direct registration still works when the center has no build commit', async () => {
  const page = createPage({ commit: null, fetchImpl: async () => ({ status: 201,
    json: async () => ({ agentId: AGENT_ID, credential: CREDENTIAL }) }) });
  page.type('office-mac');
  assert.equal(page.element('error').hidden, false);
  assert.equal(page.element('error-title').textContent, '本地 CLI 提示词不可用（直接注册仍可用）');
  assert.match(page.element('error-detail').textContent, /没有注入部署提交号/);
  assert.equal(page.element('prompt-block').hidden, true, 'the npx prompt is unavailable without a pinned commit');
  assert.equal(page.element('register').disabled, false, 'direct registration does not need the commit');
  assert.equal(activeStep(page), 2);

  await page.clickRegister();
  await flush();
  await flush();
  assert.equal(page.element('result-block').hidden, false);
  assert.equal(page.element('agent-id').textContent, AGENT_ID);
  assert.equal(activeStep(page), 3);
});

test('missing or invalid fragment shows the reason plus open manual steps', () => {
  for (const [options, pattern] of [
    [{ hash: '' }, /没有 #invite/],
    [{ hash: `#invite=${INVITE}` }, /缺少 invite/],
    [{ hash: `#invite=${INVITE}&ca=sha256:${'0'.repeat(63)}` }, /CA 指纹格式不对/],
  ]) {
    const page = createPage(options);
    assert.equal(page.element('name-block').hidden, true);
    assert.equal(page.element('register-block').hidden, true);
    assert.equal(page.element('prompt-block').hidden, true);
    assert.equal(page.element('error').hidden, false);
    assert.equal(page.element('error-title').textContent, '这条链接不能直接接入');
    assert.match(page.element('error-detail').textContent, pattern);
    assert.equal(page.element('manual').open, true, 'manual steps open on a bad link');
    assert.match(page.element('status').className, /warn/);
    assert.match(page.element('status').textContent, /手工步骤/);
  }
  // Manual steps ship with the page itself (works with or without JavaScript).
  const html = renderJoinPage({ commit: COMMIT });
  for (const needle of ['手工步骤', '指纹不符必须停', 'register --center', '/ca.pem', 'invite --config']) {
    assert.equal(html.includes(needle), true, `manual steps mention ${needle}`);
  }
});
