#!/usr/bin/env node
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CATEGORIES, listChecks, runBattery, type Category } from './battery.js';
import { render } from './report.js';
import { toSarif } from './sarif.js';

const VERSION: string = createRequire(import.meta.url)('../package.json').version;

const USAGE = `checkmcp v${VERSION} · conformance checks for MCP servers

Usage:
  checkmcp <server.js> [args...]  spawn a server over stdio and check it
  checkmcp <http(s)://url>        check a running server over HTTP
  checkmcp --list                 every check, with the spec section it enforces

Options:
  --only <category>               one of: ${CATEGORIES.join(', ')}
  --format <text|sarif>           sarif writes the standard form GitHub code
                                  scanning ingests; redirect it to a file

checkmcp's own flags go before the server; everything after it is passed
to the server verbatim: checkmcp --only schemas bin/server.mjs --mcp

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

if (args.includes('--version') || args.includes('-v')) {
  console.log(VERSION);
  process.exit(0);
}

if (args.includes('--list')) {
  for (const check of listChecks()) {
    const tag = check.advisory ? ' (advisory)' : '';
    console.log(`${check.id.padEnd(40)} spec ${check.spec}${tag}`);
  }
  process.exit(0);
}

// Our flags come before the server; everything after it, flags included,
// travels to the server verbatim (checkmcp bin/roast.mjs --mcp).
let only: Category | undefined;
let format: 'text' | 'sarif' = 'text';
let target: string | undefined;
let serverArgs: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--only') {
    const value = args[++i];
    if (!CATEGORIES.includes(value as Category)) {
      fail(`--only takes one of: ${CATEGORIES.join(', ')} (got ${JSON.stringify(value ?? '')})`);
    }
    only = value as Category;
    continue;
  }
  if (args[i] === '--format') {
    const value = args[++i];
    if (value !== 'text' && value !== 'sarif') {
      fail(`--format takes text or sarif (got ${JSON.stringify(value ?? '')})`);
    }
    format = value;
    continue;
  }
  // A flag this far left is meant for checkmcp, and this is not one of ours.
  if (args[i].startsWith('-')) {
    fail(`unknown option ${args[i]} (see checkmcp --help; flags for the server go after it)`);
  }
  target = args[i];
  serverArgs = args.slice(i + 1);
  break;
}
if (!target) fail(USAGE);

if (target.endsWith('.json')) {
  fail(
    `${target} describes a server; it is not one. A registry manifest names the command that runs the server: use that instead, e.g.\n  checkmcp bin/server.mjs --mcp`,
  );
}

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
  const reason = (error as Error).message;
  const hint = reason.includes('ENOENT')
    ? `\n  Not found as a command. A path in the current directory needs its prefix (./server) and must be executable; a .js/.mjs file is run with Node automatically.`
    : '';
  fail(`could not connect to ${target}: ${reason}${hint}`);
}

let report;
try {
  report = await runBattery(client, only);
} catch (error) {
  fail(`the battery failed against ${target}: ${(error as Error).message}`);
}
console.log(
  format === 'sarif'
    ? JSON.stringify(toSarif(report, VERSION, target), null, 2)
    : render(report, VERSION),
);
await client.close();
process.exit(report.failed > 0 ? 1 : 0);
