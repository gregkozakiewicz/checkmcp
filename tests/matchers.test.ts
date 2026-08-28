import { describe, expect, test } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { connect } from '../src/index.js';
import { matchers } from '../src/matchers.js';
import { tagResult } from '../src/meta.js';
import '../src/matchers.js';

function fixture() {
  const server = new McpServer({ name: 'fixture', version: '1.0.0' });
  server.registerTool(
    'add',
    { description: 'Add two numbers', inputSchema: { a: z.number(), b: z.number() } },
    async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }),
  );
  server.registerTool(
    'refuse',
    { description: 'Always errors' },
    async () => ({ content: [{ type: 'text', text: 'amount must be positive' }], isError: true }),
  );
  server.registerTool(
    'weather',
    {
      description: 'Structured weather',
      // The SDK compiles this with additionalProperties: false; every
      // returned field must be declared.
      outputSchema: { temperature: z.number(), unit: z.string(), station: z.string() },
    },
    async () => ({
      content: [{ type: 'text', text: '21°C' }],
      structuredContent: { temperature: 21, unit: 'C', station: 'ZRH' },
    }),
  );
  return server;
}

// Failure output is the product here: each message must name the tool, the
// arguments, and what actually came back.
function failureMessage(assertion: () => void): string {
  try {
    assertion();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected the assertion to fail, but it passed');
}

describe('matchers', () => {
  test('toBeToolSuccess passes on success and inverts with .not', async () => {
    const client = await connect(fixture());
    expect(await client.tool('add', { a: 2, b: 40 })).toBeToolSuccess();
    expect(await client.tool('refuse')).not.toBeToolSuccess();
  });

  test('toBeToolSuccess failure names the tool, the args and the error', async () => {
    const client = await connect(fixture());
    const result = await client.tool('refuse');
    const message = failureMessage(() => expect(result).toBeToolSuccess());
    expect(message).toContain('tool "refuse"');
    expect(message).toContain('amount must be positive');
  });

  test('toBeToolError matches the error text', async () => {
    const client = await connect(fixture());
    const result = await client.tool('refuse');
    expect(result).toBeToolError();
    expect(result).toBeToolError(/must be positive/);
    expect(result).toBeToolError('amount');
  });

  test('toBeToolError on a success result says so', async () => {
    const client = await connect(fixture());
    const result = await client.tool('add', { a: 1, b: 1 });
    const message = failureMessage(() => expect(result).toBeToolError());
    expect(message).toContain('tool "add"');
    expect(message).toContain('succeeded');
  });

  test('toBeToolError with a non-matching pattern shows what the error said', async () => {
    const client = await connect(fixture());
    const result = await client.tool('refuse');
    const message = failureMessage(() => expect(result).toBeToolError(/quota exceeded/));
    expect(message).toContain('quota exceeded');
    expect(message).toContain('amount must be positive');
  });

  test('toHaveTextContent takes strings and regexes', async () => {
    const client = await connect(fixture());
    const result = await client.tool('add', { a: 2, b: 40 });
    expect(result).toHaveTextContent('42');
    expect(result).toHaveTextContent(/^\d+$/);
    expect(result).not.toHaveTextContent('43');
  });

  test('toHaveStructuredContent matches deep-partially', async () => {
    const client = await connect(fixture());
    const result = await client.tool('weather');
    // Extra fields in the result (station) must not fail a partial match.
    expect(result).toHaveStructuredContent({ temperature: 21 });
    expect(result).not.toHaveStructuredContent({ temperature: 22 });
  });

  test('toHaveStructuredContent on a text-only result explains what is missing', async () => {
    const client = await connect(fixture());
    const result = await client.tool('add', { a: 1, b: 1 });
    const message = failureMessage(() => expect(result).toHaveStructuredContent({ sum: 2 }));
    expect(message).toContain('structuredContent');
    expect(message).toContain('tool "add"');
  });

  test('toMatchOutputSchema validates against the declared schema', async () => {
    const client = await connect(fixture());
    expect(await client.tool('weather')).toMatchOutputSchema();
  });

  test('toMatchOutputSchema fails a nonconforming payload with the validator message', () => {
    // The SDK client rejects nonconforming results in transit, so a broken
    // payload can only be probed by tagging a result by hand.
    const broken = tagResult(
      { content: [], structuredContent: { temperature: 'warm' } },
      {
        tool: 'weather',
        args: undefined,
        outputSchema: { type: 'object', properties: { temperature: { type: 'number' } } },
      },
    );
    const verdict = matchers.toMatchOutputSchema(broken as never);
    expect(verdict.pass).toBe(false);
    expect(verdict.message()).toContain('temperature');
  });

  test('toMatchOutputSchema on a schema-less tool tells you where to declare one', async () => {
    const client = await connect(fixture());
    const result = await client.tool('add', { a: 1, b: 1 });
    const message = failureMessage(() => expect(result).toMatchOutputSchema());
    expect(message).toContain('declares no output schema');
  });

  test('toMatchOutputSchema on a foreign result points at connect()', () => {
    const verdict = matchers.toMatchOutputSchema({ content: [] } as never);
    expect(verdict.pass).toBe(false);
    expect(verdict.message()).toContain('connect()');
  });
});
