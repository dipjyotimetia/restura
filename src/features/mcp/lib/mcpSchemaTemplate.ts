import type { McpJsonSchema } from '@/types';

/**
 * Generate a JSON template from a JSON Schema. Used to pre-fill the parameter
 * editor when a tool/resource/prompt is selected, modeled on gRPC's
 * `generateRequestTemplate` for proto messages.
 *
 * Conservative defaults — empty string for `string`, 0 for `number`, [] for arrays,
 * recursive {} for objects (only including required fields by default to keep
 * the template uncluttered). The caller can opt to include optional fields too.
 */
export function generateMcpTemplate(
  schema: McpJsonSchema | undefined,
  options: { includeOptional?: boolean; maxDepth?: number } = {}
): unknown {
  const { includeOptional = false, maxDepth = 5 } = options;
  if (!schema) return {};
  return generateValue(schema, includeOptional, 0, maxDepth, new Set());
}

function generateValue(
  schema: McpJsonSchema,
  includeOptional: boolean,
  depth: number,
  maxDepth: number,
  visiting: Set<string>
): unknown {
  if (depth > maxDepth) return null;

  // Honor an explicit default
  if (schema.default !== undefined) return schema.default;

  // Honor an enum's first value as a sensible default
  if (schema.enum && schema.enum.length > 0) return schema.enum[0];

  // Resolve oneOf/anyOf to the first option for templating
  if (schema.oneOf && schema.oneOf.length > 0) {
    return generateValue(schema.oneOf[0]!, includeOptional, depth, maxDepth, visiting);
  }
  if (schema.anyOf && schema.anyOf.length > 0) {
    return generateValue(schema.anyOf[0]!, includeOptional, depth, maxDepth, visiting);
  }

  // $ref isn't followed (we don't have a registry); emit null and let the user fill in
  if (schema.$ref) return null;

  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;

  switch (type) {
    case 'string':
      if (schema.format === 'date-time') return new Date().toISOString();
      if (schema.format === 'uri') return 'https://example.com';
      if (schema.format === 'email') return 'user@example.com';
      if (schema.format === 'uuid') return '00000000-0000-0000-0000-000000000000';
      return '';
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    case 'null':
      return null;
    case 'array': {
      // Emit a single example element so the user sees the structure
      if (Array.isArray(schema.items)) return [];
      if (schema.items) {
        return [generateValue(schema.items, includeOptional, depth + 1, maxDepth, visiting)];
      }
      return [];
    }
    case 'object':
    default: {
      const out: Record<string, unknown> = {};
      const props = schema.properties ?? {};
      const required = new Set(schema.required ?? []);
      for (const [name, propSchema] of Object.entries(props)) {
        if (!includeOptional && !required.has(name)) continue;
        out[name] = generateValue(propSchema, includeOptional, depth + 1, maxDepth, visiting);
      }
      return out;
    }
  }
}
