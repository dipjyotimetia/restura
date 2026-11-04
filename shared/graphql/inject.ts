/**
 * JSON-safe `{{variable}}` substitution for saved GraphQL bodies — shared by the
 * renderer (collection runs / saved-request runs) and the CLI runner so both
 * resolve a saved request to the same envelope.
 *
 * Plain string replacement breaks JSON as soon as a value holds a `"`, `\` or
 * a newline (`{"name": "{{name}}"}` with `O"Brien` is no longer JSON). When the
 * text parses as JSON, substitution runs inside each string value instead, so
 * the value is re-escaped on serialisation. Text that is not (yet) JSON — e.g.
 * an unquoted numeric placeholder `{"limit": {{limit}}}` — falls back to plain
 * substitution; the envelope builder then reports it if it is still invalid.
 */

import type { HttpRequest } from '../types';

export type InjectText = (text: string) => string;

/** Substitute inside every string (keys are left as written) of a JSON value. */
export function injectJsonStrings(value: unknown, inject: InjectText): unknown {
  if (typeof value === 'string') return inject(value);
  if (Array.isArray(value)) return value.map((v) => injectJsonStrings(v, inject));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = injectJsonStrings(v, inject);
    return out;
  }
  return value;
}

/** JSON-safe substitution for a JSON document; plain substitution when it isn't JSON. */
export function injectJsonText(text: string, inject: InjectText): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return inject(text);
  }
  return JSON.stringify(injectJsonStrings(parsed, inject));
}

/**
 * `body.raw` as a stored `{ query, variables, operationName }` envelope: resolve
 * the query / operationName strings and every string inside `variables`, keeping
 * the envelope shape. Anything else (a plain query document, or JSON that is not
 * an envelope object) gets plain substitution.
 */
function injectRaw(raw: string, inject: InjectText): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return inject(raw);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return inject(raw);
  const envelope = parsed as { query?: unknown; variables?: unknown; operationName?: unknown };
  const out: Record<string, unknown> = { ...envelope };
  if (typeof envelope.query === 'string') out.query = inject(envelope.query);
  if (envelope.variables && typeof envelope.variables === 'object') {
    out.variables = injectJsonStrings(envelope.variables, inject);
  }
  if (typeof envelope.operationName === 'string') {
    out.operationName = inject(envelope.operationName);
  }
  return JSON.stringify(out);
}

/** Resolve `{{vars}}` in a GraphQL body's document/envelope and variables JSON. */
export function injectGraphQLBody(
  body: HttpRequest['body'],
  inject: InjectText
): HttpRequest['body'] {
  let next = body;
  if (next.raw !== undefined) next = { ...next, raw: injectRaw(next.raw, inject) };
  if (next.graphqlVariables !== undefined) {
    next = { ...next, graphqlVariables: injectJsonText(next.graphqlVariables, inject) };
  }
  return next;
}
