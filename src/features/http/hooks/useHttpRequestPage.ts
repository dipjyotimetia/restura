import { useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { v4 as uuidv4 } from 'uuid';
import { useRequestAnnouncements } from '@/components/shared/AriaLiveAnnouncer';
import { resolveEffectiveAuth } from '@/features/auth/lib/authInheritance';
import { resolveInheritedAuthFor } from '@/features/auth/lib/resolveInheritedAuthFor';
import { parseCurlCommand } from '@/features/collections/lib/importers/curl';
import {
  saveScriptEnvironmentWrites,
  scriptEnvironmentTargetId,
} from '@/features/environments/lib/scriptEnvironmentMutations';
import { pathVariablesPatch } from '@/features/http/lib/pathVariableRows';
import {
  executeRequest,
  executeStreamingRequest,
  isStreamingAccept,
  type RequestExecutionResult,
  resolveEffectiveSettings,
} from '@/features/http/lib/requestExecutor';
import { applySettingsPatch, type RequestSettingsPatch } from '@/features/http/lib/settingsPatch';
import type { HttpStreamEvent } from '@/features/http/lib/streamingResponseReader';
import { applyUrlInput } from '@/features/http/lib/urlQuery';
import { useActiveStreamStore } from '@/features/http/store/useActiveStreamStore';
import { useKeyValueCollection } from '@/hooks/useKeyValueCollection';
import { buildActiveRequestVariableResolution } from '@/lib/shared/activeRequestScopes';
import { isElectron } from '@/lib/shared/platform';
import { replayableAsyncIterable } from '@/lib/shared/replayableAsyncIterable';
import { type RequestScope, resolveRequestScopeText } from '@/lib/shared/resolveRequestScope';
import { urlEncodedRaw } from '@/lib/shared/urlEncodedBody';
import { buildValueMap } from '@/lib/shared/variableScopes';
import { useActiveRequest } from '@/store/selectors';
import { useCollectionStore } from '@/store/useCollectionStore';
import { createConsoleEntry, useConsoleStore } from '@/store/useConsoleStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useHistoryStore } from '@/store/useHistoryStore';
import { useRequestStore } from '@/store/useRequestStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useUiStore } from '@/store/useUiStore';
import type {
  Response as ApiResponse,
  AppSettings,
  AuthConfig,
  FormDataItem,
  HttpMethod,
  HttpRequest,
  KeyValue,
  RequestBody,
  RequestSettings,
} from '@/types';

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

/**
 * The required request-settings fields, taken from the global defaults. Used
 * when a request with no override of its own gains one (e.g. from a pasted
 * cURL flag), without freezing global-only fields like the proxy into it.
 */
function coreSettings(globalSettings: AppSettings): RequestSettings {
  const { timeout, followRedirects, maxRedirects, verifySsl } = resolveEffectiveSettings(
    undefined,
    globalSettings
  );
  return { timeout, followRedirects, maxRedirects, verifySsl };
}

/**
 * True when the request, as it will be sent, asks for an SSE / NDJSON / JSON
 * Lines stream: its enabled Accept row resolved in the send scope (so
 * `Accept: {{accept}}` counts). A value that can't be resolved here is left to
 * the executor, which refuses it with the real reason.
 */
function wantsStream(request: HttpRequest, scope: RequestScope): boolean {
  const headers: Record<string, string> = {};
  for (const h of request.headers) {
    if (!h.enabled || h.key.trim().toLowerCase() !== 'accept') continue;
    try {
      headers.Accept = resolveRequestScopeText(h.value, scope);
    } catch {
      return false;
    }
  }
  return isStreamingAccept(headers);
}

// The response panel's error card (role="alert") already reports a failure
// for the visible tab, so only toast when the user has moved to another tab.
function reportFailure(originTabId: string, message: string) {
  if (useRequestStore.getState().activeTabId === originTabId) toast.dismiss('request');
  else toast.error(`Request failed: ${message}`, { id: 'request', duration: 5000 });
}

const isStreamTerminal = (event: HttpStreamEvent) => event.type === 'end' || event.type === 'error';

type ScriptOutcome = Pick<
  RequestExecutionResult,
  'scriptResult' | 'collectionVarsMutations' | 'environmentMutations'
>;

/**
 * A finished send's script output (Tests / Visualize tabs) and its
 * `pm.collectionVariables` / `pm.environment` writes — buffered or streamed.
 */
function applyScriptOutcome(
  tabId: string,
  outcome: ScriptOutcome,
  target: { collectionId: string | undefined; environmentId: string | undefined }
): void {
  const { scriptResult } = outcome;
  if (scriptResult && (scriptResult.preRequest || scriptResult.test)) {
    useRequestStore.getState().setScriptResultForTab(tabId, scriptResult);
  }
  if (target.collectionId && outcome.collectionVarsMutations) {
    useCollectionStore
      .getState()
      .applyCollectionVarMutations(target.collectionId, outcome.collectionVarsMutations);
  }
  // `pm.environment.set/unset` persist to the active environment (Postman
  // semantics), so the next request sees them. Secret handles are left alone.
  if (outcome.environmentMutations) {
    saveScriptEnvironmentWrites({
      environmentId: target.environmentId,
      collectionId: target.collectionId,
      mutations: outcome.environmentMutations,
    });
  }
}

/** The history entry and Console line for a completed send. */
function recordSend(
  request: HttpRequest,
  response: ApiResponse,
  sent: Record<string, string>,
  scriptResult: RequestExecutionResult['scriptResult'],
  resolvedUrl: string
): void {
  // `request.url` (kept as-is) preserves the `{{var}}` template so
  // reopening/replaying this entry still targets whichever environment is
  // active; `resolvedUrl` is recorded alongside for accurate history/
  // console display (see HistoryItem.resolvedUrl / ConsoleEntry.resolvedUrl).
  useHistoryStore.getState().addHistoryItem(request, response, resolvedUrl);
  const scriptLogs = [
    ...(scriptResult?.preRequest?.logs || []),
    ...(scriptResult?.test?.logs || []),
  ];
  useConsoleStore
    .getState()
    .addEntry(
      createConsoleEntry(
        request,
        response,
        captureSentHeaders(sent, resolvedUrl),
        scriptLogs,
        scriptResult?.test?.tests,
        'http',
        { resolvedUrl }
      )
    );
}

export function useHttpRequestPage() {
  const httpRequest = useActiveRequest('http');
  const updateRequest = useRequestStore((s) => s.updateRequest);
  const updateRequestForTab = useRequestStore((s) => s.updateRequestForTab);
  const setLoading = useRequestStore((s) => s.setLoading);
  const setCurrentResponseForTab = useRequestStore((s) => s.setCurrentResponseForTab);
  const isLoading = useRequestStore((s) => s.isLoading);
  const setScriptResultForTab = useRequestStore((s) => s.setScriptResultForTab);
  const setStreamingEventsForTab = useRequestStore((s) => s.setStreamingEventsForTab);
  const clearStreamingEventsForTab = useRequestStore((s) => s.clearStreamingEventsForTab);
  const addHistoryItem = useHistoryStore((s) => s.addHistoryItem);
  const resolveVariables = useEnvironmentStore((s) => s.resolveVariables);
  const globalSettings = useSettingsStore((s) => s.settings);
  const addEntry = useConsoleStore((s) => s.addEntry);

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

  // Failures and cancellation already reach screen readers through their toasts
  // (sonner's live region); a real response only shows visually, so announce it.
  const { announceRequestComplete } = useRequestAnnouncements();

  // Aborts the in-flight send; the executor honours the signal end to end.
  const abortRef = useRef<AbortController | null>(null);
  // Cancels the send in flight, or else the active tab's running stream.
  const cancelRequest = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      return;
    }
    const tabId = useRequestStore.getState().activeTabId;
    if (tabId) useActiveStreamStore.getState().stop(tabId);
  }, []);

  // The interactive Send delegates to the shared `executeRequest` — the same
  // pipeline the collection runner / workflows / load-testing use. This is
  // deliberate convergence: the page used to build its own spec (and on web,
  // send direct browser axios), which silently dropped sign-at-wire auth,
  // form-data/binary bodies, the cookie jar, OAuth2 refresh, redirect policy,
  // and renderer URL validation. Everything protocol-shaped now lives in the
  // executor; this hook owns only page concerns (toasts, response panel,
  // history, console, persisting refreshed auth / collection var mutations).
  const sendRequest = useCallback(async () => {
    if (!httpRequest?.url || isLoading) return;
    const originTabId = useRequestStore.getState().activeTabId;
    if (!originTabId) return;
    // A new send replaces this tab's response, so end a stream still running.
    useActiveStreamStore.getState().stop(originTabId);

    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    useUiStore
      .getState()
      .setInFlight({ tabId: originTabId, startedAt: Date.now(), cancel: () => controller.abort() });
    // Give the page's shared loading state back (once). A streamed send does
    // this as soon as its stream starts, so a long-lived stream never blocks
    // sending from other tabs; it is then stopped from its panel instead.
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (abortRef.current === controller) abortRef.current = null;
      setLoading(false);
      useUiStore.getState().setInFlight(null);
    };
    // Drop the previous run's script output so the Tests/Visualize tabs never
    // show stale results next to a send that ran no scripts or failed.
    setScriptResultForTab(originTabId, null);
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
      const {
        values: envVars,
        secretVariables,
        sendSecretNames,
      } = buildActiveRequestVariableResolution();

      // Resolve the owning collection (if this request is saved in one) so
      // scripts get a real `pm.collectionVariables` namespace + `pm.info`,
      // and mutations can be persisted back after the run.
      const savedRequestId = useRequestStore
        .getState()
        .tabs.find((tab) => tab.id === originTabId)?.savedRequestId;
      const collection = savedRequestId
        ? useCollectionStore.getState().getCollectionByItemId(savedRequestId)
        : undefined;
      // Captured at send time: a mid-request environment switch must not
      // redirect this request's script writes to the newly active one.
      const scriptEnvironmentId = scriptEnvironmentTargetId(collection?.id);
      const collectionVars = buildValueMap({ collection: collection?.variables });

      // Folder/collection auth inheritance: a request with no auth of its own
      // picks up the nearest configured ancestor auth — same rule the
      // collection runner applies. Resolved at send time, never persisted.
      const inherited = resolveInheritedAuthFor(httpRequest);
      const effectiveAuth = resolveEffectiveAuth(httpRequest.auth, inherited?.auth);
      const requestForExec =
        effectiveAuth === httpRequest.auth ? httpRequest : { ...httpRequest, auth: effectiveAuth };

      const scriptTarget = { collectionId: collection?.id, environmentId: scriptEnvironmentId };

      // Web: an SSE / NDJSON / JSON Lines Accept streams into the response
      // panel (the proxy answers it with a raw pass-through). Desktop's HTTP
      // IPC has no streaming channel, so it stays on the buffered path. The
      // stream path runs the same scripts as a buffered send: the pre-request
      // script before anything is sent, the test script (and the history
      // entry) once the stream ends, against the captured stream text. Once
      // the stream starts the send stops blocking other sends; the panel's
      // Stop button (or a new send / closing the tab) ends it with no tests run.
      const scope: RequestScope = {
        values: envVars,
        secretVariables,
        secretNames: sendSecretNames,
        resolveVariables: (text) => resolveVariables(text),
      };
      if (!isElectron() && wantsStream(requestForExec, scope)) {
        const streaming = await executeStreamingRequest({
          request: requestForExec,
          envVars,
          secretVariables,
          secretNames: sendSecretNames,
          globalSettings,
          resolveVariables: (text) => resolveVariables(text),
          collectionVars,
          signal: controller.signal,
        });
        resolvedUrl = streaming.sentUrl;
        if (streaming.skipped) {
          // `pm.execution.skipRequest()`: nothing was sent, so no stream and
          // no history entry; the pre-request output and writes still count.
          clearStreamingEventsForTab(originTabId);
          applyScriptOutcome(originTabId, await streaming.finish(undefined), scriptTarget);
          toast.info('Request skipped by the pre-request script', {
            id: 'request',
            duration: 3000,
          });
          return;
        }
        // Replaces any buffered response so the panel shows the stream. The
        // response stream is single-use; buffer it so a viewer that remounts
        // (StrictMode, switching tabs and back) replays it from the start —
        // and so this send can read it to the end alongside the viewer.
        const replay = replayableAsyncIterable(streaming.events, { isTerminal: isStreamTerminal });
        setStreamingEventsForTab(originTabId, replay);
        if (streaming.scriptResult?.preRequest) {
          setScriptResultForTab(originTabId, streaming.scriptResult);
        }
        toast.dismiss('request');
        announceRequestComplete(streaming.responseMeta.status, Date.now() - startTime);

        const stopStream = () => controller.abort();
        useActiveStreamStore.getState().start(originTabId, stopStream);
        release();
        let terminal: HttpStreamEvent | undefined;
        try {
          for await (const event of replay) {
            if (isStreamTerminal(event)) terminal = event;
          }
        } finally {
          useActiveStreamStore.getState().end(originTabId, stopStream);
        }
        // Stopped mid-stream: like a buffered cancel, no tests or history.
        controller.signal.throwIfAborted();
        const done = await streaming.finish(terminal);
        if (streaming.refreshedAuth && httpRequest.auth?.type === 'oauth2') {
          updateRequestForTab(originTabId, { auth: streaming.refreshedAuth });
        }
        applyScriptOutcome(originTabId, done, scriptTarget);
        recordSend(httpRequest, done.response, done.sentHeaders, done.scriptResult, resolvedUrl);
        return;
      }
      // A buffered send replaces a previous run's stream.
      clearStreamingEventsForTab(originTabId);

      const result = await executeRequest({
        request: requestForExec,
        envVars,
        secretVariables,
        secretNames: sendSecretNames,
        globalSettings,
        resolveVariables: (text) => resolveVariables(text),
        collectionVars,
        signal: controller.signal,
        honorSkipRequest: true,
      });

      // History, console and HAR record what the executor sent.
      resolvedUrl = result.sentUrl;

      const { scriptResult } = result;
      applyScriptOutcome(originTabId, result, scriptTarget);

      if (scriptResult?.preRequest?.execution?.skipRequested) {
        // `pm.execution.skipRequest()`: nothing was sent, so no response and
        // no history entry (as a streamed send); the pre-request output and
        // writes still count.
        toast.info('Request skipped by the pre-request script', { id: 'request', duration: 3000 });
        return;
      }

      // Persist a refreshed OAuth2 token — but only when the auth belongs to
      // this request; a refreshed *inherited* auth must not be materialised
      // onto the request.
      if (result.refreshedAuth && httpRequest.auth?.type === 'oauth2') {
        updateRequestForTab(originTabId, { auth: result.refreshedAuth });
      }

      const responseData = result.response;
      setCurrentResponseForTab(originTabId, responseData);
      recordSend(httpRequest, responseData, result.sentHeaders, scriptResult, resolvedUrl);
      // Transport-level failures surface as a status-0 response from the
      // executor rather than a throw. For real responses the panel already
      // shows the outcome, so just clear the in-flight toast rather than
      // stacking a redundant success one.
      if (responseData.status === 0) {
        reportFailure(originTabId, responseData.body);
      } else {
        toast.dismiss('request');
        announceRequestComplete(responseData.status, responseData.time);
      }
    } catch (error: unknown) {
      // User cancelled: not a failure, so no error response or history entry.
      if (controller.signal.aborted) {
        toast.info('Request cancelled', { id: 'request', duration: 2000 });
        return;
      }
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
      setCurrentResponseForTab(originTabId, errorResponse);
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
      reportFailure(originTabId, errorMessage);
    } finally {
      release();
    }
  }, [
    httpRequest,
    isLoading,
    setLoading,
    resolveVariables,
    setScriptResultForTab,
    setStreamingEventsForTab,
    clearStreamingEventsForTab,
    setCurrentResponseForTab,
    addHistoryItem,
    globalSettings,
    addEntry,
    announceRequestComplete,
    updateRequestForTab,
  ]);

  const changeSettings = useCallback(
    (updates: RequestSettingsPatch) => {
      const current = httpRequest?.settings || getEffectiveSettings();
      updateRequest({ settings: applySettingsPatch(current, updates) });
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
    cancelRequest,
    changeMethod: (method: HttpMethod) => updateRequest({ method }),
    replaceParams: (params: KeyValue[]) => updateRequest({ params }),
    replaceHeaders: (headers: KeyValue[]) => updateRequest({ headers }),
    // The URL bar shows url + enabled params; split edits back into both so
    // the stored url keeps no query and the params table stays in sync.
    // `:name` path segments keep the path-variable rows in step with the URL.
    changeUrl: (text: string) => {
      if (!httpRequest) return;
      const next = applyUrlInput(text, httpRequest.params, uuidv4);
      updateRequest({
        ...next,
        ...pathVariablesPatch(next.url, httpRequest.pathVariables, uuidv4),
      });
    },
    // Path-variable rows (key derived from the URL; value / description / enabled edited).
    replacePathVariables: (pathVariables: KeyValue[]) => updateRequest({ pathVariables }),
    // Paste a whole cURL command into the URL bar → fill the request. Returns
    // false when it can't be parsed so the caller lets the plain paste through.
    importCurl: (command: string): boolean => {
      if (!httpRequest) return false;
      let imported: HttpRequest | undefined;
      let explicitSettings: Partial<RequestSettings> = {};
      try {
        const parsed = parseCurlCommand(command);
        const item = parsed.result.collection.items[0];
        if (item?.request?.type === 'http') imported = item.request;
        explicitSettings = parsed.explicitSettings;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Could not parse cURL command');
        return false;
      }
      if (!imported) return false;
      const { method, url, headers, params, pathVariables, body, auth, settings } = httpRequest;
      const previous = {
        method,
        url,
        headers,
        params,
        ...(pathVariables !== undefined && { pathVariables }),
        body,
        auth,
        settings,
      };
      const applied = updateRequest({
        method: imported.method,
        url: imported.url,
        ...pathVariablesPatch(imported.url, pathVariables, uuidv4),
        headers: imported.headers,
        params: imported.params,
        body: imported.body,
        auth: imported.auth,
        // Keep the request's own settings; apply only what the command's
        // flags set (-L, --max-time, -k, …), never the importer's defaults.
        ...(Object.keys(explicitSettings).length > 0 && {
          settings: { ...(settings ?? coreSettings(globalSettings)), ...explicitSettings },
        }),
      });
      if (!applied) {
        toast.error('Could not apply the cURL command to this request');
        return false;
      }
      toast.success('Imported cURL command', {
        action: { label: 'Undo', onClick: () => updateRequest(previous) },
      });
      return true;
    },
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
    // GraphQL body: the variables JSON the executor sends in the envelope.
    changeGraphQLVariables: (graphqlVariables: string) => {
      if (!httpRequest) return;
      updateRequest({ body: { ...httpRequest.body, graphqlVariables } });
    },
    // urlencoded fields are the source of truth; keep `raw` in sync for the
    // text view and older consumers.
    changeUrlEncoded: (formData: FormDataItem[]) => {
      if (!httpRequest) return;
      updateRequest({ body: { ...httpRequest.body, formData, raw: urlEncodedRaw(formData) } });
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
