import {
  type McpClientRequestKind,
  type McpPendingClientRequest,
  useMcpClientRequestStore,
} from '@/features/mcp/store/useMcpClientRequestStore';
import { getElectronAPI, isElectron } from '@/lib/shared/platform';

/**
 * Renderer side of MCP server→client requests (#860, desktop-only).
 *
 * Main forwards `elicitation/create` and `sampling/createMessage` on
 * `mcp:client-request:<connectionId>` and withdraws them (timeout, server
 * cancel, connection closed) on `mcp:client-request-cancelled:<connectionId>`.
 * The web build has no server→client channel, so everything here is a no-op
 * there.
 */

export interface McpRoot {
  uri: string;
  name?: string;
}

export type McpElicitationResponse =
  | { action: 'accept'; content: Record<string, string | number | boolean | string[]> }
  | { action: 'decline' }
  | { action: 'cancel' };

export type McpSamplingResponse =
  | { action: 'approve'; text: string; model: string }
  | { action: 'reject' };

export type McpClientRespondResult =
  | { ok: true }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

const REQUEST_PREFIX = 'mcp:client-request:';
const CANCELLED_PREFIX = 'mcp:client-request-cancelled:';

function isKind(value: unknown): value is McpClientRequestKind {
  return value === 'elicitation' || value === 'sampling';
}

/**
 * Subscribe to a connection's server→client requests. Call BEFORE connecting
 * (a server may elicit during the handshake). The returned function removes
 * both listeners and drops any prompts still queued for the connection.
 */
export function subscribeMcpClientRequests(connectionId: string): () => void {
  const api = getElectronAPI()?.mcp;
  if (!isElectron() || !api) return () => undefined;

  const store = useMcpClientRequestStore.getState();
  const onRequest = (...args: unknown[]) => {
    const event = args[0] as { requestId?: unknown; kind?: unknown; params?: unknown } | null;
    if (!event || typeof event.requestId !== 'string' || !isKind(event.kind)) return;
    store.add({
      requestId: event.requestId,
      connectionId,
      kind: event.kind,
      params: event.params,
      receivedAt: Date.now(),
    });
  };
  const onCancelled = (...args: unknown[]) => {
    const event = args[0] as { requestId?: unknown } | null;
    if (event && typeof event.requestId === 'string') store.remove(event.requestId);
  };

  const requestChannel = `${REQUEST_PREFIX}${connectionId}`;
  const cancelledChannel = `${CANCELLED_PREFIX}${connectionId}`;
  api.on(requestChannel, onRequest);
  api.on(cancelledChannel, onCancelled);
  return () => {
    api.removeListener(requestChannel, onRequest);
    api.removeListener(cancelledChannel, onCancelled);
    useMcpClientRequestStore.getState().clearConnection(connectionId);
  };
}

async function respond(
  request: McpPendingClientRequest,
  response: McpElicitationResponse | McpSamplingResponse
): Promise<McpClientRespondResult> {
  const api = getElectronAPI()?.mcp;
  if (!api) return { ok: false, error: 'Electron MCP API not available' };
  const base = { connectionId: request.connectionId, requestId: request.requestId };
  let result: Awaited<ReturnType<typeof api.respondClientRequest>>;
  try {
    result = await api.respondClientRequest(
      request.kind === 'elicitation'
        ? { kind: 'elicitation', ...base, response: response as McpElicitationResponse }
        : { kind: 'sampling', ...base, response: response as McpSamplingResponse }
    );
  } catch (err) {
    // IPC validation rejected the payload (e.g. an oversized field).
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (result.success) {
    useMcpClientRequestStore.getState().remove(request.requestId);
    return { ok: true };
  }
  // An unknown id means main already settled it (timeout / cancel / close).
  if (result.error === 'Unknown client request') {
    useMcpClientRequestStore.getState().remove(request.requestId);
  }
  return {
    ok: false,
    error: result.error,
    ...(result.fieldErrors ? { fieldErrors: result.fieldErrors } : {}),
  };
}

export function respondToElicitation(
  request: McpPendingClientRequest,
  response: McpElicitationResponse
): Promise<McpClientRespondResult> {
  return respond(request, response);
}

export function respondToSampling(
  request: McpPendingClientRequest,
  response: McpSamplingResponse
): Promise<McpClientRespondResult> {
  return respond(request, response);
}

/** Push the connection's roots to main (stored per owner; live sessions are notified). */
export async function pushMcpRoots(
  connectionId: string,
  roots: McpRoot[]
): Promise<{ ok: true } | { ok: false; error: string }> {
  const api = getElectronAPI()?.mcp;
  if (!isElectron() || !api) return { ok: true };
  try {
    const result = await api.setRoots({
      connectionId,
      roots: roots.map((root) => ({ uri: root.uri, ...(root.name ? { name: root.name } : {}) })),
    });
    return result.success ? { ok: true } : { ok: false, error: result.error };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Client-side check mirroring main's validator: roots MUST be file:// URIs. */
export function isValidRootUri(uri: string): boolean {
  try {
    return new URL(uri).protocol === 'file:';
  } catch {
    return false;
  }
}
