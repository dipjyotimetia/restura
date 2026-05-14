import type { HttpRequest, Response as ApiResponse, RequestSettings, AppSettings } from '@/types';
import { v4 as uuidv4 } from 'uuid';
import type { AxiosRequestConfig } from 'axios';
import axios from 'axios';
import { Cookie } from 'tough-cookie';
import type { ScriptResult } from '@/features/scripts/lib/scriptExecutor';
import ScriptExecutor from '@/features/scripts/lib/scriptExecutor';
import { isElectron, getElectronAPI, workerAuthHeaders, workerBaseUrl } from '@/lib/shared/platform';
import { shouldBypassProxy, toAxiosProxyConfig, shouldUseCorsProxy } from '@/features/http/lib/proxyHelper';
import { validateURL } from '@/features/http/lib/urlValidator';
import { useCookieStore } from '@/features/http/store/useCookieStore';
import { applyAuthHeaders, applyApiKeyQueryParam } from '@/features/auth/lib/applyAuthHeaders';
import { applyAuth } from '@shared/protocol/auth-signer';
import { refreshOAuth2Auth } from '@/features/auth/lib/tokenRefresh';
import { readStreamingResponse, type StreamEvent } from '@/features/http/lib/streamingResponseReader';

// Execute request via CORS proxy (browser mode)
async function executeViaCorsProxy(
  config: AxiosRequestConfig,
  startTime: number,
  requestId: string,
  upstreamProxy?: { host: string; port: number; auth?: { username: string; password: string } },
  auth?: HttpRequest['auth']
): Promise<ApiResponse> {
  const proxyBody: Record<string, unknown> = {
    method: config.method,
    url: config.url,
    headers: config.headers,
    params: config.params,
    data: config.data,
    timeout: config.timeout,
  };

  // Pass sign-at-wire auth (currently AWS SigV4) through to the worker.
  // The worker signs against the exact bytes it sends so the upstream
  // doesn't see a SignatureDoesNotMatch from worker-side body re-encoding.
  if (auth && auth.type !== 'none') {
    proxyBody.auth = auth;
  }

  if (upstreamProxy) {
    proxyBody.upstreamProxy = upstreamProxy;
  }

  const response = await axios.post(`${workerBaseUrl()}/api/proxy`, proxyBody, {
    headers: workerAuthHeaders(),
  });

  const proxyResponse = response.data;
  const endTime = Date.now();

  return {
    id: uuidv4(),
    requestId,
    status: proxyResponse.status,
    statusText: proxyResponse.statusText,
    headers: proxyResponse.headers,
    body: proxyResponse.data,
    size: proxyResponse.size || new Blob([proxyResponse.data]).size,
    time: endTime - startTime,
    timestamp: Date.now(),
  };
}

export interface RequestExecutionResult {
  response: ApiResponse;
  scriptResult?: {
    preRequest?: ScriptResult;
    test?: ScriptResult;
  };
  envVars?: Record<string, string>;
  sentHeaders: Record<string, string>;
  refreshedAuth?: HttpRequest['auth'];
}

export interface RequestExecutorOptions {
  request: HttpRequest;
  envVars: Record<string, string>;
  globalSettings: AppSettings;
  resolveVariables: (text: string, vars?: Record<string, string>) => string;
}

export async function executeRequest(options: RequestExecutorOptions): Promise<RequestExecutionResult> {
  const { request, envVars, globalSettings, resolveVariables } = options;
  const startTime = Date.now();

  // Execute pre-request script if exists
  let preRequestResult: ScriptResult | undefined;
  if (request.preRequestScript) {
    const executor = new ScriptExecutor(envVars, {});
    preRequestResult = await executor.executeScript(
      request.preRequestScript,
      {
        request: {
          url: request.url,
          method: request.method,
          headers: request.headers
            .filter((h) => h.enabled)
            .reduce(
              (acc, h) => ({ ...acc, [h.key]: h.value }),
              {} as Record<string, string>
            ),
          body: request.body.raw,
        },
      }
    );

    // Update environment variables if script modified them
    if (preRequestResult.success && preRequestResult.variables) {
      Object.assign(envVars, preRequestResult.variables);
    }
  }

  const resolveLocal = (text: string) => {
    let result = text;
    Object.entries(envVars).forEach(([key, value]) => {
      result = result.replace(new RegExp(`{{${key}}}`, 'g'), value);
    });
    // Fallback to global resolver for other vars
    return resolveVariables(result);
  };

  const resolvedUrl = resolveLocal(request.url);

  // Security: Validate URL
  const urlValidation = validateURL(resolvedUrl, {
    allowPrivateIPs: false,
    allowLocalhost: globalSettings.allowLocalhost ?? true,
  });

  if (!urlValidation.valid) {
    throw new Error(`Invalid URL: ${urlValidation.error}`);
  }

  // Build query params
  const params: Record<string, string> = {};
  request.params
    .filter((p) => p.enabled && p.key)
    .forEach((p) => {
      params[p.key] = resolveLocal(p.value);
    });

  // Build headers
  const headers: Record<string, string> = {};
  request.headers
    .filter((h) => h.enabled && h.key)
    .forEach((h) => {
      headers[h.key] = resolveLocal(h.value);
    });

  // Refresh OAuth2 token if near expiry before signing
  const effectiveAuth = await refreshOAuth2Auth(request.auth);

  // Apply auth headers (includes AWS SigV4 signing)
  const headersWithAuth = await applyAuthHeaders(
    effectiveAuth,
    headers,
    resolvedUrl,
    request.method,
    request.body.type !== 'none' ? request.body.raw : undefined
  );
  Object.assign(headers, headersWithAuth);

  // Apply API key query params
  Object.assign(params, applyApiKeyQueryParam(effectiveAuth, params));

  // Add Cookies
  // Note: useCookieStore is a hook/store. We can access getState() outside components.
  const cookies = useCookieStore.getState().getCookiesForUrl(resolvedUrl);
  if (cookies.length > 0) {
    const cookieHeader = cookies.map((c) => `${c.key}=${c.value}`).join('; ');
    headers['Cookie'] = cookieHeader;
  }

  // Get effective settings
  const effectiveSettings: RequestSettings = request.settings || {
    timeout: globalSettings.defaultTimeout,
    followRedirects: globalSettings.followRedirects,
    maxRedirects: globalSettings.maxRedirects,
    verifySsl: globalSettings.verifySsl,
    proxy: globalSettings.proxy,
  };

  // Build Axios config
  const axiosConfig: AxiosRequestConfig = {
    method: request.method,
    url: resolvedUrl,
    params,
    headers,
    data: request.body.type !== 'none' ? request.body.raw : undefined,
    timeout: effectiveSettings.timeout,
    maxRedirects: effectiveSettings.followRedirects ? effectiveSettings.maxRedirects : 0,
    validateStatus: () => true,
  };

  let responseData: ApiResponse | undefined;

  // Check if we should use CORS proxy (browser mode)
  if (shouldUseCorsProxy(globalSettings)) {
    try {
      const proxyConfig = effectiveSettings.proxy;
      const upstreamProxy =
        !isElectron() &&
        proxyConfig?.enabled &&
        proxyConfig.host &&
        proxyConfig.type !== 'none' &&
        !shouldBypassProxy(resolvedUrl, proxyConfig.bypassList)
          ? {
              host: proxyConfig.host,
              port: proxyConfig.port,
              // EOPT: only include `auth` when present
              ...(proxyConfig.auth?.username ? { auth: proxyConfig.auth } : {}),
            }
          : undefined;

      responseData = await executeViaCorsProxy(axiosConfig, startTime, request.id, upstreamProxy, effectiveAuth);
    } catch (error: unknown) {
      const endTime = Date.now();
      const isAxiosError = axios.isAxiosError(error);
      const errorMessage = error instanceof Error ? error.message : 'CORS proxy request failed';

      // Check if it's a proxy-specific error
      if (isAxiosError && error.response?.data?.error) {
        responseData = {
          id: uuidv4(),
          requestId: request.id,
          status: error.response.status,
          statusText: 'Proxy Error',
          headers: {},
          body: error.response.data.error,
          size: 0,
          time: endTime - startTime,
          timestamp: Date.now(),
        };
      } else {
        responseData = {
          id: uuidv4(),
          requestId: request.id,
          status: 0,
          statusText: 'Error',
          headers: {},
          body: errorMessage,
          size: 0,
          time: endTime - startTime,
          timestamp: Date.now(),
        };
      }
    }
  }

  // Apply proxy configuration if enabled (for Electron)
  const proxyConfig = effectiveSettings.proxy;
  if (!responseData && proxyConfig?.enabled && proxyConfig.host && !shouldBypassProxy(resolvedUrl, proxyConfig.bypassList)) {
    if (isElectron()) {
      const electronAPI = getElectronAPI();
      if (electronAPI && 'http' in electronAPI) {
        try {
          const electronResponse = await (electronAPI as unknown as {
            http: {
              request: (config: unknown) => Promise<{
                status: number;
                statusText: string;
                headers: Record<string, string>;
                data: unknown;
                negotiatedAlpn?: 'h1.1' | 'h2' | 'h3';
              }>;
            };
          }).http.request({
            ...axiosConfig,
            proxy: proxyConfig,
            verifySsl: effectiveSettings.verifySsl,
            clientCert: effectiveSettings.clientCert,
            caCert: effectiveSettings.caCert,
            // Pass sign-at-wire auth through to the Electron handler so SigV4
            // signs against the exact bytes undici sends.
            ...(request.auth && request.auth.type !== 'none'
              ? { auth: request.auth }
              : {}),
          });

          // Process Set-Cookie headers
          const setCookie = electronResponse.headers['set-cookie'] || electronResponse.headers['Set-Cookie'];
          if (setCookie) {
            const cookiesToSet = Array.isArray(setCookie) ? setCookie : [setCookie];
            cookiesToSet.forEach((cookieStr) => {
              const parsedCookie = Cookie.parse(cookieStr);
              if (parsedCookie) {
                const expires =
                  parsedCookie.expires === 'Infinity' || !parsedCookie.expires
                    ? undefined
                    : parsedCookie.expires.toString();
                useCookieStore.getState().addCookie({
                  id: uuidv4(),
                  key: parsedCookie.key,
                  value: parsedCookie.value,
                  domain: parsedCookie.domain || new URL(resolvedUrl).hostname,
                  path: parsedCookie.path || '/',
                  ...(expires !== undefined && { expires }),
                  secure: parsedCookie.secure,
                  httpOnly: parsedCookie.httpOnly,
                  lastAccessed: new Date().toISOString(),
                });
              }
            });
          }

          const endTime = Date.now();
          responseData = {
            id: uuidv4(),
            requestId: request.id,
            status: electronResponse.status,
            statusText: electronResponse.statusText,
            headers: electronResponse.headers,
            body: typeof electronResponse.data === 'string'
                ? electronResponse.data
                : JSON.stringify(electronResponse.data, null, 2),
            size: new Blob([JSON.stringify(electronResponse.data)]).size,
            time: endTime - startTime,
            timestamp: Date.now(),
            ...(electronResponse.negotiatedAlpn !== undefined
              ? { negotiatedAlpn: electronResponse.negotiatedAlpn }
              : {}),
          };
        } catch (err) {
          console.warn('Electron proxy IPC failed, falling back to Axios', err);
          // Fallback to axios below
        }
      }
    } else {
      // Web mode proxy warning
      const axiosProxy = toAxiosProxyConfig(proxyConfig);
      if (axiosProxy) {
        headers['X-Proxy-Configured'] = 'true';
      }
    }
  }

  // If responseData is not set (Electron failed or not Electron), use Axios.
  // This path bypasses both the worker and Electron's HTTP IPC, so we must
  // apply sign-at-wire auth (SigV4) here ourselves — the shared auth-signer
  // is pure Web Crypto and works fine in the renderer.
  if (typeof responseData === 'undefined') {
    // The local axios fallback bypasses both the worker and Electron's IPC, so
    // we need to apply sign-at-wire auth ourselves. The shared `applyAuth`
    // module is pure Web Crypto / pure JS and works fine in the renderer.
    // SigV4, OAuth1, and WSSE all live there.
    const needsSharedSigning =
      request.auth &&
      (request.auth.type === 'aws-signature' ||
        request.auth.type === 'oauth1' ||
        request.auth.type === 'wsse');
    if (needsSharedSigning) {
      try {
        const finalUrl = new URL(resolvedUrl);
        Object.entries(params).forEach(([k, v]) => finalUrl.searchParams.append(k, v));
        const applied = await applyAuth(request.auth, {
          method: request.method,
          url: finalUrl.toString(),
          headers,
          body: request.body.type !== 'none' ? request.body.raw : undefined,
        });
        Object.assign(headers, applied.headers);
        // axiosConfig.headers references the same object, but defensively reassign.
        axiosConfig.headers = headers;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'auth signing failed';
        throw new Error(`Auth signing failed: ${message}`);
      }
    }

    try {
      const response = await axios(axiosConfig);
      const endTime = Date.now();
      const bodyContent = typeof response.data === 'string'
        ? response.data
        : JSON.stringify(response.data, null, 2);
      responseData = {
        id: uuidv4(),
        requestId: request.id,
        status: response.status,
        statusText: response.statusText,
        headers: response.headers as Record<string, string | string[]>,
        body: bodyContent,
        size: new Blob([bodyContent]).size,
        time: endTime - startTime,
        timestamp: Date.now(),
      };
    } catch (error: unknown) {
      const endTime = Date.now();
      const isAxiosError = axios.isAxiosError(error);
      const errorMessage = error instanceof Error ? error.message : 'Request failed';

      responseData = {
        id: uuidv4(),
        requestId: request.id,
        status: isAxiosError && error.response ? error.response.status : 0,
        statusText: isAxiosError && error.response ? error.response.statusText : 'Error',
        headers: isAxiosError && error.response ? (error.response.headers as Record<string, string | string[]>) : {},
        body: isAxiosError && error.response?.data
          ? JSON.stringify(error.response.data, null, 2)
          : errorMessage,
        size: 0,
        time: endTime - startTime,
        timestamp: Date.now(),
      };
    }
  }

  // Ensure responseData is defined
  if (!responseData) {
    throw new Error('Failed to execute request: no response data available');
  }

  // Execute test script if exists
  let testResult: ScriptResult | undefined;
  if (request.testScript) {
    const executor = new ScriptExecutor(envVars, {});
    testResult = await executor.executeScript(request.testScript, {
      request: {
        url: request.url,
        method: request.method,
        headers: request.headers
          .filter((h) => h.enabled)
          .reduce(
            (acc, h) => ({ ...acc, [h.key]: h.value }),
            {} as Record<string, string>
          ),
        body: request.body.raw,
      },
      response: {
        status: responseData.status,
        statusText: responseData.statusText,
        headers: responseData.headers as Record<string, string>,
        body: responseData.body, // Note: body is string here, might need parsing if JSON
        time: responseData.time,
        size: responseData.size,
      },
    });
  }

  const result: RequestExecutionResult = {
    response: responseData,
    scriptResult: {
      ...(preRequestResult !== undefined && { preRequest: preRequestResult }),
      ...(testResult !== undefined && { test: testResult }),
    },
    envVars,
    sentHeaders: headers,
  };
  if (effectiveAuth !== request.auth) {
    result.refreshedAuth = effectiveAuth;
  }
  return result;
}

// ============================================================================
// Streaming HTTP requests (SSE / NDJSON / raw byte streams)
// ============================================================================

/** Accept-header content types that route through the streaming pipeline. */
const STREAMING_ACCEPT_TYPES = [
  'text/event-stream',
  'application/x-ndjson',
  'application/jsonl',
];

/**
 * Returns true when the supplied request headers ask for a streaming
 * content type (SSE / NDJSON / JSON Lines). Header lookup is
 * case-insensitive; compound Accept values (e.g. `text/event-stream,
 * application/json`) match if any element is a streaming type.
 */
export function isStreamingAccept(headers: Record<string, string>): boolean {
  const accept = headers['Accept'] ?? headers['accept'] ?? '';
  if (!accept) return false;
  const lower = accept.toLowerCase();
  return STREAMING_ACCEPT_TYPES.some((t) => lower.includes(t));
}

export interface StreamingExecutionResult {
  /** Async iterable of stream events, drained by `StreamingResponseViewer`. */
  events: AsyncIterable<StreamEvent>;
  /** Status + headers, available as soon as the upstream response begins. */
  responseMeta: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
  };
}

/**
 * Execute a streaming HTTP request via the worker proxy. The worker pipes
 * the upstream body through and we return an `AsyncIterable<StreamEvent>`
 * that the response viewer consumes incrementally.
 *
 * Web only — Electron's IPC path doesn't currently stream response bodies.
 * Callers should fall back to {@link executeRequest} when running in
 * Electron.
 *
 * Uses native `fetch()` (not Axios) because Axios buffers the entire body
 * before resolving, defeating the point of streaming.
 */
export async function executeStreamingRequest(
  options: RequestExecutorOptions
): Promise<StreamingExecutionResult> {
  const { request, envVars, globalSettings, resolveVariables } = options;

  const resolveLocal = (text: string) => {
    let result = text;
    Object.entries(envVars).forEach(([key, value]) => {
      result = result.replace(new RegExp(`{{${key}}}`, 'g'), value);
    });
    return resolveVariables(result);
  };

  const resolvedUrl = resolveLocal(request.url);

  const urlValidation = validateURL(resolvedUrl, {
    allowPrivateIPs: false,
    allowLocalhost: globalSettings.allowLocalhost ?? true,
  });
  if (!urlValidation.valid) {
    throw new Error(`Invalid URL: ${urlValidation.error}`);
  }

  const params: Record<string, string> = {};
  request.params
    .filter((p) => p.enabled && p.key)
    .forEach((p) => {
      params[p.key] = resolveLocal(p.value);
    });

  const headers: Record<string, string> = {};
  request.headers
    .filter((h) => h.enabled && h.key)
    .forEach((h) => {
      headers[h.key] = resolveLocal(h.value);
    });

  // Apply auth headers (e.g. bearer, basic, AWS SigV4 — though SigV4 is
  // unlikely to be paired with a streaming Accept in practice).
  const headersWithAuth = await applyAuthHeaders(
    request.auth,
    headers,
    resolvedUrl,
    request.method,
    request.body.type !== 'none' ? request.body.raw : undefined
  );
  Object.assign(headers, headersWithAuth);

  Object.assign(params, applyApiKeyQueryParam(request.auth, params));

  const cookies = useCookieStore.getState().getCookiesForUrl(resolvedUrl);
  if (cookies.length > 0) {
    headers['Cookie'] = cookies.map((c) => `${c.key}=${c.value}`).join('; ');
  }

  const proxyBody: Record<string, unknown> = {
    method: request.method,
    url: resolvedUrl,
    headers,
    params,
    bodyType: request.body.type === 'none' ? 'none' : 'raw',
    data: request.body.type !== 'none' ? request.body.raw : undefined,
    streamingMode: true,
    // No client-side timeout for streams — the upstream chooses when to end.
    timeout: 0,
  };

  if (request.auth && request.auth.type !== 'none') {
    proxyBody.auth = request.auth;
  }

  const response = await fetch(`${workerBaseUrl()}/api/proxy`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...workerAuthHeaders(),
    },
    body: JSON.stringify(proxyBody),
  });

  const responseMeta = {
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
  };

  const events = readStreamingResponse(response);
  return { events, responseMeta };
}
