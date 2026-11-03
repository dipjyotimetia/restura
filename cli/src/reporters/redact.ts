import { SECRET_FIELDS_BY_AUTH_BLOCK } from '@shared/secrets/auth-fields';
import type { AuthConfig } from '@shared/types';
import type { LoadedRequest } from '../runner/collectionLoader.js';
import type { RequestRunResult, RunResult } from './types.js';

/**
 * File reports (JSON, HTML) are CI artifacts: they must not carry credential
 * material. What is redacted, at this one seam:
 *  - the request is a projection — identity, method, URL and its auth with
 *    every secret field (the shared `SECRET_FIELDS_BY_AUTH_BLOCK` map) set to
 *    `[redacted]`; request headers, bodies, scripts and variables are left out;
 *  - every `setCookies` entry keeps its cookie name only (`sid=[redacted]`);
 *  - response headers named `set-cookie`, `set-cookie2`, `authorization` or
 *    `proxy-authorization` (any case) are set to `[redacted]`.
 * Still written as received: the status, timings, assertions, error messages,
 * every other response header and SSE/WebSocket stream events.
 */

export const REDACTED = '[redacted]';

export interface ReportedRequest {
  relativePath: string;
  folderPath: string[];
  type: LoadedRequest['type'];
  request: {
    name: string;
    type: LoadedRequest['type'];
    method?: string;
    url?: string;
    auth?: Record<string, unknown>;
  };
}

export type ReportedRunResult = Omit<RunResult, 'requests'> & {
  requests: Array<Omit<RequestRunResult, 'request'> & { request: ReportedRequest }>;
};

const CREDENTIAL_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  'set-cookie',
  'set-cookie2',
  'authorization',
  'proxy-authorization',
]);

export function redactRunResult(result: RunResult): ReportedRunResult {
  return {
    ...result,
    requests: result.requests.map((r) => ({
      ...r,
      request: reportedRequest(r.request),
      ...(r.setCookies ? { setCookies: r.setCookies.map(redactSetCookie) } : {}),
      ...(r.responseHeaders ? { responseHeaders: redactResponseHeaders(r.responseHeaders) } : {}),
    })),
  };
}

/** `sid=abc; Path=/` → `sid=[redacted]`: the name stays so a report can show the cookie was set. */
function redactSetCookie(cookie: string): string {
  const eq = cookie.indexOf('=');
  const name = (eq === -1 ? '' : cookie.slice(0, eq)).trim();
  return name ? `${name}=${REDACTED}` : REDACTED;
}

function redactResponseHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = CREDENTIAL_RESPONSE_HEADERS.has(name.toLowerCase()) ? REDACTED : value;
  }
  return out;
}

function reportedRequest(item: LoadedRequest): ReportedRequest {
  const { method, url } = item.request as { method?: unknown; url?: unknown };
  const auth = redactAuth(item.request.auth);
  return {
    relativePath: item.relativePath,
    folderPath: item.folderPath,
    type: item.type,
    request: {
      name: item.request.name,
      type: item.type,
      ...(typeof method === 'string' ? { method } : {}),
      ...(typeof url === 'string' ? { url } : {}),
      ...(auth ? { auth } : {}),
    },
  };
}

function redactAuth(auth: AuthConfig | undefined): Record<string, unknown> | undefined {
  if (!auth) return undefined;
  const out: Record<string, unknown> = Object.fromEntries(Object.entries(auth));
  for (const [block, fields] of Object.entries(SECRET_FIELDS_BY_AUTH_BLOCK)) {
    const source: unknown = out[block];
    if (!source || typeof source !== 'object') continue;
    const copy: Record<string, unknown> = Object.fromEntries(Object.entries(source));
    for (const field of fields) {
      if (copy[field] !== undefined && copy[field] !== '') copy[field] = REDACTED;
    }
    out[block] = copy;
  }
  return out;
}
