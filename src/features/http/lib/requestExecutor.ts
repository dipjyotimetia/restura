import { applyPathVariables } from '@shared/protocol/path-variables';
import type { ProxyRequestBody } from '@shared/protocol/proxy-schema';
import {
  appendQueryPairs,
  applyBodyDefaultHeaders,
  authHeaderNames,
  buildProxyBody,
  buildProxyFormFields,
  collectEnabledHeaders,
  collectQueryPairs,
  mapProxyBodyType,
  type QueryPair,
} from '@shared/protocol/request-spec';
import { type CookieHop, responseSetCookies } from '@shared/protocol/set-cookie';
import {
  basicAuthReferencesSecretVariable,
  SecretVariableReferenceError,
} from '@shared/variables/secret-variable-token';
import { scanVariableTokens } from '@shared/variables/tokens';
import { v4 as uuidv4 } from 'uuid';
import {
  applyApiKeyQueryParam,
  applyAuthHeaders,
  assertHandleSupported,
} from '@/features/auth/lib/applyAuthHeaders';
import { createProxiedTokenFetch } from '@/features/auth/lib/oauth2-transport';
import { resolveAuthVariables } from '@/features/auth/lib/resolveAuthVariables';
import { assertPostmanSendable } from '@/features/auth/lib/resolveInheritedAuthFor';
import { persistableRefreshedAuth, refreshOAuth2Auth } from '@/features/auth/lib/tokenRefresh';
import { responseCookieHops, withJarCookies } from '@/features/http/lib/cookieJar';
import { buildDesktopTransportConfig } from '@/features/http/lib/desktopTransportConfig';
import { resolveEffectiveSettings } from '@/features/http/lib/effectiveSettings';
import {
  executeProxiedRequestWithProgress,
  type ResponseProgressHandler,
  readStreamSideChannels,
} from '@/features/http/lib/progressTransport';
import {
  type HttpStreamEvent,
  readStreamingResponse,
} from '@/features/http/lib/streamingResponseReader';
import { validateURL } from '@/features/http/lib/urlValidator';
import { useCookieStore } from '@/features/http/store/useCookieStore';
import type { ScriptResult } from '@/features/scripts/lib/scriptExecutor';
import { isElectron } from '@/lib/shared/platform';
import { resolveRequestScopeText } from '@/lib/shared/resolveRequestScope';
import type { SecretValue } from '@/lib/shared/secretRef';
import {
  type DesktopTransportConfig,
  executeProxiedRequest,
  executeProxiedStreamingRequest,
  ProxyTransportError,
} from '@/lib/shared/transport';
import type { Response as ApiResponse, AppSettings, HttpRequest, RequestSettings } from '@/types';
import { shapeGraphQLBody } from './graphqlBody';
import {
  mutationFields,
  newScriptMutations,
  runPreRequestStep,
  runTestStep,
  scriptInfo,
} from './requestScriptPhases';
import { ignoreProgress, isStreamingAccept, proxyStreamsAccept } from './streamingAccept';
import { createStreamCapture, streamedResponse } from './streamingCapture';

export interface RequestExecutionResult {
  response: ApiResponse;
  /** True only when the parent proxy transport returned a response. */
  transportOk: boolean;
  scriptResult?: {
    preRequest?: ScriptResult;
    test?: ScriptResult;
  };
  envVars?: Record<string, string>;
  /**
   * The URL handed to the transport, after `{{var}}` substitution (desktop secret
   * tokens stay opaque, and a dynamic is the value actually generated). Query
   * params are carried separately in `sentParams`.
   */
  sentUrl: string;
  sentHeaders: Record<string, string>;
  /**
   * The raw-text body as sent, after `{{var}}` substitution (desktop secret
   * tokens stay opaque). Lets callers map server coordinates — e.g. GraphQL
   * error locations — back onto the unsubstituted editor text.
   */
  sentBody?: string;
  /** Query params as sent, after `{{var}}` substitution (e.g. a GraphQL GET's `query`). */
  sentParams?: Record<string, string>;
  refreshedAuth?: HttpRequest['auth'];
  /**
   * `pm.collectionVariables.set/unset` mutations from either script phase,
   * merged (test phase wins on conflict). Callers persist these back to the
   * owning collection's `variables` — see `useCollectionStore.
   * applyCollectionVarMutations`. Undefined when neither script touched
   * `pm.collectionVariables`.
   */
  collectionVarsMutations?: Record<string, string | null>;
  /**
   * `pm.environment.set/unset` mutations from either script phase, merged (test
   * phase wins on conflict). Callers persist these to the active environment —
   * see `persistScriptEnvironmentMutations`. Undefined when neither script wrote
   * to `pm.environment`.
   */
  environmentMutations?: Record<string, string | null>;
}

export interface RequestExecutorOptions {
  request: HttpRequest;
  /**
   * Collection run only: a pre-request `pm.execution.skipRequest()` returns
   * before anything is sent, with a placeholder response and no test script.
   */
  honorSkipRequest?: boolean;
  envVars: Record<string, string>;
  /** Opaque SecretRef values that may cross only to Electron main for wire substitution. */
  secretVariables?: Record<string, SecretValue>;
  /** Names that resolve only where they are written (`sendSecretNames`). */
  secretNames?: readonly string[];
  globalSettings: AppSettings;
  resolveVariables: (text: string, vars?: Record<string, string>) => string;
  /** Cancels scripts and transport work owned by the caller. */
  signal?: AbortSignal;
  /** Collection-scoped variables, backing `pm.collectionVariables`. */
  collectionVars?: Record<string, string>;
  /** Current iteration's data-row, backing `pm.iterationData` (collection runner). */
  iterationData?: Record<string, string>;
  /** `pm.info` metadata. `requestName`/`requestId` default from `request` when omitted. */
  info?: { requestName?: string; requestId?: string; iteration?: number; iterationCount?: number };
  /** `pm.execution.location` metadata (collection/folder run context). */
  location?: {
    currentRequestName: string;
    folderPath: string[];
    collectionName: string;
  };
  /**
   * Live body progress. When set, the web transport streams the upstream body
   * through the Worker and reports each chunk; desktop reports the buffered
   * body once. The resolved response is still the complete, buffered one.
   */
  onResponseProgress?: ResponseProgressHandler;
  /**
   * Reshape the response before test scripts, history and the caller see it
   * (GraphQL folds `multipart/mixed` incremental parts into one result).
   */
  transformResponse?: (response: ApiResponse) => ApiResponse;
}

interface BuiltSpec {
  spec: ProxyRequestBody;
  /** The one resolved settings object used for both request and response handling. */
  effectiveSettings: RequestSettings;
  /** Sent headers post-cookie-merge, returned to callers for the response panel. */
  sentHeaders: Record<string, string>;
  /** The resolved URL before the query rows were folded into `spec.url`. */
  sentUrl: string;
  /** Query params as sent, one value per key (display / GraphQL GET read-back). */
  sentParams: Record<string, string>;
  /**
   * The enabled user header rows with their values as sent (resolved), for the
   * test script's `rs.request.headers` — the CLI hands the test phase the same.
   */
  scriptHeaders: Record<string, string>;
  /**
   * Set only when OAuth2 refresh issued a new token: the request's template
   * auth with the issued token folded in (never resolved `{{var}}` values).
   */
  refreshedAuth?: HttpRequest['auth'];
  /**
   * Desktop-only transport config (proxy / mTLS client cert / custom CA /
   * verifySsl / TLS knobs). Carried alongside the spec — NOT inside it —
   * because cert material must never reach the Cloudflare Worker on the web
   * path. `executeProxiedRequest` forwards it over IPC only and drops it on
   * web. Undefined when nothing desktop-specific is configured.
   */
  desktop?: DesktopTransportConfig;
}

// Re-exported (imported above for internal use) so existing import sites
// (`@/features/http/lib/requestExecutor`) keep working. The fold itself lives in
// effectiveSettings.ts so the per-request editor can share it without pulling
// this module's heavy deps. See globalSettingsToRequestSettings.
// Same treatment: the shared request-to-spec step, under the names existing sites use.
export { buildDesktopTransportConfig } from '@/features/http/lib/desktopTransportConfig';
export {
  buildProxyFormFields as buildFormFields,
  mapProxyBodyType as mapBodyType,
  resolveEffectiveSettings,
};

// Sign-at-wire auth (SigV4 / OAuth1 / WSSE) is intentionally NOT applied
// here — the descriptor flows through `spec.auth` so the proxy signs
// against the exact bytes it sends. Bearer / Basic / API-key / OAuth2 go
// through `applyAuthHeaders` because they don't depend on body bytes.
async function buildProxyRequestSpec(options: RequestExecutorOptions): Promise<BuiltSpec> {
  const { envVars, globalSettings, resolveVariables, secretVariables, secretNames } = options;

  // envVars is read per call: scripts have already written to it by this point.
  const resolveLocal = (text: string, field: string) =>
    resolveRequestScopeText(
      text,
      { values: envVars, secretVariables, secretNames, resolveVariables },
      field
    );
  // A value no user wrote (the cookie jar) must not carry a token main would
  // substitute: main replaces every token it finds in the spec.
  const refuseHandleToken = (text: string, source: string) => {
    if (!secretVariables) return;
    const token = scanVariableTokens(text).find(({ name }) => Object.hasOwn(secretVariables, name));
    if (token) throw new SecretVariableReferenceError(source, token.name);
  };

  // A GraphQL body (the HTTP tab's "GraphQL" type, or a saved request run by
  // any renderer path) goes out as the GraphQL-over-HTTP wire request the
  // GraphQL tab, collection runner and CLI send. A request already shaped by
  // the GraphQL module arrives as `json` and passes through untouched.
  const graphql = shapeGraphQLBody(options.request, (text) => resolveLocal(text, 'body'));
  const request = graphql?.request ?? options.request;

  // `:name` path segments take their (resolved) path-variable values here, the
  // shared rule the CLI and code generators use. A desktop secret token in a
  // value stays verbatim for Electron main to substitute.
  const resolvedUrl = applyPathVariables(resolveLocal(request.url, 'URL'), request.pathVariables, {
    resolve: (row) => resolveLocal(row.value, `path variable "${row.key}"`),
    encode: request.settings?.encodeUrlAutomatically !== false,
    keepToken: (name) => secretVariables !== undefined && Object.hasOwn(secretVariables, name),
  });

  const urlValidation = validateURL(resolvedUrl, {
    allowPrivateIPs: globalSettings.allowPrivateIPs === true,
    allowLocalhost: globalSettings.allowLocalhost ?? true,
  });
  if (!urlValidation.valid) {
    throw new Error(`Invalid URL: ${urlValidation.error}`);
  }

  // Every query row is kept, repeated keys included, in table order: they are
  // folded into `spec.url` (see below). User-typed rows go out as typed; rows
  // Restura built (GraphQL GET params) are fully percent-encoded.
  //
  // A row whose value holds a desktop secret token stays in `params` (a Record
  // Electron main substitutes in; the proxy then escapes it in full). Pinned
  // trade-off (requestExecutor.queryWire.test.ts): such rows go after the
  // folded ones and a repeated name keeps its last row only.
  // GraphQL GET params were built from already-resolved text: resolving them
  // again would re-expand `{{…}}` inside the resolved document.
  const queryPairs = collectQueryPairs(request.params, (p) =>
    graphql?.builtParams.has(p) ? p.value : resolveLocal(p.value, `query parameter "${p.key}"`)
  );
  const holdsSecretToken = (text: string) =>
    secretVariables !== undefined &&
    scanVariableTokens(text).some(({ name }) => Object.hasOwn(secretVariables, name));
  const params: Record<string, string> = {};
  let foldedQuery: QueryPair[] = [];
  for (const pair of queryPairs) {
    const [key, value] = pair;
    if (holdsSecretToken(value)) params[key] = value;
    else foldedQuery.push(pair);
  }
  // Repeated header rows combine (`, `; Cookie `; `) instead of the last one winning.
  // Each row's resolved value is kept for the test script (resolved once, so a
  // dynamic like `{{$uuid}}` reads back the value that was sent).
  const resolvedRows = new Map<HttpRequest['headers'][number], string>();
  const headers = applyBodyDefaultHeaders(
    request.body.type,
    collectEnabledHeaders(request.headers, (h) => {
      const value = resolveLocal(h.value, `header "${h.key}"`);
      resolvedRows.set(h, value);
      return value;
    })
  );
  const scriptHeaders: Record<string, string> = Object.fromEntries(
    options.request.headers
      .filter((h) => h.enabled)
      .map((h) => [h.key, resolvedRows.get(h) ?? h.value])
  );

  // {{vars}} in the body resolve like the URL/params/headers do. Binary bodies
  // hold base64 bytes and are never touched; file parts likewise; desktop secret
  // handles stay opaque via resolveLocal. Built once, so a dynamic in the body is
  // the same value here and on the wire.
  const builtBody =
    graphql?.body ??
    buildProxyBody(request.body, { resolve: (text) => resolveLocal(text, 'body') });

  // Resolve {{vars}} in every auth type with the same scope as the URL/headers/
  // body (secret-variable tokens and handle SecretRefs stay opaque for main).
  // The resolved copy is what's applied to headers AND sent as `spec.auth`
  // for sign-at-wire schemes (SigV4 / OAuth1 / WSSE / Digest / NTLM).
  const resolvedAuth = resolveAuthVariables(request.auth, (text) => resolveLocal(text, 'auth'));
  const effectiveSettings = resolveEffectiveSettings(request.settings, globalSettings);
  // A token refresh uses this request's transport settings (TLS, certs, proxy).
  const tokenFetch = createProxiedTokenFetch((tokenUrl) =>
    buildDesktopTransportConfig(effectiveSettings, globalSettings, tokenUrl)
  );
  const effectiveAuth = await refreshOAuth2Auth(
    resolvedAuth,
    Date.now(),
    options.signal,
    tokenFetch
  );
  // Only a real token refresh is reported for persistence — and it's folded
  // back onto the template so resolved variable values never get saved.
  const refreshedAuth =
    effectiveAuth !== resolvedAuth
      ? persistableRefreshedAuth(request.auth, resolvedAuth, effectiveAuth)
      : undefined;

  // Basic is base64-encoded here, which would bake an opaque `{{secretVar}}`
  // token into the header where main can no longer substitute it. Defer it
  // like a handle: main materializes the token in `spec.auth` and builds the
  // Authorization header (auth-applier). Web can't materialize → fails fast.
  const deferBasic =
    effectiveAuth.type === 'basic' &&
    secretVariables !== undefined &&
    basicAuthReferencesSecretVariable(effectiveAuth.basic, (name) =>
      Object.hasOwn(secretVariables, name)
    );
  const headersWithAuth = deferBasic
    ? { headers, requiresMainSideApply: true }
    : await applyAuthHeaders(effectiveAuth, headers, resolvedUrl, request.method, builtBody.data);
  assertHandleSupported(headersWithAuth);
  // The merged map is the whole header set: an auth header has already
  // replaced a user row of the same name in any casing, so replace, not merge.
  // Copy first — a deferred Basic header hands back `headers` itself.
  const merged = { ...headersWithAuth.headers };
  for (const key of Object.keys(headers)) delete headers[key];
  Object.assign(headers, merged);

  // An API key sent in the query replaces same-named query rows (it is not
  // sent next to them).
  const authParams = applyApiKeyQueryParam(effectiveAuth, {});
  const authParamNames = Object.keys(authParams);
  Object.assign(params, authParams);
  if (authParamNames.length > 0) {
    foldedQuery = foldedQuery.filter(([key]) => !authParamNames.includes(key));
  }

  // Cookie jar bypass: if disabled per-request, skip cookie reads entirely so
  // the request goes out with no Cookie header even if the jar has entries
  // for this origin.
  if (!effectiveSettings.disableCookieJar) {
    const cookies = useCookieStore.getState().getCookiesForUrl(resolvedUrl);
    if (cookies.length > 0) {
      // The joined text: a name, or a name and value together, can hold a token too.
      refuseHandleToken(cookies.map((c) => `${c.key}=${c.value}`).join('; '), 'The Cookie header');
      // A Cookie header the user wrote (any casing) keeps its cookies; the jar
      // adds only the names it does not already carry.
      const merged = withJarCookies(headers, cookies);
      for (const key of Object.keys(headers)) delete headers[key];
      Object.assign(headers, merged);
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
  // followRedirects:false → maxRedirects:0 so the shared follower (and the
  // Electron manual handler) return the 3xx unfollowed. Use `=== false`, not
  // `!followRedirects`: a partial settings object (e.g. an imported collection
  // whose `settings` omits the field) leaves it `undefined`, which must fall
  // through to the default-follow path — not be treated as "off". Matches the
  // CLI executor's `=== false` check.
  if (effectiveSettings.followRedirects === false) {
    redirectPolicy.maxRedirects = 0;
  } else if (effectiveSettings.maxRedirects !== undefined) {
    redirectPolicy.maxRedirects = effectiveSettings.maxRedirects;
  }

  const authHeaders = authHeaderNames(effectiveAuth);
  if (authHeaders.length > 0) redirectPolicy.stripOnOriginChange = authHeaders;

  const spec: ProxyRequestBody = {
    method: request.method,
    url: appendQueryPairs(resolvedUrl, foldedQuery, {
      encode: effectiveSettings.encodeUrlAutomatically !== false,
    }),
    headers,
    params,
    ...builtBody,
    ...(effectiveSettings.timeout !== undefined ? { timeout: effectiveSettings.timeout } : {}),
    ...(effectiveAuth && effectiveAuth.type !== 'none' ? { auth: effectiveAuth } : {}),
    ...(Object.keys(redirectPolicy).length > 0 ? { redirectPolicy } : {}),
    ...(effectiveSettings.encodeUrlAutomatically !== undefined
      ? { encodeUrl: effectiveSettings.encodeUrlAutomatically }
      : {}),
  };

  const baseDesktop = buildDesktopTransportConfig(effectiveSettings, globalSettings, resolvedUrl);
  const desktop =
    secretVariables && Object.keys(secretVariables).length > 0
      ? { ...(baseDesktop ?? {}), secretVariables }
      : baseDesktop;

  const sentParams: Record<string, string> = {};
  for (const [key, value] of queryPairs) sentParams[key] = value;
  Object.assign(sentParams, params);

  return {
    spec,
    effectiveSettings,
    sentHeaders: headers,
    sentUrl: resolvedUrl,
    sentParams,
    scriptHeaders,
    ...(refreshedAuth ? { refreshedAuth } : {}),
    ...(desktop ? { desktop } : {}),
  };
}

/**
 * Store a response's cookies. Each redirect hop's cookies go against the URL
 * that set them and the final response's against the final URL (the proxy
 * reports both as `cookieHops` / `finalUrl`); see cookieJar.ts for the rules.
 */
function persistResponseCookies(
  response: {
    headers: Record<string, string | string[]>;
    setCookies?: string[] | undefined;
    cookieHops?: CookieHop[] | undefined;
    finalUrl?: string | undefined;
  },
  requestedUrl: string
): void {
  const setCookies = responseSetCookies(response);
  const hops = responseCookieHops(
    {
      setCookies,
      ...(response.cookieHops ? { cookieHops: response.cookieHops } : {}),
      ...(response.finalUrl ? { finalUrl: response.finalUrl } : {}),
    },
    requestedUrl
  );
  useCookieStore.getState().storeResponseCookies(hops);
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
  const { request, envVars, signal } = options;
  signal?.throwIfAborted();
  // Pre-send refusal (#1232): a Postman `noauth` / unsupported-auth request
  // would otherwise go out with an ancestor's credential. Nothing runs.
  assertPostmanSendable(request);
  const startTime = Date.now();
  const baseInfo = scriptInfo(options);
  const mutations = newScriptMutations();
  // A pre-request script's `rs.request.headers` edits apply to what is sent.
  const pre = await runPreRequestStep(options, baseInfo, mutations);
  const requestToSend = pre.requestToSend;
  const preRequestResult = pre.result;

  if (options.honorSkipRequest && pre.skipRequested) {
    // Postman sends nothing and runs no test script. The caller reads the
    // sentinel from `scriptResult.preRequest` and discards this response.
    signal?.throwIfAborted();
    return {
      response: {
        id: uuidv4(),
        requestId: request.id,
        status: 0,
        statusText: 'Skipped',
        headers: {},
        body: '',
        size: 0,
        time: 0,
        timestamp: Date.now(),
      },
      transportOk: false,
      scriptResult: preRequestResult ? { preRequest: preRequestResult } : {},
      envVars,
      sentUrl: request.url,
      sentHeaders: {},
      ...mutationFields(mutations),
    };
  }

  const {
    spec,
    effectiveSettings,
    sentHeaders,
    sentUrl,
    sentParams,
    scriptHeaders,
    refreshedAuth,
    desktop,
  } = await buildProxyRequestSpec(
    requestToSend === request ? options : { ...options, request: requestToSend }
  );

  let responseData: ApiResponse;
  let transportOk = false;
  try {
    signal?.throwIfAborted();
    // The web proxy answers a streaming Accept with a raw pass-through, not the
    // buffered JSON envelope; read that stream to completion so the caller
    // still gets the whole body (the interactive page streams it live instead).
    const onProgress =
      options.onResponseProgress ??
      (!isElectron() && proxyStreamsAccept(spec.headers ?? {}) ? ignoreProgress : undefined);
    const proxyResponse = onProgress
      ? await executeProxiedRequestWithProgress(spec, onProgress, signal ? { signal } : {}, desktop)
      : await executeProxiedRequest(spec, signal ? { signal } : {}, desktop);
    signal?.throwIfAborted();
    transportOk = true;
    if (!effectiveSettings.disableCookieJar) {
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
      ...(proxyResponse.setCookies !== undefined ? { setCookies: proxyResponse.setCookies } : {}),
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
      ...(proxyResponse.bodyNotice !== undefined ? { bodyNotice: proxyResponse.bodyNotice } : {}),
      ...(proxyResponse.timings !== undefined ? { timings: proxyResponse.timings } : {}),
    };
    if (options.transformResponse) responseData = options.transformResponse(responseData);
  } catch (err) {
    signal?.throwIfAborted();
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

  const testResult = await runTestStep(
    options,
    {
      info: baseInfo,
      sentUrl,
      scriptHeaders,
      parentUrl: spec.url,
      sentHeaders,
      response: responseData,
    },
    mutations
  );

  // Do not expose collection-variable mutations to callers after cancellation;
  // saved-request tools apply them to the owning collection only on success.
  signal?.throwIfAborted();
  const result: RequestExecutionResult = {
    response: responseData,
    transportOk,
    scriptResult: {
      ...(preRequestResult !== undefined && { preRequest: preRequestResult }),
      ...(testResult !== undefined && { test: testResult }),
    },
    envVars,
    sentUrl,
    sentHeaders,
    ...(spec.data !== undefined ? { sentBody: spec.data } : {}),
    ...(Object.keys(sentParams).length > 0 ? { sentParams } : {}),
    ...mutationFields(mutations),
  };
  if (refreshedAuth) {
    result.refreshedAuth = refreshedAuth;
  }
  return result;
}

// ============================================================================
// Streaming HTTP requests (SSE / NDJSON / raw byte streams)
// ============================================================================

export interface StreamingExecutionResult {
  /** Async iterable of stream events, drained by `StreamingResponseViewer`. */
  events: AsyncIterable<HttpStreamEvent>;
  /** Status + headers, available as soon as the upstream response begins. */
  responseMeta: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    /** Every upstream Set-Cookie, one entry each (from the Worker side channel). */
    setCookies?: string[];
  };
  /**
   * True when the pre-request script called `pm.execution.skipRequest()`:
   * nothing was sent, `events` is empty and `finish` runs no test script.
   */
  skipped?: boolean;
  scriptResult?: { preRequest?: ScriptResult };
  /** The URL / headers handed to the transport (as on `RequestExecutionResult`). */
  sentUrl: string;
  sentHeaders: Record<string, string>;
  refreshedAuth?: HttpRequest['auth'];
  /**
   * Call once the stream has ended (its terminal `end` / `error` event, after
   * every event was read): builds the response from the captured stream text
   * and runs the test script, as `executeRequest` does after a buffered body.
   * Throws if the signal was aborted (no test script runs after a cancel).
   */
  finish: (terminal: HttpStreamEvent | undefined) => Promise<StreamingCompletion>;
}

export interface StreamingCompletion
  extends Pick<
    RequestExecutionResult,
    | 'response'
    | 'envVars'
    | 'sentUrl'
    | 'sentHeaders'
    | 'collectionVarsMutations'
    | 'environmentMutations'
  > {
  scriptResult: { preRequest?: ScriptResult; test?: ScriptResult };
}

// Web only — Electron HTTP streaming has no IPC channel yet; SSE-shaped
// requests in Electron go through sseManager. Scripts run as on the buffered
// path: pre-request before the spec is built, test once the stream ends.
export async function executeStreamingRequest(
  options: RequestExecutorOptions
): Promise<StreamingExecutionResult> {
  const { request, signal } = options;
  signal?.throwIfAborted();
  assertPostmanSendable(request); // same pre-send refusal as executeRequest (#1232)
  const startTime = Date.now();
  const info = scriptInfo(options);
  const mutations = newScriptMutations();
  const pre = await runPreRequestStep(options, info, mutations);
  const preScript = pre.result ? { preRequest: pre.result } : {};

  if (pre.skipRequested) {
    signal?.throwIfAborted();
    const responseMeta = { status: 0, statusText: 'Skipped', headers: {} };
    const capture = createStreamCapture(undefined);
    return {
      events: (async function* () {})(),
      responseMeta,
      skipped: true,
      scriptResult: preScript,
      sentUrl: request.url,
      sentHeaders: {},
      finish: async (terminal) => {
        signal?.throwIfAborted();
        return {
          response: streamedResponse({
            requestId: request.id,
            meta: responseMeta,
            capture,
            startTime,
            terminal,
          }),
          envVars: options.envVars,
          sentUrl: request.url,
          sentHeaders: {},
          scriptResult: preScript,
          ...mutationFields(mutations),
        };
      },
    };
  }

  const { spec, effectiveSettings, sentHeaders, sentUrl, scriptHeaders, refreshedAuth } =
    await buildProxyRequestSpec(
      pre.requestToSend === request ? options : { ...options, request: pre.requestToSend }
    );

  const streamingSpec: ProxyRequestBody = {
    ...spec,
    streamingMode: true,
    // No client-side timeout for streams — the upstream chooses when to end.
    timeout: 0,
  };

  signal?.throwIfAborted();
  const response = await executeProxiedStreamingRequest(streamingSpec, signal ? { signal } : {});

  // Cookies (and a followed chain's hop cookies) arrive in side channels;
  // hop cookies are stored even when the final response set none.
  const { headers, setCookies, finalUrl, cookieHops } = readStreamSideChannels(response);
  if ((setCookies.length > 0 || cookieHops) && !effectiveSettings.disableCookieJar) {
    persistResponseCookies({ headers, setCookies, cookieHops, finalUrl }, spec.url);
  }
  const responseMeta: StreamingExecutionResult['responseMeta'] = {
    status: response.status,
    statusText: response.statusText,
    headers,
    ...(setCookies.length > 0 ? { setCookies } : {}),
  };

  // The body text is captured as it is read (bounded like a buffered body),
  // for the test script and the history entry.
  const capture = createStreamCapture(response.headers.get('content-type') ?? undefined);
  const events = readStreamingResponse(response, { onBytes: capture.onBytes });
  return {
    events,
    responseMeta,
    scriptResult: preScript,
    sentUrl,
    sentHeaders,
    ...(refreshedAuth ? { refreshedAuth } : {}),
    finish: async (terminal) => {
      signal?.throwIfAborted();
      const streamed = streamedResponse({
        requestId: request.id,
        meta: responseMeta,
        capture,
        startTime,
        terminal,
      });
      const finalResponse = options.transformResponse
        ? options.transformResponse(streamed)
        : streamed;
      const test = await runTestStep(
        options,
        { info, sentUrl, scriptHeaders, parentUrl: spec.url, sentHeaders, response: finalResponse },
        mutations
      );
      signal?.throwIfAborted();
      return {
        response: finalResponse,
        envVars: options.envVars,
        sentUrl,
        sentHeaders,
        scriptResult: { ...preScript, ...(test ? { test } : {}) },
        ...mutationFields(mutations),
      };
    },
  };
}

export { isStreamingAccept };
