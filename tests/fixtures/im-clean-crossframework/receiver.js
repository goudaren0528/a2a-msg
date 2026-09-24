import https from 'node:https';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createImMcpAdapter } from '../../../src/im/mcp-adapter.js';
import { createImJournal } from '../../../src/im/journal.js';

// Test-only installer/bridge, not a new SDK or a production entrypoint. The
// adapter's injectable transport forwards real HTTPS requests (including POST
// bodies); it does not implement authentication, message state or ACK semantics.
process.umask(0o077);
process.send({ phase: 'ready', pid: process.pid,
  clean: process.cwd() === process.env.HOME && process.env.HOME === process.env.USERPROFILE &&
    !process.env.NODE_OPTIONS && !process.env.NODE_PATH && !process.env.OPENCODE_CONFIG });
process.once('message', async config => {
  const db = new DatabaseSync(config.journal);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
  const agent = new https.Agent({ ca: readFileSync(config.ca), rejectUnauthorized: true });
  const active = new Set();
  const transport = input => new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const req = https.request(new URL(input.path, config.serverUrl), {
      method: input.method, agent, family: 4, timeout: 10000,
      headers: { Authorization: `Bearer ${input.credential}`, ...input.headers,
        ...(input.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    }, res => {
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 16 * 1024 * 1024) req.destroy(Error('response limit'));
        else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('aborted', () => reject(Error('response aborted')));
      res.on('end', () => res.complete ? resolve({ status: res.statusCode, body: Buffer.concat(chunks) }) : reject(Error('incomplete response')));
    });
    const deadline = setTimeout(() => req.destroy(Error('request deadline')), 12000);
    active.add(req);
    req.on('close', () => { clearTimeout(deadline); active.delete(req); });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(Error('request timeout')));
    req.end(input.body);
  });
  const adapter = createImMcpAdapter({ serverUrl: config.serverUrl, agentId: config.agentId,
    getCredential: async () => config.credential, attachmentDirectory: config.attachments,
    journal: scope => createImJournal({ db, ...scope }), transport });
  const server = new McpServer({ name: 'isolated-im-adapter', version: '1.0.0' });
  adapter.register(server);
  await server.connect(new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 262144 }));
  process.stdin.once('end', async () => {
    adapter.close();
    for (const req of active) req.destroy();
    agent.destroy();
    await server.close();
    db.close();
    if (process.connected) process.disconnect();
  });
  process.send({ phase: 'configured' });
});
// Unexpected failures are deliberately safe and never written to protocol stdout.
process.on('uncaughtException', () => { process.stderr.write('bridge failed\n'); process.exit(1); });
process.on('unhandledRejection', () => { process.stderr.write('bridge rejected\n'); process.exit(1); });
