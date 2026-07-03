/**
 * Top toolbar inside the Graph tab: undo/redo (driven by zundo's
 * temporal store), auto-layout, fit-view, run.
 */
'use client';

import { useReactFlow } from '@xyflow/react';
import { Undo2, Redo2, LayoutGrid, Maximize2, Play, AlertTriangle } from 'lucide-react';
import { useEffect, useCallback, useMemo } from 'react';
import { validateWorkflowGraph } from '../../lib/flowValidators';
import { layoutGraph } from './layout/autoLayout';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/shared/utils';
import { useWorkflowStore } from '@/store/useWorkflowStore';
import type { Workflow, WorkflowGraph } from '@/types';

interface FlowToolbarProps {
  workflow: Workflow;
  onRun: () => void;
  canRun: boolean;
}

export function FlowToolbar({ workflow, onRun, canRun }: FlowToolbarProps) {
  const setWorkflowGraph = useWorkflowStore((s) => s.setWorkflowGraph);
  const temporal = useWorkflowStore.temporal;
  const reactFlow = useReactFlow();

  // Structural validity (cycles, dangling edges, missing start node, bad
  // condition/switch handles, …) previously only surfaced at Run time as a
  // single opaque top-level failure — nothing in the editor told the user
  // which node/edge was wrong before they clicked Run. Only validate the
  // actually-persisted graph: before any real edit `workflow.graph` is
  // absent and the canvas renders a synthesised, unpersisted view (see
  // FlowEditor's `renderedGraph`) that isn't meaningful to validate yet.
  const validation = useMemo(() => {
    if (!workflow.graph) return null;
    return validateWorkflowGraph(workflow.graph);
  }, [workflow.graph]);
  // `ok: true` can still carry non-blocking warnings (e.g. dead wiring off
  // an `end` node) — show all issues, but only block Run on 'error' ones.
  const issues = validation?.issues ?? [];
  const blockingIssues = issues.filter((i) => (i.severity ?? 'error') === 'error');

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
      {issues.length > 0 && (
        <Popover>
          <PopoverTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs text-amber-500 hover:text-amber-500"
              title={`${issues.length} validation issue${issues.length === 1 ? '' : 's'}`}
            >
              <AlertTriangle className="h-3.5 w-3.5 mr-1.5" />
              {issues.length} issue{issues.length === 1 ? '' : 's'}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-96 max-h-72 overflow-y-auto">
            <div className="text-xs font-medium mb-2">
              {blockingIssues.length > 0
                ? "This graph won't run until these are fixed:"
                : 'Non-blocking warnings:'}
            </div>
            <ul className="space-y-1.5">
              {issues.map((issue, i) => (
                <li key={i} className="text-xs">
                  <span
                    className={cn(
                      'font-mono',
                      (issue.severity ?? 'error') === 'error'
                        ? 'text-red-500'
                        : 'text-muted-foreground'
                    )}
                  >
                    {issue.path || 'graph'}
                  </span>
                  <span className="block text-foreground">{issue.message}</span>
                </li>
              ))}
            </ul>
          </PopoverContent>
        </Popover>
      )}
      <Button
        size="sm"
        className="h-7 px-3 text-xs"
        onClick={onRun}
        disabled={!canRun || blockingIssues.length > 0}
        title={blockingIssues.length > 0 ? 'Fix validation issues before running' : undefined}
      >
        <Play className="h-3.5 w-3.5 mr-1.5" />
        Run
      </Button>
    </div>
  );
}
