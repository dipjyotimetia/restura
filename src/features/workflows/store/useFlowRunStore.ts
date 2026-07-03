/**
 * Ephemeral live-execution state for the graph canvas.
 *
 * Deliberately **not** persisted — this state is meaningful only while
 * a run is in flight and for a short tail after completion (so the user
 * can read the final node colours / log). Restoring "running" state
 * across a reload would be misleading; the run is gone.
 *
 * The DAG executor's `onStepStart` / `onStepComplete` callbacks dispatch
 * into this store from `useWorkflowExecution.ts`. The canvas
 * (NodeChrome, edge derivation, RunMonitorPanel) subscribes to relevant
 * slices and renders live.
 */
import { create } from 'zustand';

export type FlowRunNodeStatus = 'idle' | 'pending' | 'running' | 'success' | 'failed' | 'skipped';

export interface FlowRunNodeState {
  status: FlowRunNodeStatus;
  /** Failure message — populated when status === 'failed'. */
  error?: string;
  /** Latest duration in ms (set when the node settles). */
  duration?: number;
  /** Latest extracted variable summary for hover preview. */
  extractedVariables?: Record<string, string>;
  /**
   * Count of in-flight instances of this node. A `forEach`/`parallel`
   * node can execute the same canvas node more than once concurrently
   * (one node box, several logical instances) — this keeps the single
   * badge from flapping back to "running" when a fast sibling finishes
   * while a slower one is still in flight, and from a failure being
   * silently overwritten by a later-finishing sibling's success.
   */
  activeCount: number;
}

export interface FlowRunLogEntry {
  timestamp: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

interface FlowRunState {
  /** Workflow currently being observed, or null if no run is active. */
  workflowId: string | null;
  /** Execution UUID — set on startRun. */
  executionId: string | null;
  /** True while the executor is running; false once it settles. */
  isRunning: boolean;
  /** Final status after the run settles ('success' | 'failed' | 'stopped'),
   *  or null while running. */
  finalStatus: 'success' | 'failed' | 'stopped' | null;

  // nodeId → live state. Stored as a plain object (NOT a Map) so React
  // can compare references shallowly through Zustand selectors.
  nodeStates: Record<string, FlowRunNodeState>;

  /** Variables snapshot — the executor's `finalVariables` after each
   *  step's extraction merge. */
  variables: Record<string, string>;

  /** Append-only log feed. */
  logs: FlowRunLogEntry[];

  // ---- actions ----
  startRun: (workflowId: string, executionId: string) => void;
  finishRun: (status: 'success' | 'failed' | 'stopped') => void;
  markNodeStarted: (nodeId: string) => void;
  markNodeComplete: (
    nodeId: string,
    status: Exclude<FlowRunNodeStatus, 'idle' | 'pending' | 'running'>,
    meta?: { error?: string; duration?: number; extractedVariables?: Record<string, string> }
  ) => void;
  setVariables: (next: Record<string, string>) => void;
  mergeVariables: (additions: Record<string, string>) => void;
  appendLog: (entry: FlowRunLogEntry) => void;
  clear: () => void;
}

const initial: Pick<
  FlowRunState,
  'workflowId' | 'executionId' | 'isRunning' | 'finalStatus' | 'nodeStates' | 'variables' | 'logs'
> = {
  workflowId: null,
  executionId: null,
  isRunning: false,
  finalStatus: null,
  nodeStates: {},
  variables: {},
  logs: [],
};

export const useFlowRunStore = create<FlowRunState>((set) => ({
  ...initial,

  startRun: (workflowId, executionId) =>
    set({
      ...initial,
      workflowId,
      executionId,
      isRunning: true,
    }),

  finishRun: (status) =>
    set({
      isRunning: false,
      finalStatus: status,
    }),

  markNodeStarted: (nodeId) =>
    set((state) => {
      const prev = state.nodeStates[nodeId];
      const activeCount = (prev?.activeCount ?? 0) + 1;
      // A sticky failure stays visible until the node is re-armed by a
      // fresh run (`clear`/`startRun`) — don't let another instance
      // starting flip the badge back to "running".
      const status: FlowRunNodeStatus = prev?.status === 'failed' ? 'failed' : 'running';
      return {
        nodeStates: {
          ...state.nodeStates,
          [nodeId]: { ...prev, status, activeCount },
        },
      };
    }),

  markNodeComplete: (nodeId, status, meta) =>
    set((state) => {
      const prev = state.nodeStates[nodeId];
      const activeCount = Math.max(0, (prev?.activeCount ?? 1) - 1);
      // Once any instance fails, keep the badge red for the rest of the
      // run so a later-finishing sibling instance's success can't paper
      // over it; otherwise show "running" while siblings are still in
      // flight, settling to the final status only once they've all
      // finished.
      const sticky = status === 'failed' || prev?.status === 'failed';
      const shown: FlowRunNodeStatus = sticky ? 'failed' : activeCount > 0 ? 'running' : status;
      const next: FlowRunNodeState = { status: shown, activeCount };
      if (sticky) {
        next.error = meta?.error ?? prev?.error;
      } else if (meta?.error) {
        next.error = meta.error;
      }
      if (meta?.duration !== undefined) next.duration = meta.duration;
      if (meta?.extractedVariables) next.extractedVariables = meta.extractedVariables;
      return {
        nodeStates: {
          ...state.nodeStates,
          [nodeId]: next,
        },
      };
    }),

  setVariables: (next) => set({ variables: { ...next } }),

  mergeVariables: (additions) =>
    set((state) => ({
      variables: { ...state.variables, ...additions },
    })),

  appendLog: (entry) =>
    set((state) => ({
      // Cap at 500 entries to bound memory on a runaway forEach.
      logs: state.logs.length >= 500 ? [...state.logs.slice(-499), entry] : [...state.logs, entry],
    })),

  clear: () => set({ ...initial }),
}));

/** Selector helper: live status for a node (defaults to 'idle'). */
export function selectNodeStatus(
  state: FlowRunState,
  nodeId: string | undefined
): FlowRunNodeStatus {
  if (!nodeId) return 'idle';
  return state.nodeStates[nodeId]?.status ?? 'idle';
}
