import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type {
  CallToolResult,
  GetPromptResult,
  ReadResourceResult,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';

/** A connected test client. Every call travels the real protocol; only the wire is fake. */
export interface TestClient {
  /** Call a tool and return its result. Error results resolve, they do not throw. */
  tool(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  /** The tool list exactly as a client sees it. */
  tools(): Promise<Tool[]>;
  /** Read a resource by URI. */
  resource(uri: string): Promise<ReadResourceResult>;
  /** Get a prompt. */
  prompt(name: string, args?: Record<string, string>): Promise<GetPromptResult>;
  /** Disconnect both ends. In-memory transports hold no sockets, so leaking one is harmless. */
  close(): Promise<void>;
  /** The underlying SDK Client, for anything the surface above does not cover. */
  raw: Client;
}

/**
 * Connect a test client to an MCP server in-process.
 *
 * Accepts the McpServer you already export from your entry point (or a
 * low-level Server). The handshake, requests and results are the real
 * protocol over a linked in-memory pair: no port, no subprocess, no model.
 */
export async function connect(server: McpServer | Server): Promise<TestClient> {
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  const raw = new Client({ name: 'checkmcp', version: '0.0.1' });

  await server.connect(serverEnd);
  await raw.connect(clientEnd);

  return {
    async tool(name, args) {
      // The full result schema keeps structuredContent; the compatibility one drops it.
      return (await raw.callTool({ name, arguments: args })) as CallToolResult;
    },
    async tools() {
      return (await raw.listTools()).tools;
    },
    async resource(uri) {
      return raw.readResource({ uri });
    },
    async prompt(name, args) {
      return raw.getPrompt({ name, arguments: args });
    },
    async close() {
      await raw.close();
      await server.close();
    },
    raw,
  };
}
