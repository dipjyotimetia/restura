import { isOwsBindings, type OwsBindings, type OwsTaskBinding } from './bindings';
import { evaluateOwsCondition, readOwsPath, resolveOwsValue } from './runtime-expression';
import { normalizeOwsWorkflow, type OwsWorkflow, validateOwsProfile } from './workflow-profile';

export const MAX_OWS_ITERATIONS = 1_000;
export const MAX_OWS_EXECUTED_TASKS = 10_000;

export type OwsExecutionStatus = 'success' | 'failed' | 'skipped' | 'stopped';

export interface OwsExecutionStep {
  taskPath: string;
  name: string;
  kind: 'call' | 'do' | 'for' | 'try' | 'wait' | 'set';
  status: OwsExecutionStatus;
  startedAt: number;
  completedAt: number;
  iteration?: number;
  error?: string;
}

export interface OwsExecutionResult {
  status: OwsExecutionStatus;
  steps: OwsExecutionStep[];
  variables: Record<string, unknown>;
  output?: unknown;
}

/**
 * Deliberately transport-free boundary for a future platform dispatcher.
 * It receives only an approved resource reference and execution cancellation;
 * OWS endpoint, headers, credentials, and adapter configuration never cross it.
 */
export interface OwsBoundCallRequest {
  taskPath: string;
  binding: OwsTaskBinding;
  call: 'http';
  method: string;
  /** Immutable workflow-scope snapshot at dispatch time. */
  variables: Record<string, unknown>;
  signal: AbortSignal;
  timeoutMs?: number;
}

export interface OwsCallDispatcher {
  dispatch(request: OwsBoundCallRequest): Promise<unknown>;
}

export interface OwsExecutorOptions {
  workflow: OwsWorkflow;
  bindings: OwsBindings;
  variables: Record<string, unknown>;
  dispatcher: OwsCallDispatcher;
  /** Optional caller-owned cap applied to the entire workflow and every call. */
  timeoutMs?: number;
  signal?: AbortSignal;
  onStep?: (step: OwsExecutionStep) => void;
}

class OwsTimeoutError extends Error {}
class OwsStoppedError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function taskKind(task: Record<string, unknown>): OwsExecutionStep['kind'] {
  if ('call' in task) return 'call';
  if ('for' in task) return 'for';
  if ('try' in task) return 'try';
  if ('do' in task) return 'do';
  if ('wait' in task) return 'wait';
  return 'set';
}

function durationMs(value: unknown): number {
  if (!isRecord(value)) return 0;
  return (
    (typeof value.days === 'number' ? value.days * 86_400_000 : 0) +
    (typeof value.hours === 'number' ? value.hours * 3_600_000 : 0) +
    (typeof value.minutes === 'number' ? value.minutes * 60_000 : 0) +
    (typeof value.seconds === 'number' ? value.seconds * 1000 : 0) +
    (typeof value.milliseconds === 'number' ? value.milliseconds : 0)
  );
}

function timeoutMs(value: unknown): number | undefined {
  return isRecord(value) && 'after' in value ? durationMs(value.after) : undefined;
}

function signalError(signal: AbortSignal): Error {
  if (signal.reason instanceof OwsTimeoutError) return signal.reason;
  if (signal.reason instanceof OwsStoppedError) return signal.reason;
  return new OwsStoppedError('OWS workflow stopped.');
}

interface ExecutionScope {
  signal: AbortSignal;
  dispose: () => void;
}

function createExecutionScope(
  parent: AbortSignal | undefined,
  timeout: number | undefined,
  timeoutMessage: string
): ExecutionScope {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent ? signalError(parent) : undefined);
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener('abort', abortFromParent, { once: true });

  const timer =
    timeout === undefined
      ? undefined
      : setTimeout(() => controller.abort(new OwsTimeoutError(timeoutMessage)), timeout);
  return {
    signal: controller.signal,
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
      parent?.removeEventListener('abort', abortFromParent);
    },
  };
}

async function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signalError(signal);
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(signalError(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function withinScope<T>(
  parent: AbortSignal,
  timeout: number | undefined,
  timeoutMessage: string,
  operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const scope = createExecutionScope(parent, timeout, timeoutMessage);
  try {
    if (scope.signal.aborted) throw signalError(scope.signal);
    const result = Promise.resolve().then(() => operation(scope.signal));
    return await new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        scope.signal.removeEventListener('abort', onAbort);
        reject(signalError(scope.signal));
      };
      scope.signal.addEventListener('abort', onAbort, { once: true });
      result.then(
        (value) => {
          scope.signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error: unknown) => {
          scope.signal.removeEventListener('abort', onAbort);
          reject(error);
        }
      );
    });
  } finally {
    scope.dispose();
  }
}

function collectCallPaths(list: unknown, path: string, output: string[]): void {
  if (!Array.isArray(list)) return;
  for (const [index, entry] of list.entries()) {
    if (!isRecord(entry) || Object.keys(entry).length !== 1) continue;
    const first = Object.entries(entry)[0];
    if (!first) continue;
    const [name, task] = first;
    if (!isRecord(task)) continue;
    const taskPath = `${path}/${index}/${name}`;
    if ('call' in task) output.push(taskPath);
    if ('do' in task) collectCallPaths(task.do, `${taskPath}/do`, output);
    if ('try' in task) collectCallPaths(task.try, `${taskPath}/try`, output);
    if (isRecord(task.catch) && 'do' in task.catch) {
      collectCallPaths(task.catch.do, `${taskPath}/catch/do`, output);
    }
  }
}

/** Executes only the profile controls the local executor can enforce. */
export async function executeOwsWorkflow(options: OwsExecutorOptions): Promise<OwsExecutionResult> {
  const workflow = normalizeOwsWorkflow(options.workflow);
  const profile = validateOwsProfile(workflow);
  if (!profile.ok) {
    throw new Error(
      `OWS workflow is outside Restura's executable profile: ${profile.issues[0]?.message}`
    );
  }
  if (!isOwsBindings(options.bindings)) {
    throw new Error('OWS bindings must contain only approved typed resource references.');
  }
  const callPaths: string[] = [];
  collectCallPaths(workflow.do, '/do', callPaths);
  const callPathSet = new Set(callPaths);
  for (const taskPath of callPaths) {
    if (!options.bindings.tasks[taskPath]) {
      throw new Error(`OWS call ${taskPath} is missing an approved binding.`);
    }
  }
  for (const taskPath of Object.keys(options.bindings.tasks)) {
    if (!callPathSet.has(taskPath)) {
      throw new Error(`OWS binding task path does not exist: ${taskPath}`);
    }
  }
  if (
    options.timeoutMs !== undefined &&
    (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
  ) {
    throw new Error('OWS execution timeout cap must be a positive finite number.');
  }
  const variables = { ...options.variables };
  const steps: OwsExecutionStep[] = [];
  const documentTimeout = timeoutMs(workflow.timeout);
  const workflowTimeout =
    options.timeoutMs === undefined
      ? documentTimeout
      : documentTimeout === undefined
        ? options.timeoutMs
        : Math.min(documentTimeout, options.timeoutMs);
  const workflowScope = createExecutionScope(
    options.signal,
    workflowTimeout,
    'OWS workflow timed out.'
  );

  let executedTasks = 0;
  const executeList = async (
    list: unknown,
    path: string,
    parentSignal: AbortSignal,
    iteration?: number
  ): Promise<void> => {
    if (!Array.isArray(list)) throw new Error(`Invalid OWS task list at ${path}.`);
    for (const [index, entry] of list.entries()) {
      if (parentSignal.aborted) throw signalError(parentSignal);
      if (!isRecord(entry) || Object.keys(entry).length !== 1) {
        throw new Error(`Invalid OWS task at ${path}/${index}.`);
      }
      const first = Object.entries(entry)[0];
      if (!first) throw new Error(`Invalid OWS task at ${path}/${index}.`);
      const [name, taskValue] = first;
      if (!isRecord(taskValue)) throw new Error(`Invalid OWS task at ${path}/${index}/${name}.`);
      const taskPath = `${path}/${index}/${name}`;
      executedTasks += 1;
      if (executedTasks > MAX_OWS_EXECUTED_TASKS) {
        throw new Error(
          `OWS workflow exceeded the ${MAX_OWS_EXECUTED_TASKS} task execution limit.`
        );
      }
      const startedAt = Date.now();
      const step: OwsExecutionStep = {
        taskPath,
        name,
        kind: taskKind(taskValue),
        status: 'success',
        startedAt,
        completedAt: startedAt,
        ...(iteration === undefined ? {} : { iteration }),
      };
      try {
        if (taskValue.if !== undefined && !evaluateOwsCondition(String(taskValue.if), variables)) {
          step.status = 'skipped';
          step.completedAt = Date.now();
          steps.push(step);
          options.onStep?.(step);
          continue;
        }
        await withinScope(
          parentSignal,
          timeoutMs(taskValue.timeout),
          'OWS task timed out.',
          async (signal) => {
            if ('set' in taskValue) {
              const set = resolveOwsValue(taskValue.set, variables);
              if (!isRecord(set))
                throw new Error(`OWS set task ${taskPath} must assign an object.`);
              Object.assign(variables, set);
            } else if ('wait' in taskValue) {
              await wait(durationMs(taskValue.wait), signal);
            } else if ('call' in taskValue) {
              const binding = options.bindings.tasks[taskPath];
              if (!binding) throw new Error(`OWS call ${taskPath} is missing an approved binding.`);
              const withArgs = taskValue.with;
              if (!isRecord(withArgs) || typeof withArgs.method !== 'string') {
                throw new Error(`OWS call ${taskPath} has an invalid binding-only HTTP form.`);
              }
              const taskTimeout = timeoutMs(taskValue.timeout);
              const callTimeout =
                options.timeoutMs === undefined
                  ? taskTimeout
                  : taskTimeout === undefined
                    ? options.timeoutMs
                    : Math.min(taskTimeout, options.timeoutMs);
              variables[name] = await options.dispatcher.dispatch({
                taskPath,
                binding,
                call: 'http',
                method: withArgs.method,
                variables: { ...variables },
                signal,
                ...(callTimeout === undefined ? {} : { timeoutMs: callTimeout }),
              });
            } else if ('for' in taskValue) {
              const config = taskValue.for;
              if (
                !isRecord(config) ||
                typeof config.in !== 'string' ||
                typeof config.each !== 'string'
              ) {
                throw new Error(`OWS for task ${taskPath} has an invalid iterator configuration.`);
              }
              const items = readOwsPath(variables, config.in);
              if (!Array.isArray(items)) {
                throw new Error(`OWS for task ${taskPath} requires an array value.`);
              }
              if (items.length > MAX_OWS_ITERATIONS) {
                throw new Error(
                  `OWS for task ${taskPath} exceeds the ${MAX_OWS_ITERATIONS} iteration limit.`
                );
              }
              const indexName = typeof config.at === 'string' ? config.at : undefined;
              const previousItem = variables[config.each];
              const hadPreviousItem = Object.prototype.hasOwnProperty.call(variables, config.each);
              const previousIndex = indexName ? variables[indexName] : undefined;
              const hadPreviousIndex = indexName
                ? Object.prototype.hasOwnProperty.call(variables, indexName)
                : false;
              try {
                for (const [itemIndex, item] of items.entries()) {
                  variables[config.each] = item;
                  if (indexName) variables[indexName] = itemIndex;
                  await executeList(taskValue.do, `${taskPath}/do`, signal, itemIndex);
                }
              } finally {
                if (hadPreviousItem) variables[config.each] = previousItem;
                else delete variables[config.each];
                if (indexName) {
                  if (hadPreviousIndex) variables[indexName] = previousIndex;
                  else delete variables[indexName];
                }
              }
            } else if ('try' in taskValue) {
              try {
                await executeList(taskValue.try, `${taskPath}/try`, signal, iteration);
              } catch (error) {
                if (error instanceof OwsStoppedError || error instanceof OwsTimeoutError)
                  throw error;
                const catchConfig = taskValue.catch;
                if (!isRecord(catchConfig)) throw error;
                const errorName = typeof catchConfig.as === 'string' ? catchConfig.as : 'error';
                variables[errorName] = {
                  message: error instanceof Error ? error.message : 'Unknown workflow error.',
                };
                if ('do' in catchConfig) {
                  await executeList(catchConfig.do, `${taskPath}/catch/do`, signal, iteration);
                }
              }
            } else if ('do' in taskValue) {
              await executeList(taskValue.do, `${taskPath}/do`, signal);
            } else {
              throw new Error(`OWS task ${taskPath} is not implemented by the safe executor.`);
            }
          }
        );
      } catch (error) {
        step.status = error instanceof OwsStoppedError ? 'stopped' : 'failed';
        step.error = error instanceof Error ? error.message : 'Unknown OWS execution error.';
        step.completedAt = Date.now();
        steps.push(step);
        options.onStep?.(step);
        throw error;
      }
      step.completedAt = Date.now();
      steps.push(step);
      options.onStep?.(step);
    }
  };

  try {
    await executeList(workflow.do, '/do', workflowScope.signal);
    const output =
      isRecord(workflow) && isRecord(workflow.output) && 'as' in workflow.output
        ? resolveOwsValue(workflow.output.as, variables)
        : undefined;
    return { status: 'success', steps, variables, ...(output === undefined ? {} : { output }) };
  } catch (error) {
    return { status: error instanceof OwsStoppedError ? 'stopped' : 'failed', steps, variables };
  } finally {
    workflowScope.dispose();
  }
}
