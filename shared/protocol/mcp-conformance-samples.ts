/**
 * Opt-in sample `tools/call` step of the MCP conformance engine (#911): which
 * tools may be called, argument synthesis, and output validation. Split from
 * `mcp-conformance.ts`; types come from there (type-only, no runtime cycle).
 */
import type { McpToolDescriptor } from '../types/streaming';
import type {
  McpConformanceSession,
  McpDescriptorSnapshot,
  McpFindingSeverity,
  McpSampleCallMode,
  McpSampleCallRecord,
} from './mcp-conformance';
import { clipText, hashJson } from './mcp-conformance-text';
import { validateAgainstSchema, validateToolOutput } from './mcp-output-schema';

type Add = (severity: McpFindingSeverity, code: string, message: string, subject?: string) => void;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------- sample calls ----------

/** Minimal valid value for a JSON Schema, or `undefined` when we can't synthesize one. */
export function synthesizeSample(schema: unknown, depth = 0): unknown {
  if (!isRecord(schema) || depth > 4) return undefined;
  if ('const' in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if ('default' in schema) return schema.default;
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case 'string':
      return typeof schema.minLength === 'number' && schema.minLength > 0
        ? 'x'.repeat(Math.min(schema.minLength, 64))
        : '';
    case 'integer':
    case 'number':
      return typeof schema.minimum === 'number' ? schema.minimum : 0;
    case 'boolean':
      return false;
    case 'null':
      return null;
    case 'array':
      return [];
    case 'object':
    case undefined: {
      const required = Array.isArray(schema.required) ? (schema.required as unknown[]) : [];
      const props = isRecord(schema.properties) ? schema.properties : {};
      const obj: Record<string, unknown> = {};
      for (const key of required) {
        if (typeof key !== 'string') continue;
        const v = synthesizeSample(props[key], depth + 1);
        if (v === undefined) return undefined;
        obj[key] = v;
      }
      return obj;
    }
    default:
      return undefined;
  }
}

export function snapshotTool(tool: McpToolDescriptor): McpDescriptorSnapshot {
  const fields: Record<string, string> = {};
  for (const key of [
    'title',
    'description',
    'inputSchema',
    'outputSchema',
    'annotations',
  ] as const) {
    if (tool[key] !== undefined) fields[key] = hashJson(tool[key]);
  }
  return {
    name: clipText(tool.name),
    ...(tool.title ? { title: clipText(tool.title) } : {}),
    fields,
  };
}

/** True when the validator gave up on a pathological schema instead of judging it. */
function tooComplex(issues: Array<{ message: string }>): boolean {
  return issues.some((i) => /too (complex|deep|large)|exceed/i.test(i.message));
}

/** Validator calls must never take the run down: a throw is treated as "too complex". */
function guarded<T>(fn: () => T): { ok: true; value: T } | { ok: false } {
  try {
    return { ok: true, value: fn() };
  } catch {
    return { ok: false };
  }
}

type SampleDecision = { call: true } | { call: false; reason: string };

function decideSample(
  tool: McpToolDescriptor,
  mode: McpSampleCallMode,
  approved: Set<string>
): SampleDecision {
  if (mode === 'off') return { call: false, reason: 'sample calls disabled' };
  const a = tool.annotations;
  // A contradictory readOnlyHint + destructiveHint is untrustworthy: never call.
  if (a?.destructiveHint === true) {
    return { call: false, reason: 'destructiveHint: never auto-invoked' };
  }
  if (a?.readOnlyHint === true) return { call: true };
  if (mode === 'selected' && approved.has(tool.name)) return { call: true };
  return { call: false, reason: 'not readOnlyHint and not explicitly approved' };
}

function hasTextBlock(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.some((c) => isRecord(c) && c.type === 'text' && typeof c.text === 'string')
  );
}

async function sampleOne(
  session: McpConformanceSession,
  tool: McpToolDescriptor,
  args: unknown,
  add: Add,
  now: () => number
): Promise<McpSampleCallRecord> {
  const start = now();
  try {
    const result = await session.request('tools/call', { name: tool.name, arguments: args });
    const durationMs = now() - start;
    if (!isRecord(result)) {
      add('error', 'tools.call-result-malformed', 'tools/call result must be an object', tool.name);
      return {
        tool: tool.name,
        status: 'protocol-error',
        durationMs,
        reason: 'result not an object',
      };
    }
    if (!Array.isArray(result.content) && result.structuredContent === undefined) {
      add(
        'error',
        'tools.call-content-missing',
        'tools/call result has neither a content array nor structuredContent',
        tool.name
      );
    }
    if (result.isError === true) {
      add('info', 'tools.sample-tool-error', 'Sample call returned isError: true', tool.name);
      return { tool: tool.name, status: 'tool-error', durationMs };
    }
    const checked = guarded(() => validateToolOutput(tool.outputSchema, result));
    if (!checked.ok || (checked.value.status === 'invalid' && tooComplex(checked.value.issues))) {
      add(
        'info',
        'tools.schema-too-complex',
        'outputSchema is too complex to validate; skipped',
        tool.name
      );
      return { tool: tool.name, status: 'ok', durationMs, outputSchema: 'no-schema' };
    }
    const validation = checked.value;
    if (validation.status === 'invalid' || validation.status === 'missing') {
      const code =
        validation.status === 'missing'
          ? 'tools.structured-content-missing'
          : 'tools.output-schema-mismatch';
      for (const issue of validation.issues) {
        add('error', code, `${issue.path}: ${issue.message}`, tool.name);
      }
    }
    if (result.structuredContent !== undefined && !hasTextBlock(result.content)) {
      add(
        'warning',
        'tools.structured-content-no-text',
        'structuredContent should also be serialized in a text content block for backward compatibility',
        tool.name
      );
    }
    if (result.structuredContent !== undefined && !tool.outputSchema) {
      add(
        'info',
        'tools.structured-content-no-schema',
        'Returned structuredContent without declaring an outputSchema',
        tool.name
      );
    }
    return { tool: tool.name, status: 'ok', durationMs, outputSchema: validation.status };
  } catch (err) {
    add('warning', 'tools.sample-failed', `Sample call failed: ${errMessage(err)}`, tool.name);
    return {
      tool: tool.name,
      status: 'protocol-error',
      durationMs: now() - start,
      reason: errMessage(err),
    };
  }
}

export async function runSamples(
  session: McpConformanceSession,
  tools: McpToolDescriptor[],
  opts: { mode: McpSampleCallMode; approved: Set<string> },
  add: Add,
  now: () => number
): Promise<McpSampleCallRecord[]> {
  const records: McpSampleCallRecord[] = [];
  const counts = new Map<string, number>();
  for (const t of tools) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
  for (const tool of tools) {
    // Duplicate names are ambiguous (which descriptor does the call hit?): never call.
    if ((counts.get(tool.name) ?? 0) > 1) {
      records.push({ tool: tool.name, status: 'skipped', reason: 'duplicate tool name' });
      continue;
    }
    const decision = decideSample(tool, opts.mode, opts.approved);
    if (!decision.call) {
      records.push({ tool: tool.name, status: 'skipped', reason: decision.reason });
      if (tool.outputSchema && opts.mode !== 'off') {
        add(
          'info',
          'tools.output-schema-unverified',
          `outputSchema not verified: ${decision.reason}`,
          tool.name
        );
      }
      continue;
    }
    const args = synthesizeSample(tool.inputSchema ?? { type: 'object' });
    const inputCheck = guarded(() => validateAgainstSchema(tool.inputSchema, args));
    if (!inputCheck.ok || tooComplex(inputCheck.value)) {
      records.push({ tool: tool.name, status: 'skipped', reason: 'inputSchema too complex' });
      add(
        'info',
        'tools.schema-too-complex',
        'inputSchema is too complex to validate; not called',
        tool.name
      );
      continue;
    }
    if (args === undefined || inputCheck.value.length > 0) {
      records.push({
        tool: tool.name,
        status: 'skipped',
        reason: 'cannot synthesize valid arguments',
      });
      add(
        'info',
        'tools.sample-skipped',
        'Could not synthesize valid arguments; not called',
        tool.name
      );
      continue;
    }
    records.push(await sampleOne(session, tool, args, add, now));
  }
  return records;
}
