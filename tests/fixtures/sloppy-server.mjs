// A standalone stdio server with everything to hide, for the e2e suite.
// Low-level Server so the SDK cannot save it from itself: an undescribed
// tool, an invalid input schema, and a handler that answers any call,
// however broken, with success.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'sloppy', version: '0.0.1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'mystery', inputSchema: { type: 'object', properties: { id: { type: 'flavour' } } } },
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
server.setRequestHandler(CallToolRequestSchema, async () => ({
  content: [{ type: 'text', text: 'done!' }],
}));
await server.connect(new StdioServerTransport());
