import type { ProxyRequestBody } from '@shared/protocol/proxy-schema';
import type { AxiosProxyConfig } from 'axios';
import axios, { isAxiosError } from 'axios';
import { useCallback } from 'react';
import { toast } from 'sonner';
import { v4 as uuidv4 } from 'uuid';
import { applyAuthHeaders, applyApiKeyQueryParam } from '@/features/auth/lib/applyAuthHeaders';
import { resolveEffectiveAuth } from '@/features/auth/lib/authInheritance';
import { resolveInheritedAuthFor } from '@/features/auth/lib/resolveInheritedAuthFor';
import {
  buildDesktopTransportConfig,
  buildFormFields,
  mapBodyType,
  resolveEffectiveSettings,
} from '@/features/http/lib/requestExecutor';
import { makeCookieAdapter } from '@/features/scripts/lib/pmCookieAdapter.renderer';
import { makeRendererSendRequest } from '@/features/scripts/lib/pmSendRequestHost';
import ScriptExecutor from '@/features/scripts/lib/scriptExecutor';
import { useKeyValueCollection } from '@/hooks/useKeyValueCollection';
import { buildActiveRequestValueMap } from '@/lib/shared/activeRequestScopes';
import { escapeRegExp } from '@/lib/shared/escapeRegExp';
import { makeRendererJudge } from '@/lib/shared/judgeBridge';
import { isElectron } from '@/lib/shared/platform';
import { unwrapSecret } from '@/lib/shared/secretRef';
import { executeProxiedRequest } from '@/lib/shared/transport';
import { buildValueMap } from '@/lib/shared/variableScopes';
import { makeVaultAdapter } from '@/lib/shared/vaultClient';
import { useActiveRequest } from '@/store/selectors';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useConsoleStore, createConsoleEntry } from '@/store/useConsoleStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useGlobalsStore } from '@/store/useGlobalsStore';
import { useHistoryStore } from '@/store/useHistoryStore';
import { useRequestStore } from '@/store/useRequestStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import type { HttpMethod, AuthConfig, RequestSettings, RequestBody, FormDataItem } from '@/types';

/**
 * Capture the headers the request actually went out with for the Console.
 *
 * axios records the per-request headers (user + auth + its defaults like
 * `Accept`, plus `Content-Type`/`Content-Length` it adds for a body) on
 * `config.headers` (an `AxiosHeaders` instance). We flatten that, fall back to
 * the pre-request map for anything axios didn't surface, and synthesise the
 * deterministic `Host` from the target URL. These are the headers the *client*
 * sent — a proxied upstream may add its own — but it's far more useful than the
 * bare user-defined set, and turns the empty "No headers" detail into reality.
 */
function captureSentHeaders(
  configHeaders: unknown,
  fallback: Record<string, string>,
  targetUrl: string | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  const raw =
    configHeaders && typeof (configHeaders as { toJSON?: () => unknown }).toJSON === 'function'
      ? (configHeaders as { toJSON: () => Record<string, unknown> }).toJSON()
      : (configHeaders as Record<string, unknown> | undefined);
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) {
      if (v == null || typeof v === 'object') continue; // skip nulls + nested default maps
      out[k] = String(v);
    }
  }
  for (const [k, v] of Object.entries(fallback)) {
    if (!Object.keys(out).some((existing) => existing.toLowerCase() === k.toLowerCase()))
      out[k] = v;
  }
  if (targetUrl) {
    try {
      const host = new URL(targetUrl).host;
      if (host && !Object.keys(out).some((k) => k.toLowerCase() === 'host')) out.Host = host;
    } catch {
      /* malformed URL — skip Host */
    }
  }
  return out;
}

export function useHttpRequestPage() {
  const httpRequest = useActiveRequest('http');
  const updateRequest = useRequestStore((s) => s.updateRequest);
  const setLoading = useRequestStore((s) => s.setLoading);
  const setCurrentResponse = useRequestStore((s) => s.setCurrentResponse);
  const isLoading = useRequestStore((s) => s.isLoading);
  const setScriptResult = useRequestStore((s) => s.setScriptResult);
  const { addHistoryItem } = useHistoryStore();
  const { resolveVariables } = useEnvironmentStore();
  const { settings: globalSettings } = useSettingsStore();
  const { addEntry } = useConsoleStore();

  const {
    handleAdd: addParam,
    handleUpdate: updateParam,
    handleDelete: removeParam,
  } = useKeyValueCollection(httpRequest?.params ?? [], (params) => updateRequest({ params }));

  const {
    handleAdd: addHeader,
    handleUpdate: updateHeader,
    handleDelete: removeHeader,
  } = useKeyValueCollection(httpRequest?.headers ?? [], (headers) => updateRequest({ headers }));

  const getEffectiveSettings = useCallback(
    (): RequestSettings => resolveEffectiveSettings(httpRequest?.settings, globalSettings),
    [httpRequest?.settings, globalSettings]
  );

  const sendRequest = useCallback(async () => {
    if (!httpRequest || !httpRequest.url || isLoading) return;

    setLoading(true);
    const startTime = Date.now();
    toast.loading('Sending request...', { id: 'request' });
    // Hoisted out of the try block, seeded with the raw URL, so the catch
    // handler can log a resolved URL even if resolution itself throws before
    // reassigning it below.
    let resolvedUrl: string = httpRequest.url;

    try {
      // Active environment + workspace globals + collection vars (precedence
      // globals < env < collection). Pre-request-script mutations layer on top below.
      const envVars: Record<string, string> = buildActiveRequestValueMap();

      // Resolve the owning collection (if this request is saved in one) so
      // scripts get a real `pm.collectionVariables` namespace + `pm.info`,
      // and `pm.sendRequest` / `pm.cookies` / `pm.vault` / `rs.judge` are
      // wired the same way the collection runner wires them — this is the
      // single most common way a user triggers a script (the "Send"
      // button), so it must not silently reject those calls.
      const savedRequestId = useRequestStore.getState().getActiveTab()?.savedRequestId;
      const collection = savedRequestId
        ? useCollectionStore.getState().getCollectionByItemId(savedRequestId)
        : undefined;
      const collectionVars = buildValueMap({ collection: collection?.variables });
      const collectionVarsMutations: Record<string, string | null> = {};
      const applyCollectionMutations = (mutations?: Record<string, string | null>) => {
        if (!mutations) return;
        Object.assign(collectionVarsMutations, mutations);
      };
      const scriptInfo = { requestName: httpRequest.name, requestId: httpRequest.id };
      const judgeCfg = useSettingsStore.getState().settings.judge;

      let preRequestResult;
      if (httpRequest.preRequestScript) {
        const globalVars = useGlobalsStore.getState().vars;
        const inheritedHeadersPre = httpRequest.headers
          .filter((h) => h.enabled)
          .reduce((acc, h) => ({ ...acc, [h.key]: h.value }), {} as Record<string, string>);
        const executor = new ScriptExecutor({
          envVars,
          globalVars,
          collectionVars: { ...collectionVars },
          info: { ...scriptInfo, eventName: 'prerequest' },
          host: {
            sendRequest: makeRendererSendRequest({
              variables: envVars,
              inheritedHeaders: inheritedHeadersPre,
            }),
            cookies: (currentUrl) => makeCookieAdapter(currentUrl),
            vault: makeVaultAdapter(),
          },
        });
        preRequestResult = await executor.executeScript(httpRequest.preRequestScript, {
          request: {
            url: httpRequest.url,
            method: httpRequest.method,
            headers: httpRequest.headers
              .filter((h) => h.enabled)
              .reduce((acc, h) => ({ ...acc, [h.key]: h.value }), {}),
            body: httpRequest.body.raw,
          },
        });
        if (preRequestResult.success && preRequestResult.variables) {
          Object.entries(preRequestResult.variables).forEach(([key, value]) => {
            envVars[key] = value;
          });
        }
        if (preRequestResult.globalsMutations) {
          useGlobalsStore.getState().applyMutations(preRequestResult.globalsMutations);
        }
        applyCollectionMutations(preRequestResult.collectionMutations);
        setScriptResult({ preRequest: preRequestResult });
      }

      // Substitute the local envVars map (active environment + any pre-request
      // script mutations) FIRST, then the env-store resolver — mirroring the
      // shared executor's `resolveLocal`. Without the envVars pass, variables a
      // pre-request script set (e.g. pm.environment.set) never reach the wire,
      // because the store resolver doesn't see them.
      const resolveLocal = (text: string): string => {
        let result = text;
        Object.entries(envVars).forEach(([key, value]) => {
          // escapeRegExp: a key with regex metachars would otherwise crash the
          // RegExp ctor; () => value: a value with $ patterns is taken literally.
          result = result.replace(new RegExp(`{{${escapeRegExp(key)}}}`, 'g'), () => value);
        });
        return resolveVariables(result);
      };

      resolvedUrl = resolveLocal(httpRequest.url);
      let params: Record<string, string> = {};
      httpRequest.params
        .filter((p) => p.enabled && p.key)
        .forEach((p) => {
          params[p.key] = resolveLocal(p.value);
        });
      let headers: Record<string, string> = {};
      httpRequest.headers
        .filter((h) => h.enabled && h.key)
        .forEach((h) => {
          headers[h.key] = resolveLocal(h.value);
        });

      // Folder/collection auth inheritance: a request with no auth of its own
      // picks up the nearest configured ancestor auth — same rule the
      // collection runner applies. Resolved at send time, never persisted.
      const inherited = resolveInheritedAuthFor(httpRequest);
      const effectiveAuth = resolveEffectiveAuth(httpRequest.auth, inherited?.auth);

      // Apply header-based auth (basic/bearer/api-key) into `headers`.
      // Sign-at-wire types (AWS SigV4 / OAuth1 / WSSE) are intentionally left
      // for the main-process signer and instead forwarded via `auth` below.
      // SecretRef handle: renderer cannot resolve; Electron HTTP handler
      // applies main-side, web fails fast.
      const applied = await applyAuthHeaders(
        effectiveAuth,
        headers,
        resolvedUrl,
        httpRequest.method,
        httpRequest.body.type !== 'none' ? httpRequest.body.raw : undefined
      );
      headers = applied.headers;
      params = applyApiKeyQueryParam(effectiveAuth, params);

      const effectiveSettings = getEffectiveSettings();
      let proxyConfig: AxiosProxyConfig | false = false;
      if (effectiveSettings.proxy?.enabled) {
        proxyConfig = {
          host: effectiveSettings.proxy.host,
          port: effectiveSettings.proxy.port,
          protocol: effectiveSettings.proxy.type,
          ...(effectiveSettings.proxy.auth && {
            auth: {
              username: effectiveSettings.proxy.auth.username,
              // Web axios path: inline secrets resolve to plaintext; a handle
              // (desktop-only) resolves to the masked placeholder, which never
              // matters here because handles aren't usable on the web build.
              password: unwrapSecret(effectiveSettings.proxy.auth.password),
            },
          }),
        };
      }

      // Desktop sends via IPC → main-process undici (CSP forbids renderer-
      // direct connections in the packaged app; the IPC path also applies
      // desktop transport config and resolves SecretRef auth main-side).
      // Web keeps the renderer axios path.
      let response: {
        status: number;
        statusText: string;
        headers: Record<string, string | string[]>;
        data: unknown;
        config?: { headers?: unknown; url?: string };
      };
      if (isElectron()) {
        const desktop = buildDesktopTransportConfig(effectiveSettings, globalSettings, resolvedUrl);
        // Build the body the same way the shared executor does (collection /
        // workflow / load-test paths). The interactive path used to hard-code
        // bodyType:'raw' + body.raw, which silently dropped form-data /
        // form-urlencoded fields and sent binary as base64 text. Reuse
        // mapBodyType + buildFormFields so this path can never diverge again.
        const proxyBodyType = mapBodyType(httpRequest.body.type);
        const formFields =
          proxyBodyType === 'form-data' ? buildFormFields(httpRequest.body.formData) : [];

        // Per-request redirect policy — only emit when a knob is set so the
        // default-behaviour path stays a no-op on the wire (mirrors executor).
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
        // followRedirects:false → maxRedirects:0 so the Electron handler returns
        // the 3xx unfollowed (mirrors the web axios `maxRedirects: 0` branch).
        // `=== false`, not `!followRedirects`: undefined (partial/imported
        // settings) must fall through to default-follow, not be read as "off".
        if (effectiveSettings.followRedirects === false) {
          redirectPolicy.maxRedirects = 0;
        } else if (effectiveSettings.maxRedirects !== undefined) {
          redirectPolicy.maxRedirects = effectiveSettings.maxRedirects;
        }

        response = await executeProxiedRequest(
          {
            method: httpRequest.method,
            url: resolvedUrl,
            params,
            headers,
            bodyType: proxyBodyType,
            ...(proxyBodyType !== 'none' &&
            proxyBodyType !== 'form-data' &&
            httpRequest.body.raw !== undefined
              ? { data: httpRequest.body.raw }
              : {}),
            ...(formFields.length > 0 ? { formData: formFields } : {}),
            ...(effectiveSettings.timeout !== undefined
              ? { timeout: effectiveSettings.timeout }
              : {}),
            // Sign-at-wire auth (AWS SigV4 / OAuth1 / WSSE) is NOT in `headers`
            // above — applyAuthHeaders leaves it for the main-process signer.
            // Forward the descriptor so the Electron handler can sign at the wire.
            ...(effectiveAuth && effectiveAuth.type !== 'none' ? { auth: effectiveAuth } : {}),
            ...(Object.keys(redirectPolicy).length > 0 ? { redirectPolicy } : {}),
            ...(effectiveSettings.encodeUrlAutomatically !== undefined
              ? { encodeUrl: effectiveSettings.encodeUrlAutomatically }
              : {}),
          },
          {},
          desktop
        );
      } else {
        // Web path: a direct browser request (no Worker proxy here), so only the
        // header-based auth already applied above travels. Sign-at-wire auth
        // (SigV4/OAuth1/WSSE) requires the proxy signer and is therefore NOT
        // applied on this path — routing the web interactive send through the
        // Worker (executeProxiedRequest) is a separate, pre-existing follow-up.
        response = await axios({
          method: httpRequest.method,
          url: resolvedUrl,
          params,
          headers,
          data: httpRequest.body.type !== 'none' ? httpRequest.body.raw : undefined,
          timeout: effectiveSettings.timeout,
          maxRedirects: effectiveSettings.followRedirects ? effectiveSettings.maxRedirects : 0,
          proxy: proxyConfig,
          validateStatus: () => true,
        });
      }

      const endTime = Date.now();
      const bodyContent =
        typeof response.data === 'string' ? response.data : JSON.stringify(response.data, null, 2);
      const responseData = {
        id: uuidv4(),
        requestId: httpRequest.id,
        status: response.status,
        statusText: response.statusText,
        headers: response.headers as Record<string, string | string[]>,
        body: bodyContent,
        size: new Blob([bodyContent]).size,
        time: endTime - startTime,
        timestamp: Date.now(),
      };

      let testResult;
      if (httpRequest.testScript) {
        const globalVars = useGlobalsStore.getState().vars;
        const executor = new ScriptExecutor({
          envVars,
          globalVars,
          collectionVars: { ...collectionVars },
          info: { ...scriptInfo, eventName: 'test' },
          host: {
            sendRequest: makeRendererSendRequest({
              variables: envVars,
              inheritedHeaders: headers,
            }),
            cookies: (currentUrl) => makeCookieAdapter(currentUrl),
            vault: makeVaultAdapter(),
            ...(judgeCfg?.enabled ? { judge: makeRendererJudge(judgeCfg) } : {}),
          },
        });
        testResult = await executor.executeScript(httpRequest.testScript, {
          request: {
            url: httpRequest.url,
            method: httpRequest.method,
            headers: httpRequest.headers
              .filter((h) => h.enabled)
              .reduce((acc, h) => ({ ...acc, [h.key]: h.value }), {}),
            body: httpRequest.body.raw,
          },
          response: {
            status: response.status,
            statusText: response.statusText,
            headers: Object.fromEntries(
              Object.entries(response.headers).map(([key, value]) => [
                key,
                Array.isArray(value) ? value.join(', ') : value,
              ])
            ),
            body: response.data,
            time: endTime - startTime,
            size: responseData.size,
          },
        });
        if (testResult.globalsMutations) {
          useGlobalsStore.getState().applyMutations(testResult.globalsMutations);
        }
        applyCollectionMutations(testResult.collectionMutations);
        setScriptResult({
          ...(preRequestResult !== undefined && { preRequest: preRequestResult }),
          ...(testResult !== undefined && { test: testResult }),
        });
      }

      if (collection && Object.keys(collectionVarsMutations).length > 0) {
        useCollectionStore
          .getState()
          .applyCollectionVarMutations(collection.id, collectionVarsMutations);
      }

      setCurrentResponse(responseData);
      // `httpRequest.url` (kept as-is) preserves the `{{var}}` template so
      // reopening/replaying this entry still targets whichever environment is
      // active; `resolvedUrl` is recorded alongside for accurate history/
      // console display (see HistoryItem.resolvedUrl / ConsoleEntry.resolvedUrl).
      addHistoryItem(httpRequest, responseData, resolvedUrl);
      const scriptLogs = [...(preRequestResult?.logs || []), ...(testResult?.logs || [])];
      const sentHeaders = captureSentHeaders(
        response.config?.headers,
        headers,
        response.config?.url ?? resolvedUrl
      );
      addEntry(
        createConsoleEntry(
          httpRequest,
          responseData,
          sentHeaders,
          scriptLogs,
          testResult?.tests,
          'http',
          { resolvedUrl }
        )
      );
      // The response panel already shows the outcome — just clear the
      // in-flight toast rather than stacking a redundant success one.
      toast.dismiss('request');
    } catch (error: unknown) {
      const endTime = Date.now();
      const axiosError = isAxiosError(error) ? error : null;
      const errorMessage = error instanceof Error ? error.message : 'Request failed';
      const errorBody = axiosError?.response?.data
        ? JSON.stringify(axiosError.response.data, null, 2)
        : errorMessage;
      const errorResponse = {
        id: uuidv4(),
        requestId: httpRequest.id,
        status: axiosError?.response?.status || 0,
        statusText: axiosError?.response?.statusText || 'Error',
        headers: (axiosError?.response?.headers ?? {}) as Record<string, string | string[]>,
        body: errorBody,
        size: new Blob([errorBody]).size,
        time: endTime - startTime,
        timestamp: Date.now(),
      };
      setCurrentResponse(errorResponse);
      // Same as the success path: log the resolved URL alongside the
      // template-preserving `httpRequest`, not in place of it.
      addHistoryItem(httpRequest, errorResponse, resolvedUrl);
      const sentHeaders = captureSentHeaders(
        axiosError?.config?.headers,
        {},
        axiosError?.config?.url ?? resolvedUrl
      );
      addEntry(
        createConsoleEntry(httpRequest, errorResponse, sentHeaders, [], undefined, 'http', {
          resolvedUrl,
        })
      );
      toast.error(`Request failed: ${errorMessage}`, { id: 'request', duration: 5000 });
    } finally {
      setLoading(false);
    }
  }, [
    httpRequest,
    isLoading,
    setLoading,
    resolveVariables,
    setScriptResult,
    setCurrentResponse,
    addHistoryItem,
    getEffectiveSettings,
    globalSettings,
    addEntry,
  ]);

  const changeSettings = useCallback(
    (updates: Partial<RequestSettings>) => {
      const current = httpRequest?.settings || getEffectiveSettings();
      updateRequest({ settings: { ...current, ...updates } });
    },
    [httpRequest?.settings, getEffectiveSettings, updateRequest]
  );

  const toggleSettingsOverride = useCallback(
    (enabled: boolean) => {
      if (enabled) {
        changeSettings({});
      } else {
        // EOPT(maintainability): updateRequest treats `undefined` as a clear
        // signal — Partial<T> can't model that under EOPT, so cast through to
        // preserve the existing contract. TODO: replace with an explicit reset
        // action on the store.
        updateRequest({ settings: undefined } as Parameters<typeof updateRequest>[0]);
      }
    },
    [changeSettings, updateRequest]
  );

  const changeProxyOverride = useCallback(
    (useOverride: boolean) => {
      if (useOverride) {
        changeSettings({ proxy: { ...globalSettings.proxy } });
      } else {
        const current = httpRequest?.settings;
        if (current) {
          const { proxy: _omit, ...rest } = current;
          void _omit;
          // EOPT(maintainability): omit the `proxy` key entirely instead of
          // setting it to undefined.
          updateRequest({ settings: rest });
        }
      }
    },
    [changeSettings, globalSettings.proxy, httpRequest?.settings, updateRequest]
  );

  const counts = {
    activeParams: httpRequest?.params.filter((p) => p.enabled && p.key).length ?? 0,
    activeHeaders: httpRequest?.headers.filter((h) => h.enabled && h.key).length ?? 0,
  };

  const handlers = {
    sendRequest,
    changeMethod: (method: HttpMethod) => updateRequest({ method }),
    changeUrl: (url: string) => updateRequest({ url }),
    changeAuth: (auth: AuthConfig) => updateRequest({ auth }),
    changeBodyType: (type: RequestBody['type']) => {
      if (!httpRequest) return;
      // `raw` is reused for binary base64; reset it crossing the binary boundary
      // so base64 never renders in the text editor and text is never base64-decoded.
      const crossesBinary = type === 'binary' || httpRequest.body.type === 'binary';
      updateRequest({
        body: { ...httpRequest.body, type, ...(crossesBinary ? { raw: '' } : {}) },
      });
    },
    changeBodyContent: (raw: string) => {
      if (!httpRequest) return;
      updateRequest({ body: { ...httpRequest.body, raw } });
    },
    changeFormData: (formData: FormDataItem[]) => {
      if (!httpRequest) return;
      updateRequest({ body: { ...httpRequest.body, formData } });
    },
    changePreRequestScript: (script: string) => updateRequest({ preRequestScript: script }),
    changeTestScript: (script: string) => updateRequest({ testScript: script }),
    addParam,
    updateParam,
    removeParam,
    addHeader,
    updateHeader,
    removeHeader,
    changeSettings,
    toggleSettingsOverride,
    changeProxyOverride,
  };

  return { httpRequest, isLoading, globalSettings, handlers, counts };
}
