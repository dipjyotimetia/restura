/**
 * Renderer → proxy transport. All HTTP-shaped requests (buffered HTTP,
 * GraphQL, SSE web mode) funnel through here so the shared orchestrator
 * (`executeHttpProxy`) is the single chokepoint for SSRF guards, header
 * policy, body construction, and sign-at-wire auth. The renderer must
 * never speak HTTP to a user-supplied upstream directly.
 */
import axios, { type AxiosError } from 'axios';
import type { ProxyRequestBody } from '@shared/protocol/proxy-schema';
import {
  isElectron,
  getElectronAPI,
  workerAuthHeaders,
  workerBaseUrl,
} from './platform';

/** Buffered JSON response shape returned by the Worker's `/api/proxy`. */
export interface ProxyJsonResponse {
  status: number;
  statusText: string;
  headers: Record<string, string | string[]>;
  /** Worker returns the body under `data` (historical wire shape). */
  data: unknown;
  size?: number;
  /** Present when `data` is base64 of a binary body (see shared/protocol/binary.ts). */
  bodyEncoding?: 'base64';
  negotiatedAlpn?: 'h1.1' | 'h2' | 'h3';
}

export interface ProxyTransportOptions {
  /** Aborts the in-flight request. For streaming, also cancels the upstream body. */
  signal?: AbortSignal;
}

export class ProxyTransportError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ProxyTransportError';
    this.status = status;
  }
}

export async function executeProxiedRequest(
  spec: ProxyRequestBody,
  options: ProxyTransportOptions = {}
): Promise<ProxyJsonResponse> {
  if (isElectron()) {
    return executeViaElectronIpc(spec);
  }
  return executeViaWorker(spec, options.signal);
}

/**
 * Web only — Electron's SSE feature owns long-lived streaming via the
 * `sse:connect` IPC channel (see `electron/main/sse-handler.ts`); other
 * streaming protocols on desktop must add their own IPC.
 */
export async function executeProxiedStreamingRequest(
  spec: ProxyRequestBody,
  options: ProxyTransportOptions = {}
): Promise<Response> {
  if (isElectron()) {
    throw new ProxyTransportError(
      'Streaming HTTP via Electron IPC is not yet supported. ' +
        'SSE in desktop mode uses sseManager.connectViaElectron; other ' +
        'streaming protocols must add their own IPC channel.'
    );
  }
  // Signal must be passed to fetch directly so abort during the
  // request/connect phase actually closes the socket. Listening on the
  // signal after the await would miss aborts fired during the await
  // window.
  const init: RequestInit = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...workerAuthHeaders(),
    },
    body: JSON.stringify(spec),
  };
  if (options.signal) init.signal = options.signal;
  return fetch(`${workerBaseUrl()}/api/proxy`, init);
}

async function executeViaWorker(
  spec: ProxyRequestBody,
  signal: AbortSignal | undefined
): Promise<ProxyJsonResponse> {
  try {
    const response = await axios.post(`${workerBaseUrl()}/api/proxy`, spec, {
      headers: {
        'Content-Type': 'application/json',
        ...workerAuthHeaders(),
      },
      ...(signal ? { signal } : {}),
    });
    return response.data as ProxyJsonResponse;
  } catch (err) {
    throw mapAxiosError(err);
  }
}

function mapAxiosError(err: unknown): ProxyTransportError {
  const axiosErr = err as AxiosError<{ error?: string }>;
  if (axiosErr.response) {
    const payload = axiosErr.response.data;
    const message =
      (typeof payload === 'object' && payload && 'error' in payload
        ? String(payload.error)
        : axiosErr.message) || 'Proxy request failed';
    return new ProxyTransportError(message, axiosErr.response.status);
  }
  return new ProxyTransportError(
    err instanceof Error ? err.message : 'Proxy request failed'
  );
}

// Electron's `http:request` IPC schema is narrower than ProxyRequestBody:
// bodyType / formData / streamingMode aren't accepted; the handler
// hard-codes bodyType:'raw' when data is present (the user's
// Content-Type header carries the format). Also: the .d.ts type omits
// `auth` even though the runtime Zod schema accepts it — passed through
// via a typed intersection until the .d.ts is regenerated.
async function executeViaElectronIpc(spec: ProxyRequestBody): Promise<ProxyJsonResponse> {
  const api = getElectronAPI();
  if (!api?.http) {
    throw new ProxyTransportError('Electron HTTP IPC is not available in this context.');
  }

  type IpcConfig = Parameters<typeof api.http.request>[0] & {
    auth?: ProxyRequestBody['auth'];
  };
  const config: IpcConfig = {
    method: spec.method,
    url: spec.url,
    ...(spec.headers ? { headers: spec.headers } : {}),
    ...(spec.params ? { params: spec.params } : {}),
    ...(spec.data !== undefined ? { data: spec.data } : {}),
    ...(spec.timeout !== undefined ? { timeout: spec.timeout } : {}),
    ...(spec.auth ? { auth: spec.auth } : {}),
  };

  const result = await api.http.request(config);

  return {
    status: result.status,
    statusText: result.statusText,
    headers: result.headers,
    data: result.data,
    ...(result.size !== undefined ? { size: result.size } : {}),
    ...(result.bodyEncoding !== undefined ? { bodyEncoding: result.bodyEncoding } : {}),
    ...(result.negotiatedAlpn !== undefined
      ? { negotiatedAlpn: result.negotiatedAlpn }
      : {}),
  };
}
