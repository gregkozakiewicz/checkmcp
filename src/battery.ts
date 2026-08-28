import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult, Prompt, Resource, ResourceTemplate, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation/index.js';

/** The spec revision this battery's checks were verified against. */
export const SPEC_VERSION = '2025-11-25';

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
  /** undefined when the capability is not declared: those checks then examine nothing. */
  resources: Resource[] | undefined;
  templates: ResourceTemplate[] | undefined;
  prompts: Prompt[] | undefined;
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

// Letters, digits, underscore, hyphen and dot; 1-128 chars. Spec: Tool Names.
const NAME_PATTERN = /^[a-zA-Z0-9_.-]{1,128}$/;

const CHECKS: Check[] = [
  {
    id: 'handshake/server-info',
    category: 'handshake',
    spec: 'basic/lifecycle#initialization',
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
    spec: 'server/tools#capabilities',
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
    id: 'handshake/declared-lists-answer',
    category: 'handshake',
    spec: 'basic/lifecycle#capability-negotiation',
    advisory: false,
    async run({ client }) {
      const caps = client.getServerCapabilities();
      const declared: [string, () => Promise<unknown>][] = [];
      if (caps?.tools) declared.push(['tools/list', () => client.listTools()]);
      if (caps?.resources) declared.push(['resources/list', () => client.listResources()]);
      if (caps?.prompts) declared.push(['prompts/list', () => client.listPrompts()]);
      const failures = [];
      for (const [method, call] of declared) {
        try {
          await call();
        } catch (error) {
          failures.push({
            subject: method,
            detail: `the server declares the capability but ${method} fails: ${(error as Error).message}`,
            advice: 'Only declare capabilities the server actually answers for.',
          });
        }
      }
      return { examined: declared.length, failures };
    },
  },
  {
    id: 'handshake/ping',
    category: 'handshake',
    spec: 'basic/utilities/ping',
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
    spec: 'server/tools#tool-names',
    advisory: false,
    async run({ tools }) {
      const failures = [];
      const seen = new Set<string>();
      for (const tool of tools) {
        if (!NAME_PATTERN.test(tool.name)) {
          failures.push({
            subject: tool.name,
            detail: `tool name ${JSON.stringify(tool.name)} is outside the allowed [a-zA-Z0-9_.-]{1,128}`,
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
    spec: 'server/tools#tool',
    // description is optional in the spec's Tool data type; flagging its
    // absence is our judgement, so it comments without failing the run.
    advisory: true,
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
    spec: 'server/tools#tool',
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
    spec: 'server/tools#output-schema',
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
    spec: 'server/tools#output-schema',
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
    spec: 'server/tools#security-considerations',
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
    spec: 'server/tools#security-considerations',
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
    id: 'schemas/resource-fields',
    category: 'schemas',
    spec: 'server/resources#resource',
    advisory: false,
    async run({ resources }) {
      const failures = [];
      for (const resource of resources ?? []) {
        if (!resource.name) {
          failures.push({ subject: resource.uri, detail: `resource ${resource.uri} declares no name` });
        }
        try {
          new URL(resource.uri);
        } catch {
          failures.push({
            subject: resource.uri,
            detail: `resource URI ${JSON.stringify(resource.uri)} is not a valid URI (RFC 3986)`,
          });
        }
      }
      return { examined: resources?.length ?? 0, failures };
    },
  },
  {
    id: 'schemas/resource-template-uris',
    category: 'schemas',
    spec: 'server/resources#resource-templates',
    advisory: false,
    async run({ templates }) {
      const failures = [];
      for (const template of templates ?? []) {
        const t = template.uriTemplate;
        const balanced = (t.match(/\{/g) ?? []).length === (t.match(/\}/g) ?? []).length;
        if (!t || !balanced) {
          failures.push({
            subject: template.name,
            detail: `uriTemplate ${JSON.stringify(t)} of "${template.name}" is not a usable URI template (RFC 6570)`,
          });
        }
      }
      return { examined: templates?.length ?? 0, failures };
    },
  },
  {
    id: 'schemas/prompt-arguments',
    category: 'schemas',
    spec: 'server/prompts#prompt',
    advisory: false,
    async run({ prompts }) {
      const failures = [];
      for (const prompt of prompts ?? []) {
        for (const arg of prompt.arguments ?? []) {
          if (!arg.name) {
            failures.push({
              subject: prompt.name,
              detail: `prompt "${prompt.name}" declares an argument with no name`,
            });
          }
        }
      }
      return { examined: prompts?.length ?? 0, failures };
    },
  },
  {
    id: 'errors/unknown-resource',
    category: 'errors',
    spec: 'server/resources#error-handling',
    advisory: false,
    async run({ client, resources }) {
      if (resources === undefined) return { examined: 0, failures: [] };
      try {
        const result = await client.readResource({ uri: 'checkmcp://no-such-resource' });
        return {
          examined: 1,
          failures: [
            {
              detail: `reading a resource that does not exist returned contents: ${JSON.stringify(result.contents).slice(0, 120)}`,
              advice: 'Unknown URIs must produce an error (-32002 Resource not found).',
            },
          ],
        };
      } catch {
        return { examined: 1, failures: [] };
      }
    },
  },
  {
    id: 'errors/resource-not-found-code',
    category: 'errors',
    spec: 'server/resources#error-handling',
    advisory: true,
    async run({ client, resources }) {
      if (resources === undefined) return { examined: 0, failures: [] };
      try {
        await client.readResource({ uri: 'checkmcp://no-such-resource' });
        return { examined: 0, failures: [] }; // the non-advisory check reports this
      } catch (error) {
        const code = (error as { code?: number }).code;
        return {
          examined: 1,
          failures:
            code === -32002
              ? []
              : [
                  {
                    detail: `an unknown resource was refused with code ${code}; the spec reserves -32002 for resource-not-found`,
                    advice: 'Clients branch on the code; -32002 tells them the URI, not the server, is at fault.',
                  },
                ],
        };
      }
    },
  },
  {
    id: 'errors/unknown-prompt',
    category: 'errors',
    spec: 'server/prompts#error-handling',
    advisory: false,
    async run({ client, prompts }) {
      if (prompts === undefined) return { examined: 0, failures: [] };
      try {
        await client.getPrompt({ name: 'checkmcp_no_such_prompt' });
        return {
          examined: 1,
          failures: [
            {
              detail: 'getting a prompt that does not exist succeeded',
              advice: 'An invalid prompt name must produce -32602 (Invalid params).',
            },
          ],
        };
      } catch {
        return { examined: 1, failures: [] };
      }
    },
  },
  {
    id: 'errors/prompt-missing-required-args',
    category: 'errors',
    spec: 'server/prompts#error-handling',
    advisory: false,
    async run({ client, prompts }) {
      const eligible = (prompts ?? []).filter((p) => p.arguments?.some((a) => a.required));
      const failures = [];
      for (const prompt of eligible) {
        try {
          await client.getPrompt({ name: prompt.name });
          failures.push({
            subject: prompt.name,
            detail: `prompt "${prompt.name}" rendered without its required arguments`,
            advice: 'Missing required arguments must produce -32602 (Invalid params).',
          });
        } catch {
          // refused, as it should be
        }
      }
      return { examined: eligible.length, failures };
    },
  },
  {
    id: 'robustness/resources-readable',
    category: 'robustness',
    spec: 'server/resources#resource-contents',
    advisory: false,
    async run({ client, resources }) {
      // Reading is the point of listing; a listed resource that cannot be
      // read is a broken promise. Capped so a huge server stays checkable.
      const sample = (resources ?? []).slice(0, 20);
      const failures = [];
      for (const resource of sample) {
        try {
          // Malformed contents never arrive: the SDK client rejects them in
          // transit, which surfaces here as a read failure.
          await client.readResource({ uri: resource.uri });
        } catch (error) {
          failures.push({
            subject: resource.uri,
            detail: `listed resource ${resource.uri} cannot be read: ${(error as Error).message}`,
          });
        }
      }
      if ((resources?.length ?? 0) > sample.length) {
        failures.push({
          detail: `only the first ${sample.length} of ${resources!.length} resources were read; the rest were not checked`,
          advice: 'A cap, not a verdict: rerun against a smaller instance for full coverage.',
        });
      }
      return { examined: sample.length, failures };
    },
  },
  {
    id: 'robustness/prompts-render',
    category: 'robustness',
    spec: 'server/prompts#promptmessage',
    advisory: false,
    async run({ client, prompts }) {
      // Filled with placeholder text; a server may legitimately refuse the
      // values, so only a malformed SUCCESS is a failure.
      const sample = (prompts ?? []).slice(0, 10);
      const failures = [];
      for (const prompt of sample) {
        const args = Object.fromEntries(
          (prompt.arguments ?? []).filter((a) => a.required).map((a) => [a.name, 'checkmcp']),
        );
        let messages;
        try {
          messages = (await client.getPrompt({ name: prompt.name, arguments: args })).messages;
        } catch {
          continue;
        }
        const bad = messages.find(
          (m) => (m.role !== 'user' && m.role !== 'assistant') || !m.content?.type,
        );
        if (messages.length === 0 || bad) {
          failures.push({
            subject: prompt.name,
            detail: `prompt "${prompt.name}" rendered malformed messages: ${JSON.stringify(messages).slice(0, 120)}`,
          });
        }
      }
      return { examined: sample.length, failures };
    },
  },
  {
    id: 'robustness/bogus-cursor',
    category: 'robustness',
    spec: 'server/utilities/pagination',
    advisory: false,
    async run({ client, resources, prompts }) {
      // A garbage cursor may be answered or refused; it must not kill the
      // server. The follow-up ping is the actual verdict.
      const surfaces: [string, () => Promise<unknown>][] = [
        ['tools/list', () => client.listTools({ cursor: 'checkmcp-bogus-cursor' })],
      ];
      if (resources) surfaces.push(['resources/list', () => client.listResources({ cursor: 'checkmcp-bogus-cursor' })]);
      if (prompts) surfaces.push(['prompts/list', () => client.listPrompts({ cursor: 'checkmcp-bogus-cursor' })]);
      const failures = [];
      for (const [method, call] of surfaces) {
        await call().catch(() => undefined);
        try {
          await client.ping();
        } catch (error) {
          failures.push({
            subject: method,
            detail: `a bogus pagination cursor on ${method} took the server down: ${(error as Error).message}`,
          });
          break;
        }
      }
      return { examined: surfaces.length, failures };
    },
  },
  {
    id: 'robustness/survives-the-battery',
    category: 'robustness',
    spec: 'basic/utilities/ping',
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
  // A server that offers no tools may not implement tools/list at all;
  // method-not-found means zero tools, not a broken server.
  const tools = await client.listTools().then(
    (r) => r.tools,
    (error) => {
      if ((error as { code?: number }).code === -32601) return [];
      throw error;
    },
  );

  // Resources and prompts are checked only when their capability is declared.
  // A declared capability whose list call fails yields an empty list here;
  // handshake/declared-lists-answer reports the breakage itself.
  const caps = client.getServerCapabilities();
  const listed = async <T>(declared: unknown, list: () => Promise<T[]>): Promise<T[] | undefined> =>
    declared === undefined ? undefined : list().catch(() => []);
  const resources = await listed(caps?.resources, async () => (await client.listResources()).resources);
  const templates = await listed(caps?.resources, async () => (await client.listResourceTemplates()).resourceTemplates);
  const prompts = await listed(caps?.prompts, async () => (await client.listPrompts()).prompts);

  const ctx: Context = { client, tools, resources, templates, prompts };
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
