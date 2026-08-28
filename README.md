# checkmcp

> Testing toolkit for [Model Context Protocol](https://modelcontextprotocol.io) servers.

**Status: placeholder release (0.0.1) — v0.1 is in active development.** This publish reserves the package name; there is no usable API yet.

## What's coming in v0.1

- **In-memory test harness** — spin up your MCP server inside ordinary `vitest`/`jest` tests: no network, no subprocess, no API keys.
- **Assertions & matchers** — `expect(result).toBeToolSuccess()`, schema-aware checks on tool results, errors, resources, and prompts.
- **Conformance suite** — one line that verifies your server against the current MCP specification.
- **Schema snapshots** — fail CI when a tool's input schema changes unintentionally.

## The promise

Everything that runs on your machine is free and MIT-licensed, forever. If we ever build a paid product, it will be a hosted service — never a better version of this library.

## License

MIT
