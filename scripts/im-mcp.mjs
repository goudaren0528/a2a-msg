#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ImError } from '../src/im/contracts.js';
import { createImMcpStdio, readNanaConfigFile } from '../src/im/mcp-stdio.js';

const usage = [
  'Usage: node scripts/im-mcp.mjs --config <ABSOLUTE_EXISTING_JSON>',
  '',
  'Starts the IM v1 MCP stdio adapter. The host owns the process; there is no',
  'background polling. The config is the strict `nana.json` shared with',
  'scripts/im-nana-session.mjs; the credential is read only from the configured',
  'owner-only (0600) file, never from tool input.',
].join('\n');

function parse(argv) {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) return null;
  if (argv.length !== 2 || argv[0] !== '--config') throw new ImError('INVALID_REQUEST');
  return { configPath: argv[1] };
}

let bridge = null;
async function main(argv) {
  const parsed = parse(argv);
  if (!parsed) { process.stdout.write(`${usage}\n`); return; }
  bridge = createImMcpStdio({ config: readNanaConfigFile(parsed.configPath) });
  const server = new McpServer({ name: 'a2a-msg-im', version: '0.1.0' });
  bridge.register(server);
  const shutdown = () => bridge.close();
  process.once('exit', shutdown);
  process.once('SIGINT', () => { shutdown(); process.exit(0); });
  process.once('SIGTERM', () => { shutdown(); process.exit(0); });
  await server.connect(new StdioServerTransport());
}

process.umask(0o077);
main(process.argv.slice(2)).catch(error => {
  const code = error instanceof ImError ? error.code : 'STORAGE_UNAVAILABLE';
  try { bridge?.close(); } catch { /* ignore */ }
  process.stderr.write(`${JSON.stringify({ error: { code } })}\n`);
  process.exitCode = 1;
});
