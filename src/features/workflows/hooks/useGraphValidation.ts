import { useMemo } from 'react';
import type { WorkflowGraph } from '@/types';
import { type ValidationIssue, validateWorkflowGraph } from '../lib/flowValidators';

export interface GraphValidationResult {
  /** Every issue — including non-blocking 'warning' severity (e.g. dead
   *  wiring off an `end` node). Empty when there's no persisted graph yet
   *  (the canvas renders an unpersisted, synthesised view in that case —
   *  see FlowEditor's `renderedGraph` — which isn't meaningful to validate). */
  issues: ValidationIssue[];
  /** Issues that actually block Run ('error' severity, the default when
   *  a check predates the severity field). Use this to gate a Run button;
   *  use `issues` to render the full list (including warnings) to the user. */
  blockingIssues: ValidationIssue[];
}

/**
 * Structural validity (cycles, dangling edges, missing start node, bad
 * condition/switch handles, …) for a workflow's persisted graph. Shared by
 * every Run entry point (FlowToolbar's in-canvas button, WorkflowBuilder's
 * footer button, WorkflowExecutor's dialog button) so a graph that fails
 * validation is caught before Run everywhere, not just wherever the check
 * happened to be written first.
 */
export function useGraphValidation(graph: WorkflowGraph | undefined): GraphValidationResult {
  return useMemo(() => {
    if (!graph) return { issues: [], blockingIssues: [] };
    const result = validateWorkflowGraph(graph);
    const issues = result.issues;
    const blockingIssues = issues.filter((i) => (i.severity ?? 'error') === 'error');
    return { issues, blockingIssues };
  }, [graph]);
}
