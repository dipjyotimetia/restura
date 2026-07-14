/**
 * The React Flow host. Slice-agnostic: parent supplies `graph` + a
 * `commit(next)` callback so the same component renders top-level
 * and nested forEach / tryCatch subgraphs.
 */
'use client';

import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  BackgroundVariant,
  type Connection,
  Controls,
  type Edge,
  type EdgeChange,
  type EdgeTypes,
  MiniMap,
  type Node,
  type NodeChange,
  type NodeTypes,
  ReactFlow,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import '@xyflow/react/dist/style.css';
import './flow-canvas.css';
import { v4 as uuidv4 } from 'uuid';
import { useWorkflowStore } from '@/store/useWorkflowStore';
import type {
  FlowEdge,
  FlowNode,
  FlowNodeKind,
  SubgraphPath,
  Workflow,
  WorkflowGraph,
} from '@/types';
import { emptyStubGraph } from '../../lib/flowTypes';
import { useFlowRunStore } from '../../store/useFlowRunStore';
import { DefaultEdge } from './edges/DefaultEdge';
import { FLOW_DRAG_KIND_MIME, FLOW_DRAG_REQUEST_MIME } from './FlowSidebar';
import { ConditionNode } from './nodes/ConditionNode';
import { DelayNode } from './nodes/DelayNode';
import { DisplayNode } from './nodes/DisplayNode';
import { EndNode } from './nodes/EndNode';
import { ForEachNode } from './nodes/ForEachNode';
import { LoopNode } from './nodes/LoopNode';
import { McpCallNode } from './nodes/McpCallNode';
import { ParallelNode } from './nodes/ParallelNode';
import { RequestNode } from './nodes/RequestNode';
import { SetVariableNode } from './nodes/SetVariableNode';
import { SseSubscribeNode } from './nodes/SseSubscribeNode';
import { StartNode } from './nodes/StartNode';
import { SubWorkflowNode } from './nodes/SubWorkflowNode';
import { SwitchNode } from './nodes/SwitchNode';
import { TemplateNode } from './nodes/TemplateNode';
import { TransformNode } from './nodes/TransformNode';
import { TryCatchNode } from './nodes/TryCatchNode';
import { WsExchangeNode } from './nodes/WsExchangeNode';

const nodeTypes: NodeTypes = {
  start: StartNode,
  end: EndNode,
  request: RequestNode,
  condition: ConditionNode,
  switch: SwitchNode,
  setVariable: SetVariableNode,
  delay: DelayNode,
  transform: TransformNode,
  template: TemplateNode,
  display: DisplayNode,
  parallel: ParallelNode,
  forEach: ForEachNode,
  loop: LoopNode,
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
  /**
   * Whether `workflow.graph` has actually been persisted yet. `false`
   * only at the top level before any real edit — `graph` is then a
   * synthesised, in-memory view derived from `requests[]` (see
   * FlowEditor's `renderedGraph`). React Flow's initial `fitView` fires
   * `onMoveEnd` on mount purely from rendering that synthesised view;
   * committing that viewport-only change would silently materialise
   * (and persist) a graph just from opening the tab. Structural edits
   * (add/move/connect/delete — the `commitLocal` calls below) always
   * commit regardless, since those are genuine user intent to build a
   * graph.
   */
  graphMaterialized: boolean;
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
  const {
    workflowId: _wf,
    status: _status,
    ...rest
  } = rfNode.data as Record<string, unknown> & { workflowId?: string; status?: string };
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
    case 'switch':
      return {
        cases: [{ id: uuidv4(), label: 'case 1', expression: 'return false;' }],
      };
    case 'setVariable':
      return { assignments: [] };
    case 'delay':
      return { ms: 1000 };
    case 'transform':
      return { script: '// edit me\n' };
    case 'template':
      return { template: '', resultVar: 'rendered' };
    case 'display':
      return { valueExpression: 'return {};', mode: 'json' };
    case 'parallel':
      return { waitMode: 'all', mergeStrategy: 'fail-on-conflict' };
    case 'forEach':
      return {
        collectionExpression: 'return [];',
        iteratorVar: 'item',
        concurrency: 8,
        subgraph: emptyStubGraph(),
      };
    case 'loop':
      return {
        conditionExpression: 'return false;',
        mode: 'while',
        maxIterations: 10,
        delayMs: 0,
        subgraph: emptyStubGraph(),
      };
    case 'tryCatch':
      return {
        trySubgraph: emptyStubGraph(),
        catchSubgraph: emptyStubGraph(),
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
  graphMaterialized,
}: FlowCanvasProps) {
  const addRequestNode = useWorkflowStore((s) => s.addRequestNode);
  const reactFlow = useReactFlow();
  const wrapperRef = useRef<HTMLDivElement>(null);

  const initialNodes = useMemo(
    () => graph.nodes.map((n) => flowNodeToRf(n, workflow.id)),
    [graph.nodes, workflow.id]
  );
  const initialEdges = useMemo(() => graph.edges.map(flowEdgeToRf), [graph.edges]);

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
          (c) => c.type === 'remove' || (c.type === 'position' && c.dragging === false)
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
            parsed.kind === 'sse' ? 'sseSubscribe' : parsed.kind === 'mcp' ? 'mcpCall' : 'request';
          addRequestNode(workflow.id, parsed.id, parsed.name, flowPosition, subgraphPath, nodeKind);
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
    <div className="restura-flow-canvas" ref={wrapperRef} onDrop={onDrop} onDragOver={onDragOver}>
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
          // Don't materialise a graph purely from panning/zooming (or the
          // initial `fitView`) a synthesised view — only persist viewport
          // once a real edit already created `workflow.graph`.
          if (!graphMaterialized) return;
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
