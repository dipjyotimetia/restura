/** OWS-only Flow import/export. Legacy Restura graph envelopes are rejected. */

import { parseOwsWorkflowImport, serializeOwsWorkflowJson } from '@shared/ows/workflow-profile';
import { v4 as uuidv4 } from 'uuid';
import { normalizeOwsWorkflowArtifacts, type OwsStoredWorkflow } from '@/store/useWorkflowStore';

export type WorkflowImportResult =
  | { ok: true; workflow: OwsStoredWorkflow }
  | { ok: false; error: string };

/**
 * Portable UI export is exactly the canonical OWS JSON document. Bindings and
 * layout are separate workspace artifacts, never executable OWS extensions.
 */
export function exportWorkflow(workflow: OwsStoredWorkflow): string {
  return serializeOwsWorkflowJson(workflow.document);
}

export function parseWorkflowImport(json: string, collectionId: string): WorkflowImportResult {
  try {
    // YAML is accepted only as an import convenience. The returned workflow
    // is normalized by the SDK and all subsequent export/persistence is JSON.
    // A document containing calls needs its separate typed bindings artifact
    // before it can be admitted to the executable store.
    const document = parseOwsWorkflowImport(json);
    const artifacts = normalizeOwsWorkflowArtifacts(
      document,
      { version: 1, tasks: {} },
      { version: 1, nodes: {} }
    );
    const now = Date.now();
    return {
      ok: true,
      workflow: {
        id: uuidv4(),
        collectionId,
        ...artifacts,
        createdAt: now,
        updatedAt: now,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Invalid OWS workflow artifact.',
    };
  }
}
