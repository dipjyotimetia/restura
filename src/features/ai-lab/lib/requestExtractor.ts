// Pure parser that recovers an HTTP/GraphQL request spec from a model
// completion. Used by the `http-exec` eval target: the model is prompted to
// emit a request, we parse it out, execute it through the real request
// executor, and score the upstream response. No renderer/IPC deps — unit-tested
// against raw strings.
import { extractFirstJsonObject } from '@shared/protocol/ai/json-extract';

/** How to pull the request JSON out of the model output. */
export type ParseMode = 'json' | 'fenced';

/** A normalized, executor-agnostic request spec parsed from model output. */
export interface ExtractedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** Raw request body (already stringified). Empty string = no body. */
  body: string;
}

export type ExtractResult = { ok: true; request: ExtractedRequest } | { ok: false; error: string };

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/** Grab the first ```json fenced block (or any fenced block) from text. */
function firstFencedBlock(text: string): string | undefined {
  // ```json ... ``` (preferred) or a bare ``` ... ``` fence.
  const fence = /```(?:json|http)?\s*\n?([\s\S]*?)```/i.exec(text);
  return fence?.[1]?.trim();
}

/**
 * Extract a request from a model completion. `json` reads the first JSON object
 * in the text; `fenced` prefers a fenced code block, falling back to the first
 * JSON object. Returns a parse error (never throws) so the runner fails the cell
 * cleanly.
 */
export function extractRequestSpec(text: string, mode: ParseMode): ExtractResult {
  const raw =
    mode === 'fenced'
      ? (firstFencedBlock(text) ?? extractFirstJsonObject(text))
      : extractFirstJsonObject(text);
  if (!raw) return { ok: false, error: 'no request found in model output' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'request is not valid JSON' };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'request must be a JSON object' };
  }

  const obj = parsed as Record<string, unknown>;
  const method = typeof obj.method === 'string' ? obj.method.toUpperCase() : 'GET';
  if (!METHODS.has(method)) {
    return { ok: false, error: `unsupported method "${method}"` };
  }
  const url = typeof obj.url === 'string' ? obj.url.trim() : '';
  if (!url) return { ok: false, error: 'request is missing a url' };

  const headers: Record<string, string> = {};
  if (obj.headers && typeof obj.headers === 'object' && !Array.isArray(obj.headers)) {
    for (const [k, v] of Object.entries(obj.headers as Record<string, unknown>)) {
      if (typeof v === 'string') headers[k] = v;
      else if (v != null) headers[k] = String(v);
    }
  }

  const body = normalizeBody(obj.body);
  return { ok: true, request: { method, url, headers, body } };
}

/** A body may arrive as a string or a JSON value; stringify objects. */
function normalizeBody(body: unknown): string {
  if (body === undefined || body === null) return '';
  if (typeof body === 'string') return body;
  try {
    return JSON.stringify(body);
  } catch {
    return '';
  }
}

/**
 * Build a GraphQL request from extracted model output. Executing it needs an
 * endpoint, so the model must emit a full request object that includes a `url`
 * (with the GraphQL body, e.g. `{ "url": "...", "body": { "query": "..." } }`);
 * this just forces POST + a JSON content type. A bare `{ query, variables }`
 * with no `url` can't be executed and surfaces the parse error from
 * `extractRequestSpec` ("request is missing a url").
 */
export function extractGraphqlSpec(text: string, mode: ParseMode): ExtractResult {
  const base = extractRequestSpec(text, mode);
  if (!base.ok) return base;
  return {
    ok: true,
    request: {
      ...base.request,
      method: 'POST',
      headers: { 'content-type': 'application/json', ...base.request.headers },
    },
  };
}
