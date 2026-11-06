import { ipcMain, type WebContents } from 'electron';
import { IPC } from '../../shared/channels';
import { createValidatedEventHandler, GrpcCancelRequestSchema } from '../ipc/ipc-validators';
import { StreamRegistry } from '../ipc/stream-registry';

/**
 * In-flight buffered `grpc:request` calls (unary + collected server-streaming)
 * that carry an `id`, keyed per owner + id like the stream registry, so
 * `grpc:cancel-request` from one window can never abort another's call. The
 * entry is dropped when the call settles; a destroyed renderer aborts (and
 * drops) its own entries; {@link disposeAllUnaryCalls} aborts the rest.
 */
interface ActiveUnaryCall {
  webContentsId: number;
  abort: AbortController;
}

const activeUnaryCalls = new StreamRegistry<ActiveUnaryCall>({
  dispose: (c) => c.abort.abort(),
});

/** A header-less buffered-call result for a status main decides itself. */
export function unaryResult(status: 1 | 13, error: string) {
  const statusText = status === 1 ? 'CANCELLED' : 'INTERNAL';
  return { status, statusText, headers: {}, trailers: {}, error };
}

/** Live tracked unary calls — for tests (leak checks). */
export function activeUnaryCallCount(): number {
  return activeUnaryCalls.size();
}

/** Abort every tracked call — module teardown (`stopStreamCleanup`). */
export function disposeAllUnaryCalls(): void {
  activeUnaryCalls.disposeAll();
}

/**
 * Run a buffered call under a cancel handle for `id` owned by `sender`. Returns
 * `undefined` without running when this owner already has `id` in flight (a
 * renderer bug: ids are per call) — never orphan the earlier call's handle.
 */
export async function runTrackedUnaryCall<T>(
  id: string,
  sender: WebContents,
  run: (signal: AbortSignal) => Promise<T>
): Promise<T | undefined> {
  const entry: ActiveUnaryCall = { webContentsId: sender.id, abort: new AbortController() };
  if (!activeUnaryCalls.tryAdd(id, sender, entry)) return undefined;
  try {
    return await run(entry.abort.signal);
  } finally {
    // Identity check: renderer cleanup may already have dropped this entry and
    // a newer call may have reused the id since.
    if (activeUnaryCalls.get(id, sender.id) === entry) activeUnaryCalls.remove(id, sender.id);
  }
}

/**
 * `grpc:cancel-request`. Owner-scoped: an id this renderer does not own
 * (another window's, finished, never seen) is a no-op success. The entry stays
 * registered until the call's own finally, so the cancelled `grpc:request`
 * settles CANCELLED and a repeated cancel is idempotent.
 */
export function registerGrpcCancelRequestIPC(): void {
  ipcMain.handle(
    IPC.grpc.cancelRequest,
    createValidatedEventHandler(
      IPC.grpc.cancelRequest,
      GrpcCancelRequestSchema,
      async ({ requestId }, event) => {
        activeUnaryCalls.getForOwner(requestId, event.sender.id)?.abort.abort();
        return { ok: true as const };
      }
    )
  );
}
