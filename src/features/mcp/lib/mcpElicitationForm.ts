import {
  type ElicitationValue,
  elicitationEnumValues,
  parseElicitationSchema,
  validateElicitationContent,
} from '@shared/protocol/mcp-elicitation';
import type { McpArgumentField } from '@/features/mcp/components/McpArgumentField';
import { parseMcpArgument } from '@/features/mcp/lib/mcpArgumentValidation';

/**
 * Elicitation form model (#860). Reuses the tool-argument form primitives
 * (`McpArgumentField` + `parseMcpArgument`): every field is edited as text and
 * parsed by its schema type, then the whole object is checked against the
 * server's `requestedSchema` with the same validator main re-runs.
 */

export interface ElicitationFormModel {
  fields: McpArgumentField[];
  initialValues: Record<string, string>;
}

function describeChoices(values: unknown[]): string {
  return `One of: ${values.map(String).join(', ')}`;
}

export function buildElicitationForm(requestedSchema: unknown): ElicitationFormModel | null {
  const schema = parseElicitationSchema(requestedSchema);
  if (!schema) return null;
  const required = new Set(schema.required ?? []);
  const fields: McpArgumentField[] = [];
  const initialValues: Record<string, string> = {};
  for (const [name, prop] of Object.entries(schema.properties)) {
    const type = typeof prop.type === 'string' ? prop.type : 'string';
    const choices =
      type === 'array'
        ? (prop.items?.enum ?? prop.items?.anyOf?.map((option) => option?.const))
        : elicitationEnumValues(prop);
    const description = [prop.title, prop.description, choices ? describeChoices(choices) : null]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join(' — ');
    fields.push({
      name,
      type,
      required: required.has(name),
      isComplex: type === 'array',
      ...(description ? { description } : {}),
    });
    if (prop.default !== undefined) {
      initialValues[name] =
        typeof prop.default === 'string' ? prop.default : JSON.stringify(prop.default);
    }
  }
  return { fields, initialValues };
}

export type ElicitationContentResult =
  | { ok: true; content: Record<string, ElicitationValue> }
  | { ok: false; errors: Record<string, string> };

/** Parse the raw field strings and validate them against `requestedSchema`. */
export function buildElicitationContent(
  requestedSchema: unknown,
  fields: McpArgumentField[],
  values: Record<string, string>
): ElicitationContentResult {
  const content: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const raw = values[field.name] ?? '';
    if (raw === '') continue;
    const parsed = parseMcpArgument(raw, field.type);
    if (parsed.ok) content[field.name] = parsed.value;
    else errors[field.name] = parsed.error;
  }
  const validation = validateElicitationContent(requestedSchema, content);
  if (validation.ok && Object.keys(errors).length === 0) {
    return { ok: true, content: validation.value };
  }
  // Parse errors win over the schema check's "Required." for the same field.
  return { ok: false, errors: { ...(validation.ok ? {} : validation.errors), ...errors } };
}
