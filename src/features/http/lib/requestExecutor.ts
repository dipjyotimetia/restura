import type {
  HttpRequest,
  Response as ApiResponse,
  RequestSettings,
  AppSettings,
  BodyType as RendererBodyType,
} from '@/types';
import type { BodyType as ProxyBodyType } from '@shared/protocol/body-builder';
import { v4 as uuidv4 } from 'uuid';
import { Cookie } from 'tough-cookie';
import type { ScriptResult } from '@/features/scripts/lib/scriptExecutor';
import ScriptExecutor from '@/features/scripts/lib/scriptExecutor';
import { validateURL } from '@/features/http/lib/urlValidator';
import { useCookieStore } from '@/features/http/store/useCookieStore';
import { useGlobalsStore } from '@/store/useGlobalsStore';
import { makeCookieAdapter } from '@/features/scripts/lib/pmCookieAdapter.renderer';
import { makeRendererSendRequest } from '@/features/scripts/lib/pmSendRequestHost';
import { makeVaultAdapter } from '@/lib/shared/vaultClient';
import {
  applyAuthHeaders,
  applyApiKeyQueryParam,
  assertHandleSupported,
} from '@/features/auth/lib/applyAuthHeaders';
import { refreshOAuth2Auth } from '@/features/auth/lib/tokenRefresh';
import {
  readStreamingResponse,
  type StreamEvent,
} from '@/features/http/lib/streamingResponseReader';
import {
  executeProxiedRequest,
  executeProxiedStreamingRequest,
  ProxyTransportError,
  type ProxyJsonResponse,
} from '@/lib/shared/transport';
import type { ProxyRequestBody } from '@shared/protocol/proxy-schema';

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

interface BuiltSpec {
  spec: ProxyRequestBody;
  /** Sent headers post-cookie-merge, returned to callers for the response panel. */
  sentHeaders: Record<string, string>;
  effectiveAuth: HttpRequest['auth'];
}

// Sign-at-wire auth (SigV4 / OAuth1 / WSSE) is intentionally NOT applied
// here — the descriptor flows through `spec.auth` so the proxy signs
// against the exact bytes it sends. Bearer / Basic / API-key / OAuth2 go
// through `applyAuthHeaders` because they don't depend on body bytes.
async function buildProxyRequestSpec(options: RequestExecutorOptions): Promise<BuiltSpec> {
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

  const effectiveAuth = await refreshOAuth2Auth(request.auth);

  const headersWithAuth = await applyAuthHeaders(
    effectiveAuth,
    headers,
    resolvedUrl,
    request.method,
    request.body.type !== 'none' ? request.body.raw : undefined
  );
  assertHandleSupported(headersWithAuth);
  Object.assign(headers, headersWithAuth.headers);

  Object.assign(params, applyApiKeyQueryParam(effectiveAuth, params));

  const effectiveSettings: RequestSettings = request.settings ?? {
    timeout: globalSettings.defaultTimeout,
    followRedirects: globalSettings.followRedirects,
    maxRedirects: globalSettings.maxRedirects,
    verifySsl: globalSettings.verifySsl,
    proxy: globalSettings.proxy,
  };

  // Cookie jar bypass: if disabled per-request, skip cookie reads entirely so
  // the request goes out with no Cookie header even if the jar has entries
  // for this origin.
  if (!effectiveSettings.disableCookieJar) {
    const cookies = useCookieStore.getState().getCookiesForUrl(resolvedUrl);
    if (cookies.length > 0) {
      const cookieHeader = cookies.map((c) => `${c.key}=${c.value}`).join('; ');
      headers['Cookie'] = cookieHeader;
    }
  }

  // Per-request redirect policy is threaded into the proxy body. Only emit
  // the field when at least one knob is set so the default-behaviour path
  // stays a no-op on the wire.
  const redirectPolicy: ProxyRequestBody['redirectPolicy'] = {};
  if (effectiveSettings.followOriginalMethod !== undefined) {
    redirectPolicy.followOriginalMethod = effectiveSettings.followOriginalMethod;
  }
  if (effectiveSettings.followAuthHeader !== undefined) {
    redirectPolicy.followAuthHeader = effectiveSettings.followAuthHeader;
  }
  if (effectiveSettings.stripReferer !== undefined) {
    redirectPolicy.stripReferer = effectiveSettings.stripReferer;
  }
  if (effectiveSettings.followRedirects && effectiveSettings.maxRedirects !== undefined) {
    redirectPolicy.maxRedirects = effectiveSettings.maxRedirects;
  }

  const proxyBodyType = mapBodyType(request.body.type);
  const spec: ProxyRequestBody = {
    method: request.method,
    url: resolvedUrl,
    headers,
    params,
    bodyType: proxyBodyType,
    ...(proxyBodyType !== 'none' && request.body.raw !== undefined
      ? { data: request.body.raw }
      : {}),
    ...(effectiveSettings.timeout !== undefined ? { timeout: effectiveSettings.timeout } : {}),
    ...(effectiveAuth && effectiveAuth.type !== 'none' ? { auth: effectiveAuth } : {}),
    ...(Object.keys(redirectPolicy).length > 0 ? { redirectPolicy } : {}),
    ...(effectiveSettings.encodeUrlAutomatically !== undefined
      ? { encodeUrl: effectiveSettings.encodeUrlAutomatically }
      : {}),
  };

  return { spec, sentHeaders: headers, effectiveAuth };
}

function persistResponseCookies(response: ProxyJsonResponse, resolvedUrl: string): void {
  const setCookie = response.headers['set-cookie'] ?? response.headers['Set-Cookie'];
  if (!setCookie) return;
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const cookieStr of list) {
    const parsed = Cookie.parse(cookieStr);
    if (!parsed) continue;
    const expires =
      parsed.expires === 'Infinity' || !parsed.expires ? undefined : parsed.expires.toString();
    useCookieStore.getState().addCookie({
      id: uuidv4(),
      key: parsed.key,
      value: parsed.value,
      domain: parsed.domain || new URL(resolvedUrl).hostname,
      path: parsed.path || '/',
      ...(expires !== undefined && { expires }),
      secure: parsed.secure,
      httpOnly: parsed.httpOnly,
      lastAccessed: new Date().toISOString(),
    });
  }
}

// Renderer's BodyType is wider than the proxy's (xml/protobuf/graphql/
// multipart-mixed). Renderer-only types fall back to 'raw' so the
// user-supplied Content-Type header is preserved verbatim.
function mapBodyType(rendererType: RendererBodyType): ProxyBodyType {
  switch (rendererType) {
    case 'none':
    case 'json':
    case 'text':
    case 'form-data':
    case 'binary':
      return rendererType;
    case 'x-www-form-urlencoded':
      return 'form-urlencoded';
    case 'graphql':
      return 'json';
    case 'xml':
    case 'protobuf':
    case 'multipart-mixed':
      return 'raw';
    default: {
      const exhaustive: never = rendererType;
      throw new Error(`Unmapped renderer body type: ${exhaustive as string}`);
    }
  }
}

function normalizeBody(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data === undefined || data === null) return '';
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

export async function executeRequest(
  options: RequestExecutorOptions
): Promise<RequestExecutionResult> {
  const { request, envVars, globalSettings } = options;
  const startTime = Date.now();

  let preRequestResult: ScriptResult | undefined;
  if (request.preRequestScript) {
    const globalVars = useGlobalsStore.getState().vars;
    // Pre-request runs before buildProxyRequestSpec has resolved auth, so
    // the inherited-header set is the user-defined headers only. The test
    // script (further down) gets the fully-resolved sentHeaders including
    // the Authorization that auth-applier produced.
    const inheritedHeadersPre = request.headers
      .filter((h) => h.enabled)
      .reduce((acc, h) => ({ ...acc, [h.key]: h.value }), {} as Record<string, string>);
    const executor = new ScriptExecutor({
      envVars,
      globalVars,
      host: {
        sendRequest: makeRendererSendRequest({
          variables: envVars,
          inheritedHeaders: inheritedHeadersPre,
        }),
        cookies: (currentUrl) => makeCookieAdapter(currentUrl),
        vault: makeVaultAdapter(),
      },
    });
    void useCookieStore; // keep the import side-effect for cookieAdapter's lazy store binding
    preRequestResult = await executor.executeScript(request.preRequestScript, {
      request: {
        url: request.url,
        method: request.method,
        headers: request.headers
          .filter((h) => h.enabled)
          .reduce((acc, h) => ({ ...acc, [h.key]: h.value }), {} as Record<string, string>),
        body: request.body.raw,
      },
    });
    if (preRequestResult.success && preRequestResult.variables) {
      Object.assign(envVars, preRequestResult.variables);
    }
    if (preRequestResult.globalsMutations) {
      useGlobalsStore.getState().applyMutations(preRequestResult.globalsMutations);
    }
  }

  const { spec, sentHeaders, effectiveAuth } = await buildProxyRequestSpec(options);

  const cookieJarDisabled =
    request.settings?.disableCookieJar === true ||
    (request.settings === undefined && globalSettings.disableCookieJar === true);

  let responseData: ApiResponse;
  try {
    const proxyResponse = await executeProxiedRequest(spec);
    if (!cookieJarDisabled) {
      persistResponseCookies(proxyResponse, spec.url);
    }
    const endTime = Date.now();
    const bodyString = normalizeBody(proxyResponse.data);
    responseData = {
      id: uuidv4(),
      requestId: request.id,
      status: proxyResponse.status,
      statusText: proxyResponse.statusText,
      headers: proxyResponse.headers,
      body: bodyString,
      size: proxyResponse.size ?? new Blob([bodyString]).size,
      time: endTime - startTime,
      timestamp: Date.now(),
      ...(proxyResponse.bodyEncoding !== undefined
        ? { bodyEncoding: proxyResponse.bodyEncoding }
        : {}),
      ...(proxyResponse.negotiatedAlpn !== undefined
        ? { negotiatedAlpn: proxyResponse.negotiatedAlpn }
        : {}),
    };
  } catch (err) {
    const endTime = Date.now();
    const isProxyError = err instanceof ProxyTransportError;
    responseData = {
      id: uuidv4(),
      requestId: request.id,
      status: isProxyError && err.status !== undefined ? err.status : 0,
      statusText: isProxyError ? 'Proxy Error' : 'Error',
      headers: {},
      body: err instanceof Error ? err.message : 'Request failed',
      size: 0,
      time: endTime - startTime,
      timestamp: Date.now(),
    };
  }

  let testResult: ScriptResult | undefined;
  if (request.testScript) {
    const globalVars = useGlobalsStore.getState().vars;
    // Test script gets the fully-resolved sentHeaders (auth + content-type
    // + framework defaults) so pm.sendRequest sub-requests inherit the
    // same Authorization the parent went out with. The user can still
    // override per-call via the headers param to pm.sendRequest.
    const executor = new ScriptExecutor({
      envVars,
      globalVars,
      host: {
        sendRequest: makeRendererSendRequest({
          variables: envVars,
          inheritedHeaders: sentHeaders,
        }),
        cookies: (currentUrl) => makeCookieAdapter(currentUrl),
        vault: makeVaultAdapter(),
      },
    });
    void useCookieStore; // keep the import side-effect for cookieAdapter's lazy store binding
    testResult = await executor.executeScript(request.testScript, {
      request: {
        url: request.url,
        method: request.method,
        headers: request.headers
          .filter((h) => h.enabled)
          .reduce((acc, h) => ({ ...acc, [h.key]: h.value }), {} as Record<string, string>),
        body: request.body.raw,
      },
      response: {
        status: responseData.status,
        statusText: responseData.statusText,
        headers: responseData.headers as Record<string, string>,
        body: responseData.body,
        time: responseData.time,
        size: responseData.size,
      },
    });
    if (testResult.globalsMutations) {
      useGlobalsStore.getState().applyMutations(testResult.globalsMutations);
    }
  }

  const result: RequestExecutionResult = {
    response: responseData,
    scriptResult: {
      ...(preRequestResult !== undefined && { preRequest: preRequestResult }),
      ...(testResult !== undefined && { test: testResult }),
    },
    envVars,
    sentHeaders,
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
const STREAMING_ACCEPT_TYPES = ['text/event-stream', 'application/x-ndjson', 'application/jsonl'];

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

// Web only — Electron HTTP streaming has no IPC channel yet; SSE-shaped
// requests in Electron go through sseManager.
export async function executeStreamingRequest(
  options: RequestExecutorOptions
): Promise<StreamingExecutionResult> {
  const { spec } = await buildProxyRequestSpec(options);

  const streamingSpec: ProxyRequestBody = {
    ...spec,
    streamingMode: true,
    // No client-side timeout for streams — the upstream chooses when to end.
    timeout: 0,
  };

  const response = await executeProxiedStreamingRequest(streamingSpec);

  const responseMeta = {
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
  };

  const events = readStreamingResponse(response);
  return { events, responseMeta };
}
