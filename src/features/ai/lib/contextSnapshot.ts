import { useRequestStore } from '@/store/useRequestStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { keyValuePairsToRecord } from '@/lib/shared/utils';
import type { KeyValue } from '@/types';
import type { ContextRef } from '@/features/ai/store';

export interface RawSnapshot {
  contextRef: ContextRef;
  request?: { method: string; url: string; headers: Record<string, string>; body: string };
  response?: { status: number; headers: Record<string, string>; body: string };
  environment?: Record<string, string>;
}

/** Request union members vary; read the common HTTP-ish fields defensively. */
interface RequestLike {
  method?: unknown;
  url?: unknown;
  headers?: unknown;
  body?: { raw?: string } | null;
}

function normalizeHeaders(headers: Record<string, string | string[]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

/**
 * Snapshot the active tab's request + its last response + the active
 * environment at the moment of capture. Returns plain objects (no store
 * references), safe to pass through promptBuilder -> redaction -> IPC.
 */
export function captureActive(): RawSnapshot {
  const reqState = useRequestStore.getState();
  const envState = useEnvironmentStore.getState();

  const activeTabId = reqState.activeTabId;
  if (!activeTabId) {
    return { contextRef: { kind: 'none', capturedAt: Date.now() } };
  }
  const tab = reqState.tabs.find((t) => t.id === activeTabId);
  if (!tab) {
    return { contextRef: { kind: 'none', capturedAt: Date.now() } };
  }

  const request = tab.request as unknown as RequestLike;
  const reqHeaders = Array.isArray(request.headers)
    ? keyValuePairsToRecord(request.headers as KeyValue[])
    : {};

  const response = tab.response ?? undefined;

  const activeEnv = envState.activeEnvironmentId
    ? envState.environments.find((e) => e.id === envState.activeEnvironmentId)
    : undefined;
  const environment = activeEnv ? keyValuePairsToRecord(activeEnv.variables) : undefined;

  return {
    contextRef: {
      kind: response ? 'response' : 'request',
      tabId: tab.id,
      capturedAt: Date.now(),
    },
    request: {
      method: typeof request.method === 'string' ? request.method : '',
      url: typeof request.url === 'string' ? request.url : '',
      headers: reqHeaders,
      body: request.body?.raw ?? '',
    },
    ...(response
      ? {
          response: {
            status: response.status,
            headers: normalizeHeaders(response.headers),
            body: response.body ?? '',
          },
        }
      : {}),
    ...(environment ? { environment } : {}),
  };
}
