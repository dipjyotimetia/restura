import type { OwsExecutionResult, OwsExecutionStep } from '@shared/ows/executor';
import { executeOwsWorkflow } from '@shared/ows/executor';
import { getGraphqlResponseErrors } from '@shared/ows/graphql-operation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { withEffectiveAuth } from '@/features/auth/lib/authInheritance';
import { protocolRegistry } from '@/features/registry/registry';
import { buildValueMap } from '@/lib/shared/variableScopes';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useGlobalsStore } from '@/store/useGlobalsStore';
import type { OwsStoredWorkflow } from '@/store/useWorkflowStore';
import { findRequestByReference } from '../lib/collectionHelpers';
import { findWorkflowGraphqlMutations } from '../lib/workflowGraphql';

function stringVariables(values: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).flatMap(([key, value]) => {
      if (typeof value === 'string') return [[key, value]];
      if (typeof value === 'number' || typeof value === 'boolean') return [[key, String(value)]];
      return [];
    })
  );
}

function isGraphqlBinding(binding: { kind: string; call: string }): binding is {
  kind: 'saved-request';
  call: 'http';
  protocol: 'graphql';
  resourceId: string;
} {
  return 'protocol' in binding && binding.protocol === 'graphql';
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
  const runGenerationRef = useRef(0);
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<OwsExecutionResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Closing the executor must have the same cancellation semantics as Stop.
  // Without this cleanup a dialog unmount could leave a policy-enforced call
  // running invisibly in the background.
  useEffect(
    () => () => {
      runGenerationRef.current += 1;
      controllerRef.current?.abort();
      controllerRef.current = null;
    },
    []
  );

  const run = useCallback(
    async (
      workflow: OwsStoredWorkflow,
      options: { allowGraphqlMutations?: boolean } = {}
    ): Promise<OwsExecutionResult> => {
      if (controllerRef.current) {
        throw new Error('A workflow is already running. Stop it before starting another run.');
      }
      const collection = collections.find((candidate) => candidate.id === workflow.collectionId);
      if (!collection) throw new Error('The workflow collection is unavailable.');
      let mutations;
      try {
        mutations = findWorkflowGraphqlMutations(
          workflow.document,
          workflow.bindings,
          collection.items
        );
      } catch (cause) {
        const message =
          cause instanceof Error ? cause.message : 'Workflow GraphQL validation failed.';
        setError(message);
        throw new Error(message);
      }
      if (mutations.length > 0 && !options.allowGraphqlMutations) {
        throw new Error(
          `Workflow contains GraphQL mutation steps (${mutations.map((mutation) => mutation.name).join(', ')}). Confirm before running.`
        );
      }
      const activeEnvironment = environments.find(
        (environment) => environment.id === activeEnvironmentId
      );
      const initialVariables = {
        ...globalVariables,
        ...buildValueMap({ env: activeEnvironment?.variables }),
        ...buildValueMap({ collection: collection.variables }),
      };
      const controller = new AbortController();
      controllerRef.current = controller;
      const runGeneration = ++runGenerationRef.current;
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
            dispatch: async ({ binding, call, method, signal, variables }) => {
              if (binding.kind !== 'saved-request' || binding.call !== 'http' || call !== 'http') {
                throw new Error('Workflow calls require an approved saved HTTP request binding.');
              }
              const request = findRequestByReference(collection.items, binding.resourceId);
              if (!request || request.type !== 'http') {
                throw new Error(
                  `Workflow binding ${binding.resourceId} does not resolve to a saved HTTP request.`
                );
              }
              const graphql = isGraphqlBinding(binding);
              if (request.method !== method) {
                throw new Error(
                  `Workflow call method ${method} does not match saved request method ${request.method}.`
                );
              }
              if (graphql && (request.method !== 'POST' || request.body.type !== 'graphql')) {
                throw new Error(
                  `Workflow GraphQL binding ${binding.resourceId} does not resolve to a saved GraphQL POST request.`
                );
              }
              if (!graphql && request.body.type === 'graphql') {
                throw new Error(
                  `Workflow HTTP binding ${binding.resourceId} cannot resolve to a saved GraphQL request.`
                );
              }
              const protocol = protocolRegistry.get(graphql ? 'graphql' : 'http');
              if (!protocol) {
                throw new Error(`${graphql ? 'GraphQL' : 'HTTP'} protocol adapter is unavailable.`);
              }
              const authed = withEffectiveAuth(request, collection.auth);
              const resolvedVariables = stringVariables(variables);
              const injected = protocol.injectVariables
                ? protocol.injectVariables(authed, resolvedVariables)
                : authed;
              const response = await protocol.runRequest(injected, {
                signal,
                variables: resolvedVariables,
              });
              if (graphql) {
                const errors = getGraphqlResponseErrors(response.body);
                if (errors.length > 0) {
                  throw new Error(
                    `Saved GraphQL request ${binding.resourceId} returned errors: ${errors.join('; ')}`
                  );
                }
              }
              return response;
            },
          },
        });
        if (runGeneration === runGenerationRef.current) setResult(execution);
        return execution;
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : 'Workflow execution failed.';
        if (runGeneration === runGenerationRef.current) setError(message);
        throw cause;
      } finally {
        if (controllerRef.current === controller) {
          controllerRef.current = null;
          if (runGeneration === runGenerationRef.current) setIsRunning(false);
        }
      }
    },
    [activeEnvironmentId, collections, environments, globalVariables]
  );

  const stop = useCallback(() => controllerRef.current?.abort(), []);
  const getMutationSteps = useCallback(
    (workflow: OwsStoredWorkflow) => {
      const collection = collections.find((candidate) => candidate.id === workflow.collectionId);
      if (!collection) return [];
      try {
        return findWorkflowGraphqlMutations(workflow.document, workflow.bindings, collection.items);
      } catch {
        // The execution preflight reports malformed GraphQL as a visible workflow error.
        return [];
      }
    },
    [collections]
  );
  const steps: OwsExecutionStep[] = result?.steps ?? [];
  return { isRunning, result, steps, error, run, stop, getMutationSteps };
}
