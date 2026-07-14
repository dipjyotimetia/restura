import {
  type ConsoleProtocol,
  createProtocolConsoleEntry,
  useConsoleStore,
} from '@/store/useConsoleStore';
import type { Request, Response } from '@/types';

/**
 * Mirror an executed workflow step into the unified console, tagged with the
 * execution id so the Run filter can isolate one workflow run — the same
 * provenance pattern the collection runner uses (`useCollectionRun`).
 *
 * Shared by both executors: the legacy linear `workflowExecutor.ts` and the
 * graph-authored `dagExecutor.ts` (its `request` node kind) — without this,
 * requests fired by a graph-authored workflow are invisible in the unified
 * Console/history view that linear-run requests show up in.
 */
export function mirrorStepToConsole(
  workflowName: string,
  executionId: string,
  request: Request,
  response: Response
): void {
  const headers: Record<string, string> = {};
  if ('headers' in request && Array.isArray(request.headers)) {
    for (const h of request.headers) if (h.enabled && h.key) headers[h.key] = h.value;
  }
  const body =
    request.type === 'http' && request.body.type !== 'none' ? request.body.raw : undefined;
  useConsoleStore.getState().addEntry(
    createProtocolConsoleEntry({
      protocol: request.type as ConsoleProtocol,
      method: request.type === 'http' ? request.method : request.type.toUpperCase(),
      url: 'url' in request ? request.url : '',
      headers,
      ...(body !== undefined ? { body } : {}),
      response,
      extra: { runId: executionId, runLabel: `Workflow: ${workflowName}` },
    })
  );
}
