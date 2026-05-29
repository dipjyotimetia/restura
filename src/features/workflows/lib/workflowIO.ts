/**
 * Workflow JSON import/export. Pure functions (no DOM / store access) so
 * they're unit-testable; the UI layer handles file download/upload.
 *
 * Export wraps the Workflow in a small envelope with a format marker so
 * imports can be recognised and versioned. Import re-ids the workflow
 * (node ids are workflow-scoped so they need no remap) and validates any
 * embedded graph through the same Zod gate the store uses.
 */
import { v4 as uuidv4 } from 'uuid';
import type { Workflow } from '@/types';
import { validateWorkflowGraph } from './flowValidators';

export const WORKFLOW_EXPORT_FORMAT = 'restura-workflow';
export const WORKFLOW_EXPORT_VERSION = 1;

interface WorkflowEnvelope {
  format: typeof WORKFLOW_EXPORT_FORMAT;
  version: number;
  workflow: Workflow;
}

/** Serialise a workflow to a pretty JSON string for download. */
export function exportWorkflow(workflow: Workflow): string {
  const envelope: WorkflowEnvelope = {
    format: WORKFLOW_EXPORT_FORMAT,
    version: WORKFLOW_EXPORT_VERSION,
    workflow,
  };
  return JSON.stringify(envelope, null, 2);
}

export type ImportResult = { ok: true; workflow: Workflow } | { ok: false; error: string };

/**
 * Parse + validate an imported JSON string into a fresh Workflow bound to
 * `collectionId`. Accepts either the export envelope or a bare Workflow
 * object. The result always gets a new id + timestamps so it can't clash
 * with an existing workflow.
 */
export function parseWorkflowImport(json: string, collectionId: string): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: 'Not valid JSON.' };
  }

  const raw: unknown =
    parsed && typeof parsed === 'object' && 'workflow' in parsed
      ? (parsed as { workflow: unknown }).workflow
      : parsed;

  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'No workflow object found.' };
  }
  const candidate = raw as Partial<Workflow>;
  if (typeof candidate.name !== 'string' || candidate.name.trim() === '') {
    return { ok: false, error: 'Workflow is missing a name.' };
  }

  if (candidate.graph !== undefined) {
    const res = validateWorkflowGraph(candidate.graph);
    if (!res.ok) {
      const first = res.issues[0];
      return {
        ok: false,
        error: `Invalid graph${first ? `: ${first.path} — ${first.message}` : ''}`,
      };
    }
  }

  const now = Date.now();
  const workflow: Workflow = {
    id: uuidv4(),
    name: candidate.name,
    collectionId,
    requests: Array.isArray(candidate.requests) ? candidate.requests : [],
    createdAt: now,
    updatedAt: now,
    ...(candidate.description ? { description: candidate.description } : {}),
    ...(candidate.variables ? { variables: candidate.variables } : {}),
    ...(candidate.graph ? { graph: candidate.graph } : {}),
  };
  return { ok: true, workflow };
}
