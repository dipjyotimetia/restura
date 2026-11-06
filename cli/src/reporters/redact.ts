import { redactDiagnosticText } from '@shared/collection-run/evidence';
import { CREDENTIAL_HEADER_NAMES } from '@shared/protocol/credential-header-names';
import { headerDenylistRegex } from '@shared/protocol/secret-patterns';
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
 *  - response headers that carry a credential are set to `[redacted]`: the
 *    shared `CREDENTIAL_HEADER_NAMES` list plus the shared `x-*-token` /
 *    `x-*-key` / `x-*-secret` denylist (the same rule the app's run evidence
 *    uses, `shared/collection-run/evidence.ts`), plus `set-cookie2`;
 *  - error messages and assertion errors go through the shared
 *    `redactDiagnosticText` token scrubber.
 * Still written as received: the status, timings, assertion names, every
 * other response header and SSE/WebSocket stream events.
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
  ...CREDENTIAL_HEADER_NAMES,
  'set-cookie2',
]);
const HEADER_DENYLIST = headerDenylistRegex();

function isCredentialHeader(name: string): boolean {
  return (
    CREDENTIAL_RESPONSE_HEADERS.has(name.toLowerCase()) ||
    HEADER_DENYLIST.some((pattern) => pattern.test(name))
  );
}

export function redactRunResult(result: RunResult): ReportedRunResult {
  return {
    ...result,
    requests: result.requests.map((r) => ({
      ...r,
      request: reportedRequest(r.request),
      ...(r.errorMessage !== undefined
        ? { errorMessage: redactDiagnosticText(r.errorMessage) }
        : {}),
      ...(r.assertions
        ? {
            assertions: r.assertions.map((a) =>
              a.error !== undefined ? { ...a, error: redactDiagnosticText(a.error) } : a
            ),
          }
        : {}),
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
    out[name] = isCredentialHeader(name) ? REDACTED : value;
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
