import { useState, useCallback, useRef } from 'react';
import { Workflow, WorkflowExecution, WorkflowExecutionStep, Request } from '@/types';
import { executeWorkflow } from '../lib/workflowExecutor';
import { useWorkflowStore } from '@/store/useWorkflowStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useCollectionStore } from '@/store/useCollectionStore';

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
  const getActiveEnvironmentVars = useEnvironmentStore((s) => {
    const activeId = s.activeEnvironmentId;
    const env = s.environments.find((e) => e.id === activeId);
    if (!env) return {};
    return env.variables
      .filter((v) => v.enabled)
      .reduce(
        (acc, v) => ({ ...acc, [v.key]: v.value }),
        {} as Record<string, string>
      );
  });
  const globalSettings = useSettingsStore((s) => s.settings);
  const collections = useCollectionStore((s) => s.collections);
  const saveExecution = useWorkflowStore((s) => s.saveExecution);

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

  const run = useCallback(
    async (workflow: Workflow): Promise<WorkflowExecution> => {
      setIsRunning(true);
      setLogs([]);
      setCurrentStep(null);

      abortControllerRef.current = new AbortController();

      try {
        const result = await executeWorkflow({
          workflow,
          getRequestById,
          envVars: { ...getActiveEnvironmentVars },
          globalSettings,
          resolveVariables,
          onStepStart: (step) => {
            setCurrentStep(step);
          },
          onStepComplete: (step) => {
            setCurrentStep(step);
            setExecution((prev) =>
              prev
                ? {
                    ...prev,
                    steps: prev.steps.map((s) =>
                      s.workflowRequestId === step.workflowRequestId ? step : s
                    ),
                  }
                : null
            );
          },
          onLog: (message, level) => {
            setLogs((prev) => [...prev, { timestamp: Date.now(), message, level }]);
          },
          abortSignal: abortControllerRef.current.signal,
        });

        setExecution(result);
        saveExecution(result);
        onComplete?.(result);

        return result;
      } catch (error) {
        const err = error instanceof Error ? error : new Error('Unknown error');
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
      getActiveEnvironmentVars,
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

// Helper to find request in nested collection items
function findRequestInItems(
  items: import('@/types').CollectionItem[],
  requestId: string
): Request | undefined {
  for (const item of items) {
    if (item.type === 'request' && item.request?.id === requestId) {
      return item.request;
    }
    if (item.items) {
      const found = findRequestInItems(item.items, requestId);
      if (found) return found;
    }
  }
  return undefined;
}
