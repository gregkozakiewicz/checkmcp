#!/usr/bin/env node
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CATEGORIES, listChecks, runBattery, type Category } from './battery.js';
import { render } from './report.js';

const VERSION: string = createRequire(import.meta.url)('../package.json').version;

const USAGE = `checkmcp v${VERSION} · conformance checks for MCP servers

Usage:
  checkmcp <server.js>            spawn a server over stdio and check it
  checkmcp <http(s)://url>        check a running server over HTTP
  checkmcp --list                 every check, with the spec section it enforces

Options:
  --only <category>               one of: ${CATEGORIES.join(', ')}

The errors and robustness categories call tools with deliberately broken
arguments. Point checkmcp at a development instance, not production.

Exit codes: 0 all checks passed · 1 failures · 2 could not connect`;

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const args = process.argv.slice(2);

if (args.includes('--help') || args.length === 0) {
  console.log(USAGE);
  process.exit(args.length === 0 ? 2 : 0);
}

if (args.includes('--list')) {
  for (const check of listChecks()) {
    const tag = check.advisory ? ' (advisory)' : '';
    console.log(`${check.id.padEnd(40)} spec ${check.spec}${tag}`);
  }
  process.exit(0);
}

let only: Category | undefined;
const onlyAt = args.indexOf('--only');
if (onlyAt !== -1) {
  const value = args[onlyAt + 1];
  if (!CATEGORIES.includes(value as Category)) {
    fail(`--only takes one of: ${CATEGORIES.join(', ')} (got ${JSON.stringify(value ?? '')})`);
  }
  only = value as Category;
  args.splice(onlyAt, 2);
}

// First non-flag argument is the server; the rest travel to it verbatim
// (checkmcp node_modules/.bin/mcp-server-filesystem /some/dir).
const [target, ...serverArgs] = args.filter((arg) => !arg.startsWith('-'));
if (!target) fail(USAGE);

const transport = /^https?:\/\//.test(target)
  ? new StreamableHTTPClientTransport(new URL(target))
  : new StdioClientTransport(
      // A .js/.mjs/.cjs file runs under this same Node; anything else is
      // treated as an executable and spawned as-is.
      /\.(mjs|cjs|js)$/.test(target)
        ? { command: process.execPath, args: [target, ...serverArgs] }
        : { command: target, args: serverArgs },
    );

const client = new Client({ name: 'checkmcp', version: VERSION });
try {
  await client.connect(transport);
} catch (error) {
  fail(`could not connect to ${target}: ${(error as Error).message}`);
}

let report;
try {
  report = await runBattery(client, only);
} catch (error) {
  fail(`the battery failed against ${target}: ${(error as Error).message}`);
}
console.log(render(report, VERSION));
await client.close();
process.exit(report.failed > 0 ? 1 : 0);
