/**
 * Top toolbar inside the Graph tab: undo/redo (driven by zundo's
 * temporal store), auto-layout, fit-view, run.
 */
'use client';

import { useEffect, useCallback } from 'react';
import type { Workflow, WorkflowGraph } from '@/types';
import { useWorkflowStore } from '@/store/useWorkflowStore';
import { useReactFlow } from '@xyflow/react';
import { Button } from '@/components/ui/button';
import { Undo2, Redo2, LayoutGrid, Maximize2, Play } from 'lucide-react';
import { layoutGraph } from './layout/autoLayout';

interface FlowToolbarProps {
  workflow: Workflow;
  onRun: () => void;
  canRun: boolean;
}

export function FlowToolbar({ workflow, onRun, canRun }: FlowToolbarProps) {
  const setWorkflowGraph = useWorkflowStore((s) => s.setWorkflowGraph);
  const temporal = useWorkflowStore.temporal;
  const reactFlow = useReactFlow();

  // We deliberately read pastStates / futureStates length lazily on each
  // render rather than subscribing through `useStore(temporal, ...)` — the
  // disable-state nudge doesn't need pixel-tight reactivity, and lazy
  // reads keep us out of zundo's internal subscription churn.
  const pastCount = temporal.getState().pastStates.length;
  const futureCount = temporal.getState().futureStates.length;

  const undo = useCallback(() => temporal.getState().undo(), [temporal]);
  const redo = useCallback(() => temporal.getState().redo(), [temporal]);

  const handleAutoLayout = useCallback(() => {
    if (!workflow.graph || workflow.graph.nodes.length === 0) return;
    const next: WorkflowGraph = layoutGraph(workflow.graph);
    setWorkflowGraph(workflow.id, next);
    // Re-fit-view after a tick so React Flow picks up the new positions.
    setTimeout(() => reactFlow.fitView({ padding: 0.2, duration: 300 }), 50);
  }, [workflow.graph, workflow.id, setWorkflowGraph, reactFlow]);

  const handleFitView = useCallback(() => {
    reactFlow.fitView({ padding: 0.2, duration: 300 });
  }, [reactFlow]);

  // Cmd/Ctrl+Z / Cmd+Shift+Z. Scoped to the canvas wrapper would be
  // ideal; for Phase 3 a window-level listener with a guard is enough —
  // the dialog has focus when the canvas is visible.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  return (
    <div className="flex items-center gap-1 px-2 py-1.5 border-b border-sp-line bg-sp-surface">
      <Button
        size="sm"
        variant="ghost"
        className="h-7 px-2"
        onClick={undo}
        disabled={pastCount === 0}
        title="Undo (Cmd/Ctrl+Z)"
      >
        <Undo2 className="h-3.5 w-3.5" />
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 px-2"
        onClick={redo}
        disabled={futureCount === 0}
        title="Redo (Cmd/Ctrl+Shift+Z)"
      >
        <Redo2 className="h-3.5 w-3.5" />
      </Button>
      <div className="w-px h-4 bg-sp-line mx-1" />
      <Button
        size="sm"
        variant="ghost"
        className="h-7 px-2 text-xs"
        onClick={handleAutoLayout}
        title="Auto-layout (dagre)"
      >
        <LayoutGrid className="h-3.5 w-3.5 mr-1.5" />
        Auto-layout
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 px-2 text-xs"
        onClick={handleFitView}
        title="Fit view"
      >
        <Maximize2 className="h-3.5 w-3.5 mr-1.5" />
        Fit
      </Button>
      <div className="flex-1" />
      <Button size="sm" className="h-7 px-3 text-xs" onClick={onRun} disabled={!canRun}>
        <Play className="h-3.5 w-3.5 mr-1.5" />
        Run
      </Button>
    </div>
  );
}
