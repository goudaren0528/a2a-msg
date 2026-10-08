import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('capabilities describes every published tool without contacting the center', async t => {
  let requests = 0;
  const server = http.createServer((_req, res) => { requests++; res.end('{}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve('src/mcp.js')],
    env: { MSG_SERVER_URL: `http://127.0.0.1:${server.address().port}` },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'capability-test', version: '1.0.0' });
  t.after(async () => { await client.close(); await transport.close(); });
  await client.connect(transport);

  const { tools } = await client.listTools();
  const schema = tools.find(tool => tool.name === 'capabilities').inputSchema;
  assert.deepEqual(schema.properties, {});
  const invoke = async () => {
    const result = await client.callTool({ name: 'capabilities', arguments: {} });
    assert.notEqual(result.isError, true);
    return JSON.parse(result.content[0].text);
  };
  const first = await invoke();
  assert.deepEqual(first, await invoke(), 'overview is deterministic');
  assert.deepEqual(first.tools.toSorted(), tools.map(tool => tool.name).toSorted());
  assert.equal(first.tools.length, 12);
  assert.deepEqual(Object.values(first.groups).flat().toSorted(), first.tools.toSorted());
  assert.equal(first.workOrders.titleFormat, '[WORK:v1][FIX|QA][TEST|BUGFIX|TEST_FIX][ticket_id] summary');
  assert.deepEqual(first.workOrders.roles, { QA: ['TEST'], FIX: ['TEST', 'BUGFIX', 'TEST_FIX'] });
  assert.match(first.workOrders.revision, /body, not the title/);
  assert.match(first.workOrders.dedup, /Different ticket_id.*without body reads/);
  assert.match(first.boundaries.unreadMetadata, /no project.*absence does not prove/i);
  assert.match(first.boundaries.agents, /soft isolation only, not identity isolation/);
  assert.match(first.boundaries.authority, /not runtime enforcement/);
  assert.equal(requests, 0, 'discovery and repeated calls make no HTTP requests');
});
