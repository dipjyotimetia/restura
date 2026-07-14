import { useCallback } from 'react';
import { toast } from 'sonner';
import { v4 as uuidv4 } from 'uuid';
import { resolveEffectiveAuth } from '@/features/auth/lib/authInheritance';
import { resolveInheritedAuthFor } from '@/features/auth/lib/resolveInheritedAuthFor';
import { executeRequest, resolveEffectiveSettings } from '@/features/http/lib/requestExecutor';
import { useKeyValueCollection } from '@/hooks/useKeyValueCollection';
import { buildActiveRequestValueMap } from '@/lib/shared/activeRequestScopes';
import { escapeRegExp } from '@/lib/shared/escapeRegExp';
import { buildValueMap } from '@/lib/shared/variableScopes';
import { useActiveRequest } from '@/store/selectors';
import { useCollectionStore } from '@/store/useCollectionStore';
import { createConsoleEntry, useConsoleStore } from '@/store/useConsoleStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useHistoryStore } from '@/store/useHistoryStore';
import { useRequestStore } from '@/store/useRequestStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import type { AuthConfig, FormDataItem, HttpMethod, RequestBody, RequestSettings } from '@/types';

/**
 * Capture the headers the request actually went out with for the Console:
 * the resolved sent-header map from the shared executor (user + auth +
 * cookie merge) plus a synthesised deterministic `Host` from the target URL.
 * These are the headers the *client* sent — a proxied upstream may add its
 * own — but it's far more useful than the bare user-defined set.
 */
function captureSentHeaders(
  sent: Record<string, string>,
  targetUrl: string | undefined
): Record<string, string> {
  const out: Record<string, string> = { ...sent };
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

  // The interactive Send delegates to the shared `executeRequest` — the same
  // pipeline the collection runner / workflows / load-testing use. This is
  // deliberate convergence: the page used to build its own spec (and on web,
  // send direct browser axios), which silently dropped sign-at-wire auth,
  // form-data/binary bodies, the cookie jar, OAuth2 refresh, redirect policy,
  // and renderer URL validation. Everything protocol-shaped now lives in the
  // executor; this hook owns only page concerns (toasts, response panel,
  // history, console, persisting refreshed auth / collection var mutations).
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
      // globals < env < collection). The executor layers pre-request-script
      // mutations on top and mutates this map in place.
      const envVars: Record<string, string> = buildActiveRequestValueMap();

      // Resolve the owning collection (if this request is saved in one) so
      // scripts get a real `pm.collectionVariables` namespace + `pm.info`,
      // and mutations can be persisted back after the run.
      const savedRequestId = useRequestStore.getState().getActiveTab()?.savedRequestId;
      const collection = savedRequestId
        ? useCollectionStore.getState().getCollectionByItemId(savedRequestId)
        : undefined;
      const collectionVars = buildValueMap({ collection: collection?.variables });

      // Folder/collection auth inheritance: a request with no auth of its own
      // picks up the nearest configured ancestor auth — same rule the
      // collection runner applies. Resolved at send time, never persisted.
      const inherited = resolveInheritedAuthFor(httpRequest);
      const effectiveAuth = resolveEffectiveAuth(httpRequest.auth, inherited?.auth);
      const requestForExec =
        effectiveAuth === httpRequest.auth ? httpRequest : { ...httpRequest, auth: effectiveAuth };

      const result = await executeRequest({
        request: requestForExec,
        envVars,
        globalSettings,
        resolveVariables: (text) => resolveVariables(text),
        collectionVars,
      });

      // Recompute the resolved URL for history/console display with the
      // post-script variable map (executeRequest mutates `envVars` in place) —
      // mirrors the executor's own resolveLocal.
      const resolveLocal = (text: string): string => {
        let out = text;
        Object.entries(envVars).forEach(([key, value]) => {
          // escapeRegExp: a key with regex metachars would otherwise crash the
          // RegExp ctor; () => value: a value with $ patterns is taken literally.
          out = out.replace(new RegExp(`{{${escapeRegExp(key)}}}`, 'g'), () => value);
        });
        return resolveVariables(out);
      };
      resolvedUrl = resolveLocal(httpRequest.url);

      const { scriptResult } = result;
      if (scriptResult && (scriptResult.preRequest || scriptResult.test)) {
        setScriptResult(scriptResult);
      }

      if (collection && result.collectionVarsMutations) {
        useCollectionStore
          .getState()
          .applyCollectionVarMutations(collection.id, result.collectionVarsMutations);
      }

      // Persist a refreshed OAuth2 token — but only when the auth belongs to
      // this request; a refreshed *inherited* auth must not be materialised
      // onto the request.
      if (result.refreshedAuth && httpRequest.auth?.type === 'oauth2') {
        updateRequest({ auth: result.refreshedAuth });
      }

      const responseData = result.response;
      setCurrentResponse(responseData);
      // `httpRequest.url` (kept as-is) preserves the `{{var}}` template so
      // reopening/replaying this entry still targets whichever environment is
      // active; `resolvedUrl` is recorded alongside for accurate history/
      // console display (see HistoryItem.resolvedUrl / ConsoleEntry.resolvedUrl).
      addHistoryItem(httpRequest, responseData, resolvedUrl);
      const scriptLogs = [
        ...(scriptResult?.preRequest?.logs || []),
        ...(scriptResult?.test?.logs || []),
      ];
      const sentHeaders = captureSentHeaders(result.sentHeaders, resolvedUrl);
      addEntry(
        createConsoleEntry(
          httpRequest,
          responseData,
          sentHeaders,
          scriptLogs,
          scriptResult?.test?.tests,
          'http',
          { resolvedUrl }
        )
      );
      // Transport-level failures surface as a status-0 response from the
      // executor rather than a throw — report those with an error toast; for
      // real responses the panel already shows the outcome, so just clear the
      // in-flight toast rather than stacking a redundant success one.
      if (responseData.status === 0) {
        toast.error(`Request failed: ${responseData.body}`, { id: 'request', duration: 5000 });
      } else {
        toast.dismiss('request');
      }
    } catch (error: unknown) {
      // executeRequest throws before anything is sent (URL failed validation,
      // SecretRef handle unsupported on this platform, …).
      const endTime = Date.now();
      const errorMessage = error instanceof Error ? error.message : 'Request failed';
      const errorResponse = {
        id: uuidv4(),
        requestId: httpRequest.id,
        status: 0,
        statusText: 'Error',
        headers: {} as Record<string, string | string[]>,
        body: errorMessage,
        size: new Blob([errorMessage]).size,
        time: endTime - startTime,
        timestamp: Date.now(),
      };
      setCurrentResponse(errorResponse);
      // Same as the success path: log the resolved URL alongside the
      // template-preserving `httpRequest`, not in place of it.
      addHistoryItem(httpRequest, errorResponse, resolvedUrl);
      addEntry(
        createConsoleEntry(
          httpRequest,
          errorResponse,
          captureSentHeaders({}, resolvedUrl),
          [],
          undefined,
          'http',
          { resolvedUrl }
        )
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
    globalSettings,
    addEntry,
    updateRequest,
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
