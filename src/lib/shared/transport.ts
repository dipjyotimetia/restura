/**
 * Renderer → proxy transport. All HTTP-shaped requests (buffered HTTP,
 * GraphQL, SSE web mode) funnel through here so the shared orchestrator
 * (`executeHttpProxy`) is the single chokepoint for SSRF guards, header
 * policy, body construction, and sign-at-wire auth. The renderer must
 * never speak HTTP to a user-supplied upstream directly.
 */
import type { ProxyRequestBody } from '@shared/protocol/proxy-schema';
import axios, { type AxiosError } from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { isElectron, getElectronAPI, workerAuthHeaders, workerBaseUrl } from './platform';
import type { ProxyConfig, ClientCert, CaCert, MinTlsVersion } from '@/types';

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

/**
 * Desktop-only transport configuration: proxy, mTLS client cert, custom CA,
 * SSL-verify toggle, and TLS handshake knobs. These are deliberately NOT part
 * of `ProxyRequestBody` because that shape is POSTed to the Cloudflare Worker
 * on the web path — cert private keys must never leave the machine. They are
 * carried as a separate argument that is merged into the Electron IPC config
 * and ignored entirely on the web path (the Worker has no per-request TLS
 * control anyway).
 */
export interface DesktopTransportConfig {
  proxy?: ProxyConfig;
  verifySsl?: boolean;
  clientCert?: ClientCert;
  caCert?: CaCert;
  serverCipherOrder?: boolean;
  minTlsVersion?: MinTlsVersion;
  cipherSuites?: string;
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
  options: ProxyTransportOptions = {},
  desktop?: DesktopTransportConfig
): Promise<ProxyJsonResponse> {
  if (isElectron()) {
    return executeViaElectronIpc(spec, options.signal, desktop);
  }
  // Web path: `desktop` (proxy / mTLS / CA / TLS knobs) is intentionally
  // dropped — the Worker has no per-request TLS control and cert material
  // must never leave the machine.
  return executeViaWorker(spec, options.signal);
}

/**
 * Web only — Electron's SSE feature owns long-lived streaming via the
 * `sse:connect` IPC channel (see `electron/main/handlers/sse-handler.ts`); other
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
  return new ProxyTransportError(err instanceof Error ? err.message : 'Proxy request failed');
}

// Electron's `http:request` IPC schema accepts bodyType + formData (so the
// shared body-builder runs the same as on the web path); streamingMode is still
// not modeled here. The handler falls back to raw-when-data only when bodyType
// is absent. Note: the generated .d.ts may lag the runtime Zod schema for
// `auth` / `bodyType` / `formData` — they're threaded via a typed intersection
// until the .d.ts is regenerated.
async function executeViaElectronIpc(
  spec: ProxyRequestBody,
  signal?: AbortSignal,
  desktop?: DesktopTransportConfig
): Promise<ProxyJsonResponse> {
  const api = getElectronAPI();
  if (!api?.http) {
    throw new ProxyTransportError('Electron HTTP IPC is not available in this context.');
  }

  // The IPC schema accepts bodyType + formData (electron-api.ts); only `auth` is
  // still absent from the .d.ts, so it's threaded via a typed intersection.
  type IpcConfig = Parameters<typeof api.http.request>[0] & {
    auth?: ProxyRequestBody['auth'];
  };
  const requestId = uuidv4();
  // The IPC proxy type excludes 'none' (the renderer's ProxyConfig allows it
  // as a "disabled" sentinel). Only forward an actually-enabled, real proxy.
  const ipcProxy: IpcConfig['proxy'] | undefined =
    desktop?.proxy && desktop.proxy.enabled && desktop.proxy.type !== 'none'
      ? {
          enabled: true,
          type: desktop.proxy.type,
          host: desktop.proxy.host,
          port: desktop.proxy.port,
          ...(desktop.proxy.auth ? { auth: desktop.proxy.auth } : {}),
        }
      : undefined;
  const config: IpcConfig = {
    requestId,
    method: spec.method,
    url: spec.url,
    ...(spec.headers ? { headers: spec.headers } : {}),
    ...(spec.params ? { params: spec.params } : {}),
    ...(spec.data !== undefined ? { data: spec.data } : {}),
    // bodyType + formData carry structured bodies (form-data / binary) to the
    // handler so the shared body-builder runs the same as on the web path.
    ...(spec.bodyType !== undefined ? { bodyType: spec.bodyType } : {}),
    ...(spec.formData !== undefined ? { formData: spec.formData } : {}),
    ...(spec.timeout !== undefined ? { timeout: spec.timeout } : {}),
    ...(spec.auth ? { auth: spec.auth } : {}),
    // Redirect policy + URL encoding. The Electron IPC config is FLAT (the
    // handler reads `config.maxRedirects` / `config.followOriginalMethod` …),
    // so the nested `spec.redirectPolicy` must be unpacked here. Omitting this
    // mapping silently dropped every per-request redirect knob and the
    // automatic-URL-encoding toggle on the desktop send path.
    ...(spec.redirectPolicy?.maxRedirects !== undefined
      ? { maxRedirects: spec.redirectPolicy.maxRedirects }
      : {}),
    ...(spec.redirectPolicy?.followOriginalMethod !== undefined
      ? { followOriginalMethod: spec.redirectPolicy.followOriginalMethod }
      : {}),
    ...(spec.redirectPolicy?.followAuthHeader !== undefined
      ? { followAuthHeader: spec.redirectPolicy.followAuthHeader }
      : {}),
    ...(spec.redirectPolicy?.stripReferer !== undefined
      ? { stripReferer: spec.redirectPolicy.stripReferer }
      : {}),
    ...(spec.encodeUrl !== undefined ? { encodeUrlAutomatically: spec.encodeUrl } : {}),
    // Desktop-only transport config (proxy / mTLS / CA / verifySsl / TLS knobs).
    // The IPC schema (HttpRequestConfigSchema) and buildConnectOptions already
    // accept these; they were previously dropped here, so global proxy + certs
    // silently had no effect on the desktop send path.
    ...(ipcProxy ? { proxy: ipcProxy } : {}),
    ...(desktop?.verifySsl !== undefined ? { verifySsl: desktop.verifySsl } : {}),
    ...(desktop?.clientCert ? { clientCert: desktop.clientCert } : {}),
    ...(desktop?.caCert ? { caCert: desktop.caCert } : {}),
    ...(desktop?.serverCipherOrder !== undefined
      ? { serverCipherOrder: desktop.serverCipherOrder }
      : {}),
    ...(desktop?.minTlsVersion !== undefined ? { minTlsVersion: desktop.minTlsVersion } : {}),
    ...(desktop?.cipherSuites !== undefined ? { cipherSuites: desktop.cipherSuites } : {}),
  };

  signal?.throwIfAborted();
  const cancel = () => {
    void api.http.cancel({ requestId }).catch(() => {
      // The request may have completed between abort dispatch and cancellation.
      // The caller still observes its own AbortSignal below.
    });
  };
  signal?.addEventListener('abort', cancel, { once: true });
  let result: Awaited<ReturnType<typeof api.http.request>>;
  try {
    result = await api.http.request(config);
    signal?.throwIfAborted();
  } finally {
    signal?.removeEventListener('abort', cancel);
  }

  return {
    status: result.status,
    statusText: result.statusText,
    headers: result.headers,
    data: result.data,
    ...(result.size !== undefined ? { size: result.size } : {}),
    ...(result.bodyEncoding !== undefined ? { bodyEncoding: result.bodyEncoding } : {}),
    ...(result.negotiatedAlpn !== undefined ? { negotiatedAlpn: result.negotiatedAlpn } : {}),
  };
}
