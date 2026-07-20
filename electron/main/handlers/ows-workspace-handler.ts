import type { OwsBindings, OwsLayout } from '@shared/ows/bindings';
import {
  deleteOwsWorkflowArtifact,
  listOwsWorkflowArtifactIds,
  loadOwsWorkflowArtifact,
  saveOwsWorkflowArtifact,
} from '@shared/ows/node/workspace';
import type { OwsWorkflow } from '@shared/ows/workflow-profile';
import { ipcMain } from 'electron';
import { z } from 'zod';
import { IPC } from '../../shared/channels';
import { createValidatedHandler, FilePathSchema } from '../ipc/ipc-validators';
import { isRegisteredCollectionDirectory } from '../storage/collection-manager';

const WINDOWS_RESERVED_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);
const OwsWorkflowIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, {
    message: 'Workflow id must be a portable lowercase identifier.',
  })
  .refine((id) => !WINDOWS_RESERVED_NAMES.has(id), {
    message: 'Workflow id is reserved by portable filesystems.',
  });
const RegisteredRootSchema = z.object({ directoryPath: FilePathSchema }).strict();
const OwsArtifactReferenceSchema = RegisteredRootSchema.extend({
  workflowId: OwsWorkflowIdSchema,
}).strict();
const OwsArtifactSaveSchema = OwsArtifactReferenceSchema.extend({
  workflow: z.record(z.string(), z.unknown()),
  bindings: z.record(z.string(), z.unknown()),
  layout: z.record(z.string(), z.unknown()),
}).strict();

function accessDenied(directoryPath: string): { ok: false; error: string } | null {
  if (isRegisteredCollectionDirectory(directoryPath)) return null;
  return { ok: false, error: 'Access denied: collection root is not registered.' };
}

function errorResult(error: unknown): { ok: false; error: string } {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

/**
 * Desktop-only OWS artifact access. The collection manager's active watcher
 * registry is the authorization source, matching Git's file-backed boundary.
 */
export function registerOwsWorkspaceHandlerIPC(): void {
  ipcMain.handle(
    IPC.owsWorkspace.delete,
    createValidatedHandler(
      IPC.owsWorkspace.delete,
      OwsArtifactReferenceSchema,
      async ({ directoryPath, workflowId }) => {
        const denied = accessDenied(directoryPath);
        if (denied) return denied;
        try {
          await deleteOwsWorkflowArtifact(directoryPath, workflowId);
          return { ok: true as const };
        } catch (error) {
          return errorResult(error);
        }
      }
    )
  );
  ipcMain.handle(
    IPC.owsWorkspace.list,
    createValidatedHandler(
      IPC.owsWorkspace.list,
      RegisteredRootSchema,
      async ({ directoryPath }) => {
        const denied = accessDenied(directoryPath);
        if (denied) return denied;
        try {
          return {
            ok: true as const,
            workflowIds: await listOwsWorkflowArtifactIds(directoryPath),
          };
        } catch (error) {
          return errorResult(error);
        }
      }
    )
  );
  ipcMain.handle(
    IPC.owsWorkspace.load,
    createValidatedHandler(
      IPC.owsWorkspace.load,
      OwsArtifactReferenceSchema,
      async ({ directoryPath, workflowId }) => {
        const denied = accessDenied(directoryPath);
        if (denied) return denied;
        try {
          return {
            ok: true as const,
            artifact: await loadOwsWorkflowArtifact(directoryPath, workflowId),
          };
        } catch (error) {
          return errorResult(error);
        }
      }
    )
  );
  ipcMain.handle(
    IPC.owsWorkspace.save,
    createValidatedHandler(
      IPC.owsWorkspace.save,
      OwsArtifactSaveSchema,
      async ({ directoryPath, workflowId, workflow, bindings, layout }) => {
        const denied = accessDenied(directoryPath);
        if (denied) return denied;
        try {
          await saveOwsWorkflowArtifact(
            directoryPath,
            workflowId,
            workflow as OwsWorkflow,
            bindings as unknown as OwsBindings,
            layout as unknown as OwsLayout
          );
          return { ok: true as const };
        } catch (error) {
          return errorResult(error);
        }
      }
    )
  );
}
