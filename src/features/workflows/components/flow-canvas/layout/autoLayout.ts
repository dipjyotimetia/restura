/**
 * Dagre-backed hierarchical layout for WorkflowGraph.
 *
 * Two entry points:
 *   - `layoutGraph(graph)` — returns a copy of the graph with node
 *     positions overwritten by dagre's hierarchical layout. Used by the
 *     "auto-layout" button and when first rendering a synthesised graph.
 *   - `deriveGraphFromLinear(workflowRequests)` — synthesises a linear
 *     start → request* → end graph from a legacy linear workflow's
 *     `requests[]` array. Phase 2 renders this in memory for display
 *     when the user opens the Graph tab on a workflow that doesn't have
 *     a `graph` yet. Phase 3 replaces this with a persisted graph on
 *     first edit.
 *
 * Lives under `flow-canvas/` so the eager executor path (Phase 1) never
 * pulls in the @dagrejs/dagre dependency — the ESLint rule enforces
 * this at CI time.
 */
import dagre from '@dagrejs/dagre';
import { v4 as uuidv4 } from 'uuid';
import type {
  FlowEdge,
  FlowNode,
  FlowNodeKind,
  WorkflowGraph,
  WorkflowRequest,
} from '@/types';

const DEFAULT_NODE_WIDTH = 240;
const DEFAULT_NODE_HEIGHT = 96;
const TERMINAL_NODE_HEIGHT = 56; // start/end are smaller pills

function nodeDimensions(kind: FlowNodeKind): { width: number; height: number } {
  if (kind === 'start' || kind === 'end') {
    return { width: 160, height: TERMINAL_NODE_HEIGHT };
  }
  return { width: DEFAULT_NODE_WIDTH, height: DEFAULT_NODE_HEIGHT };
}

export interface LayoutOptions {
  /** Top-to-bottom (TB) or left-to-right (LR). Default: TB. */
  direction?: 'TB' | 'LR';
  /** Spacing between nodes in same rank. */
  nodesep?: number;
  /** Spacing between ranks. */
  ranksep?: number;
}

export function layoutGraph(
  graph: WorkflowGraph,
  options: LayoutOptions = {}
): WorkflowGraph {
  const { direction = 'TB', nodesep = 60, ranksep = 80 } = options;

  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: direction, nodesep, ranksep });

  for (const node of graph.nodes) {
    g.setNode(node.id, nodeDimensions(node.kind));
  }
  for (const edge of graph.edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  const layoutedNodes: FlowNode[] = graph.nodes.map((node) => {
    const dn = g.node(node.id);
    if (!dn) return node;
    // dagre returns the center; React Flow expects top-left.
    const dims = nodeDimensions(node.kind);
    return {
      ...node,
      position: {
        x: dn.x - dims.width / 2,
        y: dn.y - dims.height / 2,
      },
    };
  });

  return {
    ...graph,
    nodes: layoutedNodes,
  };
}

/**
 * Build an in-memory read-only graph from a legacy linear workflow's
 * `requests[]`. Produces start → req1 → req2 → … → reqN → end with
 * dagre-laid-out positions, ready to feed to ReactFlow.
 *
 * Phase 2 displays this synthesised view when `workflow.graph` is
 * absent. Phase 3 calls this once to seed the persisted graph on the
 * user's first edit.
 */
export function deriveGraphFromLinear(
  workflowRequests: ReadonlyArray<WorkflowRequest>
): WorkflowGraph {
  const startId = `start-${uuidv4()}`;
  const endId = `end-${uuidv4()}`;

  const requestNodes: FlowNode[] = workflowRequests.map((wr) => ({
    id: `node-${wr.id}`,
    kind: 'request' as const,
    position: { x: 0, y: 0 },
    data: { workflowRequestId: wr.id },
  }));

  const nodes: FlowNode[] = [
    { id: startId, kind: 'start', position: { x: 0, y: 0 } },
    ...requestNodes,
    { id: endId, kind: 'end', position: { x: 0, y: 0 } },
  ];

  const edges: FlowEdge[] = [];
  let prevId = startId;
  for (const rn of requestNodes) {
    edges.push({
      id: `edge-${prevId}-${rn.id}`,
      source: prevId,
      target: rn.id,
    });
    prevId = rn.id;
  }
  edges.push({
    id: `edge-${prevId}-${endId}`,
    source: prevId,
    target: endId,
  });

  const graph: WorkflowGraph = {
    version: 1,
    nodes,
    edges,
    viewport: { x: 0, y: 0, zoom: 1 },
  };
  return layoutGraph(graph);
}
