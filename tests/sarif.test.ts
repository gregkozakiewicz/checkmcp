import { describe, expect, test } from 'vitest';
import { connect } from '../src/index.js';
import { runBattery, listChecks } from '../src/battery.js';
import { toSarif } from '../src/sarif.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

function plain() {
  const server = new McpServer({ name: 'plain', version: '1.0.0' });
  // No description and no output schema: guarantees advisory findings.
  server.registerTool('echo', { inputSchema: { text: z.string() } }, async ({ text }) => ({
    content: [{ type: 'text', text }],
  }));
  return server;
}

describe('sarif', () => {
  test('advisories are notes, failures are errors, and every rule cites the spec', async () => {
    const { raw } = await connect(plain());
    const report = await runBattery(raw);
    const sarif = toSarif(report, '0.0.0', 'server.js') as {
      runs: {
        tool: { driver: { rules: { id: string; helpUri: string }[] } };
        results: { ruleId: string; level: string; locations: unknown[] }[];
      }[];
    };

    const { rules } = sarif.runs[0].tool.driver;
    expect(rules).toHaveLength(listChecks().length);
    for (const rule of rules) {
      expect(rule.helpUri).toMatch(/^https:\/\/modelcontextprotocol\.io\/specification\/\d{4}-\d{2}-\d{2}\//);
    }

    const results = sarif.runs[0].results;
    expect(results.length).toBeGreaterThan(0);
    // plain has no non-advisory failures, so every result must be a note.
    expect(results.every((r) => r.level === 'note')).toBe(true);
    expect(results.every((r) => r.locations.length === 1)).toBe(true);
  });

  test('a real failure lands as an error result', async () => {
    const { raw } = await connect(plain());
    const report = await runBattery(raw);
    // Forge one non-advisory finding rather than boot a broken server here;
    // battery tests already prove detection.
    report.categories[0].findings.push({
      check: 'schemas/input-schema',
      category: 'schemas',
      detail: 'forged',
      spec: 'server/tools#tool',
      advisory: false,
    });
    const sarif = toSarif(report, '0.0.0', 'server.js') as {
      runs: { results: { level: string }[] }[];
    };
    expect(sarif.runs[0].results.some((r) => r.level === 'error')).toBe(true);
  });
});
