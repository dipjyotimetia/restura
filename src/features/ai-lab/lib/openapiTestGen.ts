// Generate an eval dataset from an OpenAPI spec. We extract a compact operation
// summary from the raw spec (no $ref dereference — a summary is enough to seed
// generation and keeps this dependency-free), then ask a model to emit test
// cases as STRUCTURED output (a tool call), same discipline as the judge.
import type { LlmChatMessage } from './llmClient';
import type { CompletionResult } from '@shared/protocol/ai/types';
import { extractFirstJsonObject } from '@shared/protocol/ai/json-extract';
import type { DatasetCase } from '../types';

export interface OperationSummary {
  method: string;
  path: string;
  summary?: string;
  /** Parameter names (path/query/header) referenced by the operation. */
  params: string[];
}

export interface SpecSummary {
  title: string;
  operations: OperationSummary[];
}

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'patch', 'head', 'options']);

/** Lightweight OpenAPI 3 / Swagger 2 extraction from a parsed spec object. */
export function summarizeOpenApi(spec: unknown): SpecSummary {
  const s = (spec ?? {}) as {
    info?: { title?: string };
    paths?: Record<
      string,
      Record<
        string,
        { summary?: string; operationId?: string; parameters?: Array<{ name?: string }> }
      >
    >;
  };
  const operations: OperationSummary[] = [];
  for (const [path, methods] of Object.entries(s.paths ?? {})) {
    for (const [method, op] of Object.entries(methods ?? {})) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;
      const params = (op.parameters ?? [])
        .map((p) => p.name)
        .filter((n): n is string => typeof n === 'string');
      operations.push({
        method: method.toUpperCase(),
        path,
        ...(op.summary ? { summary: op.summary } : {}),
        params,
      });
    }
  }
  return { title: s.info?.title ?? 'API', operations };
}

export const DATASET_TOOL = {
  name: 'submit_dataset',
  description: 'Submit the generated test cases for the dataset.',
  inputSchema: {
    type: 'object',
    properties: {
      cases: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            vars: { type: 'object', description: 'Input variables for the prompt template.' },
            expected: { type: 'string', description: 'Exact expected output, if deterministic.' },
            reference: {
              type: 'string',
              description: 'Reference/gold answer for judge/reference scorers.',
            },
          },
          required: ['vars'],
        },
      },
    },
    required: ['cases'],
  },
} as const;

export function buildGenMessages(args: {
  summary: SpecSummary;
  count: number;
  instructions?: string;
}): LlmChatMessage[] {
  const ops = args.summary.operations
    .slice(0, 60)
    .map(
      (o) =>
        `- ${o.method} ${o.path}${o.summary ? ` — ${o.summary}` : ''}${o.params.length ? ` (params: ${o.params.join(', ')})` : ''}`
    )
    .join('\n');
  const system =
    'You generate test datasets for evaluating LLM prompts about an HTTP API. Produce diverse, ' +
    'realistic cases (including a few edge cases). Call the submit_dataset tool with the cases. ' +
    "Each case's `vars` are the template variables a prompt would use; include an `expected` or " +
    '`reference` when a correct answer is well-defined.';
  const user =
    `API: ${args.summary.title}\n\nOperations:\n${ops}\n\n` +
    (args.instructions ? `Extra instructions: ${args.instructions}\n\n` : '') +
    `Generate ${args.count} test cases.`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** Parse generated cases from the dataset tool call (or JSON in the text body). */
export function parseGeneratedCases(completion: CompletionResult): Array<Omit<DatasetCase, 'id'>> {
  const raw =
    completion.toolCalls.find((t) => t.name === DATASET_TOOL.name)?.input ??
    extractFirstJsonObject(completion.text);
  if (!raw) return [];
  let parsed: { cases?: unknown };
  try {
    parsed = JSON.parse(raw) as { cases?: unknown };
  } catch {
    return [];
  }
  const cases = Array.isArray(parsed.cases) ? parsed.cases : [];
  const out: Array<Omit<DatasetCase, 'id'>> = [];
  for (const c of cases) {
    if (!c || typeof c !== 'object') continue;
    const obj = c as { vars?: unknown; expected?: unknown; reference?: unknown };
    const vars = normalizeVars(obj.vars);
    out.push({
      vars,
      ...(typeof obj.expected === 'string' ? { expected: obj.expected } : {}),
      ...(typeof obj.reference === 'string' ? { reference: obj.reference } : {}),
    });
  }
  return out;
}

function normalizeVars(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] = typeof val === 'string' ? val : JSON.stringify(val);
  }
  return out;
}
