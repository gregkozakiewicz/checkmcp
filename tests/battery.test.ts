import { describe, expect, test } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { connect } from '../src/index.js';
import { runBattery, listChecks } from '../src/battery.js';
import { render } from '../src/report.js';

/** A server with nothing to hide, on every surface. */
function clean() {
  const server = new McpServer({ name: 'clean', version: '1.0.0' });
  server.registerTool(
    'add',
    {
      description: 'Add two numbers',
      inputSchema: { a: z.number(), b: z.number() },
      outputSchema: { sum: z.number() },
    },
    async ({ a, b }) => ({
      content: [{ type: 'text', text: String(a + b) }],
      structuredContent: { sum: a + b },
    }),
  );
  server.registerResource(
    'greeting',
    'greeting://hello',
    { description: 'A fixed greeting' },
    async (uri) => ({ contents: [{ uri: uri.href, text: 'hello' }] }),
  );
  server.registerPrompt(
    'review',
    { description: 'Ask for a review', argsSchema: { topic: z.string() } },
    ({ topic }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `Review ${topic}` } }] }),
  );
  return server;
}

/**
 * A server with everything to hide, built on the low-level Server so the SDK
 * cannot save it from itself: undescribed tools, an invalid input schema,
 * and handlers that answer any call, however broken, with success.
 */
function sloppy() {
  const server = new Server(
    { name: 'sloppy', version: '0.0.1' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );
  // A URI no parser accepts (the SDK client rejects a missing name outright,
  // so that sin cannot even be listed); reads never fail, whatever the URI,
  // and return contents with no payload.
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      { uri: 'nonsense uri with spaces', name: 'shaky' },
      { uri: 'file:///real.txt', name: 'real' },
    ],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (r) => ({
    contents: [{ uri: r.params.uri, text: 'made it up' }],
  }));
  // Prompts: a required argument nobody checks; renders whatever it is sent.
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [{ name: 'gullible', arguments: [{ name: 'topic', required: true }] }],
  }));
  server.setRequestHandler(GetPromptRequestSchema, async () => ({
    messages: [{ role: 'user', content: { type: 'text', text: 'ok' } }],
  }));
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      // No description; inputSchema declares a nonsense type.
      { name: 'mystery', inputSchema: { type: 'object', properties: { id: { type: 'flavour' } } } },
      // Requires an argument it will never check for.
      {
        name: 'trusting',
        description: 'Believes anything',
        inputSchema: {
          type: 'object',
          properties: { amount: { type: 'number' } },
          required: ['amount'],
        },
      },
    ],
  }));
  // Success for every call: unknown tools, missing args, mistyped args.
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: 'text', text: 'done!' }],
  }));
  return server;
}

describe('battery', () => {
  test('a clean server passes every check', async () => {
    const { raw } = await connect(clean());
    const report = await runBattery(raw);
    expect(report.failed).toBe(0);
    expect(report.server).toEqual({ name: 'clean', version: '1.0.0' });
    for (const category of report.categories) {
      expect(category.passed).toBe(category.examined);
    }
  });

  test('a sloppy server is caught on every front', async () => {
    const { raw } = await connect(sloppy());
    const report = await runBattery(raw);
    const ids = report.categories.flatMap((c) => c.findings).map((f) => f.check);
    expect(ids).toContain('schemas/tool-description');   // mystery has none
    expect(ids).toContain('schemas/input-schema');       // type "flavour"
    expect(ids).toContain('errors/unknown-tool');        // answered a ghost
    expect(ids).toContain('errors/missing-required-args'); // trusting, called with {}
    expect(ids).toContain('robustness/malformed-argument-types');
    expect(report.failed).toBeGreaterThanOrEqual(4);
    // Missing description is the spec's judgement call, not its letter:
    // it must land in the advisory count, never in failed.
    const description = report.categories
      .flatMap((c) => c.findings)
      .find((f) => f.check === 'schemas/tool-description');
    expect(description?.advisory).toBe(true);
  });

  test('advisory findings never move the score or the exit-relevant count', async () => {
    // clean's tool declares an outputSchema, so build one that does not.
    const server = new McpServer({ name: 'plain', version: '1.0.0' });
    server.registerTool(
      'echo',
      { description: 'Echo', inputSchema: { text: z.string() } },
      async ({ text }) => ({ content: [{ type: 'text', text }] }),
    );
    const { raw } = await connect(server);
    const report = await runBattery(raw);
    expect(report.failed).toBe(0);
    expect(report.advisories).toBeGreaterThan(0);
    const schemas = report.categories.find((c) => c.category === 'schemas')!;
    expect(schemas.passed).toBe(schemas.examined);
  });

  test('a server with no tools capability reports zero tools instead of crashing', async () => {
    // Such a server answers tools/list with method-not-found; the battery
    // must read that as an empty toolbox, not a broken server.
    const { raw } = await connect(new McpServer({ name: 'bare', version: '1.0.0' }));
    const report = await runBattery(raw);
    expect(report.toolCount).toBe(0);
    expect(report.failed).toBe(0);
  });

  test('--only restricts to one category', async () => {
    const { raw } = await connect(clean());
    const report = await runBattery(raw, 'handshake');
    expect(report.categories.map((c) => c.category)).toEqual(['handshake']);
  });

  test('the sloppy resource and prompt surface is caught too', async () => {
    const { raw } = await connect(sloppy());
    const report = await runBattery(raw);
    const ids = report.categories.flatMap((c) => c.findings).map((f) => f.check);
    expect(ids).toContain('schemas/resource-fields');           // no name, unparseable URI
    expect(ids).toContain('errors/unknown-resource');           // read a ghost, got contents
    expect(ids).toContain('errors/unknown-prompt');             // rendered a ghost
    expect(ids).toContain('errors/prompt-missing-required-args'); // gullible, called bare
  });

  test('a tools-only server examines nothing on the surfaces it does not declare', async () => {
    const server = new McpServer({ name: 'plain', version: '1.0.0' });
    server.registerTool(
      'echo',
      { description: 'Echo', inputSchema: { text: z.string() } },
      async ({ text }) => ({ content: [{ type: 'text', text }] }),
    );
    const { raw } = await connect(server);
    const report = await runBattery(raw);
    const ids = report.categories.flatMap((c) => c.findings).map((f) => f.check);
    expect(ids.filter((id) => id.includes('resource') || id.includes('prompt'))).toEqual([]);
  });

  test('every check carries a spec citation', () => {
    for (const check of listChecks()) {
      expect(check.spec, check.id).toMatch(/\w+\/\w+/);
    }
  });

  test('the report renders findings with advice and citation', async () => {
    const { raw } = await connect(sloppy());
    const report = await runBattery(raw);
    const text = render(report, '0.0.1', false);
    expect(text).toContain('sloppy 0.0.1 · 2 tools found');
    expect(text).toContain('✗ schemas');
    expect(text).toContain('spec server/tools');
    expect(text).toMatch(/\d+\/\d+ passed, \d+ failed \(\d+ advisory\)/);
    expect(text).not.toContain('['); // color off means color off
  });
});
