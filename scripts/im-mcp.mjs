#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ImError } from '../src/im/contracts.js';
import { createImMcpStdio, readNanaConfigFile } from '../src/im/mcp-stdio.js';

const usage = [
  'Usage: node scripts/im-mcp.mjs --config <ABSOLUTE_EXISTING_JSON> [--download-dir <ABSOLUTE_EXISTING_DIR>]',
  '',
  'Starts the IM v1 MCP stdio adapter. The host owns the process; there is no',
  'background polling. The config is the strict `nana.json` shared with',
  'scripts/im-nana-session.mjs; the credential is read only from the configured',
  'owner-only (0600) file, never from tool input.',
  '--download-dir overrides nana.json attachmentDirectory for received files.',
].join('\n');

function parse(argv) {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) return null;
  let configPath, downloadDirectory;
  for (let i = 0; i < argv.length; i += 2) {
    const value = argv[i + 1];
    if (value === undefined) throw new ImError('INVALID_REQUEST');
    if (argv[i] === '--config' && configPath === undefined) configPath = value;
    else if (argv[i] === '--download-dir' && downloadDirectory === undefined) downloadDirectory = value;
    else throw new ImError('INVALID_REQUEST');
  }
  if (configPath === undefined) throw new ImError('INVALID_REQUEST');
  return { configPath, downloadDirectory };
}

let bridge = null;
async function main(argv) {
  const parsed = parse(argv);
  if (!parsed) { process.stdout.write(`${usage}\n`); return; }
  bridge = createImMcpStdio({ config: readNanaConfigFile(parsed.configPath),
    downloadDirectory: parsed.downloadDirectory });
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
