import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { connect } from './connect.js';

/** The per-tool contract worth guarding: what callers integrate against. */
interface ToolContract {
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
}

type Contracts = Record<string, ToolContract>;

export interface SnapshotOptions {
  /** Where snapshot files live. Default: __schemas__ under the working directory. */
  dir?: string;
}

/**
 * Snapshot every tool's declared contract to a committed file, and fail when
 * a contract drifts. A tool's schema is its public interface: changing it
 * carelessly breaks every agent already integrated against the server,
 * without a single test in the server's own suite failing.
 *
 * First run writes `<dir>/<serverName>.json`; commit it. From then on any
 * drift throws, described change by change. An intentional change is
 * accepted by rerunning with CHECKMCP_UPDATE=1 and committing the diff.
 */
export async function snapshotSchemas(
  server: McpServer | Server,
  options: SnapshotOptions = {},
): Promise<void> {
  const client = await connect(server);
  const tools = await client.tools();
  const name = client.raw.getServerVersion()?.name ?? 'server';
  await client.close();

  const current: Contracts = {};
  for (const tool of [...tools].sort((a, b) => a.name.localeCompare(b.name))) {
    current[tool.name] = {
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
    };
  }

  const dir = options.dir ?? join(process.cwd(), '__schemas__');
  const file = join(dir, `${name}.json`);
  const serialized = JSON.stringify(current, null, 2) + '\n';

  let previous: Contracts | undefined;
  try {
    previous = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // No snapshot yet: this run defines the contract.
  }

  if (previous === undefined || process.env.CHECKMCP_UPDATE === '1') {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, serialized);
    return;
  }

  const drift = describeDrift(previous, current);
  if (drift.length === 0) return;

  throw new Error(
    [
      `Tool contracts drifted from ${file}:`,
      ...drift.map((line) => `  ${line}`),
      `Intentional? rerun with CHECKMCP_UPDATE=1 and commit the diff.`,
    ].join('\n'),
  );
}

/** One sentence per change, written for the human deciding whether to allow it. */
function describeDrift(previous: Contracts, current: Contracts): string[] {
  const lines: string[] = [];

  for (const name of Object.keys(previous)) {
    if (!(name in current)) {
      lines.push(`tool "${name}" was removed. This breaks every existing caller.`);
    }
  }
  for (const name of Object.keys(current)) {
    if (!(name in previous)) {
      lines.push(`tool "${name}" is new. Safe for existing callers; snapshot it to make it official.`);
    }
  }

  for (const name of Object.keys(current)) {
    const before = previous[name];
    if (!before) continue;
    const after = current[name];
    if (before.description !== after.description) {
      lines.push(`description of "${name}" changed. Models pick tools by description; reread it as a stranger would.`);
    }
    lines.push(...describeSchemaDrift(name, 'argument', before.inputSchema, after.inputSchema));
    lines.push(...describeSchemaDrift(name, 'output field', before.outputSchema, after.outputSchema));
  }

  return lines;
}

interface ObjectSchema {
  properties?: Record<string, { type?: string }>;
  required?: string[];
}

function describeSchemaDrift(
  tool: string,
  noun: string,
  beforeRaw: unknown,
  afterRaw: unknown,
): string[] {
  if (JSON.stringify(beforeRaw) === JSON.stringify(afterRaw)) return [];

  const before = (beforeRaw ?? {}) as ObjectSchema;
  const after = (afterRaw ?? {}) as ObjectSchema;
  const beforeProps = before.properties ?? {};
  const afterProps = after.properties ?? {};
  const beforeRequired = new Set(before.required ?? []);
  const afterRequired = new Set(after.required ?? []);
  const lines: string[] = [];

  for (const key of Object.keys(beforeProps)) {
    if (!(key in afterProps)) {
      lines.push(`${noun} "${key}" of "${tool}" was removed. Callers still sending it may be refused.`);
    }
  }
  for (const key of Object.keys(afterProps)) {
    if (!(key in beforeProps)) {
      lines.push(
        afterRequired.has(key)
          ? `${noun} "${key}" of "${tool}" is new and required. This breaks every existing caller.`
          : `${noun} "${key}" of "${tool}" is new and optional. Safe for existing callers.`,
      );
    }
  }
  for (const key of Object.keys(afterProps)) {
    if (!(key in beforeProps)) continue;
    const was = beforeProps[key]?.type;
    const is = afterProps[key]?.type;
    if (was !== is) {
      lines.push(`${noun} "${key}" of "${tool}" changed type: was ${was}, now ${is}. This breaks existing callers.`);
    }
    if (!beforeRequired.has(key) && afterRequired.has(key)) {
      lines.push(`${noun} "${key}" of "${tool}": was optional, now required. This breaks every caller that omits it.`);
    }
    if (beforeRequired.has(key) && !afterRequired.has(key)) {
      lines.push(`${noun} "${key}" of "${tool}": was required, now optional. Safe for existing callers.`);
    }
  }

  // A change the classifier cannot name still fails; never let drift pass silently.
  if (lines.length === 0) {
    lines.push(`${noun === 'argument' ? 'inputSchema' : 'outputSchema'} of "${tool}" changed in a way not classified above; compare the snapshot diff.`);
  }
  return lines;
}
