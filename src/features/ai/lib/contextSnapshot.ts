import type { ContextRef } from '@/features/ai/store';
import { flattenMultiValueHeaders, keyValuePairsToRecord } from '@/lib/shared/utils';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useRequestStore } from '@/store/useRequestStore';
import type { KeyValue } from '@/types';

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
  body?: RequestBodyLike | null;
}

/** A loose view of RequestBody covering the body types we can render to text. */
interface RequestBodyLike {
  type?: string;
  raw?: string;
  formData?: Array<{ key?: string; value?: string; enabled?: boolean }>;
  multipartParts?: Array<{ contentType?: string; content?: string }>;
}

/**
 * Render a request body to text for the AI context. `raw` covers json / xml /
 * text / graphql / protobuf; form-data and url-encoded bodies live in
 * `formData`, and multipart bodies in `multipartParts`. Reading only `raw` (the
 * old behavior) sent an empty body for every form/multipart request, so the
 * model never saw the payload it was asked about. Binary bodies have no text
 * representation and are summarized.
 */
function bodyToText(body: RequestBodyLike | null | undefined): string {
  if (!body) return '';
  if (typeof body.raw === 'string' && body.raw.length > 0) return body.raw;
  if (Array.isArray(body.formData) && body.formData.length > 0) {
    return body.formData
      .filter((f) => f.enabled !== false)
      .map((f) => `${f.key ?? ''}=${f.value ?? ''}`)
      .join('\n');
  }
  if (Array.isArray(body.multipartParts) && body.multipartParts.length > 0) {
    return body.multipartParts
      .map((p) => `[part ${p.contentType ?? 'application/octet-stream'}]\n${p.content ?? ''}`)
      .join('\n');
  }
  if (body.type === 'binary') return '(binary body)';
  return '';
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
      body: bodyToText(request.body),
    },
    ...(response
      ? {
          response: {
            status: response.status,
            headers: flattenMultiValueHeaders(response.headers),
            body: response.body ?? '',
          },
        }
      : {}),
    ...(environment ? { environment } : {}),
  };
}
