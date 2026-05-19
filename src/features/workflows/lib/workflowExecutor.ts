import type {
  Workflow,
  WorkflowRequest,
  WorkflowExecution,
  WorkflowExecutionStep,
  Request,
  Response,
  AppSettings,
  AuthConfig,
} from '@/types';
import { withEffectiveAuth } from '@/features/auth/lib/authInheritance';
import { v4 as uuidv4 } from 'uuid';
import { executeRequest } from '@/features/http/lib/requestExecutor';
import { protocolRegistry } from '@/features/registry/registry';
import { extractVariables } from './variableExtractor';
import { executeWithRetry } from './retryHelpers';
import { evalScriptBoolean } from './scriptHelpers';

export interface WorkflowExecutorOptions {
  workflow: Workflow;
  getRequestById: (id: string) => Request | undefined;
  envVars: Record<string, string>;
  globalSettings: AppSettings;
  resolveVariables: (text: string) => string;
  getInheritedAuth?: (requestId: string) => AuthConfig | undefined;
  onStepStart?: (step: WorkflowExecutionStep) => void;
  onStepComplete?: (step: WorkflowExecutionStep) => void;
  onLog?: (message: string, level: 'info' | 'warn' | 'error') => void;
  abortSignal?: AbortSignal;
}

/**
 * Execute a linear workflow.
 *
 * **This executor only handles linear workflows** (no `workflow.graph`).
 * Graph-authored workflows run through `dagExecutor.executeDag`. The
 * legacy executor refuses to run a graph workflow because the linear
 * `requests[]` array is treated as a bag (insertion order is
 * meaningless) once a graph is authored.
 */
export async function executeWorkflow(
  options: WorkflowExecutorOptions
): Promise<WorkflowExecution> {
  const {
    workflow,
    getRequestById,
    envVars,
    globalSettings,
    resolveVariables,
    getInheritedAuth,
    onStepStart,
    onStepComplete,
    onLog,
    abortSignal,
  } = options;

  if (workflow.graph) {
    throw new Error(
      'executeWorkflow received a graph-authored workflow. Use executeDag from dagExecutor.ts.'
    );
  }

  const execution: WorkflowExecution = {
    id: uuidv4(),
    workflowId: workflow.id,
    workflowName: workflow.name,
    startedAt: Date.now(),
    status: 'running',
    steps: [],
    finalVariables: { ...envVars },
    executionLog: [],
  };

  const log = (message: string, level: 'info' | 'warn' | 'error' = 'info') => {
    execution.executionLog.push({ timestamp: Date.now(), message, level });
    onLog?.(message, level);
  };

  log(`Starting workflow: ${workflow.name}`);

  // Merge workflow-level variables
  if (workflow.variables) {
    workflow.variables
      .filter((v) => v.enabled)
      .forEach((v) => {
        execution.finalVariables[v.key] = v.value;
      });
  }

  // Execute each request in sequence
  for (const workflowRequest of workflow.requests) {
    // Check for abort
    if (abortSignal?.aborted) {
      log('Workflow aborted by user', 'warn');
      execution.status = 'stopped';
      break;
    }

    const step: WorkflowExecutionStep = {
      workflowRequestId: workflowRequest.id,
      requestId: workflowRequest.requestId,
      requestName: workflowRequest.name,
      status: 'running',
      timestamp: Date.now(),
    };

    execution.steps.push(step);
    onStepStart?.(step);

    try {
      // Get the actual request
      const rawRequest = getRequestById(workflowRequest.requestId);
      if (!rawRequest) {
        throw new Error(`Request not found: ${workflowRequest.requestId}`);
      }
      const request = getInheritedAuth
        ? withEffectiveAuth(rawRequest, getInheritedAuth(workflowRequest.requestId))
        : rawRequest;

      // Check precondition
      if (workflowRequest.precondition) {
        const conditionMet = await evalScriptBoolean(workflowRequest.precondition, {
          variables: execution.finalVariables,
        });
        if (!conditionMet) {
          step.status = 'skipped';
          log(`Skipping "${workflowRequest.name}" - precondition not met`, 'info');
          onStepComplete?.(step);
          continue;
        }
      }

      log(`Executing: ${workflowRequest.name}`);

      // Execute with retry policy
      const response = await runHttpStep(
        request,
        workflowRequest,
        execution.finalVariables,
        globalSettings,
        resolveVariables,
        log,
        abortSignal
      );

      step.response = response;
      step.duration = Date.now() - step.timestamp;

      // Extract variables
      if (workflowRequest.extractVariables && workflowRequest.extractVariables.length > 0) {
        const extracted = extractVariables(response, workflowRequest.extractVariables);
        step.extractedVariables = extracted;

        // Merge extracted variables
        Object.assign(execution.finalVariables, extracted);

        if (Object.keys(extracted).length > 0) {
          log(
            `Extracted variables: ${Object.entries(extracted)
              .map(([k, v]) => `${k}=${v.substring(0, 50)}${v.length > 50 ? '...' : ''}`)
              .join(', ')}`,
            'info'
          );
        }
      }

      // Check for success (2xx status)
      if (response.status >= 200 && response.status < 300) {
        step.status = 'success';
        log(`Completed: ${workflowRequest.name} (${response.status})`, 'info');
      } else {
        step.status = 'failed';
        step.error = `HTTP ${response.status}: ${response.statusText}`;
        log(`Failed: ${workflowRequest.name} - ${step.error}`, 'error');

        // Stop workflow on failure
        execution.status = 'failed';
        onStepComplete?.(step);
        break;
      }
    } catch (error) {
      step.status = 'failed';
      step.error = error instanceof Error ? error.message : 'Unknown error';
      step.duration = Date.now() - step.timestamp;
      log(`Error in "${workflowRequest.name}": ${step.error}`, 'error');

      execution.status = 'failed';
      onStepComplete?.(step);
      break;
    }

    onStepComplete?.(step);
  }

  // Finalize execution
  execution.completedAt = Date.now();
  if (execution.status === 'running') {
    execution.status = 'success';
  }

  log(
    `Workflow ${execution.status}: ${execution.steps.filter((s) => s.status === 'success').length}/${execution.steps.length} steps completed`
  );

  return execution;
}

/**
 * Execute a single HTTP step with retry + the protocol-registry's
 * injectVariables for {{var}} substitution. We still call
 * `executeRequest` directly (not protocol.runRequest) because the legacy
 * executor needs `result.envVars` from inline scripts merged back — a
 * surface that the registry currently doesn't expose. Once useRequestRunner
 * grows that capability, this can collapse to a registry call.
 */
async function runHttpStep(
  request: Request,
  workflowRequest: WorkflowRequest,
  envVars: Record<string, string>,
  globalSettings: AppSettings,
  resolveVariables: (text: string) => string,
  log: (message: string, level: 'info' | 'warn' | 'error') => void,
  abortSignal?: AbortSignal
): Promise<Response> {
  if (request.type !== 'http') {
    throw new Error('Only HTTP requests are supported in linear workflows');
  }

  const httpModule = protocolRegistry.get('http');
  const injected = httpModule?.injectVariables
    ? httpModule.injectVariables(request, envVars)
    : request;
  if (injected.type !== 'http') {
    throw new Error('HTTP injectVariables produced non-HTTP request');
  }

  return executeWithRetry(
    async () => {
      const result = await executeRequest({
        request: injected,
        envVars,
        globalSettings,
        resolveVariables,
      });
      if (result.envVars) {
        Object.assign(envVars, result.envVars);
      }
      return result.response;
    },
    {
      policy: workflowRequest.retryPolicy ?? { maxAttempts: 1, delayMs: 0 },
      ...(abortSignal ? { signal: abortSignal } : {}),
      onRetry: (attempt, delay) => {
        log(
          `Retry ${attempt}/${workflowRequest.retryPolicy?.maxAttempts ?? 1} for "${workflowRequest.name}" in ${delay}ms`,
          'warn'
        );
      },
    }
  );
}
