import type { OwsBindings, OwsLayout } from '@shared/ows/bindings';
import { isOwsBindings } from '@shared/ows/bindings';
import {
  normalizeOwsWorkflow,
  type OwsWorkflow,
  validateOwsProfile,
} from '@shared/ows/workflow-profile';
import { v4 as uuidv4 } from 'uuid';
import { temporal } from 'zundo';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { dexieStorageAdapters } from '@/lib/shared/dexie-storage';

/**
 * The renderer's workflow record intentionally contains only portable OWS
 * semantics plus Restura-owned references and presentation metadata. The
 * document is executable; bindings and layout are not.
 */
export interface OwsStoredWorkflow {
  id: string;
  collectionId: string;
  /** Portable artifact directory id when this workflow was loaded from disk. */
  workspaceId?: string;
  document: OwsWorkflow;
  bindings: OwsBindings;
  layout: OwsLayout;
  createdAt: number;
  updatedAt: number;
}

interface WorkflowState {
  workflows: OwsStoredWorkflow[];

  addWorkflow: (workflow: OwsStoredWorkflow) => void;
  renameWorkflow: (id: string, name: string) => void;
  updateWorkflowArtifacts: (
    id: string,
    document: OwsWorkflow,
    bindings: OwsBindings,
    layout: OwsLayout
  ) => void;
  removeWorkflow: (id: string) => void;
  removeWorkflowsByCollectionId: (collectionId: string) => void;
  getWorkflowById: (id: string) => OwsStoredWorkflow | undefined;
  getWorkflowsByCollectionId: (collectionId: string) => OwsStoredWorkflow[];
  createNewWorkflow: (name: string, collectionId: string) => OwsStoredWorkflow;
}

function workflowName(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'workflow';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateLayout(layout: unknown): asserts layout is OwsLayout {
  if (!isRecord(layout) || layout.version !== 1 || !isRecord(layout.nodes)) {
    throw new Error('OWS layout must be a version 1 non-semantic layout document.');
  }
  for (const position of Object.values(layout.nodes)) {
    if (
      !isRecord(position) ||
      typeof position.x !== 'number' ||
      !Number.isFinite(position.x) ||
      typeof position.y !== 'number' ||
      !Number.isFinite(position.y)
    ) {
      throw new Error('OWS layout node positions must be finite numbers.');
    }
  }
}

function collectCallPaths(list: unknown, path: string, output: Set<string>): void {
  if (!Array.isArray(list)) return;
  for (const [index, entry] of list.entries()) {
    if (!isRecord(entry) || Object.keys(entry).length !== 1) continue;
    const [name, task] = Object.entries(entry)[0] ?? [];
    if (!name || !isRecord(task)) continue;
    const taskPath = `${path}/${index}/${name}`;
    if ('call' in task) output.add(taskPath);
    if ('do' in task) collectCallPaths(task.do, `${taskPath}/do`, output);
  }
}

/** Validate every persisted artifact together so a document can never be saved with stale bindings. */
export function normalizeOwsWorkflowArtifacts(
  document: OwsWorkflow,
  bindings: OwsBindings,
  layout: OwsLayout
): Pick<OwsStoredWorkflow, 'document' | 'bindings' | 'layout'> {
  const normalized = normalizeOwsWorkflow(document);
  const profile = validateOwsProfile(normalized);
  if (!profile.ok) {
    throw new Error(
      `Workflow is outside Restura's executable profile: ${profile.issues[0]?.message ?? 'invalid profile'}`
    );
  }
  if (!isOwsBindings(bindings)) {
    throw new Error('Workflow bindings must be a version 1 typed bindings document.');
  }
  validateLayout(layout);

  const callPaths = new Set<string>();
  collectCallPaths(normalized.do, '/do', callPaths);
  for (const taskPath of callPaths) {
    if (!bindings.tasks[taskPath]) {
      throw new Error(`Workflow call ${taskPath} is missing an approved binding.`);
    }
  }
  for (const taskPath of Object.keys(bindings.tasks)) {
    if (!callPaths.has(taskPath)) {
      throw new Error(
        `Workflow binding task path ${taskPath} does not exist in the workflow document.`
      );
    }
  }
  return { document: normalized, bindings, layout };
}

function createDocument(name: string): OwsWorkflow {
  return {
    document: {
      dsl: '1.0.3',
      namespace: 'restura',
      name: workflowName(name),
      version: '1.0.0',
    },
    // OWS requires a task list entry. A zero-duration wait is a bounded no-op
    // and replaces the old persisted synthetic graph start/end nodes.
    do: [{ initialize: { wait: { milliseconds: 0 } } }],
  };
}

function toStoredWorkflow(value: unknown): OwsStoredWorkflow | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.collectionId !== 'string') {
    return undefined;
  }
  if (typeof value.createdAt !== 'number' || typeof value.updatedAt !== 'number') return undefined;
  try {
    const artifacts = normalizeOwsWorkflowArtifacts(
      value.document as OwsWorkflow,
      value.bindings as OwsBindings,
      value.layout as OwsLayout
    );
    return {
      id: value.id,
      collectionId: value.collectionId,
      ...(typeof value.workspaceId === 'string' ? { workspaceId: value.workspaceId } : {}),
      ...artifacts,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    };
  } catch {
    // Legacy/malformed records are intentionally unavailable; no conversion
    // or shadow persistence path exists.
    return undefined;
  }
}

export const useWorkflowStore = create<WorkflowState>()(
  temporal(
    persist(
      (set, get) => ({
        workflows: [],
        addWorkflow: (workflow) => {
          const normalized = toStoredWorkflow(workflow);
          if (!normalized) throw new Error('Invalid workflow artifact.');
          set((state) => ({ workflows: [...state.workflows, normalized] }));
        },
        renameWorkflow: (id, name) =>
          set((state) => ({
            workflows: state.workflows.map((workflow) => {
              if (workflow.id !== id) return workflow;
              const document = {
                ...workflow.document,
                document: { ...workflow.document.document, name: workflowName(name) },
              } as OwsWorkflow;
              return {
                ...workflow,
                ...normalizeOwsWorkflowArtifacts(document, workflow.bindings, workflow.layout),
                updatedAt: Date.now(),
              };
            }),
          })),
        updateWorkflowArtifacts: (id, document, bindings, layout) => {
          const artifacts = normalizeOwsWorkflowArtifacts(document, bindings, layout);
          set((state) => ({
            workflows: state.workflows.map((workflow) =>
              workflow.id === id ? { ...workflow, ...artifacts, updatedAt: Date.now() } : workflow
            ),
          }));
        },
        removeWorkflow: (id) =>
          set((state) => ({ workflows: state.workflows.filter((workflow) => workflow.id !== id) })),
        removeWorkflowsByCollectionId: (collectionId) =>
          set((state) => ({
            workflows: state.workflows.filter((workflow) => workflow.collectionId !== collectionId),
          })),
        getWorkflowById: (id) => get().workflows.find((workflow) => workflow.id === id),
        getWorkflowsByCollectionId: (collectionId) =>
          get().workflows.filter((workflow) => workflow.collectionId === collectionId),
        createNewWorkflow: (name, collectionId) => {
          const now = Date.now();
          const bindings: OwsBindings = { version: 1, tasks: {} };
          const layout: OwsLayout = { version: 1, nodes: {} };
          return {
            id: uuidv4(),
            collectionId,
            ...normalizeOwsWorkflowArtifacts(createDocument(name), bindings, layout),
            createdAt: now,
            updatedAt: now,
          };
        },
      }),
      {
        name: 'workflow-storage',
        version: 4,
        storage: dexieStorageAdapters.workflows(),
        partialize: (state) => ({ workflows: state.workflows }),
        // The application never transforms legacy graphs. Any record that is
        // not a complete OWS artifact is dropped during hydration.
        merge: (persisted, current) => {
          const raw =
            isRecord(persisted) && Array.isArray(persisted.workflows) ? persisted.workflows : [];
          return {
            ...current,
            workflows: raw.flatMap((workflow) => {
              const normalized = toStoredWorkflow(workflow);
              return normalized ? [normalized] : [];
            }),
          };
        },
        onRehydrateStorage: () => (_state, error) => {
          if (error) console.error('OWS workflow store rehydration failed:', error);
        },
      }
    ),
    {
      partialize: (state) => ({ workflows: state.workflows }),
      limit: 10,
    }
  )
);
