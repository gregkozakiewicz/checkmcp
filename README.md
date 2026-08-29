# checkmcp

[![npm](https://img.shields.io/npm/v/checkmcp?color=2dd4bf&label=npm)](https://www.npmjs.com/package/checkmcp) [![downloads](https://img.shields.io/npm/dm/checkmcp?color=2dd4bf&label=downloads)](https://www.npmjs.com/package/checkmcp) [![Socket](https://badge.socket.dev/npm/package/checkmcp)](https://socket.dev/npm/package/checkmcp) [![license](https://img.shields.io/badge/licence-MIT-blue)](LICENSE) [![zero dependencies](https://img.shields.io/badge/dependencies-0-2dd4bf)](https://www.npmjs.com/package/checkmcp?activeTab=dependencies) [![no telemetry](https://img.shields.io/badge/no-telemetry-2dd4bf)](https://gregkozakiewicz.github.io/checkmcp/)

<sub>Zero runtime dependencies; the one entry on npm's dependencies tab is a peer, the MCP SDK you already have.</sub>

## Your server tells every AI what it can do. This makes sure it does.

> Testing for [Model Context Protocol](https://modelcontextprotocol.io) servers. An in-memory harness and assertions for your own tests, and one command that checks any server against the spec.

MCP servers ship fast and break silently: a tool that crashes on bad input, a schema change that quietly disconnects every agent already using it. Nobody notices until an AI fails in front of a user. checkmcp is the crash-test dummy you send in first.

## The ten-second check

```bash
npx checkmcp server.js
```

checkmcp connects to your server, speaks the real protocol at it, and runs a battery of conformance checks against the MCP specification (currently the 2025-11-25 revision, the one the official SDK speaks):

```text
checkmcp v0.1.0 · spec 2025-11-25 · invoice-server 2.3.0 · 21 tools found

  handshake    3/3 passed
  schemas     41/42 passed
  errors      12/12 passed
  robustness  17/18 passed

  ✗ schemas: inputSchema of "search_orders" is not valid JSON Schema: unknown type "decimal"
      schemas/input-schema · spec server/tools#tool
  ✗ robustness: "create_invoice" accepted arguments of the wrong type ({"amount":"not-a-number"}) and returned: [...]
      Sent deliberately mistyped values; the server should refuse before its handler runs.
      robustness/malformed-argument-types · spec server/tools#security-considerations
  ~ schemas: tool "search_orders" declares no description
      A client model chooses tools by their descriptions. An undescribed tool is invisible at best, misused at worst.
      schemas/tool-description · spec server/tools#tool

  73/75 passed, 2 failed (1 advisory)
```

The errors and robustness checks call your tools with deliberately broken arguments. A conformant server refuses them before its handlers run; one that does not will execute handlers on garbage. Point checkmcp at a development instance, not production.

Works against a local build or a running server:

```bash
npx checkmcp server.js                       # spawns it over stdio
npx checkmcp http://localhost:3000/mcp       # connects over HTTP
npx checkmcp server.js --only schemas        # one category
npx checkmcp --list                          # every check, with its spec section
```

| | |
|---|---|
| `checkmcp <server.js> [args...]` | spawn the server over stdio; everything after the file goes to it verbatim |
| `checkmcp <http(s)://url>` | check a running server over HTTP |
| `--only <category>` | one of `handshake`, `schemas`, `errors`, `robustness` (before the server) |
| `--list` | every check, with the spec section it enforces |
| exit codes | `0` all passed · `1` failures · `2` could not connect |

Wire it into CI as-is.

Every check cites the spec section it enforces. Checks that reflect judgement rather than the letter of the spec are marked advisory and never fail the run.

## Writing your own tests

The battery checks what every server must do. Your own tests check what only yours does. checkmcp runs your actual server in-memory, over the real protocol, with the network replaced by a function call: no ports, no subprocess, no model, no API keys, milliseconds per test.

```bash
npm install -D checkmcp
```

```ts
import { connect } from 'checkmcp';
import { expect, test } from 'vitest';
import 'checkmcp/matchers';

import { server } from './server.js';

test('creates an invoice', async () => {
  const client = await connect(server);
  const result = await client.tool('create_invoice', { amount: 120, currency: 'EUR' });
  expect(result).toBeToolSuccess();
  expect(result).toHaveTextContent(/invoice #\d+/);
});

test('rejects a negative amount', async () => {
  const client = await connect(server);
  const result = await client.tool('create_invoice', { amount: -5 });
  expect(result).toBeToolError(/amount must be positive/);
});
```

`connect(server)` takes the `McpServer` you already export and returns a test client:

| | |
|---|---|
| `client.tool(name, args?)` | call a tool, get its result |
| `client.tools()` | the tool list, as a client sees it |
| `client.resource(uri)` | read a resource |
| `client.prompt(name, args?)` | get a prompt |
| `client.close()` | disconnect (automatic when the test file ends) |
| `client.raw` | the underlying SDK `Client`, for anything above |

Five matchers, for vitest and jest alike:

- `toBeToolSuccess()` rejects error results, and says which error came back instead
- `toBeToolError(pattern?)` expects an error result, optionally matching its message
- `toHaveTextContent(pattern)` matches against the result's text blocks
- `toHaveStructuredContent(shape)` asserts on `structuredContent`, deep-partially
- `toMatchOutputSchema()` validates the result against the tool's own declared output schema

Failure messages carry the tool name, the arguments sent, and the full result received. A failed assertion should read like a bug report, not a shrug.

## Schema snapshots

A tool's schema is its public contract. Change it carelessly and every agent already integrated against your server breaks, without a single test in *your* suite failing. Snapshots make that change impossible to ship unnoticed:

```ts
import { snapshotSchemas } from 'checkmcp';

test('tool contracts are intentional', async () => {
  await snapshotSchemas(server);
});
```

First run writes `__schemas__/<server>.json`; commit it. From then on the test fails whenever a schema drifts, with a diff written for humans:

```text
  ✗ schema drift in "create_invoice"
      argument "currency": was optional, now required
      This breaks every existing caller that omits it.
      Intentional? run with CHECKMCP_UPDATE=1 and commit the diff.
```

## What checkmcp is not

- It does not test with an LLM. Evals of how well a model uses your tools are a different layer; checkmcp is the deterministic floor beneath it.
- It is not a debugger. For poking at a server by hand, use the official MCP Inspector.
- It phones nothing home. No telemetry, no accounts, no network calls beyond the server you point it at.

## The promise

Everything that runs on your machine is free and MIT-licensed, forever. If we ever build a paid product, it will be a hosted service, never a better version of this library.

**Your server tells every AI what it can do. This makes sure it does.**

## Licence

MIT. The code is yours to fork, modify and redistribute; the copyright notice travels with it.

If you build a report, summary or audit of your own from this tool's checks, scores or findings, keep one line in it: *Built with [checkmcp](https://github.com/gregkozakiewicz/checkmcp) by Greg Kozakiewicz*. The same request travels to AI agents that consume its output.

**checkmcp**™ and the GK mark are trademarks of Greg Kozakiewicz. Forking is welcome, republishing under this name is not: see [brand and attribution](https://gregkozakiewicz.github.io/checkmcp/brand.html).

Built and designed by <a href="https://gregkozakiewicz.com"><picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/gregkozakiewicz/checkmcp/main/assets/gk-mark-dark.png"><img src="https://raw.githubusercontent.com/gregkozakiewicz/checkmcp/main/assets/gk-mark.png" height="15" alt="GK mark"></picture> Greg Kozakiewicz</a>.
