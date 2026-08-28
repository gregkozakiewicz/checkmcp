import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation/index.js';

/**
 * connect() tags each tool result with how it was produced, so matcher
 * failures can say "tool X, called with Y" instead of shrugging at a bare
 * result object. Symbol-keyed and non-enumerable: invisible to JSON,
 * toEqual and iteration.
 */
export const META = Symbol.for('checkmcp.callMeta');

export interface CallMeta {
  tool: string;
  args: Record<string, unknown> | undefined;
  outputSchema: JsonSchemaType | undefined;
}

export function tagResult<T extends object>(result: T, meta: CallMeta): T {
  Object.defineProperty(result, META, { value: meta, enumerable: false });
  return result;
}

export function metaOf(result: unknown): CallMeta | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  return (result as Record<symbol, CallMeta>)[META];
}
