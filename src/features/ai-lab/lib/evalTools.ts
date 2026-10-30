import type { AiToolDef } from '../types';

export type ParsedTools = { ok: true; tools: AiToolDef[] } | { ok: false; error: string };

/**
 * Parse the raw tool-definition editor text. Accepts a JSON array of
 * `{ name, description?, inputSchema }` (the shape MCP `tools/list` and the
 * providers use). Empty text means "no tools".
 */
export function parseToolsJson(text: string): ParsedTools {
  if (!text.trim()) return { ok: true, tools: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!Array.isArray(raw)) return { ok: false, error: 'Tools must be a JSON array.' };
  const tools: AiToolDef[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { ok: false, error: `Tool ${index + 1} must be an object.` };
    }
    const { name, description, inputSchema } = entry as Record<string, unknown>;
    if (typeof name !== 'string' || !name.trim()) {
      return { ok: false, error: `Tool ${index + 1} needs a non-empty "name".` };
    }
    if (seen.has(name)) return { ok: false, error: `Duplicate tool name "${name}".` };
    seen.add(name);
    if (description !== undefined && typeof description !== 'string') {
      return { ok: false, error: `Tool "${name}": "description" must be a string.` };
    }
    if (typeof inputSchema !== 'object' || inputSchema === null || Array.isArray(inputSchema)) {
      return { ok: false, error: `Tool "${name}": "inputSchema" must be a JSON schema object.` };
    }
    tools.push({
      name,
      description: description ?? '',
      inputSchema: inputSchema as Record<string, unknown>,
    });
  }
  return { ok: true, tools };
}

/** Add or replace (by name) a tool definition. */
export function upsertTool(tools: AiToolDef[], tool: AiToolDef): AiToolDef[] {
  return tools.some((existing) => existing.name === tool.name)
    ? tools.map((existing) => (existing.name === tool.name ? tool : existing))
    : [...tools, tool];
}
