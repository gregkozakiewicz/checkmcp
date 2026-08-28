# checkmcp

> Testing for [Model Context Protocol](https://modelcontextprotocol.io) servers. An in-memory harness and assertions for your own tests, and one command that checks any server against the spec.

**Status: v0.1 in development.** The API below is the contract being built; the current npm release (0.0.1) is a name reservation. Watch the repo for the release.

MCP servers ship fast and break silently: a tool that crashes on bad input, a schema change that quietly disconnects every agent already using it. Nobody notices until an AI fails in front of a user. checkmcp is the crash-test dummy you send in first.

## The ten-second check

```bash
npx checkmcp server.js
```

checkmcp connects to your server, speaks the real protocol at it, and runs a battery of conformance checks against the current MCP specification:

```text
checkmcp v0.1.0 · spec 2026-07-28 · 21 tools found

  handshake     6/6 passed
  schemas      11/12 passed
  errors        5/5 passed
  robustness    7/8 passed

  ✗ schemas: tool "search_orders" declares no description
      A client model chooses tools by their descriptions. An undescribed
      tool is invisible at best, misused at worst. Spec §5.1.
  ✗ robustness: tool "create_invoice" crashed on malformed arguments
      Sent {"amount": "not-a-number"}; the server threw instead of
      returning an error result. Spec §7.3.

  29/31 passed, 2 failed (0 advisory)
```

Works against a local build or a running server:

```bash
npx checkmcp server.js                       # spawns it over stdio
npx checkmcp http://localhost:3000/mcp       # connects over HTTP
npx checkmcp server.js --only schemas        # one category
npx checkmcp --list                          # every check, with its spec section
```

Exit code 0 when everything passes, 1 on failures, 2 when it cannot connect. Wire it into CI as-is.

Every check cites the spec section it enforces. Checks that reflect judgement rather than the letter of the spec are marked advisory and never fail the run.

## Writing your own tests

The battery checks what every server must do. Your own tests check what only yours does. checkmcp runs your actual server in-memory, over the real protocol, with the network replaced by a function call: no ports, no subprocess, no model, no API keys, milliseconds per test.

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

## Licence

MIT
