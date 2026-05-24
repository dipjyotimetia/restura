import { validateMcpSpec } from '@shared/protocol/mcp-proxy';
import { request as undiciRequest } from 'undici';
import { v4 as uuidv4 } from 'uuid';
import type { McpRequest } from '@/types';
import { resolveVarsDeep } from '../varResolver';
import type { LoadedRequest } from '../collectionLoader';
import type { ExecuteOptions, ExecuteOutcome } from './types';

/**
 * MCP (Model Context Protocol) executor. Fires a one-shot JSON-RPC POST and
 * captures the response. `validateMcpSpec` from the shared proxy handles URL
 * validation, header sanitisation, and envelope construction — we just dispatch.
 *
 * Subscription / streaming MCP transports are out of scope for CLI v0.2 — we
 * run the request as a single round trip even when `transport: http-sse`.
 */
export async function executeMcp(
  item: LoadedRequest,
  opts: ExecuteOptions
): Promise<ExecuteOutcome> {
  if (item.type !== 'mcp') {
    return {
      status: 0,
      passed: false,
      durationMs: 0,
      bodyBytes: 0,
      errorMessage: `MCP executor received non-mcp request: ${item.type}`,
    };
  }
  const req = item.request as McpRequest;

  const url = resolveVarsDeep(req.url, opts.vars);
  const headers: Record<string, string> = {};
  for (const h of req.headers ?? []) {
    if (h.enabled && h.key) headers[h.key] = resolveVarsDeep(h.value, opts.vars);
  }

  // Build a JSON-RPC envelope from defaultMethod/defaultParams. Real MCP usage
  // would walk a script-driven dialog; the CLI's contract is "send one call".
  const method = req.defaultMethod ? resolveVarsDeep(req.defaultMethod, opts.vars) : 'ping';
  let params: unknown = undefined;
  if (req.defaultParams) {
    const resolved = resolveVarsDeep(req.defaultParams, opts.vars);
    try {
      params = JSON.parse(resolved);
    } catch {
      params = resolved; // pass through verbatim if not JSON
    }
  }
  const id = uuidv4();

  const validation = validateMcpSpec(
    {
      url,
      transport: req.transport,
      headers,
      jsonRpc: { method, params, id },
      timeout: opts.timeoutMs,
    },
    opts.allowLocalhost
  );

  if (!validation.ok) {
    return {
      status: validation.status,
      passed: false,
      durationMs: 0,
      bodyBytes: 0,
      errorMessage: validation.error,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), validation.timeoutMs);
  const start = Date.now();
  try {
    const response = await undiciRequest(validation.targetUrl, {
      method: 'POST',
      headers: validation.headers,
      body: validation.body,
      signal: controller.signal,
    });
    const status = response.statusCode;
    const text = await response.body.text();
    const responseHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(response.headers)) {
      if (v === undefined) continue;
      responseHeaders[k] = Array.isArray(v) ? v.join(', ') : String(v);
    }

    let passed = status >= 200 && status < 300;
    let errorMessage: string | undefined;
    // A 2xx with a JSON-RPC `error` field is still a failure from the caller's POV.
    if (passed) {
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && 'error' in parsed && parsed.error) {
          passed = false;
          const e = parsed.error as { message?: string; code?: number };
          errorMessage = `JSON-RPC error ${e.code ?? ''}: ${e.message ?? text}`;
        }
      } catch {
        // Non-JSON body — leave passed as is; the script can decide.
      }
    } else {
      errorMessage = `MCP upstream returned ${status}`;
    }

    const outcome: ExecuteOutcome = {
      status,
      passed,
      durationMs: Date.now() - start,
      bodyBytes: text.length,
      responseHeaders,
      responseBody: text,
    };
    if (errorMessage) outcome.errorMessage = errorMessage;
    return outcome;
  } catch (err) {
    return {
      status: 0,
      passed: false,
      durationMs: Date.now() - start,
      bodyBytes: 0,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}
