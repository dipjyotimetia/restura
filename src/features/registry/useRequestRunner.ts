/**
 * useRequestRunner — protocol-agnostic request execution hook.
 *
 * Centralizes the `script -> resolve variables -> execute -> history -> test`
 * pipeline that each Builder used to re-implement. Builders look up a
 * `ProtocolModule` by id from the registry and invoke `run()` here; the hook
 * handles AbortController lifecycle, environment variable extraction,
 * history persistence, and (Task 4.4) forwarding script results from the
 * protocol to the originating tab so the Console panel renders pre-request and
 * test script logs.
 *
 * Protocols opt into the script-result side-channel by calling
 * `ctx.onScriptResult(...)` from inside their `runRequest`. The HTTP
 * executor runs both scripts inline today (see `requestExecutor.ts`), so
 * the HTTP protocol simply passes the executor's `scriptResult` through.
 * Protocols that don't have a script pipeline may omit the call entirely.
 */
import { useCallback, useRef } from 'react';
import { withEffectiveAuth } from '@/features/auth/lib/authInheritance';
import { resolveInheritedAuthForSend } from '@/features/auth/lib/resolveInheritedAuthFor';
import {
  mergeEnvironmentMutations,
  saveScriptEnvironmentWrites,
  scriptEnvironmentTargetId,
} from '@/features/environments/lib/scriptEnvironmentMutations';
import { buildActiveRequestVariableResolution } from '@/lib/shared/activeRequestScopes';
import { buildValueMap } from '@/lib/shared/variableScopes';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useHistoryStore } from '@/store/useHistoryStore';
import { useRequestStore } from '@/store/useRequestStore';
import type { AuthConfig, Request, Response } from '@/types';
import { protocolRegistry } from './registry';
import type { ProtocolScriptResult, StreamRunHooks } from './types';

export interface RegistryRunResult {
  response: Response;
  durationMs: number;
  /**
   * Pre-request and test script results produced by the protocol, if any.
   * Mirrors `useRequestStore.setScriptResult`'s payload — the runner has
   * already forwarded these to the originating tab, this field exists so
   * Builders can react to them (e.g. early-exit on test failure) without
   * subscribing to the store.
   */
  scriptResult?: ProtocolScriptResult;
}

export interface RegistryRunOptions {
  /**
   * Per-protocol options forwarded to `ProtocolModule.runRequest` via
   * `RunContext.protocolOptions`. Used by gRPC for transient proto content
   * (which doesn't live on the Request shape) and reserved for future
   * protocol extensions. Cross-protocol callers can omit it.
   */
  protocolOptions?: Record<string, unknown>;
  /**
   * Live stream hooks forwarded as `RunContext.stream` (gRPC streams). `run()`
   * still resolves once, after the stream ends, and records one history entry.
   */
  stream?: StreamRunHooks;
}

export function useRequestRunner() {
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(
    async (
      rawRequest: Request,
      protocolId: string,
      options?: RegistryRunOptions
    ): Promise<RegistryRunResult> => {
      const protocol = protocolRegistry.get(protocolId);
      if (!protocol) {
        throw new Error(`Unknown protocol: ${protocolId}`);
      }
      const originTabId = useRequestStore.getState().activeTabId;

      // Folder/collection auth inheritance for single sends. A request whose
      // own auth is 'none' picks up the nearest configured ancestor auth —
      // the same rule collection runs apply via flattenRunnables. Only this
      // runner resolves it: the collection runner and workflow executor
      // bypass run() and thread inherited auth themselves, so there is no
      // double application.
      // Refuses a Postman-guard-blocked request (#1232), like an unknown protocol.
      const inherited = resolveInheritedAuthForSend(rawRequest);
      const request = inherited ? withEffectiveAuth(rawRequest, inherited.auth) : rawRequest;

      // Cancel any prior in-flight request from this hook instance. Builders
      // that fire a second `run()` before the first resolves get the latest
      // result; the older promise rejects with AbortError.
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      // Build the variables map from every scope the active request can resolve:
      // active environment + workspace globals + the request's collection vars
      // (precedence globals < env < collection). gRPC unary substitution reads
      // this map directly, so collection/global vars must live here, not only in
      // the store resolver.
      const {
        values: variables,
        secretVariables,
        sendSecretNames,
      } = buildActiveRequestVariableResolution();

      // Capture script results emitted by the protocol so we can both push
      // them to the originating tab (so the Console panel updates) AND surface
      // them on `RegistryRunResult` for callers that want to react synchronously.
      let collectedScripts: ProtocolScriptResult | undefined;
      const onScriptResult = (result: ProtocolScriptResult) => {
        // A cancelled run reports nothing: its script output is not this send's.
        if (ctrl.signal.aborted) return;
        collectedScripts = result;
        // Push to the store immediately so Console/Tests panels render as
        // soon as scripts finish — even if the caller never inspects
        // `RegistryRunResult.scriptResult`. Mirrors the inline pipeline that
        // useHttpRequest used to drive directly.
        if (originTabId) {
          useRequestStore.getState().setScriptResultForTab(originTabId, result);
        }
      };

      // Write a refreshed OAuth2 token back only when the request owns that
      // auth; a refreshed *inherited* auth must not be materialised onto it.
      const onAuthRefreshed = (auth: AuthConfig) => {
        if (originTabId && rawRequest.type === 'http' && rawRequest.auth?.type === 'oauth2') {
          useRequestStore.getState().updateRequestForTab(originTabId, { auth });
        }
      };

      // Script env writes go to the environment this request runs against:
      // captured now, so switching environment mid-request cannot redirect them.
      const savedRequestId = originTabId
        ? useRequestStore.getState().tabs.find((tab) => tab.id === originTabId)?.savedRequestId
        : undefined;
      const scriptCollection = savedRequestId
        ? useCollectionStore.getState().getCollectionByItemId(savedRequestId)
        : undefined;
      const scriptCollectionId = scriptCollection?.id;
      const scriptEnvironmentId = scriptEnvironmentTargetId(scriptCollectionId);
      // `pm.collectionVariables` for the owning collection, as the HTTP send
      // gives it (`useHttpRequestPage`). A caller's own protocolOptions win.
      const protocolOptions: Record<string, unknown> = {
        ...(scriptCollection
          ? { collectionVars: buildValueMap({ collection: scriptCollection.variables }) }
          : {}),
        ...(options?.protocolOptions ?? {}),
      };

      const startedAt = performance.now();
      const response = await protocol.runRequest(request, {
        signal: ctrl.signal,
        variables,
        secretVariables,
        secretNames: sendSecretNames,
        onScriptResult,
        onAuthRefreshed,
        ...(Object.keys(protocolOptions).length > 0 ? { protocolOptions } : {}),
        ...(options?.stream ? { stream: options.stream } : {}),
      });
      const durationMs = performance.now() - startedAt;

      // Cancelled while the transport was finishing (a gRPC unary call that
      // resolved anyway): the run is abandoned, so nothing it did is recorded
      // (no history entry, no environment or collection writes).
      if (ctrl.signal.aborted) {
        if (abortRef.current === ctrl) abortRef.current = null;
        throw new DOMException('Request aborted', 'AbortError');
      }

      // Persist to history. addHistoryItem honors user settings
      // (autoSaveHistory / maxHistoryItems) internally — no need to re-check.
      // The RAW request is stored: inherited auth is a send-time resolution,
      // and persisting it would copy ancestor credentials into history.
      useHistoryStore.getState().addHistoryItem(rawRequest, response);

      // Clear the abort ref only if this run is still the latest one — a
      // newer run() call would have already replaced it.
      if (abortRef.current === ctrl) {
        abortRef.current = null;
      }

      // `pm.environment.set/unset` from either script persist to the active
      // environment when it applies to the request's collection — the same
      // for every protocol sent through this runner.
      const environmentMutations = mergeEnvironmentMutations(
        collectedScripts?.preRequest,
        collectedScripts?.test
      );
      saveScriptEnvironmentWrites({
        environmentId: scriptEnvironmentId,
        collectionId: scriptCollectionId,
        mutations: environmentMutations,
      });

      // `pm.collectionVariables.set/unset` from either script persist to the
      // owning collection (pre-request first, then test), as for HTTP.
      const collectionMutations: Record<string, string | null> = {
        ...(collectedScripts?.preRequest?.collectionMutations ?? {}),
        ...(collectedScripts?.test?.collectionMutations ?? {}),
      };
      if (scriptCollectionId && Object.keys(collectionMutations).length > 0) {
        useCollectionStore
          .getState()
          .applyCollectionVarMutations(scriptCollectionId, collectionMutations);
      }

      const result: RegistryRunResult = { response, durationMs };
      if (collectedScripts) {
        result.scriptResult = collectedScripts;
      }
      return result;
    },
    []
  );

  const abort = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  return { run, abort };
}
