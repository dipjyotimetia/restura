/** One step into a JSON value: an object key or an array index. */
export type JsonPathSegment = string | number;

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * JSONPath for a node, in the syntax the response JSONPath box accepts
 * (jsonpath-plus): `$.user.tags[0]`, with bracket quoting for keys that
 * aren't plain identifiers (`$['content-type']`).
 */
export function jsonPathFor(segments: readonly JsonPathSegment[]): string {
  let path = '$';
  for (const segment of segments) {
    if (typeof segment === 'number') path += `[${segment}]`;
    else if (IDENTIFIER.test(segment)) path += `.${segment}`;
    else path += `['${segment.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}']`;
  }
  return path;
}

/** Short one-line preview of a JSON value for a collapsed/leaf tree row. */
export function previewJson(value: unknown): string {
  if (Array.isArray(value)) return `Array(${value.length})`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    return `{${keys.slice(0, 3).join(', ')}${keys.length > 3 ? ', …' : ''}}`;
  }
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}
