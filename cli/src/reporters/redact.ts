import { SECRET_FIELDS_BY_AUTH_BLOCK } from '@shared/secrets/auth-fields';
import type { AuthConfig } from '@shared/types';
import type { LoadedRequest } from '../runner/collectionLoader.js';
import type { RequestRunResult, RunResult } from './types.js';

/**
 * File reports (JSON, HTML) are CI artifacts: they must not carry credential
 * material. A request is reported as a projection — identity, method, URL and
 * its auth with every secret field (the shared `SECRET_FIELDS_BY_AUTH_BLOCK`
 * map) redacted. Headers, bodies, scripts and variables (which can hold session
 * cookies or tokens) are left out.
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

export function redactRunResult(result: RunResult): ReportedRunResult {
  return {
    ...result,
    requests: result.requests.map((r) => ({ ...r, request: reportedRequest(r.request) })),
  };
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
