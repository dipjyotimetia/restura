/**
 * Owns the subgraph drill-down state. Renders breadcrumb +
 * toolbar + sidebar + canvas + inspector. At the top level (path=[])
 * a workflow with empty graph nodes falls back to a synthesised
 * read-only view of `workflow.requests[]`; nested subgraphs get an
 * auto-seeded start/end pair so they validate.
 */
'use client';

import { ReactFlowProvider } from '@xyflow/react';
import { useEffect, useMemo, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { selectAtPath, emptyStubGraph } from '../../lib/flowTypes';

const SUBGRAPH_TOUR_KEY = 'restura.tour.subgraphDrillDown.v1';
import { FlowBreadcrumb } from './FlowBreadcrumb';
import FlowCanvas from './FlowCanvas';
import { FlowInspector } from './FlowInspector';
import { FlowSidebar } from './FlowSidebar';
import { FlowToolbar } from './FlowToolbar';
import { deriveGraphFromLinear, layoutGraph } from './layout/autoLayout';
import { RunMonitorPanel } from './RunMonitorPanel';
import { secureStorage } from '@/lib/shared/secure-storage';
import { useWorkflowStore } from '@/store/useWorkflowStore';
import type { Workflow, WorkflowGraph, SubgraphPath } from '@/types';

interface FlowEditorProps {
  workflow: Workflow;
  onRun: () => void;
}

export default function FlowEditor({ workflow, onRun }: FlowEditorProps) {
  const setWorkflowSubgraph = useWorkflowStore((s) => s.setWorkflowSubgraph);
  const [subgraphPath, setSubgraphPath] = useState<SubgraphPath>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const renderedGraph: WorkflowGraph | null = useMemo(() => {
    if (!workflow.graph) {
      // No graph has been created yet — render a synthesised, in-memory
      // view derived from `requests[]` instead of getting stuck on
      // "Loading graph…" merely because the user opened this tab. This
      // view is NOT persisted; `workflow.graph` is only materialised by
      // an actual structural edit (see FlowCanvas's `commit` calls and
      // its `graphMaterialized` guard on viewport-only changes).
      return deriveGraphFromLinear(workflow.requests);
    }
    if (subgraphPath.length === 0) {
      if (workflow.graph.nodes.length > 0) {
        const needsLayout = workflow.graph.nodes.every(
          (n) => n.position.x === 0 && n.position.y === 0
        );
        return needsLayout ? layoutGraph(workflow.graph) : workflow.graph;
      }
      const synthesised = deriveGraphFromLinear(workflow.requests);
      return workflow.graph.viewport
        ? { ...synthesised, viewport: workflow.graph.viewport }
        : synthesised;
    }
    return selectAtPath(workflow.graph, subgraphPath);
  }, [workflow.graph, workflow.requests, subgraphPath]);

  // Auto-seed an empty subgraph on first drill into it. We only do this
  // when the slice resolves but has no nodes — happens when a user
  // creates a forEach / tryCatch via the palette (default subgraph is
  // `{ nodes: [], edges: [] }`) and clicks "Edit body" before doing
  // anything else.
  useEffect(() => {
    if (subgraphPath.length === 0) return;
    if (!workflow.graph) return;
    const slice = selectAtPath(workflow.graph, subgraphPath);
    if (slice && slice.nodes.length === 0) {
      setWorkflowSubgraph(workflow.id, subgraphPath, emptyStubGraph());
    }
  }, [subgraphPath, workflow.graph, workflow.id, setWorkflowSubgraph]);

  /** Commit a new graph slice through the store. */
  const commit = useCallback(
    (next: WorkflowGraph) => {
      setWorkflowSubgraph(workflow.id, subgraphPath, next);
    },
    [setWorkflowSubgraph, workflow.id, subgraphPath]
  );

  /** Push / pop / jump on the breadcrumb. Clears selection too. */
  const onNavigate = useCallback((nextPath: SubgraphPath) => {
    setSubgraphPath(nextPath);
    setSelectedNodeId(null);
  }, []);

  /** Push one segment onto the current path (from inspector buttons). */
  const pushPath = useCallback((segment: SubgraphPath[number]) => {
    setSubgraphPath((curr) => [...curr, segment]);
    setSelectedNodeId(null);
    // One-time toast — many users miss that drilling into a forEach /
    // tryCatch swaps the canvas for a separate editable slice.
    if (!secureStorage.get(SUBGRAPH_TOUR_KEY)) {
      toast.info('Now editing inside a sub-graph. Click "root" in the breadcrumb to go back.', {
        duration: 8000,
      });
      secureStorage.set(SUBGRAPH_TOUR_KEY, '1');
    }
  }, []);

  // If the path becomes stale (parent node deleted in another tab), bail
  // back to root. Cheap reactive guard.
  useEffect(() => {
    if (subgraphPath.length === 0) return;
    if (!workflow.graph) return;
    if (!selectAtPath(workflow.graph, subgraphPath)) {
      setSubgraphPath([]);
      setSelectedNodeId(null);
    }
  }, [workflow.graph, subgraphPath]);

  const canRun =
    workflow.requests.length > 0 ||
    (workflow.graph?.nodes.some((n) => n.kind === 'request') ?? false);

  return (
    <ReactFlowProvider>
      <div className="flex flex-col h-full w-full">
        <FlowToolbar workflow={workflow} onRun={onRun} canRun={canRun} />
        <FlowBreadcrumb workflow={workflow} path={subgraphPath} onNavigate={onNavigate} />
        <div className="flex-1 flex min-h-0">
          <FlowSidebar collectionId={workflow.collectionId} />
          <div className="flex-1 min-w-0 flex flex-col">
            <div className="flex-1 min-h-0">
              {renderedGraph ? (
                <FlowCanvas
                  workflow={workflow}
                  graph={renderedGraph}
                  subgraphPath={subgraphPath}
                  commit={commit}
                  selectedNodeId={selectedNodeId}
                  onSelectionChange={setSelectedNodeId}
                  graphMaterialized={Boolean(workflow.graph)}
                />
              ) : (
                <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
                  Loading graph…
                </div>
              )}
            </div>
            <RunMonitorPanel />
          </div>
          <FlowInspector
            workflow={workflow}
            subgraphPath={subgraphPath}
            selectedNodeId={selectedNodeId}
            onClose={() => setSelectedNodeId(null)}
            onDrillInto={pushPath}
          />
        </div>
      </div>
    </ReactFlowProvider>
  );
}
