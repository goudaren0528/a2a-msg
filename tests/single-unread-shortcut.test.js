import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SKILL = 'integrations/opencode/skills/team-mailbox-read/SKILL.md';
const COMMAND = 'integrations/opencode/commands/team-mailbox-read.md';
const MCP = 'src/mcp.js';
const normalized = text => text.replace(/\s+/g, ' ');

test('single unread shortcut is wired into skill, command and tool descriptions', () => {
  const skill = normalized(fs.readFileSync(SKILL, 'utf8'));
  const command = normalized(fs.readFileSync(COMMAND, 'utf8'));
  const mcp = fs.readFileSync(MCP, 'utf8');

  // The guidance constant must actually reach tool descriptions, not sit unused.
  assert.match(mcp, /const SINGLE_UNREAD_GUIDANCE = '([^']+)';/);
  for (const name of ['getmsg', 'get_unread_summary']) {
    const registration = mcp.split(`'${name}',`)[1]?.split('mcpServer.tool(')[0];
    assert.ok(registration?.includes('${SINGLE_UNREAD_GUIDANCE}'), `${name}: shared single-unread guidance required`);
  }

  const guidance = mcp.match(/const SINGLE_UNREAD_GUIDANCE = '([^']+)';/)[1];
  for (const phrase of ['unread_only=true', 'cursor omitted or cursor=0', 'messages.length=1', 'hasMore=false',
    'Never apply this shortcut in all mode', 'After cancel, a new request queries again',
    'not runtime enforcement']) {
    assert.ok(guidance.includes(phrase), `guidance: ${phrase}`);
  }

  // Skill and command must state the same preconditions and never weaken them.
  for (const [name, text] of Object.entries({ skill, command })) {
    assert.match(text, /messages\.length=1/, `${name}: exact single-match requirement`);
    assert.match(text, /hasMore=false/, `${name}: completeness requirement`);
    assert.match(text, /unread_only=true/, `${name}: unread-only requirement`);
    assert.match(text, /cursor omitted or cursor=0/, `${name}: fresh-first-page requirement`);
    assert.match(text, /not runtime enforcement|Agent instructions, not runtime enforcement/, `${name}: honest limits`);
  }

  // Explicit safety boundaries that must not regress into silent behaviour.
  for (const phrase of ['No shortcut in all mode', 'never reuse cached uniqueness',
    'Zero matches means no reading/download', 'retry,', 'not a later page']) {
    assert.ok(skill.includes(phrase) || command.includes(phrase), phrase);
  }
  assert.match(skill, /Zero matches means no body read or download/);
  assert.match(skill, /Attachment failure still requires retry \/ explicit skip \/ cancel/);
  assert.match(skill, /Multiple matches or uncertain completeness require native question/);
  assert.match(skill, /All mode never gets this automatic single-result shortcut/);

  // The shortcut must not silently continue reading after an attachment failure.
  assert.match(skill, /never silently continue reading after failure/);
});

test('sender-specific shortcut verifies server-filtered complete page, not a manufactured singleton', () => {
  const skill = normalized(fs.readFileSync(SKILL, 'utf8'));
  const command = normalized(fs.readFileSync(COMMAND, 'utf8'));
  const mcp = fs.readFileSync(MCP, 'utf8');

  assert.match(skill, /sender filter via getmsg `from` before checking this result: uniqueness means the complete server-filtered matching set, not one locally retained row/);
  assert.match(skill, /Never request limit=1 to manufacture a single-message page; use the normal browsing limit=10/);
  assert.match(command, /specified sender, pass `from` to getmsg and test uniqueness on the complete server-filtered result; never use limit=1 to force apparent uniqueness \(use the normal limit=10\)/);
  assert.match(mcp, /For a specified sender pass from to getmsg and check the complete server-filtered matching set, never a locally retained row; use normal limit=10, not limit=1 to force apparent uniqueness/);
  assert.match(mcp, /if \(params\.from\) searchParams\.set\('from', params\.from\)/);
  assert.match(skill, /messages\.length=1 and hasMore=false/);
  assert.match(command, /messages\.length=1 and hasMore=false/);
  assert.match(mcp, /messages\.length=1 and hasMore=false/);
});

test('sidebar explicit ID bypasses repeated selection, not metadata or attachment handling', () => {
  const skill = normalized(fs.readFileSync(SKILL, 'utf8'));
  const command = normalized(fs.readFileSync(COMMAND, 'utf8'));
  const mcp = fs.readFileSync(MCP, 'utf8');

  assert.match(skill, /sidebar click that submits the fixed instruction `读取消息ID n`[^.]*is explicit-ID direct-read intent: the clicked ID already selects the message, so do not ask a redundant candidate-selection question/);
  assert.match(skill, /Still resolve that exact ID and attachment\.id from getmsg metadata before receiving the attachment and reading the body/);
  assert.match(command, /sidebar click submits only `读取消息ID n` with the real clicked ID; this is explicit-ID direct-read intent, so do not ask a duplicate candidate-selection question/);
  assert.match(command, /Still locate its attachment\.id via getmsg before receiving it and reading the body/);
  assert.match(mcp, /sidebar click instruction 读取消息ID n with the actual clicked ID is explicit-ID direct-read intent and needs no redundant selection: resolve exact-ID attachment metadata via getmsg, then save attachments before reading the body/);
  assert.match(skill, /A missing\/stale ID does not authorize a different message\. Cancellation and attachment-failure choices remain unchanged/);
  assert.match(command, /Missing IDs, cancellation and attachment failures follow the skill's existing safety paths; never substitute another message/);
  assert.match(mcp, /Missing IDs must not select another message; cancellation and attachment failure paths still apply/);
});

test('all-mode one-row history still requires selection except for direct ID', () => {
  const skill = normalized(fs.readFileSync(SKILL, 'utf8'));
  const command = normalized(fs.readFileSync(COMMAND, 'utf8'));
  const mcp = fs.readFileSync(MCP, 'utf8');

  assert.match(skill, /single historical result in all mode still needs selection unless the request directly specifies the ID to read/);
  assert.match(command, /In all\/history mode, even one result needs selection unless the request directly specifies its ID/);
  assert.match(mcp, /In all\/history mode even one result needs selection unless an explicit ID is specified for direct reading/);
  for (const text of [skill, command, mcp]) assert.match(text, /not runtime enforcement/);
});
