// Renderer bridge that executes an AI-generated request through the SAME
// request executor the app uses (SSRF guard, redirects, cookies all come for
// free). Kept separate from evalRunner so the runner stays pure/unit-testable:
// the runner receives `runRequest` injected, and only this module pulls in the
// renderer-heavy executor + stores.
import { v4 as uuidv4 } from 'uuid';
import { executeRequest } from '@/features/http/lib/requestExecutor';
import { useSettingsStore } from '@/store/useSettingsStore';
import type { KeyValue } from '@/types/common';
import type { BodyType, HttpMethod, HttpRequest } from '@/types/http';
import type { ExtractedRequest } from './requestExtractor';

/** Normalized result of executing an extracted request, fed back to scorers. */
export interface ExecResult {
  status: number;
  statusText: string;
  /** Response body text (becomes the scoring `output`). */
  body: string;
  latencyMs: number;
  ok: boolean;
}

function toKeyValues(headers: Record<string, string>): KeyValue[] {
  return Object.entries(headers).map(([key, value]) => ({
    id: uuidv4(),
    key,
    value,
    enabled: true,
  }));
}

/** A request with a body is JSON unless its content-type says otherwise. */
function inferBodyType(req: ExtractedRequest): BodyType {
  if (!req.body) return 'none';
  const ct =
    Object.entries(req.headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
  if (ct.includes('graphql')) return 'graphql';
  if (ct.includes('x-www-form-urlencoded')) return 'x-www-form-urlencoded';
  if (ct.includes('xml')) return 'xml';
  if (ct.includes('text/')) return 'text';
  return 'json';
}

/** Build a minimal, executable HttpRequest from an extracted spec. */
export function buildHttpRequest(req: ExtractedRequest): HttpRequest {
  return {
    id: uuidv4(),
    name: 'AI Lab generated request',
    type: 'http',
    method: req.method as HttpMethod,
    url: req.url,
    headers: toKeyValues(req.headers),
    params: [],
    body: { type: inferBodyType(req), raw: req.body || undefined },
    auth: { type: 'none' },
  };
}

/**
 * Execute an extracted request and normalize the response for scoring. AI Lab
 * generated requests are concrete (no env indirection), so the variable
 * resolver is identity. Never throws — a transport failure surfaces as the
 * executor's synthetic error response.
 */
export async function executeExtractedRequest(
  req: ExtractedRequest,
  signal?: AbortSignal
): Promise<ExecResult> {
  const request = buildHttpRequest(req);
  const globalSettings = useSettingsStore.getState().settings;
  const result = await executeRequest({
    request,
    envVars: {},
    globalSettings,
    resolveVariables: (text) => text,
    ...(signal ? { signal } : {}),
  });
  const r = result.response;
  return {
    status: r.status,
    statusText: r.statusText,
    body: r.body,
    latencyMs: r.time,
    ok: r.status >= 200 && r.status < 400,
  };
}
