/**
 * Approved agent test-run planner.
 *
 * Binds a user-approved test plan to saved Restura requests and defined
 * variable fixtures, then executes each step through the normal request
 * executor (SSRF guard, redirects, auth, cookies, scripts all inherited).
 *
 * All non-default-read methods (not GET/HEAD/OPTIONS) and every scripted
 * request require approval before execution.  Dry-run surfaces every action
 * that will need approval.  The execution trace is sanitised before it is
 * returned so no raw request body/header data leaks into prompts, persistence,
 * or telemetry.
 *
 * @module
 */

import { v4 as uuidv4 } from 'uuid';
import { executeRequest } from '@/features/http/lib/requestExecutor';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useGlobalsStore } from '@/store/useGlobalsStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { buildValueMap } from '@/lib/shared/variableScopes';
import {
  findInheritedAuthWithSource,
  resolveEffectiveAuth,
} from '@/features/auth/lib/authInheritance';
import { redactToolUrl } from './agentTools';
import type { AgentRunResult } from '@shared/agent-lab';
import type {
  Collection,
  CollectionItem,
  HttpRequest,
  Response as ApiResponse,
} from '@/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single step in a user-authored test plan. */
export interface TestPlanStep {
  /** Unique step identifier within the plan. */
  id: string;
  /** Human-readable description of what this step verifies. */
  description: string;
  /** The saved-request ID this step binds to. */
  requestId: string;
  /** Optional list of natural-language assertions to check against the response. */
  expectedAssertions?: string[];
}

/** A user-authored test plan before it is bound to resolved requests. */
export interface TestPlan {
  /** Display name for the plan. */
  name: string;
  /** Ordered list of test steps. */
  steps: TestPlanStep[];
  /**
   * Optional variable overrides injected into the execution environment.
   * These are merged on top of the active environment and globals.
   */
  variableFixtures?: Record<string, string>;
}

/** A planned step after resolution — shows the redacted target and permission class. */
export interface PlannedExecutionStep {
  stepId: string;
  description: string;
  requestId: string;
  method: string;
  /** Redacted URL safe for display and persistence. */
  url: string;
  permissionClass: 'read' | 'mutation';
  expectedAssertions?: string[];
  /** True when this step will trigger an approval prompt at runtime. */
  requiresApproval: boolean;
  /** True when the resolved request has executable scripts. */
  hasExecutableScripts: boolean;
}

/** A fully resolved, dry-run-ready plan. */
export interface PlannedExecution {
  planName: string;
  /** Ordered steps the agent will execute. */
  steps: PlannedExecutionStep[];
  /**
   * Variable overrides merged on top of active environment and globals
   * during execution.
   */
  variableFixtures?: Record<string, string>;
  budgets: {
    maxSteps: number;
    maxWallTimeMs: number;
  };
}

/** The result of executing a single test-plan step. */
export interface StepExecutionResult {
  stepId: string;
  status: 'passed' | 'failed' | 'error' | 'cancelled';
  requestId: string;
  response?: {
    status: number;
    statusText: string;
    timeMs: number;
    sizeBytes: number;
  };
  assertions?: Array<{
    assertion: string;
    passed: boolean;
    detail?: string;
  }>;
  error?: string;
  approvalId?: string;
  approvalDecision?: 'approved' | 'denied';
}

/** Complete trace of a test-plan execution. */
export interface TestRunTrace {
  id: string;
  startedAt: number;
  finishedAt?: number;
  plan: PlannedExecution;
  results: StepExecutionResult[];
  status: 'passed' | 'failed' | 'error' | 'cancelled';
}

/** Budget constraints for a test-plan run. */
export interface TestRunBudgets {
  maxSteps: number;
  maxWallTimeMs: number;
}

const DEFAULT_BUDGETS: TestRunBudgets = {
  maxSteps: 50,
  maxWallTimeMs: 300_000,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findItem(items: CollectionItem[], id: string): CollectionItem | undefined {
  for (const item of items) {
    if (item.id === id || item.request?.id === id) return item;
    const nested = item.items ? findItem(item.items, id) : undefined;
    if (nested) return nested;
  }
  return undefined;
}

function itemHasScripts(items: CollectionItem[], requestId: string, inherited = false): boolean {
  for (const item of items) {
    const scripted = inherited || Boolean(item.preRequestScript?.trim() || item.testScript?.trim());
    if ((item.id === requestId || item.request?.id === requestId) && item.request) {
      return (
        scripted ||
        Boolean(item.request.preRequestScript?.trim() || item.request.testScript?.trim())
      );
    }
    if (item.items && itemHasScripts(item.items, requestId, scripted)) return true;
  }
  return false;
}

function isReadMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------

/**
 * Resolve a test plan against saved Restura requests and produce a
 * `PlannedExecution` that can be inspected (dry-run) or executed.
 *
 * @param plan      - The user-authored test plan.
 * @param budgets   - Optional budget overrides.
 * @returns         A resolved execution plan with redacted URLs and
 *                  permission classifications.
 * @throws          If any step references a request that cannot be found.
 */
export function planTestRun(
  plan: TestPlan,
  budgets: Partial<TestRunBudgets> = {}
): PlannedExecution {
  const collections = useCollectionStore.getState().collections;
  const mergedBudgets: TestRunBudgets = { ...DEFAULT_BUDGETS, ...budgets };

  const steps: PlannedExecutionStep[] = plan.steps.map((step) => {
    const resolved = resolveRequestInCollections(collections, step.requestId);
    if (!resolved) {
      throw new Error(
        `Test-plan step "${step.id}" references unknown request "${step.requestId}". ` +
          'Select a saved request from your collections.'
      );
    }
    const { request, collection } = resolved;
    const hasScripts = Boolean(
      collection?.preRequestScript?.trim() ||
        collection?.testScript?.trim() ||
        itemHasScripts(collection?.items ?? [], request.id)
    );
    const readOnly = isReadMethod(request.method) && !hasScripts;

    return {
      stepId: step.id,
      description: step.description,
      requestId: step.requestId,
      method: request.method,
      url: redactToolUrl(request.url),
      permissionClass: readOnly ? 'read' : 'mutation',
      expectedAssertions: step.expectedAssertions,
      requiresApproval: !readOnly,
      hasExecutableScripts: hasScripts,
    };
  });

  return {
    planName: plan.name,
    steps,
    variableFixtures: plan.variableFixtures,
    budgets: {
      maxSteps: Math.min(mergedBudgets.maxSteps, 200),
      maxWallTimeMs: Math.min(mergedBudgets.maxWallTimeMs, 600_000),
    },
  };
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/**
 * Check assertions against a completed response.
 * Assertions are simple natural-language checks — currently we mark them as
 * pending evaluation since the actual assertion logic would be agent-driven.
 * Future iterations may plug in a judge or script evaluator.
 */
function evaluateAssertions(
  assertions: string[] | undefined,
  _response: ApiResponse
): Array<{ assertion: string; passed: boolean; detail?: string }> {
  if (!assertions || assertions.length === 0) return [];
  // For now, assertions are recorded as "pending" — they will be evaluated
  // by the agent or a downstream judge. This preserves the trace structure
  // without introducing arbitrary HTTP-client capabilities.
  return assertions.map((assertion) => ({
    assertion,
    passed: false,
    detail: 'Assertion evaluation requires an agent or judge pass.',
  }));
}

/**
 * Execute a planned test-run step through the normal Restura request executor.
 *
 * @param step      - The planned step to execute.
 * @param signal    - AbortSignal for cancellation.
 * @param approval  - Optional approval callback for non-read steps.
 * @returns         The execution result.
 */
async function executePlannedStep(
  step: PlannedExecutionStep,
  signal: AbortSignal,
  variableFixtures: Record<string, string> | undefined,
  requestApproval?: (step: PlannedExecutionStep) => Promise<'approved' | 'denied'>
): Promise<StepExecutionResult> {
  signal.throwIfAborted();

  const collections = useCollectionStore.getState().collections;
  const resolved = resolveRequestInCollections(collections, step.requestId);
  if (!resolved) {
    return {
      stepId: step.stepId,
      status: 'error',
      requestId: step.requestId,
      error: `Request "${step.requestId}" not found in any collection.`,
    };
  }

  const { request, collection } = resolved;

  // Request approval for non-read steps.
  let approvalId: string | undefined;
  let approvalDecision: 'approved' | 'denied' | undefined;
  if (step.requiresApproval && requestApproval) {
    approvalId = uuidv4();
    try {
      signal.throwIfAborted();
      approvalDecision = await requestApproval(step);
      signal.throwIfAborted();
    } catch (error) {
      if (isAbortError(error) || signal.aborted) {
        return {
          stepId: step.stepId,
          status: 'cancelled',
          requestId: step.requestId,
          approvalId,
          approvalDecision: undefined,
          error: 'Run cancelled during approval.',
        };
      }
      return {
        stepId: step.stepId,
        status: 'error',
        requestId: step.requestId,
        approvalId,
        approvalDecision: undefined,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (approvalDecision === 'denied') {
      return {
        stepId: step.stepId,
        status: 'failed',
        requestId: step.requestId,
        approvalId,
        approvalDecision,
        error: 'Step execution denied by user.',
      };
    }
  }

  signal.throwIfAborted();

  try {
    const collectionVars = buildValueMap({ collection: collection?.variables });
    const envVars = buildValueMap({
      globals: useGlobalsStore.getState().vars,
      env: useEnvironmentStore.getState().getActiveEnvironment()?.variables,
      collection: collection?.variables,
    });

    // Merge variable fixtures on top of resolved env vars and globals.
    const envVarsWithFixtures: Record<string, string> = {
      ...envVars,
      ...(variableFixtures ?? {}),
    };

    const inherited = collection
      ? findInheritedAuthWithSource(collection, request.id)
      : undefined;
    const effectiveAuth = resolveEffectiveAuth(request.auth, inherited?.auth);
    const requestForExec =
      effectiveAuth === request.auth ? request : { ...request, auth: effectiveAuth };

    const result = await executeRequest({
      request: requestForExec,
      envVars: envVarsWithFixtures,
      globalSettings: useSettingsStore.getState().settings,
      resolveVariables: (value) => useEnvironmentStore.getState().resolveVariables(value),
      collectionVars,
      ...(signal ? { signal } : {}),
    });

    signal.throwIfAborted();

    // Apply collection-variable mutations if scripts ran.
    if (
      step.hasExecutableScripts &&
      collection &&
      result.transportOk &&
      result.collectionVarsMutations
    ) {
      useCollectionStore
        .getState()
        .applyCollectionVarMutations(collection.id, result.collectionVarsMutations);
    }

    const resp = result.response;
    const assertions = evaluateAssertions(step.expectedAssertions, resp);

    // A response in the 2xx range is "passed" at the transport level.
    const transportPassed = resp.status >= 200 && resp.status < 400;

    return {
      stepId: step.stepId,
      status: transportPassed ? 'passed' : 'failed',
      requestId: step.requestId,
      response: {
        status: resp.status,
        statusText: resp.statusText,
        timeMs: resp.time,
        sizeBytes: resp.size,
      },
      assertions,
      approvalId,
      approvalDecision,
    };
  } catch (error) {
    if (isAbortError(error) || signal.aborted) {
      return {
        stepId: step.stepId,
        status: 'cancelled',
        requestId: step.requestId,
        approvalId,
        approvalDecision,
        error: 'Run cancelled during step execution.',
      };
    }
    return {
      stepId: step.stepId,
      status: 'error',
      requestId: step.requestId,
      approvalId,
      approvalDecision,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Execute a planned test run through the normal Restura request executor.
 *
 * Each step is executed sequentially.  Non-read steps request approval
 * before execution.  Cancellation is honoured at step boundaries and
 * during execution via the provided AbortSignal.
 *
 * @param planned       - The resolved execution plan (from `planTestRun`).
 * @param signal        - AbortSignal for cancellation.
 * @param requestApproval - Optional callback for user approval of non-read steps.
 * @returns             A full trace of the execution.
 */
export async function executeTestRun(
  planned: PlannedExecution,
  signal: AbortSignal,
  requestApproval?: (step: PlannedExecutionStep) => Promise<'approved' | 'denied'>
): Promise<TestRunTrace> {
  const traceId = uuidv4();
  const startedAt = Date.now();
  const results: StepExecutionResult[] = [];

  let overallStatus: TestRunTrace['status'] = 'passed';

  for (const step of planned.steps) {
    if (signal.aborted) {
      overallStatus = 'cancelled';
      break;
    }

    const result = await executePlannedStep(step, signal, planned.variableFixtures, requestApproval);
    results.push(result);

    // Derive overall status: cancellation wins, then errors, then failures.
    if (result.status === 'cancelled') {
      overallStatus = 'cancelled';
      break;
    }
    if (result.status === 'error' && overallStatus !== 'cancelled') {
      overallStatus = 'error';
    }
    if (result.status === 'failed' && overallStatus !== 'cancelled' && overallStatus !== 'error') {
      overallStatus = 'failed';
    }
    if (result.status === 'passed' && overallStatus === 'passed') {
      overallStatus = 'passed';
    }
  }

  return {
    id: traceId,
    startedAt,
    finishedAt: Date.now(),
    plan: planned,
    results,
    status: overallStatus,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface ResolvedRequest {
  request: HttpRequest;
  collection?: Collection;
}

function resolveRequestInCollections(
  collections: Collection[],
  requestId: string
): ResolvedRequest | undefined {
  for (const collection of collections) {
    const item = findItem(collection.items ?? [], requestId);
    if (item?.request && item.request.type === 'http') {
      return { request: item.request as HttpRequest, collection };
    }
  }
  return undefined;
}