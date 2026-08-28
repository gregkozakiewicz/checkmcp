import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { metaOf } from './meta.js';

interface MatcherResult {
  pass: boolean;
  message: () => string;
}

/** "tool "add" (called with {"a":2})", or just "the result" for an untagged object. */
function describeCall(result: unknown): string {
  const meta = metaOf(result);
  if (!meta) return 'the result';
  return meta.args === undefined
    ? `tool "${meta.tool}" (called with no arguments)`
    : `tool "${meta.tool}" (called with ${JSON.stringify(meta.args)})`;
}

function textOf(result: CallToolResult): string {
  return (result.content ?? [])
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function matches(text: string, pattern: string | RegExp): boolean {
  return typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text);
}

/** Is `expected` a deep subset of `actual`? Arrays must match in length and order. */
function isSubset(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item, i) => isSubset(actual[i], item))
    );
  }
  if (typeof expected === 'object' && expected !== null) {
    if (typeof actual !== 'object' || actual === null) return false;
    return Object.entries(expected).every(([key, value]) =>
      isSubset((actual as Record<string, unknown>)[key], value),
    );
  }
  return Object.is(actual, expected);
}

let ajv: AjvJsonSchemaValidator | undefined;

export const matchers = {
  toBeToolSuccess(received: CallToolResult): MatcherResult {
    const pass = !received.isError;
    return {
      pass,
      message: () =>
        pass
          ? `Expected ${describeCall(received)} to be an error result, but it succeeded:\n  ${textOf(received) || '(no text content)'}`
          : `Expected ${describeCall(received)} to succeed, but it returned an error:\n  ${textOf(received) || '(no text content)'}`,
    };
  },

  toBeToolError(received: CallToolResult, pattern?: string | RegExp): MatcherResult {
    if (!received.isError) {
      return {
        pass: false,
        message: () =>
          `Expected ${describeCall(received)} to return an error result, but it succeeded:\n  ${textOf(received) || '(no text content)'}`,
      };
    }
    const text = textOf(received);
    const pass = pattern === undefined || matches(text, pattern);
    return {
      pass,
      message: () =>
        pass
          ? `Expected ${describeCall(received)} not to return an error matching ${String(pattern ?? '(any)')}, but it did:\n  ${text}`
          : `Expected the error from ${describeCall(received)} to match ${String(pattern)}, but it said:\n  ${text || '(no text content)'}`,
    };
  },

  toHaveTextContent(received: CallToolResult, pattern: string | RegExp): MatcherResult {
    const text = textOf(received);
    const pass = matches(text, pattern);
    return {
      pass,
      message: () =>
        pass
          ? `Expected ${describeCall(received)} not to have text content matching ${String(pattern)}, but it does:\n  ${text}`
          : `Expected ${describeCall(received)} to have text content matching ${String(pattern)}, but its text is:\n  ${text || '(no text content)'}`,
    };
  },

  toHaveStructuredContent(received: CallToolResult, shape: Record<string, unknown>): MatcherResult {
    if (received.structuredContent === undefined) {
      return {
        pass: false,
        message: () =>
          `Expected ${describeCall(received)} to have structuredContent, but the result carries none. ` +
          `Return { structuredContent: ... } from the tool, alongside content.`,
      };
    }
    const pass = isSubset(received.structuredContent, shape);
    return {
      pass,
      message: () =>
        `Expected structuredContent of ${describeCall(received)} ${pass ? 'not ' : ''}to contain\n` +
        `  ${JSON.stringify(shape)}\n` +
        `but received\n  ${JSON.stringify(received.structuredContent)}`,
    };
  },

  toMatchOutputSchema(received: CallToolResult): MatcherResult {
    const meta = metaOf(received);
    if (!meta) {
      return {
        pass: false,
        message: () =>
          `This result was not produced by checkmcp's connect(), so its tool's output schema is unknown. ` +
          `Call the tool through the client returned by connect().`,
      };
    }
    if (!meta.outputSchema) {
      return {
        pass: false,
        message: () =>
          `Tool "${meta.tool}" declares no output schema, so there is nothing to validate against. ` +
          `Declare outputSchema where the tool is registered.`,
      };
    }
    if (received.structuredContent === undefined) {
      return {
        pass: false,
        message: () =>
          `Tool "${meta.tool}" declares an output schema, but ${describeCall(received)} returned no structuredContent to validate.`,
      };
    }
    ajv ??= new AjvJsonSchemaValidator();
    const verdict = ajv.getValidator(meta.outputSchema)(received.structuredContent);
    return {
      pass: verdict.valid,
      message: () =>
        verdict.valid
          ? `Expected structuredContent of ${describeCall(received)} not to match the declared output schema, but it does.`
          : `structuredContent of ${describeCall(received)} does not match the declared output schema:\n` +
            `  ${verdict.errorMessage}\n  received: ${JSON.stringify(received.structuredContent)}`,
    };
  },
};

// Register wherever we land: jest (and vitest with globals) expose a global
// expect; plain vitest is resolvable from inside its own test runtime.
const globalExpect = (globalThis as { expect?: { extend(m: object): void } }).expect;
if (globalExpect?.extend) {
  globalExpect.extend(matchers);
} else {
  try {
    const { expect } = await import('vitest');
    expect.extend(matchers);
  } catch {
    throw new Error(
      `checkmcp/matchers could not find a test runner to register with. ` +
        `Import it inside a vitest or jest run, or register manually: expect.extend(matchers).`,
    );
  }
}

interface CheckmcpMatchers<R> {
  toBeToolSuccess(): R;
  toBeToolError(pattern?: string | RegExp): R;
  toHaveTextContent(pattern: string | RegExp): R;
  toHaveStructuredContent(shape: Record<string, unknown>): R;
  toMatchOutputSchema(): R;
}

// One augmentation covers both runners: jest reads jest.Matchers directly,
// and vitest inherits it through its jest-compatibility layer.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace jest {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface Matchers<R> extends CheckmcpMatchers<R> {}
  }
}
