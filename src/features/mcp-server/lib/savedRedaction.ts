/**
 * Redaction of *saved* request fields for agents, and its inverse guard.
 *
 * `get_request` masks credentials in what it returns (`(redacted)`,
 * `(redacted-jwt)`, `%28secret%29`, `(secret)`). An agent that copies those
 * values back into `update_request` / `create_request` must never overwrite a
 * real secret with a placeholder. So the write path recognises the exact
 * redacted form of what is saved and keeps the original value, and refuses any
 * other value that still contains a placeholder.
 */

import type { RequestPatch } from '@shared/mcp-server/control-tools';
import {
  REDACTED,
  redactBodyForAgent,
  redactHeadersForAgent,
  redactUrlCredentials,
} from '@shared/mcp-server/redaction';
import type { KeyValue, Request } from '@/types';

const TOKENISH_KEY = /(token|secret|password|passwd|api[-_]?key|auth|session|cookie|signature)/i;
const VARIABLE_ONLY = /^\s*\{\{[^{}]+\}\}\s*$/;

/** Every placeholder an agent can receive from a read tool. */
export const PLACEHOLDER_PATTERN = /\(redacted(?:-jwt)?\)|\(secret\)|%28secret%29|%28redacted%29/i;

export function containsPlaceholder(value: unknown): boolean {
  if (typeof value === 'string') return PLACEHOLDER_PATTERN.test(value);
  if (Array.isArray(value)) return value.some(containsPlaceholder);
  if (value && typeof value === 'object') return Object.values(value).some(containsPlaceholder);
  return false;
}

export interface AgentKeyValue {
  key: string;
  value: string;
  enabled: boolean;
}

/** Header / param / metadata rows: credential names keep only `{{var}}` references. */
export function redactKeyValues(rows: readonly KeyValue[] | undefined): AgentKeyValue[] {
  const sensitiveHeaders = redactHeadersForAgent(
    Object.fromEntries((rows ?? []).map((r) => [r.key, r.value]))
  );
  return (rows ?? []).map((row) => {
    const masked =
      !VARIABLE_ONLY.test(row.value) &&
      (sensitiveHeaders[row.key] === REDACTED || TOKENISH_KEY.test(row.key));
    return { key: row.key, value: masked ? REDACTED : row.value, enabled: row.enabled };
  });
}

/** Longest saved body-like text `get_request` returns in full. */
export const MAX_SAVED_TEXT_CHARS = 100_000;

/** Saved body-like text (JSON, form pairs, JWTs) with credentials masked. */
export function redactSavedText(text: string): string {
  return redactBodyForAgent(text, { redact: true, maxChars: MAX_SAVED_TEXT_CHARS }).text;
}

export function redactSavedUrl(url: string): string {
  return redactUrlCredentials(url) ?? url;
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };

const refuse = (field: string): Outcome<never> => ({
  ok: false,
  error: `${field} contains a redaction placeholder such as "(redacted)". Restura never stores those: leave the field out to keep the saved value, keep the row exactly as get_request returned it, or use a {{variable}} for the secret.`,
});

/**
 * A text field: the unchanged redacted form keeps the saved value; any other
 * value with a placeholder is refused. A saved value too long for get_request
 * to have shown in full can only be kept or replaced without placeholders —
 * never "edited" from a truncated copy.
 */
function restoreText(
  field: string,
  incoming: string | undefined,
  saved: string | undefined,
  redact: (s: string) => string
): Outcome<string | undefined> {
  if (incoming === undefined) return { ok: true, value: incoming };
  if (saved !== undefined && redact(saved) === incoming) return { ok: true, value: saved };
  if (
    saved !== undefined &&
    saved.length > MAX_SAVED_TEXT_CHARS &&
    incoming.startsWith(redact(saved).slice(0, 1_000))
  ) {
    return {
      ok: false,
      error: `${field} is longer than get_request shows (${MAX_SAVED_TEXT_CHARS.toLocaleString()} characters), so it cannot be edited from that copy. Ask the user to edit it in Restura.`,
    };
  }
  if (!PLACEHOLDER_PATTERN.test(incoming)) return { ok: true, value: incoming };
  return refuse(field);
}

/**
 * Rows: a row whose value equals the redacted form of the saved row with the
 * same key keeps the saved value; any other placeholder is refused.
 */
function restoreRows(
  field: string,
  incoming: RequestPatch['headers'],
  saved: readonly KeyValue[] | undefined
): Outcome<RequestPatch['headers']> {
  if (!incoming) return { ok: true, value: incoming };
  const redactedSaved = redactKeyValues(saved);
  // Each saved row restores at most one incoming row, in order: rows that
  // share a key (two Authorization headers, one disabled) each get their own
  // value back instead of all getting the first one.
  const used = new Set<number>();
  const out = [];
  for (const row of incoming) {
    if (!PLACEHOLDER_PATTERN.test(row.value)) {
      out.push(row);
      continue;
    }
    const index = redactedSaved.findIndex(
      (r, i) =>
        !used.has(i) && r.key.toLowerCase() === row.key.toLowerCase() && r.value === row.value
    );
    const original = index >= 0 ? saved?.[index] : undefined;
    if (!original) return refuse(`${field} “${row.key}”`);
    used.add(index);
    out.push({ ...row, value: original.value });
  }
  return { ok: true, value: out };
}

const AUTHORITY = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#@\s]*@)?([^/?#\s]*)(.*)$/is;

/**
 * `get_request` strips `user:pass@` from URLs (no placeholder), so an edited
 * URL arrives without them. Put the saved userinfo back when the edit kept
 * the same scheme and host — the credential was never shown to the agent and
 * still belongs to that host. A URL pointed at another host keeps none: the
 * saved credential must not follow it there.
 */
function reattachUserinfo(incoming: string, saved: string | undefined): string {
  if (!saved) return incoming;
  const [, sScheme = '', sUser = '', sHost = ''] = AUTHORITY.exec(saved) ?? [];
  const [, iScheme = '', iUser = '', iHost = '', iRest = ''] = AUTHORITY.exec(incoming) ?? [];
  if (!sUser || !iScheme || iUser) return incoming;
  if (
    sScheme.toLowerCase() !== iScheme.toLowerCase() ||
    sHost.toLowerCase() !== iHost.toLowerCase()
  ) {
    return incoming;
  }
  return `${iScheme}${sUser}${iHost}${iRest}`;
}

/** Make an `update_request` patch safe to apply over `saved`. */
export function restoreRedactedPatch(saved: Request, patch: RequestPatch): Outcome<RequestPatch> {
  const next: RequestPatch = { ...patch };
  const savedUrl = 'url' in saved ? saved.url : undefined;
  if (patch.url !== undefined && savedUrl !== undefined && patch.url === redactSavedUrl(savedUrl)) {
    // URL redaction can *remove* credentials (userinfo) rather than mask them,
    // so the unchanged redacted URL carries no placeholder at all: keep the
    // saved URL instead of silently dropping its credentials.
    next.url = savedUrl;
  } else {
    const url = restoreText('url', patch.url, savedUrl, redactSavedUrl);
    if (!url.ok) return url;
    if (patch.url !== undefined) {
      next.url = reattachUserinfo(url.value as string, savedUrl);
    }
  }

  const rowsOf = (key: 'headers' | 'params' | 'metadata'): KeyValue[] | undefined =>
    key in saved ? ((saved as unknown as Record<string, KeyValue[]>)[key] ?? undefined) : undefined;
  for (const key of ['headers', 'params', 'metadata'] as const) {
    const rows = restoreRows(key, patch[key], rowsOf(key));
    if (!rows.ok) return rows;
    if (patch[key] !== undefined) next[key] = rows.value;
  }

  if (patch.body) {
    const savedRaw = saved.type === 'http' ? saved.body.raw : undefined;
    const savedVars = saved.type === 'http' ? saved.body.graphqlVariables : undefined;
    const content = restoreText('body', patch.body.content, savedRaw, redactSavedText);
    if (!content.ok) return content;
    const vars = restoreText(
      'graphqlVariables',
      patch.body.graphqlVariables,
      savedVars,
      redactSavedText
    );
    if (!vars.ok) return vars;
    next.body = {
      ...patch.body,
      ...(content.value !== undefined ? { content: content.value } : {}),
      ...(vars.value !== undefined ? { graphqlVariables: vars.value } : {}),
    };
  }

  const savedMessage = saved.type === 'grpc' ? saved.message : undefined;
  const message = restoreText('message', patch.message, savedMessage, redactSavedText);
  if (!message.ok) return message;
  if (patch.message !== undefined) next.message = message.value as string;

  const savedParams = saved.type === 'mcp' ? saved.defaultParams : undefined;
  const params = restoreText('defaultParams', patch.defaultParams, savedParams, redactSavedText);
  if (!params.ok) return params;
  if (patch.defaultParams !== undefined) next.defaultParams = params.value as string;

  // Fields that are never redacted on read must not carry placeholders either.
  for (const key of ['name', 'description', 'preRequestScript', 'testScript'] as const) {
    if (containsPlaceholder(patch[key])) return refuse(key);
  }
  return { ok: true, value: next };
}
