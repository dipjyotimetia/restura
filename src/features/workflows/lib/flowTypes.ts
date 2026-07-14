/**
 * Re-exports + helpers for the React Flow DAG types defined in
 * `src/types/index.ts`. Kept thin — the canonical types live in the
 * top-level types module so the workflow store, the executor, and the
 * canvas all see the same shapes.
 *
 * Anything that needs Zod validation lives in `flowValidators.ts`.
 */
import { v4 as uuidv4 } from 'uuid';
import type {
  ConditionFlowNode,
  FlowEdge,
  FlowNode,
  FlowNodeKind,
  ForEachFlowNode,
  ParallelFlowNode,
  RequestFlowNode,
  SubgraphPath,
  SubWorkflowFlowNode,
  TryCatchFlowNode,
  WorkflowGraph,
} from '@/types';

export type {
  ConditionFlowNode,
  FlowEdge,
  FlowNode,
  FlowNodeKind,
  ForEachFlowNode,
  ParallelFlowNode,
  RequestFlowNode,
  SubgraphPath,
  SubWorkflowFlowNode,
  TryCatchFlowNode,
  WorkflowGraph,
};

/**
 * Bumped when the persisted `WorkflowGraph` shape changes in a
 * backward-incompatible way. There is currently NO migration path: this
 * constant is only ever used to stamp brand-new graphs (here and in
 * FlowCanvas's palette default), and `flowValidators.ts` hardcodes
 * `version: z.literal(1)` rather than referencing it — nothing reads or
 * upgrades an existing persisted graph's version at load time. Bumping
 * this without first adding a migration step (e.g. in `workflowIO.ts`'s
 * import path and wherever `useWorkflowStore` hydrates from storage) will
 * hard-fail every previously-saved workflow's graph against the new Zod
 * schema — validation, not silent corruption, but with no upgrade path
 * offered to the user.
 */
export const CURRENT_GRAPH_VERSION = 1 as const;

/**
 * A brand-new subgraph seeded with a start + end node so it satisfies the
 * validator's "exactly one start / at least one end" rule out of the box.
 *
 * Subgraph-bearing nodes (forEach / loop / tryCatch) MUST default to this
 * rather than an empty `{ nodes: [], edges: [] }`: an empty subgraph fails
 * `validateWorkflowGraph`, so dropping one of these nodes and running the
 * workflow *before* drilling into its body would otherwise fail the whole
 * run at validation. Used both as the palette default (FlowCanvas) and as the
 * drill-in auto-seed (FlowEditor) so the two can't drift apart.
 */
export function emptyStubGraph(): WorkflowGraph {
  return {
    version: CURRENT_GRAPH_VERSION,
    nodes: [
      { id: `start-${uuidv4()}`, kind: 'start', position: { x: 240, y: 80 } },
      { id: `end-${uuidv4()}`, kind: 'end', position: { x: 240, y: 240 } },
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

export function isRequestNode(node: FlowNode): node is RequestFlowNode {
  return node.kind === 'request';
}

export function isConditionNode(node: FlowNode): node is ConditionFlowNode {
  return node.kind === 'condition';
}

export function isParallelNode(node: FlowNode): node is ParallelFlowNode {
  return node.kind === 'parallel';
}

export function isForEachNode(node: FlowNode): node is ForEachFlowNode {
  return node.kind === 'forEach';
}

export function isTryCatchNode(node: FlowNode): node is TryCatchFlowNode {
  return node.kind === 'tryCatch';
}

export function isSubWorkflowNode(node: FlowNode): node is SubWorkflowFlowNode {
  return node.kind === 'subWorkflow';
}

export function findStartNode(graph: WorkflowGraph): FlowNode | undefined {
  return graph.nodes.find((n) => n.kind === 'start');
}

export function findEndNodes(graph: WorkflowGraph): FlowNode[] {
  return graph.nodes.filter((n) => n.kind === 'end');
}

export function getOutgoingEdges(graph: WorkflowGraph, nodeId: string): FlowEdge[] {
  return graph.edges.filter((e) => e.source === nodeId);
}

export function getIncomingEdges(graph: WorkflowGraph, nodeId: string): FlowEdge[] {
  return graph.edges.filter((e) => e.target === nodeId);
}

export function getNodeById(graph: WorkflowGraph, nodeId: string): FlowNode | undefined {
  return graph.nodes.find((n) => n.id === nodeId);
}

/**
 * Recursively yield every WorkflowGraph: the input plus any nested
 * subgraphs (forEach / tryCatch). Used by the cycle detector and the
 * recursive Zod validator.
 */
export function* allSubgraphs(graph: WorkflowGraph): Generator<WorkflowGraph> {
  yield graph;
  for (const node of graph.nodes) {
    if (node.kind === 'forEach' || node.kind === 'loop') {
      yield* allSubgraphs(node.data.subgraph);
    } else if (node.kind === 'tryCatch') {
      yield* allSubgraphs(node.data.trySubgraph);
      yield* allSubgraphs(node.data.catchSubgraph);
    }
  }
}

// ---------- SubgraphPath helpers ----------

/**
 * Read the nested subgraph at `path` inside `root`. Returns `null` if
 * any segment references a missing node or a kind/key combination that
 * doesn't carry a subgraph slot (e.g. `'subgraph'` on a tryCatch).
 *
 * `path === []` returns `root` unchanged — top-level slice.
 */
export function selectAtPath(root: WorkflowGraph, path: SubgraphPath): WorkflowGraph | null {
  if (path.length === 0) return root;
  const [head, ...rest] = path;
  if (!head) return null;
  const parent = root.nodes.find((n) => n.id === head.parentNodeId);
  if (!parent) return null;
  if ((parent.kind === 'forEach' || parent.kind === 'loop') && head.key === 'subgraph') {
    return selectAtPath(parent.data.subgraph, rest);
  }
  if (parent.kind === 'tryCatch') {
    if (head.key === 'trySubgraph') {
      return selectAtPath(parent.data.trySubgraph, rest);
    }
    if (head.key === 'catchSubgraph') {
      return selectAtPath(parent.data.catchSubgraph, rest);
    }
  }
  return null;
}

/**
 * Return a new root graph with the subgraph at `path` replaced by
 * `replacement`. Returns the original root unchanged if `path` is
 * invalid — caller should validate paths via `selectAtPath` first if
 * silent no-op is unacceptable.
 *
 * `path === []` returns `replacement` (callers should usually invoke
 * `setWorkflowGraph` directly for that case).
 */
export function setAtPath(
  root: WorkflowGraph,
  path: SubgraphPath,
  replacement: WorkflowGraph
): WorkflowGraph {
  if (path.length === 0) return replacement;
  const [head, ...rest] = path;
  if (!head) return root;
  let touched = false;
  const nextNodes = root.nodes.map((node) => {
    if (node.id !== head.parentNodeId) return node;
    // forEach and loop both carry a single `data.subgraph` slot (matches the
    // combined check in selectAtPath / allSubgraphs). The cast is needed
    // because narrowing to the union widens `data` past what TS will
    // re-assign to a single FlowNode member when the object is rebuilt.
    if ((node.kind === 'forEach' || node.kind === 'loop') && head.key === 'subgraph') {
      touched = true;
      return {
        ...node,
        data: {
          ...node.data,
          subgraph: setAtPath(node.data.subgraph, rest, replacement),
        },
      } as FlowNode;
    }
    if (node.kind === 'tryCatch' && head.key === 'trySubgraph') {
      touched = true;
      return {
        ...node,
        data: {
          ...node.data,
          trySubgraph: setAtPath(node.data.trySubgraph, rest, replacement),
        },
      };
    }
    if (node.kind === 'tryCatch' && head.key === 'catchSubgraph') {
      touched = true;
      return {
        ...node,
        data: {
          ...node.data,
          catchSubgraph: setAtPath(node.data.catchSubgraph, rest, replacement),
        },
      };
    }
    // Wrong kind/key — return node unchanged (path is invalid here).
    return node;
  });
  if (!touched) return root;
  return { ...root, nodes: nextNodes };
}

/**
 * Human-readable label for a path segment — used by the breadcrumb.
 *   { key: 'subgraph' }      -> 'body'
 *   { key: 'trySubgraph' }   -> 'try'
 *   { key: 'catchSubgraph' } -> 'catch'
 */
export function pathSegmentLabel(key: SubgraphPath[number]['key']): string {
  switch (key) {
    case 'subgraph':
      return 'body';
    case 'trySubgraph':
      return 'try';
    case 'catchSubgraph':
      return 'catch';
  }
}
