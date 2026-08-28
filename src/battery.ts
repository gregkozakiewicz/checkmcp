import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation/index.js';

export const CATEGORIES = ['handshake', 'schemas', 'errors', 'robustness'] as const;
export type Category = (typeof CATEGORIES)[number];

export interface Finding {
  check: string;
  category: Category;
  /** What failed: a tool name, or undefined for server-wide checks. */
  subject?: string;
  detail: string;
  advice?: string;
  spec: string;
  advisory: boolean;
}

export interface CategoryScore {
  category: Category;
  examined: number;
  passed: number;
  findings: Finding[];
}

export interface Report {
  server: { name: string; version: string };
  toolCount: number;
  categories: CategoryScore[];
  /** Non-advisory failures. The exit code hangs on this. */
  failed: number;
  advisories: number;
}

interface Probe {
  examined: number;
  failures: { subject?: string; detail: string; advice?: string }[];
}

interface Check {
  id: string;
  category: Category;
  spec: string;
  advisory: boolean;
  run(ctx: Context): Promise<Probe>;
}

interface Context {
  client: Client;
  tools: Tool[];
}

const ajv = new AjvJsonSchemaValidator();

/** Compile a schema; a schema ajv rejects outright is the finding. */
function compiles(schema: unknown): string | undefined {
  try {
    ajv.getValidator(schema as JsonSchemaType);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

/**
 * Call a tool expecting the server to refuse. Either refusal shape is
 * conformant: an error result, or a JSON-RPC error. A success result is the
 * failure. Returns undefined on conformance, else what came back.
 */
async function expectRefusal(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<string | undefined> {
  let result: CallToolResult;
  try {
    result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  } catch {
    return undefined;
  }
  if (result.isError) return undefined;
  return JSON.stringify(result.content ?? result);
}

/** Values that violate a declared JSON Schema type. */
const WRONG: Record<string, unknown> = {
  number: 'not-a-number',
  integer: 'not-a-number',
  string: 42,
  boolean: 'yes',
  array: 'not-an-array',
  object: 'not-an-object',
};

const NAME_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

const CHECKS: Check[] = [
  {
    id: 'handshake/server-info',
    category: 'handshake',
    spec: 'lifecycle/initialization',
    advisory: false,
    async run({ client }) {
      const info = client.getServerVersion();
      const failures = [];
      if (!info?.name || !info?.version) {
        failures.push({
          detail: `initialize returned serverInfo ${JSON.stringify(info)}`,
          advice: 'Declare both name and version when constructing the server.',
        });
      }
      return { examined: 1, failures };
    },
  },
  {
    id: 'handshake/tools-capability',
    category: 'handshake',
    spec: 'lifecycle/capability-negotiation',
    advisory: false,
    async run({ client, tools }) {
      const declared = client.getServerCapabilities()?.tools !== undefined;
      const failures =
        tools.length > 0 && !declared
          ? [
              {
                detail: `the server lists ${tools.length} tools but did not declare the tools capability`,
                advice: 'Capabilities tell clients what to ask for; declare tools during initialize.',
              },
            ]
          : [];
      return { examined: 1, failures };
    },
  },
  {
    id: 'handshake/ping',
    category: 'handshake',
    spec: 'utilities/ping',
    advisory: false,
    async run({ client }) {
      try {
        await client.ping();
        return { examined: 1, failures: [] };
      } catch (error) {
        return {
          examined: 1,
          failures: [{ detail: `ping failed: ${(error as Error).message}` }],
        };
      }
    },
  },
  {
    id: 'schemas/tool-name',
    category: 'schemas',
    spec: 'server/tools#name',
    advisory: false,
    async run({ tools }) {
      const failures = [];
      const seen = new Set<string>();
      for (const tool of tools) {
        if (!NAME_PATTERN.test(tool.name)) {
          failures.push({
            subject: tool.name,
            detail: `tool name ${JSON.stringify(tool.name)} is outside [a-zA-Z0-9_-]{1,128}`,
          });
        }
        if (seen.has(tool.name)) {
          failures.push({ subject: tool.name, detail: `tool name "${tool.name}" is declared twice` });
        }
        seen.add(tool.name);
      }
      return { examined: tools.length, failures };
    },
  },
  {
    id: 'schemas/tool-description',
    category: 'schemas',
    spec: 'server/tools#description',
    advisory: false,
    async run({ tools }) {
      const failures = tools
        .filter((tool) => !tool.description?.trim())
        .map((tool) => ({
          subject: tool.name,
          detail: `tool "${tool.name}" declares no description`,
          advice:
            'A client model chooses tools by their descriptions. An undescribed tool is invisible at best, misused at worst.',
        }));
      return { examined: tools.length, failures };
    },
  },
  {
    id: 'schemas/input-schema',
    category: 'schemas',
    spec: 'server/tools#inputSchema',
    advisory: false,
    async run({ tools }) {
      const failures = [];
      for (const tool of tools) {
        const reason = compiles(tool.inputSchema);
        if (reason) {
          failures.push({
            subject: tool.name,
            detail: `inputSchema of "${tool.name}" is not valid JSON Schema: ${reason}`,
          });
        }
      }
      return { examined: tools.length, failures };
    },
  },
  {
    id: 'schemas/output-schema',
    category: 'schemas',
    spec: 'server/tools#outputSchema',
    advisory: false,
    async run({ tools }) {
      const withSchema = tools.filter((tool) => tool.outputSchema);
      const failures = [];
      for (const tool of withSchema) {
        const reason = compiles(tool.outputSchema);
        if (reason) {
          failures.push({
            subject: tool.name,
            detail: `outputSchema of "${tool.name}" is not valid JSON Schema: ${reason}`,
          });
        }
      }
      return { examined: withSchema.length, failures };
    },
  },
  {
    id: 'schemas/output-schema-declared',
    category: 'schemas',
    spec: 'server/tools#outputSchema',
    advisory: true,
    async run({ tools }) {
      const failures = tools
        .filter((tool) => !tool.outputSchema)
        .map((tool) => ({
          subject: tool.name,
          detail: `tool "${tool.name}" declares no output schema`,
          advice: 'With outputSchema declared, clients can validate results and type integrations.',
        }));
      return { examined: tools.length, failures };
    },
  },
  {
    id: 'errors/unknown-tool',
    category: 'errors',
    spec: 'server/tools#error-handling',
    advisory: false,
    async run({ client }) {
      const outcome = await expectRefusal(client, 'checkmcp_no_such_tool', {});
      return {
        examined: 1,
        failures: outcome
          ? [
              {
                detail: `calling a tool that does not exist returned a success result: ${outcome}`,
                advice: 'Unknown tools must produce an error, or every typo becomes a silent no-op.',
              },
            ]
          : [],
      };
    },
  },
  {
    id: 'errors/missing-required-args',
    category: 'errors',
    spec: 'server/tools#inputSchema',
    advisory: false,
    async run({ client, tools }) {
      const eligible = tools.filter(
        (tool) => Array.isArray(tool.inputSchema?.required) && tool.inputSchema.required.length > 0,
      );
      const failures = [];
      for (const tool of eligible) {
        const outcome = await expectRefusal(client, tool.name, {});
        if (outcome) {
          failures.push({
            subject: tool.name,
            detail: `"${tool.name}" accepted a call missing its required arguments and returned: ${outcome}`,
            advice: 'Validate arguments against the declared schema before acting on them.',
          });
        }
      }
      return { examined: eligible.length, failures };
    },
  },
  {
    id: 'robustness/malformed-argument-types',
    category: 'robustness',
    spec: 'server/tools#inputSchema',
    advisory: false,
    async run({ client, tools }) {
      let examined = 0;
      const failures = [];
      for (const tool of tools) {
        const properties = (tool.inputSchema?.properties ?? {}) as Record<
          string,
          { type?: string }
        >;
        const args: Record<string, unknown> = {};
        for (const [key, prop] of Object.entries(properties)) {
          if (prop.type && prop.type in WRONG) args[key] = WRONG[prop.type];
        }
        if (Object.keys(args).length === 0) continue;
        examined++;
        const outcome = await expectRefusal(client, tool.name, args);
        if (outcome) {
          failures.push({
            subject: tool.name,
            detail: `"${tool.name}" accepted arguments of the wrong type (${JSON.stringify(args)}) and returned: ${outcome}`,
            advice: 'Sent deliberately mistyped values; the server should refuse before its handler runs.',
          });
        }
      }
      return { examined, failures };
    },
  },
  {
    id: 'robustness/survives-the-battery',
    category: 'robustness',
    spec: 'utilities/ping',
    advisory: false,
    async run({ client }) {
      try {
        await client.ping();
        return { examined: 1, failures: [] };
      } catch (error) {
        return {
          examined: 1,
          failures: [
            {
              detail: `the server stopped answering after the battery ran: ${(error as Error).message}`,
              advice: 'Something above crashed the connection; a hostile call must never take the server down.',
            },
          ],
        };
      }
    },
  },
];

/**
 * Run the battery against a connected client.
 *
 * The errors and robustness categories call the server's tools with
 * deliberately broken arguments. A conformant server refuses them before its
 * handlers run; a server that does not validate will execute handlers on
 * garbage. Point the battery at a development instance, not production.
 */
export async function runBattery(client: Client, only?: Category): Promise<Report> {
  const tools = (await client.listTools()).tools;
  const ctx: Context = { client, tools };
  const info = client.getServerVersion();

  const categories: CategoryScore[] = [];
  for (const category of CATEGORIES) {
    if (only && category !== only) continue;
    const score: CategoryScore = { category, examined: 0, passed: 0, findings: [] };
    for (const check of CHECKS.filter((c) => c.category === category)) {
      const { examined, failures } = await check.run(ctx);
      // Advisory checks comment; they never move the score.
      if (!check.advisory) {
        score.examined += examined;
        score.passed += examined - failures.length;
      }
      score.findings.push(
        ...failures.map((failure) => ({
          check: check.id,
          category,
          spec: check.spec,
          advisory: check.advisory,
          ...failure,
        })),
      );
    }
    categories.push(score);
  }

  const all = categories.flatMap((c) => c.findings);
  return {
    server: { name: info?.name ?? '(unnamed)', version: info?.version ?? '(unversioned)' },
    toolCount: tools.length,
    categories,
    failed: all.filter((f) => !f.advisory).length,
    advisories: all.filter((f) => f.advisory).length,
  };
}

/** Every check in the battery, for `checkmcp --list`. */
export function listChecks(): { id: string; category: Category; spec: string; advisory: boolean }[] {
  return CHECKS.map(({ id, category, spec, advisory }) => ({ id, category, spec, advisory }));
}
