/**
 * The React Flow host. Slice-agnostic: parent supplies `graph` + a
 * `commit(next)` callback so the same component renders top-level
 * and nested forEach / tryCatch subgraphs.
 */
'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  useReactFlow,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  type Node,
  type Edge,
  type NodeTypes,
  type EdgeTypes,
  type NodeChange,
  type EdgeChange,
  type Connection,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './flow-canvas.css';
import type {
  Workflow,
  FlowNode,
  FlowEdge,
  WorkflowGraph,
  FlowNodeKind,
  SubgraphPath,
} from '@/types';
import { v4 as uuidv4 } from 'uuid';
import { useWorkflowStore } from '@/store/useWorkflowStore';
import { useFlowRunStore } from '../../store/useFlowRunStore';
import { RequestNode } from './nodes/RequestNode';
import { StartNode } from './nodes/StartNode';
import { EndNode } from './nodes/EndNode';
import { ConditionNode } from './nodes/ConditionNode';
import { SetVariableNode } from './nodes/SetVariableNode';
import { DelayNode } from './nodes/DelayNode';
import { TransformNode } from './nodes/TransformNode';
import { ParallelNode } from './nodes/ParallelNode';
import { ForEachNode } from './nodes/ForEachNode';
import { TryCatchNode } from './nodes/TryCatchNode';
import { SubWorkflowNode } from './nodes/SubWorkflowNode';
import { SseSubscribeNode } from './nodes/SseSubscribeNode';
import { WsExchangeNode } from './nodes/WsExchangeNode';
import { McpCallNode } from './nodes/McpCallNode';
import { DefaultEdge } from './edges/DefaultEdge';
import { FLOW_DRAG_KIND_MIME, FLOW_DRAG_REQUEST_MIME } from './FlowSidebar';

const nodeTypes: NodeTypes = {
  start: StartNode,
  end: EndNode,
  request: RequestNode,
  condition: ConditionNode,
  setVariable: SetVariableNode,
  delay: DelayNode,
  transform: TransformNode,
  parallel: ParallelNode,
  forEach: ForEachNode,
  tryCatch: TryCatchNode,
  subWorkflow: SubWorkflowNode,
  sseSubscribe: SseSubscribeNode,
  wsExchange: WsExchangeNode,
  mcpCall: McpCallNode,
};

const edgeTypes: EdgeTypes = {
  default: DefaultEdge,
};

interface FlowCanvasProps {
  workflow: Workflow;
  /** The graph slice to render (top-level OR a nested subgraph). */
  graph: WorkflowGraph;
  /** Path of `graph` inside `workflow.graph`. `[]` for top-level. */
  subgraphPath: SubgraphPath;
  /** Persist a new version of the slice. */
  commit: (next: WorkflowGraph) => void;
  selectedNodeId: string | null;
  onSelectionChange: (nodeId: string | null) => void;
}

function flowNodeToRf(node: FlowNode, workflowId: string): Node {
  return {
    id: node.id,
    type: node.kind,
    position: node.position,
    data: {
      ...('data' in node ? (node.data as Record<string, unknown>) : {}),
      workflowId,
    },
  };
}

function flowEdgeToRf(edge: FlowEdge): Edge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    ...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {}),
    ...(edge.label ? { label: edge.label } : {}),
    type: 'default',
  };
}

function rfNodeToFlow(rfNode: Node): FlowNode {
  const { workflowId: _wf, status: _status, ...rest } = rfNode.data as Record<
    string,
    unknown
  > & { workflowId?: string; status?: string };
  return {
    id: rfNode.id,
    kind: rfNode.type as FlowNodeKind,
    position: rfNode.position,
    ...(Object.keys(rest).length > 0 ? { data: rest } : {}),
  } as FlowNode;
}

function rfEdgeToFlow(rfEdge: Edge): FlowEdge {
  const out: FlowEdge = {
    id: rfEdge.id,
    source: rfEdge.source,
    target: rfEdge.target,
  };
  if (rfEdge.sourceHandle) out.sourceHandle = rfEdge.sourceHandle;
  if (typeof rfEdge.label === 'string' && rfEdge.label.length > 0) {
    out.label = rfEdge.label;
  }
  return out;
}

/**
 * Default `data` payload for a freshly-dropped logic node. The shapes
 * here must match each FlowNode discriminant's `data` schema so the
 * Zod validator and DAG executor accept them.
 */
function defaultNodeData(kind: FlowNodeKind): unknown {
  switch (kind) {
    case 'condition':
      return { expression: 'return true;' };
    case 'setVariable':
      return { assignments: [] };
    case 'delay':
      return { ms: 1000 };
    case 'transform':
      return { script: '// edit me\n' };
    case 'parallel':
      return { waitMode: 'all', mergeStrategy: 'fail-on-conflict' };
    case 'forEach':
      return {
        collectionExpression: 'return [];',
        iteratorVar: 'item',
        concurrency: 8,
        subgraph: { version: 1, nodes: [], edges: [] },
      };
    case 'tryCatch':
      return {
        trySubgraph: { version: 1, nodes: [], edges: [] },
        catchSubgraph: { version: 1, nodes: [], edges: [] },
      };
    case 'subWorkflow':
      return { workflowId: '' };
    case 'sseSubscribe':
      return {
        workflowRequestId: '',
        completion: { kind: 'eventCount', n: 1 },
        accumulateAll: true,
      };
    case 'wsExchange':
      return {
        url: '',
        sendExpression: 'return JSON.stringify({});',
        matchExpression: 'return true;',
        completion: { kind: 'eventMatch', expression: 'return true;' },
      };
    case 'mcpCall':
      return {
        workflowRequestId: '',
        method: 'tools/call',
        paramsExpression: 'return {};',
      };
    default:
      return undefined;
  }
}

export default function FlowCanvas({
  workflow,
  graph,
  subgraphPath,
  commit,
  selectedNodeId,
  onSelectionChange,
}: FlowCanvasProps) {
  const addRequestNode = useWorkflowStore((s) => s.addRequestNode);
  const reactFlow = useReactFlow();
  const wrapperRef = useRef<HTMLDivElement>(null);

  const initialNodes = useMemo(
    () => graph.nodes.map((n) => flowNodeToRf(n, workflow.id)),
    [graph.nodes, workflow.id]
  );
  const initialEdges = useMemo(
    () => graph.edges.map(flowEdgeToRf),
    [graph.edges]
  );

  const [nodes, setNodes, _onNodesChangeRf] = useNodesState<Node>(initialNodes);
  const [edges, setEdges, _onEdgesChangeRf] = useEdgesState<Edge>(initialEdges);

  // Keep local state aligned when the slice changes upstream — undo,
  // drilldown swap, another tab editing the same workflow, etc.
  useEffect(() => {
    setNodes(initialNodes);
  }, [initialNodes, setNodes]);
  useEffect(() => {
    setEdges(initialEdges);
  }, [initialEdges, setEdges]);

  /** Persist the current local state up through `commit`. */
  const commitLocal = useCallback(
    (nextNodes: Node[], nextEdges: Edge[]) => {
      const nextGraph: WorkflowGraph = {
        version: 1,
        nodes: nextNodes.map(rfNodeToFlow),
        edges: nextEdges.map(rfEdgeToFlow),
        ...(graph.viewport ? { viewport: graph.viewport } : {}),
      };
      commit(nextGraph);
    },
    [commit, graph.viewport]
  );

  // ---- Change dispatchers ----

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setNodes((curr) => {
        const next = applyNodeChanges(changes, curr);
        const settled = changes.some(
          (c) =>
            c.type === 'remove' ||
            (c.type === 'position' && c.dragging === false)
        );
        if (settled) {
          setEdges((edgesCurr) => {
            commitLocal(next, edgesCurr);
            return edgesCurr;
          });
        }
        return next;
      });
    },
    [setNodes, setEdges, commitLocal]
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      setEdges((curr) => {
        const next = applyEdgeChanges(changes, curr);
        const settled = changes.some((c) => c.type === 'remove');
        if (settled) {
          setNodes((nodesCurr) => {
            commitLocal(nodesCurr, next);
            return nodesCurr;
          });
        }
        return next;
      });
    },
    [setEdges, setNodes, commitLocal]
  );

  const onConnect = useCallback(
    (params: Connection) => {
      setEdges((curr) => {
        const next = addEdge({ ...params, id: `edge-${uuidv4()}`, type: 'default' }, curr);
        setNodes((nodesCurr) => {
          commitLocal(nodesCurr, next);
          return nodesCurr;
        });
        return next;
      });
    },
    [setEdges, setNodes, commitLocal]
  );

  // ---- Drag & drop from sidebar ----

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (
      e.dataTransfer.types.includes(FLOW_DRAG_KIND_MIME) ||
      e.dataTransfer.types.includes(FLOW_DRAG_REQUEST_MIME)
    ) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const bounds = wrapperRef.current?.getBoundingClientRect();
      if (!bounds) return;
      const flowPosition = reactFlow.screenToFlowPosition({
        x: e.clientX,
        y: e.clientY,
      });

      const kindData = e.dataTransfer.getData(FLOW_DRAG_KIND_MIME);
      const requestData = e.dataTransfer.getData(FLOW_DRAG_REQUEST_MIME);

      if (requestData) {
        try {
          const parsed = JSON.parse(requestData) as {
            id: string;
            name: string;
            kind?: string;
          };
          // Pick the right node kind for the dropped request type. SSE
          // saved requests become sseSubscribe nodes, MCP become
          // mcpCall, everything else (http, grpc, graphql) stays a
          // generic `request` node.
          const nodeKind: 'request' | 'sseSubscribe' | 'mcpCall' =
            parsed.kind === 'sse'
              ? 'sseSubscribe'
              : parsed.kind === 'mcp'
                ? 'mcpCall'
                : 'request';
          addRequestNode(
            workflow.id,
            parsed.id,
            parsed.name,
            flowPosition,
            subgraphPath,
            nodeKind
          );
        } catch {
          /* ignore malformed drop */
        }
        return;
      }

      if (kindData) {
        const kind = kindData as FlowNodeKind;
        const newId = `node-${uuidv4()}`;
        const newRfNode: Node = {
          id: newId,
          type: kind,
          position: flowPosition,
          data: {
            ...(defaultNodeData(kind) as Record<string, unknown>),
            workflowId: workflow.id,
          },
        };
        setNodes((curr) => {
          const next = [...curr, newRfNode];
          setEdges((edgesCurr) => {
            commitLocal(next, edgesCurr);
            return edgesCurr;
          });
          return next;
        });
        onSelectionChange(newId);
      }
    },
    [
      reactFlow,
      workflow.id,
      addRequestNode,
      subgraphPath,
      setNodes,
      setEdges,
      commitLocal,
      onSelectionChange,
    ]
  );

  // Subscribe to the raw nodeStates object (referentially stable across
  // unrelated mutations like log appends). Building the Set inside a
  // useMemo means a log event in useFlowRunStore doesn't reclone every
  // edge and re-reconcile the canvas.
  const nodeStates = useFlowRunStore((s) => s.nodeStates);
  const runningNodeIds = useMemo(() => {
    const out = new Set<string>();
    for (const [id, st] of Object.entries(nodeStates)) {
      if (st.status === 'running') out.add(id);
    }
    return out;
  }, [nodeStates]);
  const animatedEdges = useMemo(
    () =>
      edges.map((e) =>
        runningNodeIds.has(e.target) === Boolean(e.animated)
          ? e
          : { ...e, animated: runningNodeIds.has(e.target) }
      ),
    [edges, runningNodeIds]
  );

  // Project selection onto the React-Flow node list. Memoised so we only
  // reclone when nodes or selection actually change — without this every
  // store mutation reclones the entire node list.
  const displayedNodes = useMemo(
    () =>
      nodes.map((n) =>
        Boolean(n.selected) === (n.id === selectedNodeId)
          ? n
          : { ...n, selected: n.id === selectedNodeId }
      ),
    [nodes, selectedNodeId]
  );

  return (
    <div
      className="restura-flow-canvas"
      ref={wrapperRef}
      onDrop={onDrop}
      onDragOver={onDragOver}
    >
      <ReactFlow
        nodes={displayedNodes}
        edges={animatedEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onSelectionChange={(sel) => {
          const first = sel.nodes[0]?.id ?? null;
          onSelectionChange(first);
        }}
        onMoveEnd={(_, viewport) => {
          if (
            graph.viewport &&
            graph.viewport.x === viewport.x &&
            graph.viewport.y === viewport.y &&
            graph.viewport.zoom === viewport.zoom
          ) {
            return;
          }
          commit({ ...graph, viewport });
        }}
        deleteKeyCode={['Backspace', 'Delete']}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        defaultViewport={graph.viewport ?? { x: 0, y: 0, zoom: 1 }}
        minZoom={0.2}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable />
      </ReactFlow>
    </div>
  );
}
