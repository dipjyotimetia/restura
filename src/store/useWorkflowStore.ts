import { v4 as uuidv4 } from 'uuid';
import { temporal } from 'zundo';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { selectAtPath, setAtPath } from '@/features/workflows/lib/flowTypes';
import { dexieStorageAdapters } from '@/lib/shared/dexie-storage';
import type {
  Workflow,
  WorkflowRequest,
  WorkflowExecution,
  VariableExtraction,
  WorkflowGraph,
  FlowNodePosition,
  FlowNode,
  RequestFlowNode,
  SseSubscribeFlowNode,
  McpCallFlowNode,
  SubgraphPath,
} from '@/types';

interface WorkflowState {
  workflows: Workflow[];
  executions: WorkflowExecution[];

  // Workflow CRUD
  addWorkflow: (workflow: Workflow) => void;
  updateWorkflow: (id: string, updates: Partial<Workflow>) => void;
  removeWorkflow: (id: string) => void;
  getWorkflowById: (id: string) => Workflow | undefined;
  getWorkflowsByCollectionId: (collectionId: string) => Workflow[];
  createNewWorkflow: (name: string, collectionId: string) => Workflow;

  // Workflow Request CRUD (legacy linear path)
  // When workflow.graph is set, these throw — form view is read-only in that
  // case and graph view uses addRequestNode/removeRequestNode for the dual
  // WorkflowRequest+FlowNode mutation.
  addWorkflowRequest: (workflowId: string, request: WorkflowRequest) => void;
  updateWorkflowRequest: (
    workflowId: string,
    requestId: string,
    updates: Partial<WorkflowRequest>
  ) => void;
  removeWorkflowRequest: (workflowId: string, requestId: string) => void;
  reorderWorkflowRequests: (workflowId: string, requests: WorkflowRequest[]) => void;

  // Graph operations
  // setWorkflowGraph is the single mutation point for top-level canvas
  // writes. setWorkflowSubgraph handles writes inside nested
  // forEach/tryCatch bodies. Both flow through zundo for undo/redo.
  setWorkflowGraph: (workflowId: string, graph: WorkflowGraph) => void;
  /** Replace the nested subgraph at `path` inside `workflow.graph`.
   *  Empty path delegates to setWorkflowGraph. Invalid paths no-op. */
  setWorkflowSubgraph: (workflowId: string, path: SubgraphPath, graph: WorkflowGraph) => void;
  /** Drop a collection request onto the canvas. Creates both a
   *  WorkflowRequest (always in workflow.requests[] — flat bag, no
   *  matter how deep the path) AND a FlowNode (in the graph at
   *  `path`, default = top-level). The root graph must already exist
   *  (open the Graph tab first to trigger the stub).
   *
   *  `nodeKind` lets a saved SSE/MCP request drop create the matching
   *  streaming-node kind directly instead of a generic `request` node.
   *  Defaults to `'request'` for back-compat. */
  addRequestNode: (
    workflowId: string,
    collectionRequestId: string,
    requestName: string,
    position: FlowNodePosition,
    path?: SubgraphPath,
    nodeKind?: 'request' | 'sseSubscribe' | 'mcpCall'
  ) => { nodeId: string; workflowRequestId: string };
  /** Remove a node from the graph at `path`. For request nodes, also
   *  deletes the underlying WorkflowRequest. Cascades edges touching
   *  the node within the same subgraph. */
  removeRequestNode: (workflowId: string, nodeId: string, path?: SubgraphPath) => void;
  clearWorkflowGraph: (workflowId: string) => void;

  // Variable Extraction
  addExtraction: (workflowId: string, requestId: string, extraction: VariableExtraction) => void;
  updateExtraction: (
    workflowId: string,
    requestId: string,
    extractionId: string,
    updates: Partial<VariableExtraction>
  ) => void;
  removeExtraction: (workflowId: string, requestId: string, extractionId: string) => void;

  // Execution History
  saveExecution: (execution: WorkflowExecution) => void;
  getExecutionsByWorkflowId: (workflowId: string) => WorkflowExecution[];
  getLatestExecution: (workflowId: string) => WorkflowExecution | undefined;
  clearExecutionHistory: (workflowId?: string) => void;

  // Helpers
  createNewWorkflowRequest: (requestId: string, name: string) => WorkflowRequest;
  createNewExtraction: (variableName: string, path: string) => VariableExtraction;
}

/**
 * Throttle a function so successive invocations within `delay` ms fire
 * at most once (leading + trailing). Used to coalesce rapid graph
 * mutations (e.g. dragging a node, which fires onNodesChange every
 * frame) into a single undo entry per ~300 ms.
 */
function throttle<T extends (...args: never[]) => unknown>(fn: T, delay: number): T {
  let lastFire = 0;
  let pending: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: Parameters<T> | null = null;
  return ((...args: Parameters<T>) => {
    const now = Date.now();
    lastArgs = args;
    if (now - lastFire >= delay) {
      lastFire = now;
      fn(...args);
    } else if (!pending) {
      const wait = delay - (now - lastFire);
      pending = setTimeout(() => {
        pending = null;
        lastFire = Date.now();
        if (lastArgs) fn(...lastArgs);
      }, wait);
    }
  }) as T;
}

export const useWorkflowStore = create<WorkflowState>()(
  temporal(
    persist(
      (set, get) => ({
        workflows: [],
        executions: [],

        // Workflow CRUD
        addWorkflow: (workflow) =>
          set((state) => ({
            workflows: [...state.workflows, workflow],
          })),

        updateWorkflow: (id, updates) =>
          set((state) => ({
            workflows: state.workflows.map((wf) =>
              wf.id === id ? { ...wf, ...updates, updatedAt: Date.now() } : wf
            ),
          })),

        removeWorkflow: (id) =>
          set((state) => ({
            workflows: state.workflows.filter((wf) => wf.id !== id),
            executions: state.executions.filter((ex) => ex.workflowId !== id),
          })),

        getWorkflowById: (id) => get().workflows.find((wf) => wf.id === id),

        getWorkflowsByCollectionId: (collectionId) =>
          get().workflows.filter((wf) => wf.collectionId === collectionId),

        createNewWorkflow: (name, collectionId) => ({
          id: uuidv4(),
          name,
          collectionId,
          requests: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),

        // Workflow Request CRUD
        addWorkflowRequest: (workflowId, request) =>
          set((state) => ({
            workflows: state.workflows.map((wf) => {
              if (wf.id !== workflowId) return wf;
              if (wf.graph) {
                throw new Error(
                  'Cannot addWorkflowRequest on a graph-authored workflow. Use addRequestNode (graph view) or clear the graph first.'
                );
              }
              return { ...wf, requests: [...wf.requests, request], updatedAt: Date.now() };
            }),
          })),

        updateWorkflowRequest: (workflowId, requestId, updates) =>
          set((state) => ({
            workflows: state.workflows.map((wf) =>
              wf.id === workflowId
                ? {
                    ...wf,
                    requests: wf.requests.map((req) =>
                      req.id === requestId ? { ...req, ...updates } : req
                    ),
                    updatedAt: Date.now(),
                  }
                : wf
            ),
          })),

        removeWorkflowRequest: (workflowId, requestId) =>
          set((state) => ({
            workflows: state.workflows.map((wf) => {
              if (wf.id !== workflowId) return wf;
              if (wf.graph) {
                throw new Error(
                  'Cannot removeWorkflowRequest on a graph-authored workflow. Use removeRequestNode (graph view) or clear the graph first.'
                );
              }
              return {
                ...wf,
                requests: wf.requests.filter((req) => req.id !== requestId),
                updatedAt: Date.now(),
              };
            }),
          })),

        reorderWorkflowRequests: (workflowId, requests) =>
          set((state) => ({
            workflows: state.workflows.map((wf) => {
              if (wf.id !== workflowId) return wf;
              if (wf.graph) {
                throw new Error(
                  'Cannot reorderWorkflowRequests on a graph-authored workflow. Edges in the graph are the source of order.'
                );
              }
              return { ...wf, requests, updatedAt: Date.now() };
            }),
          })),

        setWorkflowGraph: (workflowId, graph) =>
          set((state) => ({
            workflows: state.workflows.map((wf) =>
              wf.id === workflowId ? { ...wf, graph, updatedAt: Date.now() } : wf
            ),
          })),

        setWorkflowSubgraph: (workflowId, path, graph) =>
          set((state) => ({
            workflows: state.workflows.map((wf) => {
              if (wf.id !== workflowId) return wf;
              if (!wf.graph) {
                throw new Error('setWorkflowSubgraph requires workflow.graph to exist.');
              }
              if (path.length === 0) {
                return { ...wf, graph, updatedAt: Date.now() };
              }
              return {
                ...wf,
                graph: setAtPath(wf.graph, path, graph),
                updatedAt: Date.now(),
              };
            }),
          })),

        addRequestNode: (
          workflowId,
          collectionRequestId,
          requestName,
          position,
          path,
          nodeKind
        ) => {
          const newWorkflowRequest: WorkflowRequest = {
            id: uuidv4(),
            requestId: collectionRequestId,
            name: requestName,
          };
          const newNodeId = `node-${uuidv4()}`;
          let newNode: FlowNode;
          if (nodeKind === 'sseSubscribe') {
            const data: SseSubscribeFlowNode['data'] = {
              workflowRequestId: newWorkflowRequest.id,
              completion: { kind: 'eventCount', n: 1 },
              accumulateAll: true,
            };
            newNode = {
              id: newNodeId,
              kind: 'sseSubscribe',
              position,
              data,
            };
          } else if (nodeKind === 'mcpCall') {
            const data: McpCallFlowNode['data'] = {
              workflowRequestId: newWorkflowRequest.id,
              method: 'tools/call',
              paramsExpression: 'return {};',
            };
            newNode = {
              id: newNodeId,
              kind: 'mcpCall',
              position,
              data,
            };
          } else {
            const data: RequestFlowNode['data'] = {
              workflowRequestId: newWorkflowRequest.id,
            };
            newNode = {
              id: newNodeId,
              kind: 'request',
              position,
              data,
            };
          }
          set((state) => ({
            workflows: state.workflows.map((wf) => {
              if (wf.id !== workflowId) return wf;
              if (!wf.graph) {
                throw new Error(
                  'addRequestNode requires workflow.graph to exist. Open the Graph tab first.'
                );
              }
              // WorkflowRequest is always flat — it's a bag indexed by id
              // regardless of where in the graph the node lives.
              const nextRequests = [...wf.requests, newWorkflowRequest];
              if (!path || path.length === 0) {
                return {
                  ...wf,
                  requests: nextRequests,
                  graph: {
                    ...wf.graph,
                    nodes: [...wf.graph.nodes, newNode],
                  },
                  updatedAt: Date.now(),
                };
              }
              const targetSlice = selectAtPath(wf.graph, path);
              if (!targetSlice) {
                // Path was invalid — drop the request anyway? No: the
                // caller assumes the FlowNode lands somewhere. Throw to
                // surface the bug.
                throw new Error(
                  `addRequestNode: subgraph path ${JSON.stringify(path)} did not resolve.`
                );
              }
              const nextSlice: WorkflowGraph = {
                ...targetSlice,
                nodes: [...targetSlice.nodes, newNode],
              };
              return {
                ...wf,
                requests: nextRequests,
                graph: setAtPath(wf.graph, path, nextSlice),
                updatedAt: Date.now(),
              };
            }),
          }));
          return {
            nodeId: newNodeId,
            workflowRequestId: newWorkflowRequest.id,
          };
        },

        removeRequestNode: (workflowId, nodeId, path) =>
          set((state) => ({
            workflows: state.workflows.map((wf) => {
              if (wf.id !== workflowId) return wf;
              if (!wf.graph) return wf;
              const slice = !path || path.length === 0 ? wf.graph : selectAtPath(wf.graph, path);
              if (!slice) return wf;
              const node = slice.nodes.find((n) => n.id === nodeId);
              const nextSlice: WorkflowGraph = {
                ...slice,
                nodes: slice.nodes.filter((n) => n.id !== nodeId),
                edges: slice.edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
              };
              const nextGraph =
                !path || path.length === 0 ? nextSlice : setAtPath(wf.graph, path, nextSlice);
              // Cascade WorkflowRequest deletion for any node kind that
              // holds a `workflowRequestId` in its `data`. Three kinds
              // qualify today: request, sseSubscribe, mcpCall. (wsExchange
              // uses inline URL config and has no linked WorkflowRequest.)
              const linkedWorkflowRequestId =
                node &&
                'data' in node &&
                node.data &&
                (node.kind === 'request' || node.kind === 'sseSubscribe' || node.kind === 'mcpCall')
                  ? (node.data as { workflowRequestId?: string }).workflowRequestId
                  : undefined;
              const nextRequests = linkedWorkflowRequestId
                ? wf.requests.filter((r) => r.id !== linkedWorkflowRequestId)
                : wf.requests;
              return {
                ...wf,
                requests: nextRequests,
                graph: nextGraph,
                updatedAt: Date.now(),
              };
            }),
          })),

        clearWorkflowGraph: (workflowId) =>
          set((state) => ({
            workflows: state.workflows.map((wf) => {
              if (wf.id !== workflowId) return wf;
              // Strip `graph` from the workflow. The rest (requests[],
              // variables, etc.) is preserved verbatim so users return to
              // the linear form view with everything still in place.
              const { graph: _graph, ...rest } = wf;
              return { ...rest, updatedAt: Date.now() };
            }),
          })),

        // Variable Extraction
        addExtraction: (workflowId, requestId, extraction) =>
          set((state) => ({
            workflows: state.workflows.map((wf) =>
              wf.id === workflowId
                ? {
                    ...wf,
                    requests: wf.requests.map((req) =>
                      req.id === requestId
                        ? {
                            ...req,
                            extractVariables: [...(req.extractVariables || []), extraction],
                          }
                        : req
                    ),
                    updatedAt: Date.now(),
                  }
                : wf
            ),
          })),

        updateExtraction: (workflowId, requestId, extractionId, updates) =>
          set((state) => ({
            workflows: state.workflows.map((wf) =>
              wf.id === workflowId
                ? {
                    ...wf,
                    requests: wf.requests.map((req) =>
                      req.id === requestId
                        ? {
                            ...req,
                            extractVariables: req.extractVariables?.map((ext) =>
                              ext.id === extractionId ? { ...ext, ...updates } : ext
                            ),
                          }
                        : req
                    ),
                    updatedAt: Date.now(),
                  }
                : wf
            ),
          })),

        removeExtraction: (workflowId, requestId, extractionId) =>
          set((state) => ({
            workflows: state.workflows.map((wf) =>
              wf.id === workflowId
                ? {
                    ...wf,
                    requests: wf.requests.map((req) =>
                      req.id === requestId
                        ? {
                            ...req,
                            extractVariables: req.extractVariables?.filter(
                              (ext) => ext.id !== extractionId
                            ),
                          }
                        : req
                    ),
                    updatedAt: Date.now(),
                  }
                : wf
            ),
          })),

        // Execution History
        saveExecution: (execution) =>
          set((state) => ({
            executions: [...state.executions, execution].slice(-100), // Keep last 100 executions
          })),

        getExecutionsByWorkflowId: (workflowId) =>
          get()
            .executions.filter((ex) => ex.workflowId === workflowId)
            .sort((a, b) => b.startedAt - a.startedAt),

        getLatestExecution: (workflowId) =>
          get()
            .executions.filter((ex) => ex.workflowId === workflowId)
            .sort((a, b) => b.startedAt - a.startedAt)[0],

        clearExecutionHistory: (workflowId) =>
          set((state) => ({
            executions: workflowId
              ? state.executions.filter((ex) => ex.workflowId !== workflowId)
              : [],
          })),

        // Helpers
        createNewWorkflowRequest: (requestId, name) => ({
          id: uuidv4(),
          requestId,
          name,
        }),

        createNewExtraction: (variableName, path) => ({
          id: uuidv4(),
          variableName,
          extractionMethod: 'jsonpath' as const,
          path,
        }),
      }),
      {
        name: 'workflow-storage',
        // v3 → optional Workflow.graph (WorkflowGraph); existing rows just have
        // `graph` absent, which is valid — no migration needed.
        version: 3,
        storage: dexieStorageAdapters.workflows(),
        onRehydrateStorage: () => (state, error) => {
          if (error) {
            console.error('Workflow store rehydration failed:', error);
          }
          if (state) {
            console.debug('Workflow store rehydrated from Dexie successfully');
          }
        },
      }
    ),
    {
      // Track only the workflows array — executions are ephemeral run
      // history (not user intent to undo) and the action functions
      // themselves are stable. Reading the persisted slice keeps the
      // undo stack focused on graph/workflow edits.
      partialize: (state) => ({ workflows: state.workflows }),
      // Cap history at 10 to avoid unbounded memory growth during a long
      // editing session. zundo defaults to unlimited.
      limit: 10,
      // Throttle entry creation. Dragging a node fires onNodesChange
      // many times per second; we coalesce into one undo step per ~300 ms.
      handleSet: (handleSet) => throttle(handleSet, 300),
      // Don't track the temporal stack itself across reloads — it'd be
      // misleading after a refresh since the user has no visual cue for
      // why "Undo" still works from a previous session.
    }
  )
);
