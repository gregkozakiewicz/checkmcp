import { describe, expect, test } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { connect } from '../src/index.js';

// A small but real server: one honest tool, one that misbehaves on purpose.
function fixture() {
  const server = new McpServer({ name: 'fixture', version: '1.0.0' });
  server.registerTool(
    'add',
    { description: 'Add two numbers', inputSchema: { a: z.number(), b: z.number() } },
    async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }),
  );
  server.registerTool(
    'refuse',
    { description: 'Always returns an error result' },
    async () => ({ content: [{ type: 'text', text: 'amount must be positive' }], isError: true }),
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

describe('connect', () => {
  test('calls a tool over the real protocol', async () => {
    const client = await connect(fixture());
    const result = await client.tool('add', { a: 2, b: 40 });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: 'text', text: '42' }]);
  });

  test('an error result resolves rather than throws', async () => {
    const client = await connect(fixture());
    const result = await client.tool('refuse');
    expect(result.isError).toBe(true);
  });

  test('an unknown tool comes back as an error result naming the tool', async () => {
    // SDK >=1.30 answers unknown tools with an error result, not a protocol error.
    const client = await connect(fixture());
    const result = await client.tool('no_such_tool');
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/no_such_tool/);
  });

  test('lists tools as a client sees them', async () => {
    const client = await connect(fixture());
    const names = (await client.tools()).map((t) => t.name).sort();
    expect(names).toEqual(['add', 'refuse']);
  });

  test('reads a resource', async () => {
    const client = await connect(fixture());
    const result = await client.resource('greeting://hello');
    expect(result.contents[0]).toMatchObject({ text: 'hello' });
  });

  test('gets a prompt', async () => {
    const client = await connect(fixture());
    const result = await client.prompt('review', { topic: 'the harness' });
    expect(result.messages[0].content).toMatchObject({ text: 'Review the harness' });
  });

  test('close disconnects both ends', async () => {
    const client = await connect(fixture());
    await client.close();
    await expect(client.tool('add', { a: 1, b: 1 })).rejects.toThrow();
  });
});
