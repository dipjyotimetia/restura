export type McpArgumentParseResult = { ok: true; value: unknown } | { ok: false; error: string };

export function parseMcpArgument(raw: string, type: string): McpArgumentParseResult {
  if (type === 'number' || type === 'integer') {
    if (!raw.trim()) {
      return { ok: false, error: `Enter a valid ${type}.` };
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || (type === 'integer' && !Number.isInteger(value))) {
      return { ok: false, error: `Enter a valid ${type}.` };
    }
    return { ok: true, value };
  }

  if (type === 'boolean') {
    if (raw !== 'true' && raw !== 'false') {
      return { ok: false, error: 'Enter true or false.' };
    }
    return { ok: true, value: raw === 'true' };
  }

  if (type === 'object' || type === 'array') {
    try {
      const value: unknown = JSON.parse(raw);
      if (
        type === 'object' &&
        (value === null || Array.isArray(value) || typeof value !== 'object')
      ) {
        return { ok: false, error: 'Enter valid JSON for this object.' };
      }
      if (type === 'array' && !Array.isArray(value)) {
        return { ok: false, error: 'Enter valid JSON for this array.' };
      }
      return { ok: true, value };
    } catch {
      return { ok: false, error: `Enter valid JSON for this ${type}.` };
    }
  }

  return { ok: true, value: raw };
}
