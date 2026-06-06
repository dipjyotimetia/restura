/**
 * useRequestRunner — protocol-agnostic request execution hook.
 *
 * Centralizes the `script -> resolve variables -> execute -> history -> test`
 * pipeline that each Builder used to re-implement. Builders look up a
 * `ProtocolModule` by id from the registry and invoke `run()` here; the hook
 * handles AbortController lifecycle, environment variable extraction,
 * history persistence, and (Task 4.4) forwarding script results from the
 * protocol to the active tab so the Console panel renders pre-request and
 * test script logs.
 *
 * Protocols opt into the script-result side-channel by calling
 * `ctx.onScriptResult(...)` from inside their `runRequest`. The HTTP
 * executor runs both scripts inline today (see `requestExecutor.ts`), so
 * the HTTP protocol simply passes the executor's `scriptResult` through.
 * Protocols that don't have a script pipeline may omit the call entirely.
 */
import { useCallback, useRef } from 'react';
import { protocolRegistry } from './registry';
import type { ProtocolScriptResult } from './types';
import type { Request, Response } from '@/types';
import { useHistoryStore } from '@/store/useHistoryStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useRequestStore } from '@/store/useRequestStore';
import { withEffectiveAuth } from '@/features/auth/lib/authInheritance';
import { resolveInheritedAuthFor } from '@/features/auth/lib/resolveInheritedAuthFor';

export interface RunResult {
  response: Response;
  durationMs: number;
  /**
   * Pre-request and test script results produced by the protocol, if any.
   * Mirrors `useRequestStore.setScriptResult`'s payload — the runner has
   * already forwarded these to the active tab, this field exists so
   * Builders can react to them (e.g. early-exit on test failure) without
   * subscribing to the store.
   */
  scriptResult?: ProtocolScriptResult;
}

export interface RunOptions {
  /**
   * Per-protocol options forwarded to `ProtocolModule.runRequest` via
   * `RunContext.protocolOptions`. Used by gRPC for transient proto content
   * (which doesn't live on the Request shape) and reserved for future
   * protocol extensions. Cross-protocol callers can omit it.
   */
  protocolOptions?: Record<string, unknown>;
}

export function useRequestRunner() {
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(
    async (rawRequest: Request, protocolId: string, options?: RunOptions): Promise<RunResult> => {
      const protocol = protocolRegistry.get(protocolId);
      if (!protocol) {
        throw new Error(`Unknown protocol: ${protocolId}`);
      }

      // Folder/collection auth inheritance for single sends. A request whose
      // own auth is 'none' picks up the nearest configured ancestor auth —
      // the same rule collection runs apply via flattenRunnables. Only this
      // runner resolves it: the collection runner and workflow executor
      // bypass run() and thread inherited auth themselves, so there is no
      // double application.
      const inherited = resolveInheritedAuthFor(rawRequest);
      const request = inherited ? withEffectiveAuth(rawRequest, inherited.auth) : rawRequest;

      // Cancel any prior in-flight request from this hook instance. Builders
      // that fire a second `run()` before the first resolves get the latest
      // result; the older promise rejects with AbortError.
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      // Build the variables map from the active environment (only enabled
      // entries, mirroring useHttpRequest's existing extraction).
      const variables: Record<string, string> = {};
      const activeEnv = useEnvironmentStore.getState().getActiveEnvironment();
      if (activeEnv) {
        for (const v of activeEnv.variables) {
          if (v.enabled) {
            variables[v.key] = v.value;
          }
        }
      }

      // Capture script results emitted by the protocol so we can both push
      // them to the active tab (so the Console panel updates) AND surface
      // them on `RunResult` for callers that want to react synchronously.
      let collectedScripts: ProtocolScriptResult | undefined;
      const onScriptResult = (result: ProtocolScriptResult) => {
        collectedScripts = result;
        // Push to the store immediately so Console/Tests panels render as
        // soon as scripts finish — even if the caller never inspects
        // `RunResult.scriptResult`. Mirrors the inline pipeline that
        // useHttpRequest used to drive directly.
        useRequestStore.getState().setScriptResult(result);
      };

      const startedAt = performance.now();
      const response = await protocol.runRequest(request, {
        signal: ctrl.signal,
        variables,
        onScriptResult,
        ...(options?.protocolOptions ? { protocolOptions: options.protocolOptions } : {}),
      });
      const durationMs = performance.now() - startedAt;

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

      const result: RunResult = { response, durationMs };
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
