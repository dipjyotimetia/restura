import {
  isMcpOAuthFlow,
  isMcpTransportHeader,
  mcpAuthUnsupportedReason,
} from '@shared/protocol/mcp-auth';
import { validateMcpSpec } from '@shared/protocol/mcp-proxy';
import { isMcpToolError, mcpToolErrorText } from '@shared/protocol/mcp-result';
import type { AuthConfig, McpRequest } from '@shared/types';
import { request as undiciRequest } from 'undici';
import { v4 as uuidv4 } from 'uuid';
import type { LoadedRequest } from '../collectionLoader';
import { resolveVarsDeep } from '../varResolver';
import { applyAuthHeaders, resolveOAuth2Token } from './auth';
import { materializeExternalSecretsInAuth } from './external-secret-materializer';
import type { ExecuteOptions, ExecuteOutcome } from './types';

/**
 * MCP (Model Context Protocol) executor. Fires a one-shot JSON-RPC POST and
 * captures the response. `validateMcpSpec` from the shared proxy handles URL
 * validation, header sanitisation, and envelope construction — we just dispatch.
 *
 * Subscription / streaming MCP transports are out of scope for CLI v0.2 — we
 * run the request as a single round trip even when `transport: http-sse`.
 */
/**
 * Resolve `{{vars}}` in the header-shaped credential fields BEFORE headers are
 * built (Basic is base64-encoded and `apiKey.key` is a header name), matching
 * the app's `resolveAuthVariables`. Non-string / non-inline values pass through.
 */
function resolveMcpAuthVars(auth: AuthConfig | undefined, vars: Record<string, string>) {
  if (!auth) return auth;
  const r = (v: string) => resolveVarsDeep(v, vars);
  const secret = <T>(v: T): T => {
    if (typeof v === 'string') return r(v) as T;
    if (v && typeof v === 'object' && (v as { kind?: string }).kind === 'inline') {
      return {
        ...(v as object),
        value: r((v as unknown as { value: string }).value),
      } as T;
    }
    return v;
  };
  switch (auth.type) {
    case 'bearer':
      return auth.bearer
        ? {
            ...auth,
            bearer: { ...auth.bearer, token: secret(auth.bearer.token) },
          }
        : auth;
    case 'basic':
      return auth.basic
        ? {
            ...auth,
            basic: {
              username: r(auth.basic.username),
              password: secret(auth.basic.password),
            },
          }
        : auth;
    case 'api-key':
      return auth.apiKey
        ? {
            ...auth,
            apiKey: {
              ...auth.apiKey,
              key: r(auth.apiKey.key),
              value: secret(auth.apiKey.value),
            },
          }
        : auth;
    case 'oauth2':
      return auth.oauth2
        ? {
            ...auth,
            oauth2: {
              ...auth.oauth2,
              accessToken: secret(auth.oauth2.accessToken),
              ...(auth.oauth2.tokenType !== undefined
                ? { tokenType: r(auth.oauth2.tokenType) }
                : {}),
            },
          }
        : auth;
    default:
      return auth;
  }
}

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

  // A saved MCP request is ONE operation (`defaultMethod` + `defaultParams`).
  // Without a method there is nothing meaningful to run — fail the item loudly
  // instead of silently substituting `ping` (#877), before any I/O.
  const method = req.defaultMethod ? resolveVarsDeep(req.defaultMethod, opts.vars).trim() : '';
  if (!method) {
    return {
      status: 0,
      passed: false,
      durationMs: 0,
      bodyBytes: 0,
      errorMessage:
        `No MCP method configured for "${req.name}". Set defaultMethod (e.g. "tools/call", ` +
        `"resources/read", "prompts/get") and defaultParams (e.g. {"name":"<tool>","arguments":{}}) ` +
        'on the request — open it in Restura, build the operation, and save it to the collection again.',
    };
  }

  const url = resolveVarsDeep(req.url, opts.vars);
  const headers: Record<string, string> = {};
  for (const h of req.headers ?? []) {
    if (h.enabled && h.key) headers[h.key] = resolveVarsDeep(h.value, opts.vars);
  }
  // Header-based auth (Bearer / Basic / API-key / OAuth2) under the shared MCP
  // policy (#896): an unsupported scheme or an `in: query` API key fails the
  // item instead of silently going out unauthenticated. A handle ref throws;
  // external refs resolve through the configured provider (HTTP parity).
  try {
    const unsupported = mcpAuthUnsupportedReason(req.auth);
    if (unsupported) throw new Error(unsupported);
    // #856: the OAuth 2.1 browser sign-in is desktop-only; CI passes a token.
    if (isMcpOAuthFlow(req.auth)) {
      throw new Error(
        'MCP OAuth sign-in is interactive (desktop app only) — in CI set oauth2.accessToken from a variable or use Bearer auth'
      );
    }
    const externalMaterializedAuth = await materializeExternalSecretsInAuth(
      req.auth,
      opts.externalSecretResolver
    );
    const resolvedAuth = await resolveOAuth2Token(externalMaterializedAuth, opts.vars, {
      allowLocalhost: opts.allowLocalhost,
      ...(opts.oauthFetch ? { fetch: opts.oauthFetch } : {}),
    });
    const authHeaders: Record<string, string> = {};
    applyAuthHeaders(resolveMcpAuthVars(resolvedAuth, opts.vars), authHeaders, {});
    for (const [key, value] of Object.entries(authHeaders)) {
      if (isMcpTransportHeader(key)) {
        throw new Error(`Auth header "${key}" is reserved by the MCP transport`);
      }
      // Auth wins over a same-named user header in any casing.
      for (const existing of Object.keys(headers)) {
        if (existing.toLowerCase() === key.toLowerCase()) delete headers[existing];
      }
      headers[key] = value;
    }
  } catch (err) {
    return {
      status: 0,
      passed: false,
      durationMs: 0,
      bodyBytes: 0,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }

  // Build a JSON-RPC envelope from defaultMethod/defaultParams. Real MCP usage
  // would walk a script-driven dialog; the CLI's contract is "send one call".
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
      // The CLI fires a single JSON-RPC POST. For the http-sse transport the
      // shared validator requires an explicit POST endpoint (it otherwise only
      // has the SSE GET url); for a one-shot call that endpoint is the url.
      ...(req.transport === 'http-sse' ? { postEndpoint: url } : {}),
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
      ...(opts.dispatcher ? { dispatcher: opts.dispatcher } : {}),
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
        } else if (parsed && typeof parsed === 'object' && isMcpToolError(parsed.result)) {
          // Tool execution errors ride a *successful* JSON-RPC response with
          // `result.isError: true` (MCP 2025-06-18). Fail the item, and word it
          // differently from a protocol error so reports can tell them apart.
          passed = false;
          errorMessage = `MCP tool error (isError: true): ${mcpToolErrorText(parsed.result)}`;
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
