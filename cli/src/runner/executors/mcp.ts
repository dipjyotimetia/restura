import { resolveAuthVariables } from '@shared/auth/resolve-variables';
import {
  isMcpOAuthFlow,
  isMcpTransportHeader,
  mcpAuthUnsupportedReason,
} from '@shared/protocol/mcp-auth';
import { validateMcpSpec } from '@shared/protocol/mcp-proxy';
import {
  buildMcpRunReply,
  mcpMissingMethodMessage,
  mcpSessionKey,
  parseMcpRunParams,
} from '@shared/protocol/mcp-run';
import type { McpRequest } from '@shared/types';
import type { LoadedRequest } from '../collectionLoader';
import { type CliMcpSession, openCliMcpSession } from '../mcpSession';
import { resolveVarsDeep } from '../varResolver';
import { applyAuthHeaders, resolveOAuth2Token } from './auth';
import { materializeExternalSecretsInAuth } from './external-secret-materializer';
import type { ExecuteOptions, ExecuteOutcome } from './types';

/**
 * MCP (Model Context Protocol) executor (#901). Runs the saved operation
 * (`defaultMethod` + `defaultParams`) over a real MCP session — initialize
 * once per server per run (pooled by the runner), then the call — and returns
 * the JSON-RPC envelope as the response body, exactly like the in-app
 * collection runner (`@shared/protocol/mcp-run`):
 *
 *   rs.response.json().result          — the result (incl. `isError`)
 *   rs.response.json().error           — a JSON-RPC error { code, message, data }
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

  // The stdio transport launches a local process. That is a desktop-only
  // capability gated by an interactive consent prompt (ADR 0030); the CLI
  // must never spawn processes from collection data, so refuse before any I/O.
  if (req.transport === 'stdio') {
    return {
      status: 0,
      passed: false,
      durationMs: 0,
      bodyBytes: 0,
      errorMessage: `MCP stdio transport is desktop-only; "${req.name}" was not run (the CLI never launches local processes from a collection).`,
    };
  }

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
      errorMessage: mcpMissingMethodMessage(req.name),
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
    // `{{vars}}` resolve once, before external secrets are materialized, so
    // vault plaintext is never template-expanded (shared field map).
    const varResolvedAuth = req.auth
      ? resolveAuthVariables(req.auth, (text) => resolveVarsDeep(text, opts.vars))
      : req.auth;
    const externalMaterializedAuth = await materializeExternalSecretsInAuth(
      varResolvedAuth,
      opts.externalSecretResolver
    );
    const resolvedAuth = await resolveOAuth2Token(externalMaterializedAuth, opts.vars, {
      allowLocalhost: opts.allowLocalhost,
      ...(opts.oauthFetch ? { fetch: opts.oauthFetch } : {}),
    });
    const authHeaders: Record<string, string> = {};
    applyAuthHeaders(resolvedAuth, authHeaders, {});
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

  const parsedParams = parseMcpRunParams(
    req.defaultParams ? resolveVarsDeep(req.defaultParams, opts.vars) : undefined
  );
  if (!parsedParams.ok) {
    return {
      status: 0,
      passed: false,
      durationMs: 0,
      bodyBytes: 0,
      errorMessage: parsedParams.error,
    };
  }

  // Shared URL guard + header sanitisation; the SDK session owns the wire.
  const validation = validateMcpSpec(
    {
      url,
      transport: req.transport,
      ...(req.transport === 'http-sse' ? { postEndpoint: url } : {}),
      headers,
      jsonRpc: { method, id: 0 },
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

  // Narrowed above: stdio was refused, so only the HTTP transports remain.
  const transport = req.transport;
  const open = () =>
    openCliMcpSession({
      url,
      transport,
      headers: validation.headers,
      allowLocalhost: opts.allowLocalhost,
      timeoutMs: validation.timeoutMs,
      ...(opts.dispatcher ? { dispatcher: opts.dispatcher } : {}),
      ...(opts.tls ? { tls: opts.tls } : {}),
      ...(opts.proxy ? { proxy: opts.proxy } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  // Pooled (a `restura run`): one initialized session per server for the
  // whole run, closed by the runner. Unpooled: a session for this call only.
  const pool = opts.mcpSessions;
  const sessionKey = mcpSessionKey(url, req.transport, validation.headers);
  const start = Date.now();
  let session: CliMcpSession | undefined;
  try {
    session = pool ? await pool.get(sessionKey, open) : await open();
    const reply = buildMcpRunReply(
      await session.request(method, parsedParams.params, {
        timeoutMs: validation.timeoutMs,
        ...(opts.signal ? { signal: opts.signal } : {}),
      })
    );
    const outcome: ExecuteOutcome = {
      // The JSON-RPC call completed; HTTP-level failures throw below.
      status: 200,
      passed: reply.outcome === 'result',
      durationMs: Date.now() - start,
      bodyBytes: Buffer.byteLength(reply.body),
      responseHeaders: {},
      responseBody: reply.body,
    };
    // JSON-RPC errors and tool `isError` results stay assertable: they fail
    // the item only when no test assertion decides (see runner).
    if (reply.outcome !== 'result') outcome.protocolError = reply.statusText;
    return outcome;
  } catch (err) {
    // A transport-level failure (JSON-RPC errors are returned, not thrown)
    // may have broken the session: evict it so a retry / later item reconnects.
    pool?.evict(sessionKey);
    return {
      status: 0,
      passed: false,
      durationMs: Date.now() - start,
      bodyBytes: 0,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (!pool) await session?.close();
  }
}
