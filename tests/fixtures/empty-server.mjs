// A server with no tools at all: the degenerate case the battery must
// survive without dividing by zero or inventing findings.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: 'empty', version: '1.0.0' });
await server.connect(new StdioServerTransport());
