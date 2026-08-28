# Changelog

All notable changes to checkmcp. Format follows [Keep a Changelog](https://keepachangelog.com); versions follow semver.

## [0.1.1] - 2026-08-28

### Fixed

- Flags after the server now travel to it verbatim (`checkmcp bin/server.mjs --mcp`); previously the CLI swallowed them. checkmcp's own flags go before the server.
- Pointing checkmcp at a `.json` registry manifest now explains that a manifest describes a server rather than being one, instead of a raw spawn error.
- A target that cannot be spawned gets a hint about `./` prefixes and executability instead of a bare ENOENT.

## [0.1.0] - 2026-08-28

### Added

- `connect(server)`: an in-memory test client for MCP servers. Real protocol, no network, no subprocess, no model; `tool`, `tools`, `resource`, `prompt`, `close` and `raw`.
- Five matchers for vitest and jest via `import 'checkmcp/matchers'`: `toBeToolSuccess`, `toBeToolError`, `toHaveTextContent`, `toHaveStructuredContent`, `toMatchOutputSchema`. Failure messages name the tool, the arguments sent and what came back.
- `npx checkmcp <server>`: a conformance battery of 11 checks in four categories (handshake, schemas, errors, robustness), verified against the 2025-11-25 specification with a citation per check. Advisory findings comment without failing the run. Targets a server file over stdio (arguments passed through) or a running server over HTTP; `--only` and `--list`; exit codes 0/1/2.
- `snapshotSchemas(server)`: tool contracts snapshotted to committed files; drift fails with one caller-impact sentence per change and is accepted with `CHECKMCP_UPDATE=1`.
- Verified against the official reference servers (memory, filesystem, everything) and a fastmcp server: zero false positives.

## [0.0.1] - 2026-08-28

### Added

- Placeholder release to reserve the package name. No usable API yet.
- README with the v0.1 roadmap and the project promise: everything that runs on your machine is free and MIT-licensed, forever.
