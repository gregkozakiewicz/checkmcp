// A standalone stdio server for exercising the CLI end to end.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'clean-fixture', version: '1.0.0' });
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
await server.connect(new StdioServerTransport());
