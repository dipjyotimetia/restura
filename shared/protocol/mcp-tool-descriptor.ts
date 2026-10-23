import type { McpJsonSchema, McpToolAnnotations, McpToolDescriptor } from '../types/streaming';

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function normalizeAnnotations(raw: unknown): McpToolAnnotations | undefined {
  if (!isObject(raw)) return undefined;
  const out: McpToolAnnotations = {};
  if (typeof raw.title === 'string' && raw.title !== '') out.title = raw.title;
  for (const key of [
    'readOnlyHint',
    'destructiveHint',
    'idempotentHint',
    'openWorldHint',
  ] as const) {
    const v = raw[key];
    if (typeof v === 'boolean') out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Normalise one raw `tools/list` entry (desktop SDK result or web JSON-RPC
 * body — both arrive as untrusted JSON) into a McpToolDescriptor. Keeps the
 * 2025-06-18 fields `title`, `outputSchema` and `annotations`; drops anything
 * malformed instead of trusting it. Annotations are *hints* from a possibly
 * untrusted server and are never used for security decisions.
 */
export function normalizeMcpToolDescriptor(raw: unknown): McpToolDescriptor | null {
  if (!isObject(raw)) return null;
  if (typeof raw.name !== 'string' || raw.name === '') return null;

  const annotations = normalizeAnnotations(raw.annotations);
  // Spec: display name precedence is title > annotations.title > name.
  const title = typeof raw.title === 'string' && raw.title !== '' ? raw.title : annotations?.title;

  const tool: McpToolDescriptor = { name: raw.name };
  if (title !== undefined) tool.title = title;
  if (typeof raw.description === 'string') tool.description = raw.description;
  if (isObject(raw.inputSchema)) tool.inputSchema = raw.inputSchema as McpJsonSchema;
  if (isObject(raw.outputSchema)) tool.outputSchema = raw.outputSchema as McpJsonSchema;
  if (annotations) tool.annotations = annotations;
  return tool;
}

/** Display label: title when the server supplied one, else the programmatic name. */
export function mcpToolDisplayName(tool: Pick<McpToolDescriptor, 'name' | 'title'>): string {
  return tool.title || tool.name;
}

/**
 * Only an explicit `destructiveHint: true` triggers the confirm (the spec's
 * implicit default would nag on every unannotated tool). Read-only wins over a
 * contradictory destructive hint. Hints are untrusted; this is a speed bump,
 * not a security boundary.
 */
export function isDestructiveTool(tool: Pick<McpToolDescriptor, 'annotations'>): boolean {
  const a = tool.annotations;
  return a?.destructiveHint === true && a.readOnlyHint !== true;
}
