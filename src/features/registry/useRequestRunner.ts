/**
 * useRequestRunner — protocol-agnostic request execution hook.
 *
 * Centralizes the `script -> resolve variables -> execute -> history -> test`
 * pipeline that each Builder currently re-implements (see
 * `useHttpRequest.ts`, `GrpcRequestBuilder.tsx`, etc). Builders look up a
 * `ProtocolModule` by id from the registry and invoke `run()` here; the hook
 * handles AbortController lifecycle, environment variable extraction, and
 * history persistence.
 *
 * This is the skeleton introduced by Task 4.3. Pre-request and test script
 * execution are TODOs that Task 4.4 will wire when migrating HTTP through
 * this hook (the QuickJS executor in `scripts/lib/scriptExecutor.ts` has its
 * own context shape that needs adapting per-protocol).
 */
import { useCallback, useRef } from 'react';
import { protocolRegistry } from './registry';
import type { Request, Response } from '@/types';
import { useHistoryStore } from '@/store/useHistoryStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';

export interface RunResult {
  response: Response;
  durationMs: number;
}

export function useRequestRunner() {
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(
    async (request: Request, protocolId: string): Promise<RunResult> => {
      const protocol = protocolRegistry.get(protocolId);
      if (!protocol) {
        throw new Error(`Unknown protocol: ${protocolId}`);
      }

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

      // FIXME(4.4): wire pre-request scripts through scripts/lib/scriptExecutor.
      // The existing executors (e.g. http/lib/requestExecutor) run pre-request
      // scripts inline; once we migrate them through this hook we need to lift
      // that invocation here so every protocol benefits.

      const startedAt = performance.now();
      const response = await protocol.runRequest(request, {
        signal: ctrl.signal,
        variables,
      });
      const durationMs = performance.now() - startedAt;

      // Persist to history. addHistoryItem honors user settings
      // (autoSaveHistory / maxHistoryItems) internally — no need to re-check.
      useHistoryStore.getState().addHistoryItem(request, response);

      // FIXME(4.4): wire test scripts + setScriptResult similarly. The test
      // script needs the response, env vars, and a way to push results back
      // into useRequestStore.setScriptResult for the active tab.

      // Clear the abort ref only if this run is still the latest one — a
      // newer run() call would have already replaced it.
      if (abortRef.current === ctrl) {
        abortRef.current = null;
      }

      return { response, durationMs };
    },
    []
  );

  const abort = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  return { run, abort };
}
