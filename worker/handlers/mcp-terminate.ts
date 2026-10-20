import {
  McpTerminateBodySchema,
  type McpTerminateSpec,
  validateMcpTerminateSpec,
} from '@shared/protocol/mcp-session';
import type { Context } from 'hono';
import type { NodeHostnameGuard } from '../adapters';
import type { Env } from '../env';
import { allowPrivateIPs, isLocalDevBypass } from '../shared/env';
import { parseJsonBody } from '../shared/validate-body';

/**
 * `POST /api/mcp/terminate` — end a Streamable HTTP MCP session by sending
 * `DELETE <endpoint>` with `Mcp-Session-Id` upstream (MCP 2025-06-18 Session
 * Management, #888). Called by the web client on disconnect.
 *
 * Same SSRF path as `/api/mcp`: `validateMcpTerminateSpec` delegates to
 * `validateMcpSpec` (URL guard + header policy), and the injected Node DNS
 * guard runs before the fetch on self-host. Redirects are not followed.
 *
 * Termination is best-effort by spec: `405` (server does not allow
 * client-initiated termination) and `404` (session already gone) are reported
 * as `ok` with `terminated: false` rather than as errors.
 */
/** Terminate bodies are tiny (url, session id, headers); cap them. */
const MAX_TERMINATE_BODY_BYTES = 64 * 1024;

export function createMcpTerminateHandler(nodeHostnameGuard?: NodeHostnameGuard) {
  return async function mcpTerminateHandler(c: Context<{ Bindings: Env }>) {
    const parsed = await parseJsonBody(c.req.raw, McpTerminateBodySchema, {
      maxBytes: MAX_TERMINATE_BODY_BYTES,
    });
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, parsed.status);
    }
    const spec = parsed.value as McpTerminateSpec;

    const isDev = isLocalDevBypass(c.env);
    const permitPrivateIPs = allowPrivateIPs(c.env);
    const validation = validateMcpTerminateSpec(spec, {
      allowLocalhost: isDev,
      allowPrivateIPs: permitPrivateIPs,
    });
    if (!validation.ok) {
      return c.json({ error: validation.error }, validation.status as 400);
    }

    const { targetUrl, headers, timeoutMs } = validation;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      if (nodeHostnameGuard) {
        await nodeHostnameGuard(new URL(targetUrl).hostname, {
          allowLocalhost: isDev,
          allowPrivateIPs: permitPrivateIPs,
        });
      }
      const upstream = await fetch(targetUrl, {
        method: 'DELETE',
        headers,
        redirect: 'manual',
        signal: controller.signal,
      });
      clearTimeout(timer);
      await upstream.body?.cancel().catch(() => {});

      if (upstream.ok) {
        return c.json({ ok: true, terminated: true, upstreamStatus: upstream.status });
      }
      if (upstream.status === 404 || upstream.status === 405) {
        return c.json({ ok: true, terminated: false, upstreamStatus: upstream.status });
      }
      return c.json(
        {
          error: `Upstream HTTP ${upstream.status} ${upstream.statusText}`,
          upstreamStatus: upstream.status,
        },
        502
      );
    } catch (err) {
      clearTimeout(timer);
      if (controller.signal.aborted) {
        return c.json({ error: `Upstream timeout after ${timeoutMs}ms` }, 504);
      }
      return c.json({ error: err instanceof Error ? err.message : 'Upstream fetch failed' }, 502);
    }
  };
}
