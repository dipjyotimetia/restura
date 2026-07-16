import type { KeyValue } from './common';
import type { Response } from './http';

// Workflow Types (Request Chaining & Flows)
export type ExtractionMethod = 'jsonpath' | 'regex' | 'header';

export interface VariableExtraction {
  id: string;
  variableName: string;
  extractionMethod: ExtractionMethod;
  path: string; // JSONPath (dot notation), regex pattern, or header name
  description?: string;
}

export interface WorkflowRequest {
  id: string;
  requestId: string; // Reference to actual request in collection
  name: string;
  extractVariables?: VariableExtraction[];
  precondition?: string; // Script for conditional execution
  retryPolicy?: {
    maxAttempts: number;
    delayMs: number;
    backoffMultiplier?: number;
  };
  timeout?: number; // Override global timeout
}

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  collectionId: string;
  /**
   * Linear list of workflow steps. When `graph` is also present, this is
   * a BAG (insertion order is meaningless) — the graph's edges are the
   * authoritative execution order. The legacy linear executor refuses to
   * run a workflow with a non-null `graph`; only the DAG executor does.
   */
  requests: WorkflowRequest[];
  variables?: KeyValue[]; // Workflow-level variables
  /**
   * Optional DAG authored via the React Flow canvas. When present, the
   * workflow runs through the DAG executor and the form view becomes
   * read-only (with a "Discard graph" button). Absent for workflows
   * created in linear form view only.
   */
  graph?: WorkflowGraph;
  createdAt: number;
  updatedAt: number;
}

// React Flow DAG types
// ---------------------

export interface FlowNodePosition {
  x: number;
  y: number;
}

export type ParallelWaitMode = 'all' | 'any' | 'race';
export type ParallelMergeStrategy = 'fail-on-conflict' | 'pick-first' | 'pick-last' | 'merge-list';

/** What counts as failure for a request node. Drives surrounding try/catch. */
export type RequestFailureMode = 'thrown-only' | 'http-status' | 'never';

/**
 * When does a streaming-node terminate?
 *
 * `eventCount` — after N events received.
 * `timeoutMs` — after a wall-clock duration regardless of activity.
 * `eventMatch` — when a QuickJS predicate on the latest event returns truthy.
 * `connectionClose` — when the server closes the stream (or `close()` fires).
 */
export type CompletionPolicy =
  | { kind: 'eventCount'; n: number }
  | { kind: 'timeoutMs'; ms: number }
  | { kind: 'eventMatch'; expression: string }
  | { kind: 'connectionClose' };

export type FlowNodeKind =
  | 'start'
  | 'end'
  | 'request'
  | 'condition'
  | 'switch'
  | 'setVariable'
  | 'delay'
  | 'transform'
  | 'template'
  | 'display'
  | 'parallel'
  | 'forEach'
  | 'loop'
  | 'tryCatch'
  | 'subWorkflow'
  | 'sseSubscribe'
  | 'wsExchange'
  | 'mcpCall';

interface FlowNodeBase {
  id: string;
  kind: FlowNodeKind;
  position: FlowNodePosition;
}

export interface StartFlowNode extends FlowNodeBase {
  kind: 'start';
}

export interface EndFlowNode extends FlowNodeBase {
  kind: 'end';
}

export interface RequestFlowNode extends FlowNodeBase {
  kind: 'request';
  data: {
    /** Points at a WorkflowRequest in Workflow.requests[]. */
    workflowRequestId: string;
    /** Default 'thrown-only' — non-2xx responses do NOT auto-fail. */
    failureMode?: RequestFailureMode;
  };
}

export interface ConditionFlowNode extends FlowNodeBase {
  kind: 'condition';
  data: {
    /** QuickJS expression — must `return` a value coerced to boolean. */
    expression: string;
    description?: string;
  };
}

/** One branch of a switch node. The first case whose expression returns
 *  truthy wins; if none match, the `'default'` source handle is taken. */
export interface SwitchCase {
  /** Stable id, used as the React Flow source-handle id for this branch. */
  id: string;
  label?: string;
  /** QuickJS expression — coerced to boolean, evaluated in declared order. */
  expression: string;
}

export interface SwitchFlowNode extends FlowNodeBase {
  kind: 'switch';
  data: {
    cases: SwitchCase[];
    description?: string;
  };
}

export type LoopMode = 'while' | 'until';

/** Condition-driven loop (polling). Unlike forEach it shares the parent
 *  variable scope so body mutations affect the next condition check. */
export interface LoopFlowNode extends FlowNodeBase {
  kind: 'loop';
  data: {
    /** QuickJS expression evaluated before each pass — coerced to boolean. */
    conditionExpression: string;
    /** 'while' runs the body while the condition is truthy; 'until' runs
     *  until the condition becomes truthy. */
    mode: LoopMode;
    /** Hard cap on iterations — prevents a runaway loop. */
    maxIterations: number;
    /** Optional pause between iterations (ms). */
    delayMs?: number;
    /** Body executed each iteration. */
    subgraph: WorkflowGraph;
  };
}

export interface SetVariableAssignment {
  key: string;
  /** QuickJS expression evaluated to a string. */
  valueExpression: string;
}

export interface SetVariableFlowNode extends FlowNodeBase {
  kind: 'setVariable';
  data: {
    assignments: SetVariableAssignment[];
  };
}

export interface DelayFlowNode extends FlowNodeBase {
  kind: 'delay';
  data: {
    ms: number;
  };
}

export interface TransformFlowNode extends FlowNodeBase {
  kind: 'transform';
  data: {
    /** QuickJS script. Variables set via `pm.variables.set` propagate. */
    script: string;
  };
}

/** Render a {{var}}-interpolated string into a single variable. The
 *  declarative counterpart to a transform script. */
export interface TemplateFlowNode extends FlowNodeBase {
  kind: 'template';
  data: {
    /** Text with {{varName}} tokens substituted from workflow variables. */
    template: string;
    /** Variable name receiving the rendered string. */
    resultVar: string;
  };
}

export type DisplayMode = 'json' | 'table' | 'raw';

/** Capture a value for inspection in the run monitor. Side-effect only —
 *  does not mutate downstream variables beyond `<nodeId>.display`. */
export interface DisplayFlowNode extends FlowNodeBase {
  kind: 'display';
  data: {
    /** QuickJS expression evaluated to the value to display. */
    valueExpression: string;
    /** How the run monitor renders the captured value. */
    mode: DisplayMode;
    /** Optional label shown beside the value. */
    label?: string;
  };
}

export interface ParallelFlowNode extends FlowNodeBase {
  kind: 'parallel';
  data: {
    waitMode: ParallelWaitMode;
    mergeStrategy?: ParallelMergeStrategy;
  };
}

export interface ForEachFlowNode extends FlowNodeBase {
  kind: 'forEach';
  data: {
    /** QuickJS expression that must return a JSON-serialisable array. */
    collectionExpression: string;
    /** Variable name receiving each item (JSON-encoded) per iteration. */
    iteratorVar: string;
    /** Subgraph executed once per item. Max concurrency 8 in v1. */
    subgraph: WorkflowGraph;
    /** Optional override for the v1 default concurrency cap of 8. */
    concurrency?: number;
  };
}

export interface TryCatchFlowNode extends FlowNodeBase {
  kind: 'tryCatch';
  data: {
    trySubgraph: WorkflowGraph;
    catchSubgraph: WorkflowGraph;
  };
}

export interface SubWorkflowFlowNode extends FlowNodeBase {
  kind: 'subWorkflow';
  data: {
    workflowId: string;
    /** parent var name → child var name. Child sees only mapped vars. */
    inputVarMap?: Record<string, string>;
    /** child var name → parent var name. Defaults to no projection. */
    outputVarMap?: Record<string, string>;
  };
}

/** Subscribe to a saved SseRequest, accumulate events, terminate per completion policy. */
export interface SseSubscribeFlowNode extends FlowNodeBase {
  kind: 'sseSubscribe';
  data: {
    /** Points at a WorkflowRequest in Workflow.requests[] whose
     *  underlying collection request is an SseRequest. */
    workflowRequestId: string;
    completion: CompletionPolicy;
    /** When false, only events matching the `eventMatch` predicate are
     *  accumulated (no-op for other completion kinds — all events kept). */
    accumulateAll?: boolean;
    /** Maximum number of events to collect into `resultVar`. Defaults to
     *  10_000 — prevents a runaway stream from filling memory with a
     *  massive variable. When the cap is hit, the stream closes early
     *  and the node settles as `success` with a warning logged. */
    maxEvents?: number;
    /** Variable to receive the JSON-stringified events array.
     *  Defaults to `<nodeId>.events`. */
    resultVar?: string;
    failureMode?: RequestFailureMode;
  };
}

/** Send one frame to a WebSocket endpoint and wait for a matching reply. */
export interface WsExchangeFlowNode extends FlowNodeBase {
  kind: 'wsExchange';
  data: {
    /** WebSocket URL (`ws:` or `wss:`). Inline because there's no
     *  WebSocketRequest type in the collection model today. */
    url: string;
    /** QuickJS expression evaluated to the frame to send on open. */
    sendExpression: string;
    /** QuickJS predicate against `event` — first truthy match wins. */
    matchExpression: string;
    completion: CompletionPolicy;
    /** Variable to receive the matched reply (JSON-stringified).
     *  Defaults to `<nodeId>.reply`. */
    resultVar?: string;
    failureMode?: RequestFailureMode;
  };
}

/** Call one JSON-RPC method on an MCP server. */
export interface McpCallFlowNode extends FlowNodeBase {
  kind: 'mcpCall';
  data: {
    workflowRequestId: string;
    /** Method to invoke — e.g. "tools/call", "resources/read". */
    method: string;
    /** QuickJS expression evaluating to the JSON params object. Optional. */
    paramsExpression?: string;
    /** Variable to receive the JSON-stringified result.
     *  Defaults to `<nodeId>.result`. */
    resultVar?: string;
    failureMode?: RequestFailureMode;
  };
}

export type FlowNode =
  | StartFlowNode
  | EndFlowNode
  | RequestFlowNode
  | ConditionFlowNode
  | SwitchFlowNode
  | SetVariableFlowNode
  | DelayFlowNode
  | TransformFlowNode
  | TemplateFlowNode
  | DisplayFlowNode
  | ParallelFlowNode
  | ForEachFlowNode
  | LoopFlowNode
  | TryCatchFlowNode
  | SubWorkflowFlowNode
  | SseSubscribeFlowNode
  | WsExchangeFlowNode
  | McpCallFlowNode;

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  /**
   * For condition nodes: 'true' | 'false'. For tryCatch internal edges:
   * 'try' | 'catch'. Undefined for ordinary edges. Matches the React Flow
   * v12 `<Handle id="…" />` convention.
   */
  sourceHandle?: string;
  label?: string;
}

/**
 * Path into a workflow's nested subgraphs. Empty array = top-level.
 * Each segment names the parent node and which of its nested graph
 * slots to descend into.
 *
 *   []                                                    -> workflow.graph
 *   [{parentNodeId: 'fe', key: 'subgraph'}]               -> forEach's / loop's body
 *   [{parentNodeId: 'tc', key: 'trySubgraph'}, ...]       -> tryCatch's try-branch, then drill deeper
 */
export type SubgraphPath = ReadonlyArray<{
  parentNodeId: string;
  key: 'subgraph' | 'trySubgraph' | 'catchSubgraph';
}>;

export interface WorkflowGraph {
  /** Bumped when the graph schema changes; v1 in this release. */
  version: 1;
  nodes: FlowNode[];
  edges: FlowEdge[];
  /** Persisted React Flow viewport so the user's pan/zoom survives reload. */
  viewport?: { x: number; y: number; zoom: number };
}

// Execution history
// -----------------

export interface WorkflowExecutionStep {
  /**
   * Legacy linear step pointed at a `WorkflowRequest` (workflowRequestId)
   * which pointed at a collection request (requestId). Graph executions
   * have many more node kinds, so these become optional and the new
   * `nodeId` / `nodeKind` fields take over. The history viewer branches
   * on `nodeKind` — when absent, it falls back to the legacy rendering.
   */
  workflowRequestId?: string;
  requestId?: string;
  requestName: string;
  status: 'pending' | 'running' | 'success' | 'failed' | 'skipped';
  response?: Response;
  extractedVariables?: Record<string, string>;
  error?: string;
  duration?: number;
  timestamp: number;
  /** Present for graph executions; absent for legacy linear executions. */
  nodeId?: string;
  nodeKind?: FlowNodeKind;
  /**
   * Disambiguates concurrent executions of the same `nodeId` — e.g. two
   * `forEach` iterations or two `parallel` branches running the same
   * subgraph at once produce steps with identical `nodeId`s. Undefined
   * for steps that only ever run once at a time (the common case), so a
   * later transition (running -> success/failed) for the *same* logical
   * step still correctly replaces its own in-flight entry.
   */
  instanceId?: string;
}

export interface WorkflowExecution {
  id: string;
  workflowId: string;
  workflowName: string;
  startedAt: number;
  completedAt?: number;
  status: 'running' | 'success' | 'failed' | 'stopped';
  steps: WorkflowExecutionStep[];
  finalVariables: Record<string, string>;
  environment?: string; // Environment ID used
  executionLog: Array<{
    timestamp: number;
    message: string;
    level: 'info' | 'warn' | 'error';
  }>;
}
