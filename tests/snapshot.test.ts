import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, type ZodRawShape } from 'zod';
import { snapshotSchemas } from '../src/index.js';

// Each variant is "the same server, one release later". The snapshot's job
// is to narrate the difference in caller-impact terms.
function invoiceServer(shape: ZodRawShape, extraTool = false) {
  const server = new McpServer({ name: 'invoices', version: '1.0.0' });
  server.registerTool(
    'create_invoice',
    { description: 'Create an invoice', inputSchema: shape },
    async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  );
  if (extraTool) {
    server.registerTool('void_invoice', { description: 'Void one' }, async () => ({
      content: [{ type: 'text', text: 'ok' }],
    }));
  }
  return server;
}

const V1 = { amount: z.number(), currency: z.string().optional() };

let dir: string;
function fresh() {
  dir = mkdtempSync(join(tmpdir(), 'checkmcp-snap-'));
  return dir;
}
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.CHECKMCP_UPDATE;
});

async function driftMessage(work: () => Promise<void>): Promise<string> {
  try {
    await work();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected drift to throw, but it passed');
}

describe('snapshotSchemas', () => {
  test('first run writes the snapshot and passes', async () => {
    await snapshotSchemas(invoiceServer(V1), { dir: fresh() });
    const written = JSON.parse(readFileSync(join(dir, 'invoices.json'), 'utf8'));
    expect(Object.keys(written)).toEqual(['create_invoice']);
    expect(written.create_invoice.inputSchema.required).toEqual(['amount']);
  });

  test('an unchanged contract passes silently', async () => {
    await snapshotSchemas(invoiceServer(V1), { dir: fresh() });
    await snapshotSchemas(invoiceServer(V1), { dir });
  });

  test('optional-to-required reads as the break it is', async () => {
    await snapshotSchemas(invoiceServer(V1), { dir: fresh() });
    const message = await driftMessage(() =>
      snapshotSchemas(invoiceServer({ amount: z.number(), currency: z.string() }), { dir }),
    );
    expect(message).toContain('"currency" of "create_invoice": was optional, now required');
    expect(message).toContain('breaks every caller that omits it');
    expect(message).toContain('CHECKMCP_UPDATE=1');
  });

  test('a type change names both types', async () => {
    await snapshotSchemas(invoiceServer(V1), { dir: fresh() });
    const message = await driftMessage(() =>
      snapshotSchemas(invoiceServer({ amount: z.string(), currency: z.string().optional() }), { dir }),
    );
    expect(message).toContain('"amount" of "create_invoice" changed type: was number, now string');
  });

  test('a removed tool is the loudest sentence', async () => {
    await snapshotSchemas(invoiceServer(V1, true), { dir: fresh() });
    const message = await driftMessage(() => snapshotSchemas(invoiceServer(V1), { dir }));
    expect(message).toContain('tool "void_invoice" was removed');
    expect(message).toContain('breaks every existing caller');
  });

  test('a new tool fails the run but is described as safe', async () => {
    await snapshotSchemas(invoiceServer(V1), { dir: fresh() });
    const message = await driftMessage(() => snapshotSchemas(invoiceServer(V1, true), { dir }));
    expect(message).toContain('tool "void_invoice" is new');
    expect(message).toContain('Safe for existing callers');
  });

  test('CHECKMCP_UPDATE=1 accepts the drift and rewrites the snapshot', async () => {
    await snapshotSchemas(invoiceServer(V1), { dir: fresh() });
    process.env.CHECKMCP_UPDATE = '1';
    await snapshotSchemas(invoiceServer(V1, true), { dir });
    delete process.env.CHECKMCP_UPDATE;
    // The rewritten snapshot is the new contract; the same shape now passes.
    await snapshotSchemas(invoiceServer(V1, true), { dir });
  });
});
