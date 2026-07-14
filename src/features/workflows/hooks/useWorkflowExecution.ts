import { useCallback, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { resolveInheritedAuthFor } from '@/features/auth/lib/resolveInheritedAuthFor';
import { buildValueMap } from '@/lib/shared/variableScopes';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useGlobalsStore } from '@/store/useGlobalsStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useWorkflowStore } from '@/store/useWorkflowStore';
import type { Request, Workflow, WorkflowExecution, WorkflowExecutionStep } from '@/types';
import { findRequestInItems } from '../lib/collectionHelpers';
import { executeDag } from '../lib/dagExecutor';
import { executeWorkflow } from '../lib/workflowExecutor';
import { useFlowRunStore } from '../store/useFlowRunStore';

interface UseWorkflowExecutionOptions {
  onComplete?: (execution: WorkflowExecution) => void;
  onError?: (error: Error) => void;
}

interface UseWorkflowExecutionReturn {
  isRunning: boolean;
  currentStep: WorkflowExecutionStep | null;
  execution: WorkflowExecution | null;
  logs: Array<{ timestamp: number; message: string; level: 'info' | 'warn' | 'error' }>;
  run: (workflow: Workflow) => Promise<WorkflowExecution>;
  stop: () => void;
}

export function useWorkflowExecution(
  options: UseWorkflowExecutionOptions = {}
): UseWorkflowExecutionReturn {
  const { onComplete, onError } = options;

  const [isRunning, setIsRunning] = useState(false);
  const [currentStep, setCurrentStep] = useState<WorkflowExecutionStep | null>(null);
  const [execution, setExecution] = useState<WorkflowExecution | null>(null);
  const [logs, setLogs] = useState<
    Array<{ timestamp: number; message: string; level: 'info' | 'warn' | 'error' }>
  >([]);

  const abortControllerRef = useRef<AbortController | null>(null);

  const resolveVariables = useEnvironmentStore((s) => s.resolveVariables);
  // `useShallow` memoises the reduced object so successive selector calls
  // return the same reference when the underlying variables haven't changed.
  // Without it, the fresh `{}` allocation on every call destabilises
  // `useSyncExternalStore`'s snapshot and triggers an infinite re-render
  // ("Maximum update depth exceeded").
  const getActiveEnvironmentVars = useEnvironmentStore(
    useShallow((s) => {
      const activeId = s.activeEnvironmentId;
      const env = s.environments.find((e) => e.id === activeId);
      if (!env) return {} as Record<string, string>;
      return env.variables
        .filter((v) => v.enabled)
        .reduce<Record<string, string>>((acc, v) => ({ ...acc, [v.key]: v.value }), {});
    })
  );
  const globalSettings = useSettingsStore((s) => s.settings);
  const collections = useCollectionStore((s) => s.collections);
  const saveExecution = useWorkflowStore((s) => s.saveExecution);
  const getWorkflowById = useWorkflowStore((s) => s.getWorkflowById);

  // Get request by ID from collections
  const getRequestById = useCallback(
    (requestId: string): Request | undefined => {
      for (const collection of collections) {
        const request = findRequestInItems(collection.items, requestId);
        if (request) return request;
      }
      return undefined;
    },
    [collections]
  );

  // Folder/collection auth the request inherits when its own auth is 'none' —
  // the executors apply it per step via withEffectiveAuth (own auth wins).
  const getInheritedAuth = useCallback(
    (requestId: string) => {
      const request = getRequestById(requestId);
      if (!request) return undefined;
      return resolveInheritedAuthFor({ id: requestId, auth: request.auth })?.auth;
    },
    [getRequestById]
  );

  const run = useCallback(
    async (workflow: Workflow): Promise<WorkflowExecution> => {
      setIsRunning(true);
      setLogs([]);
      setCurrentStep(null);

      abortControllerRef.current = new AbortController();

      // Live-canvas mirroring for graph workflows. Linear runs don't
      // populate the run store — they use the legacy WorkflowExecutor
      // modal which reads from the hook's local state.
      const isGraphRun = Boolean(workflow.graph);
      const runStore = useFlowRunStore.getState();
      if (isGraphRun) {
        // We don't have the execution id yet (the executor mints it),
        // so we pass a placeholder and overwrite once the result comes
        // back. The id is read-only outside the store and only used for
        // display, so the swap is harmless.
        runStore.startRun(workflow.id, '');
      }

      try {
        const onStepStart = (step: WorkflowExecutionStep) => {
          setCurrentStep(step);
          if (isGraphRun && step.nodeId) {
            useFlowRunStore.getState().markNodeStarted(step.nodeId);
          }
        };
        const onStepComplete = (step: WorkflowExecutionStep) => {
          setCurrentStep(step);
          setExecution((prev) => {
            if (!prev) return null;
            // graph executions match on nodeId + instanceId (so concurrent
            // forEach iterations / parallel branches sharing a nodeId don't
            // overwrite each other's row); linear matches on workflowRequestId.
            const matchIdx = prev.steps.findIndex((s) =>
              step.nodeId
                ? s.nodeId === step.nodeId && s.instanceId === step.instanceId
                : s.workflowRequestId === step.workflowRequestId
            );
            if (matchIdx === -1) {
              return { ...prev, steps: [...prev.steps, step] };
            }
            const steps = prev.steps.slice();
            steps[matchIdx] = step;
            return { ...prev, steps };
          });
          if (isGraphRun && step.nodeId) {
            const status = step.status;
            // Only commit a terminal status — pending/running already
            // shown by markNodeStarted.
            if (status === 'success' || status === 'failed' || status === 'skipped') {
              const meta: Parameters<
                ReturnType<typeof useFlowRunStore.getState>['markNodeComplete']
              >[2] = {};
              if (step.error) meta.error = step.error;
              if (step.duration !== undefined) meta.duration = step.duration;
              if (step.extractedVariables) meta.extractedVariables = step.extractedVariables;
              useFlowRunStore.getState().markNodeComplete(step.nodeId, status, meta);
              if (step.extractedVariables) {
                useFlowRunStore.getState().mergeVariables(step.extractedVariables);
              }
            }
          }
        };
        const onLog = (message: string, level: 'info' | 'warn' | 'error') => {
          setLogs((prev) => [...prev, { timestamp: Date.now(), message, level }]);
          if (isGraphRun) {
            useFlowRunStore.getState().appendLog({ timestamp: Date.now(), level, message });
          }
        };

        // Seed variables from every scope a workflow step can resolve:
        // workspace globals < active environment < the linked collection's vars
        // (workflow.collectionId). workflow.variables + extracted vars layer on
        // top inside the executors.
        const linkedCollection = collections.find((c) => c.id === workflow.collectionId);
        const seedVars: Record<string, string> = {
          ...useGlobalsStore.getState().vars,
          ...getActiveEnvironmentVars,
          ...buildValueMap({ collection: linkedCollection?.variables }),
        };

        const result = workflow.graph
          ? await executeDag({
              workflow,
              getRequestById,
              getWorkflowById,
              getInheritedAuth,
              envVars: { ...seedVars },
              onStepStart,
              onStepComplete,
              onLog,
              abortSignal: abortControllerRef.current.signal,
            })
          : await executeWorkflow({
              workflow,
              getRequestById,
              getInheritedAuth,
              envVars: { ...seedVars },
              globalSettings,
              resolveVariables,
              onStepStart,
              onStepComplete,
              onLog,
              abortSignal: abortControllerRef.current.signal,
            });

        setExecution(result);
        saveExecution(result);
        if (isGraphRun) {
          useFlowRunStore.getState().setVariables(result.finalVariables);
          useFlowRunStore
            .getState()
            .finishRun(result.status === 'running' ? 'success' : result.status);
        }
        onComplete?.(result);

        return result;
      } catch (error) {
        const err = error instanceof Error ? error : new Error('Unknown error');
        if (isGraphRun) {
          useFlowRunStore.getState().finishRun('failed');
        }
        onError?.(err);
        throw err;
      } finally {
        setIsRunning(false);
        setCurrentStep(null);
        abortControllerRef.current = null;
      }
    },
    [
      getRequestById,
      getWorkflowById,
      getInheritedAuth,
      getActiveEnvironmentVars,
      collections,
      globalSettings,
      resolveVariables,
      saveExecution,
      onComplete,
      onError,
    ]
  );

  const stop = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

  return {
    isRunning,
    currentStep,
    execution,
    logs,
    run,
    stop,
  };
}
