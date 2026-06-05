/**
 * Protocol-agnostic DAG executor for graph-authored workflows. Walks
 * `workflow.graph` from `start` and dispatches each node kind through
 * the protocol registry. `ctx.signal` threads through every long-lived
 * call so Stop aborts cleanly. Parallel branches get isolated variable
 * scopes with conflict detection; sub-workflows get isolated scopes
 * with explicit input/output mapping; tryCatch respects each request
 * node's `failureMode` to decide what counts as failure.
 */
import { v4 as uuidv4 } from 'uuid';
import type {
  Workflow,
  WorkflowGraph,
  WorkflowExecution,
  WorkflowExecutionStep,
  FlowNode,
  FlowEdge,
  Request,
  AuthConfig,
  RequestFailureMode,
  ParallelWaitMode,
  ParallelMergeStrategy,
  CompletionPolicy,
  SseSubscribeFlowNode,
  WsExchangeFlowNode,
  McpCallFlowNode,
} from '@/types';
import { protocolRegistry } from '@/features/registry/registry';
import type { RunContext, ProtocolStreamHandle } from '@/features/registry/types';
import type { McpClient } from '@/features/mcp/lib/mcpClient';
import type { McpClientPool, McpRunJsonRpcOptions } from '@/features/mcp/protocol';
import { extractVariables } from './variableExtractor';
import { injectString } from './variableHelpers';
import { executeWithRetry, sleepWithAbort, isAbortError } from './retryHelpers';
import { validateURL } from '@shared/protocol/url-validation';
import {
  evalScriptBoolean,
  evalScriptValue,
  evalScriptForVariables,
  createPooledScriptEvaluator,
  type PooledEvaluator,
} from './scriptHelpers';
import { findStartNode, getOutgoingEdges, getNodeById } from './flowTypes';
import { validateWorkflowGraph } from './flowValidators';
import { withEffectiveAuth } from '@/features/auth/lib/authInheritance';

export interface DagExecutorOptions {
  workflow: Workflow;
  getRequestById: (id: string) => Request | undefined;
  getWorkflowById?: (id: string) => Workflow | undefined;
  /**
   * Folder/collection auth a request inherits when its own auth is 'none'
   * (nearest ancestor wins — see `resolveInheritedAuthFor`). Applied to
   * request nodes only; SSE/MCP nodes use separate header pipelines and are
   * excluded (matches the single-send limitation).
   */
  getInheritedAuth?: (requestId: string) => AuthConfig | undefined;
  envVars: Record<string, string>;
  /** Variables map at the seed (env + dynamic). DAG mutates a clone. */
  resolveDynamicVariables?: (text: string) => string;
  onStepStart?: (step: WorkflowExecutionStep) => void;
  onStepComplete?: (step: WorkflowExecutionStep) => void;
  onLog?: (message: string, level: 'info' | 'warn' | 'error') => void;
  abortSignal?: AbortSignal;
  /** Internal — sub-workflow recursion guard (workflowId stack). */
  callStack?: ReadonlyArray<string>;
}

type Logger = (message: string, level?: 'info' | 'warn' | 'error') => void;

export async function executeDag(options: DagExecutorOptions): Promise<WorkflowExecution> {
  const { workflow, abortSignal, onStepStart, onStepComplete, onLog } = options;

  if (!workflow.graph) {
    throw new Error('executeDag called with no graph on workflow');
  }

  const execution: WorkflowExecution = {
    id: uuidv4(),
    workflowId: workflow.id,
    workflowName: workflow.name,
    startedAt: Date.now(),
    status: 'running',
    steps: [],
    finalVariables: { ...options.envVars },
    executionLog: [],
  };

  const log: Logger = (message, level = 'info') => {
    execution.executionLog.push({ timestamp: Date.now(), message, level });
    onLog?.(message, level);
  };

  log(`Starting graph workflow: ${workflow.name}`);

  // Seed workflow-level variables (matches the legacy executor's behaviour).
  if (workflow.variables) {
    for (const v of workflow.variables) {
      if (v.enabled) execution.finalVariables[v.key] = v.value;
    }
  }

  const validation = validateWorkflowGraph(workflow.graph);
  if (!validation.ok) {
    execution.status = 'failed';
    execution.completedAt = Date.now();
    const msg = `Graph validation failed: ${validation.issues
      .map((i) => `${i.path}: ${i.message}`)
      .join('; ')}`;
    log(msg, 'error');
    return execution;
  }

  const callStack = options.callStack ?? [];
  if (callStack.includes(workflow.id)) {
    execution.status = 'failed';
    execution.completedAt = Date.now();
    log(`Sub-workflow cycle detected: ${[...callStack, workflow.id].join(' -> ')}`, 'error');
    return execution;
  }

  const mcpClientPool: Map<string, McpClient> = new Map();

  try {
    await runGraph({
      graph: validation.graph,
      variables: execution.finalVariables,
      workflow,
      options,
      execution,
      log,
      abortSignal,
      callStack: [...callStack, workflow.id],
      mcpClientPool,
      onStepStart,
      onStepComplete,
    });
    execution.status = execution.status === 'running' ? 'success' : execution.status;
  } catch (err) {
    if (isAbortError(err)) {
      execution.status = 'stopped';
      log('Workflow aborted', 'warn');
    } else {
      execution.status = 'failed';
      const msg = err instanceof Error ? err.message : String(err);
      log(`Workflow failed: ${msg}`, 'error');
    }
  } finally {
    // Tear down pooled MCP clients in parallel — we don't await
    // sequentially since a slow disconnect shouldn't block the others.
    await Promise.all(
      Array.from(mcpClientPool.values()).map((c) => c.disconnect().catch(() => undefined))
    );
    mcpClientPool.clear();
    execution.completedAt = Date.now();
  }

  log(
    `Workflow ${execution.status}: ${execution.steps.filter((s) => s.status === 'success').length}/${execution.steps.length} steps completed`
  );

  return execution;
}

// ---------- core graph traversal ----------

interface RunGraphArgs {
  graph: WorkflowGraph;
  variables: Record<string, string>;
  workflow: Workflow;
  options: DagExecutorOptions;
  execution: WorkflowExecution;
  log: Logger;
  abortSignal?: AbortSignal;
  callStack: ReadonlyArray<string>;
  /** Per-run MCP client pool keyed by WorkflowRequest id. Initialised
   *  in `executeDag` and disposed in its finally block. Lets multiple
   *  mcpCall nodes hitting the same MCP server share one initialized
   *  session instead of paying the initialize round-trip N times. */
  mcpClientPool: Map<string, McpClient>;
  onStepStart?: (step: WorkflowExecutionStep) => void;
  onStepComplete?: (step: WorkflowExecutionStep) => void;
}

async function runGraph(args: RunGraphArgs): Promise<void> {
  const start = findStartNode(args.graph);
  if (!start) {
    throw new Error('Graph has no start node');
  }
  await walkFrom(start, args, new Set());
}

/**
 * Walk forward from a node. Tracks the set of nodes ALREADY VISITED on this
 * branch so a join node (multiple incoming edges) is only entered once per
 * sibling — we follow the first incoming edge that reaches it.
 *
 * For v1 we use a "single-token" traversal: each branch is its own
 * recursion. Parallel splits explicitly fan out via `runParallel`. This
 * keeps the executor simple at the cost of NOT auto-syncing diamond
 * patterns (`a -> {b, c} -> d` doesn't wait at d). Users wanting a sync
 * point use a `parallel` node.
 */
async function walkFrom(node: FlowNode, args: RunGraphArgs, visited: Set<string>): Promise<void> {
  if (args.abortSignal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
  if (visited.has(node.id)) return;
  visited.add(node.id);

  if (node.kind === 'end') return;
  if (node.kind === 'start') {
    return walkOutgoing(node, args, visited);
  }

  if (node.kind === 'parallel') {
    await runParallel(node, args, visited);
    return;
  }

  // Linear (non-parallel) nodes: execute, then follow outgoing edges.
  await executeNode(node, args);
  return walkOutgoing(node, args, visited);
}

async function walkOutgoing(
  node: FlowNode,
  args: RunGraphArgs,
  visited: Set<string>
): Promise<void> {
  const out = getOutgoingEdges(args.graph, node.id);

  // condition + switch route to exactly one outgoing edge, chosen by the
  // handle stashed on a transient variable in executeNode (keeps the walker
  // stateless). switch additionally falls back to the 'default' handle.
  const routing =
    node.kind === 'condition'
      ? { key: '__restura_condition_' + node.id, fallback: undefined }
      : node.kind === 'switch'
        ? { key: '__restura_switch_' + node.id, fallback: 'default' }
        : null;

  if (routing) {
    const branch = args.variables[routing.key];
    delete args.variables[routing.key];
    const edge =
      out.find((e) => e.sourceHandle === branch) ??
      (routing.fallback ? out.find((e) => e.sourceHandle === routing.fallback) : undefined);
    if (!edge) return;
    const next = getNodeById(args.graph, edge.target);
    if (next) await walkFrom(next, args, visited);
    return;
  }

  for (const edge of out) {
    const next = getNodeById(args.graph, edge.target);
    if (next) await walkFrom(next, args, visited);
  }
}

// ---------- per-node execution ----------

async function executeNode(node: FlowNode, args: RunGraphArgs): Promise<void> {
  const { log } = args;
  if (args.abortSignal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  switch (node.kind) {
    case 'request':
      return runRequestNode(node, args);
    case 'condition': {
      const result = await evalScriptBoolean(node.data.expression, {
        variables: args.variables,
      });
      log(`Condition ${node.id}: ${result}`);
      // Stash the branch label so walkOutgoing can route.
      args.variables['__restura_condition_' + node.id] = String(result);
      pushStep(args, {
        nodeId: node.id,
        nodeKind: 'condition',
        requestName: 'condition',
        status: 'success',
        timestamp: Date.now(),
      });
      return;
    }
    case 'switch': {
      // First case whose expression is truthy wins; else 'default'.
      let matched = 'default';
      for (const c of node.data.cases) {
        const hit = await evalScriptBoolean(c.expression, {
          variables: args.variables,
        });
        if (hit) {
          matched = c.id;
          break;
        }
      }
      log(`Switch ${node.id}: ${matched}`);
      args.variables['__restura_switch_' + node.id] = matched;
      pushStep(args, {
        nodeId: node.id,
        nodeKind: 'switch',
        requestName: 'switch',
        status: 'success',
        timestamp: Date.now(),
      });
      return;
    }
    case 'setVariable': {
      const step: WorkflowExecutionStep = {
        nodeId: node.id,
        nodeKind: 'setVariable',
        requestName: 'setVariable',
        status: 'running',
        timestamp: Date.now(),
      };
      args.onStepStart?.(step);
      const extracted: Record<string, string> = {};
      for (const a of node.data.assignments) {
        const result = await evalScriptValue(`return ${a.valueExpression};`, {
          variables: args.variables,
        });
        if (!result.ok) {
          step.status = 'failed';
          step.error = `Failed to evaluate ${a.key}: ${result.error}`;
          finishStep(args, step);
          throw new Error(step.error);
        }
        const stringified =
          typeof result.value === 'string' ? result.value : JSON.stringify(result.value);
        args.variables[a.key] = stringified;
        extracted[a.key] = stringified;
      }
      step.extractedVariables = extracted;
      step.status = 'success';
      step.duration = Date.now() - step.timestamp;
      finishStep(args, step);
      return;
    }
    case 'delay': {
      const step: WorkflowExecutionStep = {
        nodeId: node.id,
        nodeKind: 'delay',
        requestName: 'delay',
        status: 'running',
        timestamp: Date.now(),
      };
      args.onStepStart?.(step);
      await sleepWithAbort(node.data.ms, args.abortSignal);
      step.status = 'success';
      step.duration = Date.now() - step.timestamp;
      finishStep(args, step);
      return;
    }
    case 'transform': {
      const step: WorkflowExecutionStep = {
        nodeId: node.id,
        nodeKind: 'transform',
        requestName: 'transform',
        status: 'running',
        timestamp: Date.now(),
      };
      args.onStepStart?.(step);
      const result = await evalScriptForVariables(node.data.script, {
        variables: args.variables,
      });
      if (!result.ok) {
        step.status = 'failed';
        step.error = result.error;
        finishStep(args, step);
        throw new Error(`transform failed: ${result.error}`);
      }
      // Replace variables in place (preserve identity for caller's map).
      for (const k of Object.keys(args.variables)) delete args.variables[k];
      Object.assign(args.variables, result.variables);
      step.status = 'success';
      step.duration = Date.now() - step.timestamp;
      finishStep(args, step);
      return;
    }
    case 'template': {
      const step: WorkflowExecutionStep = {
        nodeId: node.id,
        nodeKind: 'template',
        requestName: 'template',
        status: 'running',
        timestamp: Date.now(),
      };
      args.onStepStart?.(step);
      const rendered = injectString(node.data.template, args.variables);
      args.variables[node.data.resultVar] = rendered;
      step.extractedVariables = { [node.data.resultVar]: rendered };
      step.status = 'success';
      step.duration = Date.now() - step.timestamp;
      finishStep(args, step);
      return;
    }
    case 'display': {
      const step: WorkflowExecutionStep = {
        nodeId: node.id,
        nodeKind: 'display',
        requestName: 'display',
        status: 'running',
        timestamp: Date.now(),
      };
      args.onStepStart?.(step);
      const result = await evalScriptValue(`return ${node.data.valueExpression};`, {
        variables: args.variables,
      });
      if (!result.ok) {
        step.status = 'failed';
        step.error = `display eval failed: ${result.error}`;
        finishStep(args, step);
        throw new Error(step.error);
      }
      const text = typeof result.value === 'string' ? result.value : JSON.stringify(result.value);
      const label = node.data.label || 'value';
      // Surface in the run monitor (extractedVariables) without polluting
      // the downstream scope beyond a namespaced handle.
      step.extractedVariables = { [label]: text };
      args.variables[`${node.id}.display`] = text;
      step.status = 'success';
      step.duration = Date.now() - step.timestamp;
      finishStep(args, step);
      return;
    }
    case 'forEach':
      return runForEach(node, args);
    case 'loop':
      return runLoop(node, args);
    case 'tryCatch':
      return runTryCatch(node, args);
    case 'subWorkflow':
      return runSubWorkflow(node, args);
    case 'sseSubscribe':
      return runSseSubscribe(node, args);
    case 'wsExchange':
      return runWsExchange(node, args);
    case 'mcpCall':
      return runMcpCall(node, args);
    case 'start':
    case 'end':
    case 'parallel':
      // Handled by walkFrom — should not reach here.
      return;
  }
}

async function runRequestNode(
  node: Extract<FlowNode, { kind: 'request' }>,
  args: RunGraphArgs
): Promise<void> {
  const { workflow, log } = args;
  const workflowRequest = workflow.requests.find((r) => r.id === node.data.workflowRequestId);
  if (!workflowRequest) {
    throw new Error(
      `Request node "${node.id}" points at missing WorkflowRequest "${node.data.workflowRequestId}"`
    );
  }
  const step: WorkflowExecutionStep = {
    nodeId: node.id,
    nodeKind: 'request',
    workflowRequestId: workflowRequest.id,
    requestId: workflowRequest.requestId,
    requestName: workflowRequest.name,
    status: 'running',
    timestamp: Date.now(),
  };
  args.onStepStart?.(step);

  // Precondition
  if (workflowRequest.precondition?.trim()) {
    const allowed = await evalScriptBoolean(workflowRequest.precondition, {
      variables: args.variables,
    });
    if (!allowed) {
      step.status = 'skipped';
      step.duration = Date.now() - step.timestamp;
      log(`Skipping "${workflowRequest.name}" — precondition not met`);
      finishStep(args, step);
      return;
    }
  }

  const rawRequest = args.options.getRequestById(workflowRequest.requestId);
  if (!rawRequest) {
    step.status = 'failed';
    step.error = `Request not found: ${workflowRequest.requestId}`;
    finishStep(args, step);
    throw new Error(step.error);
  }

  // Same nearest-ancestor auth inheritance as single sends and the linear
  // executor — the request's own configured auth always wins.
  const request = args.options.getInheritedAuth
    ? withEffectiveAuth(rawRequest, args.options.getInheritedAuth(workflowRequest.requestId))
    : rawRequest;

  const protocol = protocolRegistry.get(request.type);
  if (!protocol) {
    step.status = 'failed';
    step.error = `No protocol module registered for type "${request.type}"`;
    finishStep(args, step);
    throw new Error(step.error);
  }

  const injected = protocol.injectVariables
    ? protocol.injectVariables(request, args.variables)
    : request;

  try {
    const response = await executeWithRetry(
      async () => {
        const ctx: RunContext = {
          signal: args.abortSignal ?? new AbortController().signal,
          variables: { ...args.variables },
        };
        return protocol.runRequest(injected, ctx);
      },
      {
        policy: workflowRequest.retryPolicy ?? { maxAttempts: 1, delayMs: 0 },
        ...(args.abortSignal ? { signal: args.abortSignal } : {}),
        onRetry: (attempt, delay) => {
          log(`Retry ${attempt} for "${workflowRequest.name}" in ${delay}ms`, 'warn');
        },
      }
    );

    step.response = response;
    step.duration = Date.now() - step.timestamp;

    if (workflowRequest.extractVariables?.length) {
      const extracted = extractVariables(response, workflowRequest.extractVariables);
      step.extractedVariables = extracted;
      Object.assign(args.variables, extracted);
    }

    const failureMode: RequestFailureMode = node.data.failureMode ?? 'thrown-only';
    if (failureMode === 'http-status' && (response.status < 200 || response.status >= 300)) {
      step.status = 'failed';
      step.error = `HTTP ${response.status}: ${response.statusText}`;
      finishStep(args, step);
      throw new RequestNodeFailure(step.error, response.status);
    }

    step.status = 'success';
    finishStep(args, step);
  } catch (err) {
    if (err instanceof RequestNodeFailure) throw err;
    step.status = 'failed';
    step.error = err instanceof Error ? err.message : String(err);
    step.duration = Date.now() - step.timestamp;
    finishStep(args, step);
    throw err;
  }
}

class RequestNodeFailure extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = 'RequestNodeFailure';
  }
}

// ---------- parallel / forEach / tryCatch / subWorkflow ----------

async function runParallel(
  node: Extract<FlowNode, { kind: 'parallel' }>,
  args: RunGraphArgs,
  visited: Set<string>
): Promise<void> {
  const step: WorkflowExecutionStep = {
    nodeId: node.id,
    nodeKind: 'parallel',
    requestName: 'parallel',
    status: 'running',
    timestamp: Date.now(),
  };
  args.onStepStart?.(step);

  const outgoing = getOutgoingEdges(args.graph, node.id);
  const branches: Array<Promise<Record<string, string>>> = outgoing.map((edge) =>
    runBranch(edge, args, visited)
  );

  const waitMode: ParallelWaitMode = node.data.waitMode;
  const mergeStrategy: ParallelMergeStrategy = node.data.mergeStrategy ?? 'fail-on-conflict';

  try {
    let branchResults: Array<Record<string, string>>;
    if (waitMode === 'all') {
      branchResults = await Promise.all(branches);
    } else if (waitMode === 'any') {
      branchResults = [await Promise.any(branches)];
    } else {
      branchResults = [await Promise.race(branches)];
    }
    mergeBranchVariables(args.variables, branchResults, mergeStrategy);
    step.status = 'success';
    step.duration = Date.now() - step.timestamp;
    finishStep(args, step);
  } catch (err) {
    step.status = 'failed';
    step.error = err instanceof Error ? err.message : String(err);
    step.duration = Date.now() - step.timestamp;
    finishStep(args, step);
    throw err;
  }
}

async function runBranch(
  edge: FlowEdge,
  args: RunGraphArgs,
  parentVisited: Set<string>
): Promise<Record<string, string>> {
  // Each branch gets an isolated deep-cloned variables map.
  const branchVars: Record<string, string> = { ...args.variables };
  const branchArgs: RunGraphArgs = { ...args, variables: branchVars };
  const next = getNodeById(args.graph, edge.target);
  if (!next) return branchVars;
  // Branch visited set is independent of the parent's so a downstream
  // node reached via two parallel branches doesn't get skipped.
  const branchVisited = new Set(parentVisited);
  await walkFrom(next, branchArgs, branchVisited);
  return branchVars;
}

function mergeBranchVariables(
  target: Record<string, string>,
  branchResults: Array<Record<string, string>>,
  strategy: ParallelMergeStrategy
): void {
  // For each variable seen across branches, look at the values different
  // branches set; resolve per strategy. Variables only one branch touched
  // pass through unchanged.
  const seen = new Map<string, string[]>();
  for (const branch of branchResults) {
    for (const [k, v] of Object.entries(branch)) {
      if (target[k] === v) continue; // unchanged from seed
      if (!seen.has(k)) seen.set(k, []);
      seen.get(k)!.push(v);
    }
  }
  for (const [key, values] of seen) {
    const uniq = Array.from(new Set(values));
    if (uniq.length === 1) {
      target[key] = uniq[0]!;
      continue;
    }
    switch (strategy) {
      case 'fail-on-conflict':
        throw new Error(
          `Parallel merge conflict on variable "${key}": branches produced ${JSON.stringify(uniq)}`
        );
      case 'pick-first':
        target[key] = values[0]!;
        break;
      case 'pick-last':
        target[key] = values[values.length - 1]!;
        break;
      case 'merge-list':
        target[key] = JSON.stringify(values);
        break;
    }
  }
}

async function runForEach(
  node: Extract<FlowNode, { kind: 'forEach' }>,
  args: RunGraphArgs
): Promise<void> {
  const step: WorkflowExecutionStep = {
    nodeId: node.id,
    nodeKind: 'forEach',
    requestName: 'forEach',
    status: 'running',
    timestamp: Date.now(),
  };
  args.onStepStart?.(step);

  const collectionResult = await evalScriptValue(`return ${node.data.collectionExpression};`, {
    variables: args.variables,
  });
  if (!collectionResult.ok) {
    step.status = 'failed';
    step.error = `forEach collection eval failed: ${collectionResult.error}`;
    finishStep(args, step);
    throw new Error(step.error);
  }
  const items = collectionResult.value;
  if (!Array.isArray(items)) {
    step.status = 'failed';
    step.error = 'forEach collection did not evaluate to an array';
    finishStep(args, step);
    throw new Error(step.error);
  }

  const concurrency = Math.max(1, Math.min(node.data.concurrency ?? 8, 64));
  const allResults: unknown[] = new Array(items.length);

  let cursor = 0;
  const workers: Array<Promise<void>> = [];
  for (let w = 0; w < Math.min(concurrency, items.length); w++) {
    workers.push(
      (async () => {
        while (true) {
          if (args.abortSignal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
          }
          const i = cursor++;
          if (i >= items.length) return;
          const item = items[i];
          const iterVars: Record<string, string> = { ...args.variables };
          iterVars[node.data.iteratorVar] = JSON.stringify(item);
          const iterArgs: RunGraphArgs = {
            ...args,
            graph: node.data.subgraph,
            variables: iterVars,
          };
          // Each iteration walks its own subgraph from start.
          await runGraph(iterArgs);
          allResults[i] = iterVars;
        }
      })()
    );
  }
  try {
    await Promise.all(workers);
    args.variables[`${node.id}.results`] = JSON.stringify(allResults);
    step.status = 'success';
    step.duration = Date.now() - step.timestamp;
    finishStep(args, step);
  } catch (err) {
    step.status = 'failed';
    step.error = err instanceof Error ? err.message : String(err);
    step.duration = Date.now() - step.timestamp;
    finishStep(args, step);
    throw err;
  }
}

async function runLoop(
  node: Extract<FlowNode, { kind: 'loop' }>,
  args: RunGraphArgs
): Promise<void> {
  const step: WorkflowExecutionStep = {
    nodeId: node.id,
    nodeKind: 'loop',
    requestName: 'loop',
    status: 'running',
    timestamp: Date.now(),
  };
  args.onStepStart?.(step);

  // Hard cap mirrors the Zod ceiling — defends against a runaway condition.
  const max = Math.max(1, Math.min(node.data.maxIterations, 100_000));
  let iterations = 0;
  try {
    while (iterations < max) {
      if (args.abortSignal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      const cond = await evalScriptBoolean(node.data.conditionExpression, {
        variables: args.variables,
      });
      // 'while' runs while truthy; 'until' runs until truthy (i.e. while falsy).
      const shouldRun = node.data.mode === 'while' ? cond : !cond;
      if (!shouldRun) break;
      // Share the parent scope so body mutations affect the next condition.
      await runGraph({ ...args, graph: node.data.subgraph });
      iterations++;
      if (node.data.delayMs && node.data.delayMs > 0) {
        await sleepWithAbort(node.data.delayMs, args.abortSignal);
      }
    }
    args.variables[`${node.id}.iterations`] = String(iterations);
    step.status = 'success';
    step.duration = Date.now() - step.timestamp;
    finishStep(args, step);
  } catch (err) {
    step.status = 'failed';
    step.error = err instanceof Error ? err.message : String(err);
    step.duration = Date.now() - step.timestamp;
    finishStep(args, step);
    throw err;
  }
}

async function runTryCatch(
  node: Extract<FlowNode, { kind: 'tryCatch' }>,
  args: RunGraphArgs
): Promise<void> {
  const step: WorkflowExecutionStep = {
    nodeId: node.id,
    nodeKind: 'tryCatch',
    requestName: 'tryCatch',
    status: 'running',
    timestamp: Date.now(),
  };
  args.onStepStart?.(step);

  const tryVars: Record<string, string> = { ...args.variables };
  try {
    await runGraph({
      ...args,
      graph: node.data.trySubgraph,
      variables: tryVars,
    });
    Object.assign(args.variables, tryVars);
    step.status = 'success';
    step.duration = Date.now() - step.timestamp;
    finishStep(args, step);
  } catch (err) {
    if (isAbortError(err)) {
      step.status = 'failed';
      step.error = 'Aborted';
      finishStep(args, step);
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    args.log(`tryCatch caught: ${msg}`, 'warn');
    const catchVars: Record<string, string> = { ...args.variables };
    catchVars.error = msg;
    catchVars.errorNode = err instanceof RequestNodeFailure ? String(err.status) : '';
    try {
      await runGraph({
        ...args,
        graph: node.data.catchSubgraph,
        variables: catchVars,
      });
      Object.assign(args.variables, catchVars);
      step.status = 'success';
      step.duration = Date.now() - step.timestamp;
      finishStep(args, step);
    } catch (catchErr) {
      step.status = 'failed';
      step.error = catchErr instanceof Error ? catchErr.message : String(catchErr);
      step.duration = Date.now() - step.timestamp;
      finishStep(args, step);
      throw catchErr;
    }
  }
}

async function runSubWorkflow(
  node: Extract<FlowNode, { kind: 'subWorkflow' }>,
  args: RunGraphArgs
): Promise<void> {
  const step: WorkflowExecutionStep = {
    nodeId: node.id,
    nodeKind: 'subWorkflow',
    requestName: 'subWorkflow',
    status: 'running',
    timestamp: Date.now(),
  };
  args.onStepStart?.(step);

  if (!args.options.getWorkflowById) {
    step.status = 'failed';
    step.error = 'subWorkflow requires a getWorkflowById resolver';
    finishStep(args, step);
    throw new Error(step.error);
  }
  const child = args.options.getWorkflowById(node.data.workflowId);
  if (!child) {
    step.status = 'failed';
    step.error = `Sub-workflow not found: ${node.data.workflowId}`;
    finishStep(args, step);
    throw new Error(step.error);
  }
  if (!child.graph) {
    step.status = 'failed';
    step.error =
      'Sub-workflow has no graph — only graph-authored workflows can be called from a graph';
    finishStep(args, step);
    throw new Error(step.error);
  }

  // Isolated input scope: child sees only mapped vars.
  const childVars: Record<string, string> = {};
  if (node.data.inputVarMap) {
    for (const [parentKey, childKey] of Object.entries(node.data.inputVarMap)) {
      const v = args.variables[parentKey];
      if (v !== undefined) childVars[childKey] = v;
    }
  }

  const childExec = await executeDag({
    workflow: child,
    getRequestById: args.options.getRequestById,
    getWorkflowById: args.options.getWorkflowById,
    getInheritedAuth: args.options.getInheritedAuth,
    envVars: childVars,
    ...(args.abortSignal ? { abortSignal: args.abortSignal } : {}),
    callStack: args.callStack,
    onLog: (msg, lvl) => args.log(`[${child.name}] ${msg}`, lvl),
  });

  if (childExec.status !== 'success') {
    step.status = 'failed';
    step.error = `Sub-workflow "${child.name}" ${childExec.status}`;
    finishStep(args, step);
    throw new Error(step.error);
  }

  // Output projection: only mapped vars flow back to parent scope.
  if (node.data.outputVarMap) {
    for (const [childKey, parentKey] of Object.entries(node.data.outputVarMap)) {
      const v = childExec.finalVariables[childKey];
      if (v !== undefined) args.variables[parentKey] = v;
    }
  }
  step.extractedVariables = node.data.outputVarMap
    ? Object.fromEntries(
        Object.entries(node.data.outputVarMap).map(([childKey, parentKey]) => [
          parentKey,
          childExec.finalVariables[childKey] ?? '',
        ])
      )
    : {};
  step.status = 'success';
  step.duration = Date.now() - step.timestamp;
  finishStep(args, step);
}

// ---------- step bookkeeping ----------

function pushStep(args: RunGraphArgs, step: WorkflowExecutionStep): void {
  args.execution.steps.push(step);
  args.onStepStart?.(step);
  args.onStepComplete?.(step);
}

function finishStep(args: RunGraphArgs, step: WorkflowExecutionStep): void {
  // Replace any prior in-flight copy of this step (matched by nodeId)
  // so we don't duplicate the row.
  const existingIdx = args.execution.steps.findIndex(
    (s) => s.nodeId && s.nodeId === step.nodeId && s !== step
  );
  if (existingIdx >= 0) {
    args.execution.steps[existingIdx] = step;
  } else {
    args.execution.steps.push(step);
  }
  args.onStepComplete?.(step);
}

// `sleepWithAbort` + `isAbortError` live in retryHelpers.ts and are
// re-imported above. `injectString` is re-exported by callers as needed.

// ---------- Streaming-step helpers ----------

/**
 * Construct a failed step inline, push it via finishStep, and return an
 * Error the caller throws. Used by streaming-node executors for setup
 * failures (missing WorkflowRequest, missing protocol, bad URL). Setup
 * errors always surface as failed regardless of `failureMode` — that
 * knob is for runtime errors only.
 */
function fatalStep(
  args: RunGraphArgs,
  init: {
    nodeId: string;
    nodeKind: NonNullable<WorkflowExecutionStep['nodeKind']>;
    requestName: string;
    timestamp?: number;
  },
  message: string
): Error {
  const step: WorkflowExecutionStep = {
    nodeId: init.nodeId,
    nodeKind: init.nodeKind,
    requestName: init.requestName,
    status: 'failed',
    timestamp: init.timestamp ?? Date.now(),
    error: message,
    duration: 0,
  };
  finishStep(args, step);
  return new Error(message);
}

/**
 * Run the runtime portion of a streaming-node executor inside the
 * `failureMode` envelope. Setup failures should NOT go through here —
 * they use `fatalStep`.
 *
 * Aborts are propagated regardless of `failureMode` — a Stop click
 * must always stop, never silently succeed.
 */
async function withStreamingStep<T>(
  args: RunGraphArgs,
  init: {
    nodeId: string;
    nodeKind: NonNullable<WorkflowExecutionStep['nodeKind']>;
    requestName: string;
  },
  failureMode: RequestFailureMode,
  body: (step: WorkflowExecutionStep) => Promise<T>
): Promise<T | undefined> {
  const step: WorkflowExecutionStep = {
    nodeId: init.nodeId,
    nodeKind: init.nodeKind,
    requestName: init.requestName,
    status: 'running',
    timestamp: Date.now(),
  };
  args.onStepStart?.(step);
  try {
    const result = await body(step);
    step.duration = Date.now() - step.timestamp;
    if (step.status === 'running') step.status = 'success';
    finishStep(args, step);
    return result;
  } catch (err) {
    step.error = err instanceof Error ? err.message : String(err);
    step.duration = Date.now() - step.timestamp;
    // Aborts always stop the run — never swallow.
    if (failureMode === 'never' && !isAbortError(err)) {
      step.status = 'success';
      finishStep(args, step);
      return undefined;
    }
    step.status = 'failed';
    finishStep(args, step);
    throw err;
  }
}

// ---------- Streaming protocol node executors ----------

/**
 * Apply a `CompletionPolicy` while consuming an event stream. Calls
 * `onEvent(event, matched)` for each incoming event — `matched` is
 * true when the policy is `eventMatch` AND the predicate matched. The
 * promise resolves when the policy fires or `signal` aborts.
 */
async function consumeWithPolicy(
  handle: ProtocolStreamHandle,
  policy: CompletionPolicy,
  signal: AbortSignal,
  onEvent: (event: unknown, matchedPredicate: boolean) => void
): Promise<void> {
  let count = 0;

  // Set up the timeout race — only matters for `timeoutMs`. Linked to
  // the executor's signal so an external abort tears down the timer.
  let timeoutFired = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  if (policy.kind === 'timeoutMs') {
    timeoutId = setTimeout(() => {
      timeoutFired = true;
    }, policy.ms);
  }

  // For `eventMatch`, pre-warm a single QuickJS session and reuse it
  // across all events. Without this, each event would spin up a fresh
  // runtime (~30 ms) and saturate a high-frequency stream.
  let predicateEvaluator: PooledEvaluator | null = null;
  if (policy.kind === 'eventMatch') {
    predicateEvaluator = await createPooledScriptEvaluator(policy.expression, {
      variables: {},
    });
  }

  try {
    for await (const event of handle.events) {
      if (signal.aborted) break;
      if (timeoutFired) break;
      count++;

      let matched = false;
      if (policy.kind === 'eventMatch' && predicateEvaluator) {
        const result = await predicateEvaluator.evaluate({
          event: JSON.stringify(event),
        });
        // The predicate reads `event` via pm.variables.get (string-typed).
        // Predicates that want the parsed object call `JSON.parse(pm.variables.get('event'))`.
        matched = result.ok && Boolean(result.value);
      }

      onEvent(event, matched);

      if (policy.kind === 'eventCount' && count >= policy.n) break;
      if (policy.kind === 'eventMatch' && matched) break;
    }
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
    predicateEvaluator?.dispose();
    await handle.close().catch(() => undefined);
  }
}

async function runSseSubscribe(node: SseSubscribeFlowNode, args: RunGraphArgs): Promise<void> {
  const stepInit = {
    nodeId: node.id,
    nodeKind: 'sseSubscribe' as const,
    requestName: 'sseSubscribe',
  };

  // ---- Setup (fail-fast, not failureMode-aware) ----
  const workflowRequest = args.workflow.requests.find((r) => r.id === node.data.workflowRequestId);
  if (!workflowRequest) {
    throw fatalStep(
      args,
      stepInit,
      `sseSubscribe: WorkflowRequest "${node.data.workflowRequestId}" not found`
    );
  }
  const rawRequest = args.options.getRequestById(workflowRequest.requestId);
  if (!rawRequest || rawRequest.type !== 'sse') {
    throw fatalStep(args, stepInit, 'sseSubscribe: linked request must be SSE-typed');
  }
  const protocol = protocolRegistry.get('sse');
  if (!protocol?.startStream) {
    throw fatalStep(args, stepInit, 'sseSubscribe: SSE protocol has no startStream implementation');
  }

  const injected = protocol.injectVariables
    ? protocol.injectVariables(rawRequest, args.variables)
    : rawRequest;

  const ctx: RunContext = {
    signal: args.abortSignal ?? new AbortController().signal,
    variables: { ...args.variables },
  };

  const failureMode: RequestFailureMode = node.data.failureMode ?? 'thrown-only';
  const accumulateAll = node.data.accumulateAll ?? true;
  const maxEvents = node.data.maxEvents ?? 10_000;

  // ---- Runtime (failureMode-aware via withStreamingStep) ----
  await withStreamingStep(args, stepInit, failureMode, async (step) => {
    const collected: unknown[] = [];
    let cappedEarly = false;
    const handle = await protocol.startStream!(injected, ctx);
    await consumeWithPolicy(handle, node.data.completion, ctx.signal, (event, matched) => {
      if (accumulateAll || (node.data.completion.kind === 'eventMatch' && matched)) {
        if (collected.length < maxEvents) {
          collected.push(event);
        } else if (!cappedEarly) {
          cappedEarly = true;
          args.log(
            `sseSubscribe "${node.id}" hit maxEvents=${maxEvents}; closing stream early`,
            'warn'
          );
          handle.close().catch(() => undefined);
        }
      }
      args.variables[`${node.id}.eventCount`] = String(collected.length);
    });
    const varName = node.data.resultVar || `${node.id}.events`;
    args.variables[varName] = JSON.stringify(collected);
    step.extractedVariables = { [varName]: `[${collected.length} event(s)]` };
  });
}

async function runWsExchange(node: WsExchangeFlowNode, args: RunGraphArgs): Promise<void> {
  const stepInit = {
    nodeId: node.id,
    nodeKind: 'wsExchange' as const,
    requestName: 'wsExchange',
  };

  // ---- Setup ----
  const protocol = protocolRegistry.get('websocket');
  if (!protocol?.startStream) {
    throw fatalStep(
      args,
      stepInit,
      'wsExchange: WebSocket protocol has no startStream implementation'
    );
  }
  const url = injectString(node.data.url, args.variables);
  const urlCheck = validateURL(url, { allowedSchemes: ['ws:', 'wss:'] });
  if (!urlCheck.valid) {
    throw fatalStep(args, stepInit, `wsExchange: ${urlCheck.error}`);
  }
  const synthRequest = { type: 'websocket', url };
  const ctx: RunContext = {
    signal: args.abortSignal ?? new AbortController().signal,
    variables: { ...args.variables },
  };
  const failureMode: RequestFailureMode = node.data.failureMode ?? 'thrown-only';

  // ---- Runtime ----
  await withStreamingStep(args, stepInit, failureMode, async (step) => {
    const handle = await protocol.startStream!(synthRequest, ctx);

    const sendResult = await evalScriptValue(node.data.sendExpression, {
      variables: args.variables,
    });
    if (!sendResult.ok) {
      throw new Error(`wsExchange: sendExpression failed: ${sendResult.error}`);
    }
    const payload =
      typeof sendResult.value === 'string' ? sendResult.value : JSON.stringify(sendResult.value);
    // The WebSocket protocol exposes `.send` as a structural extension
    // on the handle — see websocketProtocol's start-stream impl.
    const sendable = handle as ProtocolStreamHandle & {
      send?: (frame: string) => void;
    };
    sendable.send?.(payload);

    let matched: unknown = null;
    await consumeWithPolicy(handle, node.data.completion, ctx.signal, (event, isMatch) => {
      if (isMatch) matched = event;
    });

    const varName = node.data.resultVar || `${node.id}.reply`;
    args.variables[varName] = matched === null ? '' : JSON.stringify(matched);
    step.extractedVariables = {
      [varName]: matched === null ? '<no match>' : '<reply>',
    };
  });
}

async function runMcpCall(node: McpCallFlowNode, args: RunGraphArgs): Promise<void> {
  const stepInit = {
    nodeId: node.id,
    nodeKind: 'mcpCall' as const,
    requestName: 'mcpCall',
  };

  // ---- Setup ----
  const workflowRequest = args.workflow.requests.find((r) => r.id === node.data.workflowRequestId);
  if (!workflowRequest) {
    throw fatalStep(
      args,
      stepInit,
      `mcpCall: WorkflowRequest "${node.data.workflowRequestId}" not found`
    );
  }
  const rawRequest = args.options.getRequestById(workflowRequest.requestId);
  if (!rawRequest || rawRequest.type !== 'mcp') {
    throw fatalStep(args, stepInit, 'mcpCall: linked request must be MCP-typed');
  }
  const protocol = protocolRegistry.get('mcp') as
    | (ReturnType<typeof protocolRegistry.get> & {
        runJsonRpc?: (
          request: Request,
          ctx: RunContext,
          opts: McpRunJsonRpcOptions
        ) => Promise<{
          ok: boolean;
          result?: unknown;
          error?: string;
          jsonRpcError?: { code: number; message: string; data?: unknown };
        }>;
      })
    | undefined;
  if (!protocol?.runJsonRpc) {
    throw fatalStep(args, stepInit, 'mcpCall: MCP protocol has no runJsonRpc implementation');
  }

  const injected = protocol.injectVariables
    ? protocol.injectVariables(rawRequest, args.variables)
    : rawRequest;

  let params: unknown = undefined;
  if (node.data.paramsExpression?.trim()) {
    const evald = await evalScriptValue(node.data.paramsExpression, {
      variables: args.variables,
    });
    if (!evald.ok) {
      throw fatalStep(args, stepInit, `mcpCall: paramsExpression failed: ${evald.error}`);
    }
    params = evald.value;
  }

  const ctx: RunContext = {
    signal: args.abortSignal ?? new AbortController().signal,
    variables: { ...args.variables },
  };
  const failureMode: RequestFailureMode = node.data.failureMode ?? 'thrown-only';

  // ---- Runtime ----
  await withStreamingStep(args, stepInit, failureMode, async (step) => {
    // Share the executor-scoped client pool — N mcpCall nodes against
    // the same MCP server reuse one initialized session.
    const pool: McpClientPool = {
      get: (k) => args.mcpClientPool.get(k),
      set: (k, c) => {
        args.mcpClientPool.set(k, c);
      },
    };
    const callArgs: McpRunJsonRpcOptions = {
      method: node.data.method,
      clientPool: pool,
      cacheKey: workflowRequest.id,
    };
    if (params !== undefined) callArgs.params = params;
    const result = await protocol.runJsonRpc!(injected, ctx, callArgs);
    if (!result.ok) {
      throw new Error(result.error || 'mcpCall: JSON-RPC error');
    }
    const varName = node.data.resultVar || `${node.id}.result`;
    args.variables[varName] =
      typeof result.result === 'string' ? result.result : JSON.stringify(result.result ?? null);
    step.extractedVariables = { [varName]: '<mcp result>' };
  });
}
