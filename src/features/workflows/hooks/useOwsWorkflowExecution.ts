import type { OwsExecutionResult, OwsExecutionStep } from '@shared/ows/executor';
import { executeOwsWorkflow } from '@shared/ows/executor';
import { useCallback, useRef, useState } from 'react';
import { withEffectiveAuth } from '@/features/auth/lib/authInheritance';
import { protocolRegistry } from '@/features/registry/registry';
import { buildValueMap } from '@/lib/shared/variableScopes';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useGlobalsStore } from '@/store/useGlobalsStore';
import type { OwsStoredWorkflow } from '@/store/useWorkflowStore';
import { findRequestByReference } from '../lib/collectionHelpers';

function stringVariables(values: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).flatMap(([key, value]) => {
      if (typeof value === 'string') return [[key, value]];
      if (typeof value === 'number' || typeof value === 'boolean') return [[key, String(value)]];
      return [];
    })
  );
}

/**
 * Renderer adapter for the trusted, binding-only OWS dispatcher. It resolves
 * saved HTTP resources locally, preserves normal auth/SSRF protocol policy,
 * and never forwards OWS endpoint/header/body data to the request runner.
 */
export function useOwsWorkflowExecution() {
  const collections = useCollectionStore((state) => state.collections);
  const environments = useEnvironmentStore((state) => state.environments);
  const activeEnvironmentId = useEnvironmentStore((state) => state.activeEnvironmentId);
  const globalVariables = useGlobalsStore((state) => state.vars);
  const controllerRef = useRef<AbortController | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<OwsExecutionResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (workflow: OwsStoredWorkflow): Promise<OwsExecutionResult> => {
      const collection = collections.find((candidate) => candidate.id === workflow.collectionId);
      if (!collection) throw new Error('The workflow collection is unavailable.');
      const activeEnvironment = environments.find(
        (environment) => environment.id === activeEnvironmentId
      );
      const initialVariables = {
        ...globalVariables,
        ...buildValueMap({ env: activeEnvironment?.variables }),
        ...buildValueMap({ collection: collection.variables }),
      };
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      setIsRunning(true);
      setResult(null);
      setError(null);

      try {
        const execution = await executeOwsWorkflow({
          workflow: workflow.document,
          bindings: workflow.bindings,
          variables: initialVariables,
          signal: controller.signal,
          dispatcher: {
            dispatch: async ({ binding, call, method, signal }) => {
              if (binding.kind !== 'saved-request' || binding.call !== 'http' || call !== 'http') {
                throw new Error('OWS calls require an approved saved HTTP request binding.');
              }
              const request = findRequestByReference(collection.items, binding.resourceId);
              if (!request || request.type !== 'http') {
                throw new Error(
                  `OWS binding ${binding.resourceId} does not resolve to a saved HTTP request.`
                );
              }
              if (request.method !== method) {
                throw new Error(
                  `OWS call method ${method} does not match saved request method ${request.method}.`
                );
              }
              const protocol = protocolRegistry.get('http');
              if (!protocol) throw new Error('The HTTP protocol adapter is unavailable.');
              const authed = withEffectiveAuth(request, collection.auth);
              const injected = protocol.injectVariables
                ? protocol.injectVariables(authed, stringVariables(initialVariables))
                : authed;
              return protocol.runRequest(injected, {
                signal,
                variables: stringVariables(initialVariables),
              });
            },
          },
        });
        setResult(execution);
        return execution;
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : 'OWS workflow execution failed.';
        setError(message);
        throw cause;
      } finally {
        if (controllerRef.current === controller) controllerRef.current = null;
        setIsRunning(false);
      }
    },
    [activeEnvironmentId, collections, environments, globalVariables]
  );

  const stop = useCallback(() => controllerRef.current?.abort(), []);
  const steps: OwsExecutionStep[] = result?.steps ?? [];
  return { isRunning, result, steps, error, run, stop };
}
