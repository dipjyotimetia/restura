import {
  Workflow,
  WorkflowRequest,
  WorkflowExecution,
  WorkflowExecutionStep,
  Request,
  Response,
  HttpRequest,
  AppSettings,
} from '@/types';
import { v4 as uuidv4 } from 'uuid';
import { executeRequest } from '@/features/http/lib/requestExecutor';
import { extractVariables } from './variableExtractor';
import ScriptExecutor from '@/features/scripts/lib/scriptExecutor';

export interface WorkflowExecutorOptions {
  workflow: Workflow;
  getRequestById: (id: string) => Request | undefined;
  envVars: Record<string, string>;
  globalSettings: AppSettings;
  resolveVariables: (text: string) => string;
  onStepStart?: (step: WorkflowExecutionStep) => void;
  onStepComplete?: (step: WorkflowExecutionStep) => void;
  onLog?: (message: string, level: 'info' | 'warn' | 'error') => void;
  abortSignal?: AbortSignal;
}

/**
 * Execute a workflow sequentially, passing variables between requests
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
    onStepStart,
    onStepComplete,
    onLog,
    abortSignal,
  } = options;

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
      const request = getRequestById(workflowRequest.requestId);
      if (!request) {
        throw new Error(`Request not found: ${workflowRequest.requestId}`);
      }

      // Check precondition
      if (workflowRequest.precondition) {
        const conditionMet = await evaluatePrecondition(
          workflowRequest.precondition,
          execution.finalVariables
        );
        if (!conditionMet) {
          step.status = 'skipped';
          log(`Skipping "${workflowRequest.name}" - precondition not met`, 'info');
          onStepComplete?.(step);
          continue;
        }
      }

      log(`Executing: ${workflowRequest.name}`);

      // Execute with retry policy
      const response = await executeWithRetry(
        request,
        workflowRequest,
        execution.finalVariables,
        globalSettings,
        resolveVariables,
        log
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
 * Execute a request with retry policy
 */
async function executeWithRetry(
  request: Request,
  workflowRequest: WorkflowRequest,
  envVars: Record<string, string>,
  globalSettings: AppSettings,
  resolveVariables: (text: string) => string,
  log: (message: string, level: 'info' | 'warn' | 'error') => void
): Promise<Response> {
  // Only HTTP requests supported for now
  if (request.type !== 'http') {
    throw new Error('Only HTTP requests are supported in workflows');
  }

  const retryPolicy = workflowRequest.retryPolicy || { maxAttempts: 1, delayMs: 0 };
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= retryPolicy.maxAttempts; attempt++) {
    try {
      // Clone request to apply variable substitution
      const clonedRequest = injectVariables(request, envVars);

      const result = await executeRequest({
        request: clonedRequest,
        envVars,
        globalSettings,
        resolveVariables,
      });

      // Update envVars with any changes from scripts
      if (result.envVars) {
        Object.assign(envVars, result.envVars);
      }

      return result.response;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Unknown error');

      if (attempt < retryPolicy.maxAttempts) {
        const delay = retryPolicy.delayMs * Math.pow(retryPolicy.backoffMultiplier || 1, attempt - 1);
        log(`Retry ${attempt}/${retryPolicy.maxAttempts} for "${workflowRequest.name}" in ${delay}ms`, 'warn');
        await sleep(delay);
      }
    }
  }

  throw lastError || new Error('Request failed');
}

/**
 * Inject variables into request URL, headers, and body
 */
function injectVariables(request: HttpRequest, variables: Record<string, string>): HttpRequest {
  const inject = (text: string): string => {
    let result = text;
    Object.entries(variables).forEach(([key, value]) => {
      result = result.replace(new RegExp(`{{${key}}}`, 'g'), value);
    });
    return result;
  };

  return {
    ...request,
    url: inject(request.url),
    headers: request.headers.map((h) => ({
      ...h,
      key: inject(h.key),
      value: inject(h.value),
    })),
    params: request.params.map((p) => ({
      ...p,
      key: inject(p.key),
      value: inject(p.value),
    })),
    body: {
      ...request.body,
      raw: request.body.raw ? inject(request.body.raw) : undefined,
    },
  };
}

/**
 * Evaluate precondition script
 */
async function evaluatePrecondition(
  script: string,
  variables: Record<string, string>
): Promise<boolean> {
  try {
    const executor = new ScriptExecutor(variables, {});
    const result = await executor.executeScript(
      `
      const __result = (function() {
        ${script}
      })();
      if (typeof __result !== 'boolean') {
        throw new Error('Precondition must return a boolean');
      }
      return __result;
      `,
      {}
    );

    // If script executed without errors, check if it returned true
    if (result.success) {
      // The script should set a variable or we check for no errors
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
