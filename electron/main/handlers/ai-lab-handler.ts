/**
 * AI Lab IPC handler (Electron-only). Sibling to ai-handler.ts, kept separate so
 * the interactive chat path is untouched. Adds three things the chat path lacks:
 *
 *  1. A non-streaming `complete` — drains a model call to a single
 *     CompletionResult. The eval runner and LLM-as-judge fire many of these;
 *     per-token streaming would be pure overhead. Bounded by a queueing
 *     semaphore so a large eval can't open hundreds of sockets at once.
 *  2. Model discovery + connection test (GET /api/tags, GET /v1/models).
 *  3. The localhost SSRF carve-out: every outbound URL is validated with the
 *     SAME shared guard as everything else, but `allowLocalhost` is derived from
 *     the provider kind — true only for local runtimes (Ollama, OpenAI-compat).
 *     Cloud providers can never reach localhost/private hosts.
 *
 * Streaming (`stream`/`streamCancel`) backs the Playground's multi-model compare
 * and mirrors ai-handler's runChat, but on ai-lab channels with the carve-out.
 */

import { runToCompletion } from '@shared/protocol/ai/ai-complete';
import { executeAiChat } from '@shared/protocol/ai/ai-proxy';
import { listModels, testConnection } from '@shared/protocol/ai/model-discovery';
import { resolveBaseUrl } from '@shared/protocol/ai/provider-routes';
import { type ChatRequestSpec, isLocalProvider, type Provider } from '@shared/protocol/ai/types';
import type { Fetcher } from '@shared/protocol/types';
import { createLogger } from '@shared/runtime/logger';
import { ipcMain } from 'electron';
import { EVENT_PREFIX, eventChannel, IPC } from '../../shared/channels';
import { bindRendererCleanup } from '../ipc/connection-cleanup';
import { createKeyedRateLimiter } from '../ipc/ipc-rate-limiter';
import { emitTo } from '../ipc/ipc-utils';
import {
  AiLabCompleteCancelSchema,
  AiLabCompleteSchema,
  AiLabDiscoverSchema,
  AiLabStreamCancelSchema,
  AiLabStreamSchema,
  AiLabTelemetryExportSchema,
  assertTrustedSender,
} from '../ipc/ipc-validators';
import { StreamRegistry } from '../ipc/stream-registry';
import { createAgentTelemetryService } from '../lifecycle/agent-telemetry';
import { resolveSecretHandle } from '../security/secret-handle-store';
import { makePinnedFetcher } from './fetch-fetcher';

const log = createLogger('ai-lab');

// Per-webContents budget for Playground streams (a handful of models at a time).
const streamRateLimiter = createKeyedRateLimiter(300, 60_000);
// `complete` is throttled primarily by COMPLETE_CONCURRENCY (the real bound); this
// per-minute ceiling sits well ABOVE the semaphore's sustainable throughput so it
// never trips a legitimate eval run — it only stops a runaway/compromised renderer
// from firing unbounded completes.
const completeRateLimiter = createKeyedRateLimiter(1200, 60_000);
// Discovery is user-initiated (click "test connection" / "refresh models"); a modest
// cap is plenty and bounds a renderer probing arbitrary hosts in a tight loop.
const discoveryRateLimiter = createKeyedRateLimiter(60, 60_000);
const MAX_CONCURRENT_STREAMS = 6; // Playground compares a handful of models at once.
const COMPLETE_CONCURRENCY = 8; // Hard ceiling on simultaneous upstream model calls.

async function resolveSecretFn(handleId: string): Promise<string | undefined> {
  const v = resolveSecretHandle(handleId);
  return typeof v === 'string' ? v : undefined;
}

/** Queueing semaphore whose pending acquisitions remain cancellable. */
function makeSemaphore(max: number) {
  let inUse = 0;
  interface Waiter {
    resolve: () => void;
    reject: (cause: Error) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }
  const waiters: Waiter[] = [];
  const abortError = () => {
    const error = new Error('Operation cancelled.');
    error.name = 'AbortError';
    return error;
  };
  const acquire = (signal?: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      if (inUse < max) {
        inUse += 1;
        resolve();
      } else {
        const waiter: Waiter = { resolve, reject, ...(signal ? { signal } : {}) };
        const onAbort = () => {
          const index = waiters.indexOf(waiter);
          if (index !== -1) waiters.splice(index, 1);
          reject(abortError());
        };
        waiter.onAbort = onAbort;
        waiters.push(waiter);
        signal?.addEventListener('abort', onAbort, { once: true });
      }
    });
  const release = () => {
    const next = waiters.shift();
    if (next) {
      if (next.signal && next.onAbort) next.signal.removeEventListener('abort', next.onAbort);
      next.resolve();
    } else {
      inUse = Math.max(0, inUse - 1);
    }
  };
  return { acquire, release };
}

const completeSlots = makeSemaphore(COMPLETE_CONCURRENCY);
const agentTelemetry = createAgentTelemetryService({
  resolveCredential: async (ref) => {
    if (ref.source === 'env') {
      const value = process.env[ref.name];
      if (value) return value;
      throw new Error(`Telemetry credential environment variable is not set: ${ref.name}`);
    }
    const value = resolveSecretHandle(ref.id);
    if (value) return value;
    throw new Error('Telemetry secret handle could not be resolved');
  },
});

interface ActiveAbort {
  webContentsId: number;
  abort: AbortController;
}

interface ActiveStream extends ActiveAbort {
  streamId: string;
  registryKey: string;
  cancelled: boolean;
}

// Shared connection bookkeeping (map + renderer-destroyed cleanup + disposeAll).
// Emits use emitTo with the captured webContentsId, so the registries are used
// for bookkeeping only — dispose aborts the in-flight call.
const activeStreams = new StreamRegistry<ActiveStream>({
  dispose: (s) => s.abort.abort(),
});
// The exact explicitly-cancelled generation may emit its established abort
// error until a successor reserves the same owner-scoped key or it settles.
const cancelledStreamGenerations = new Map<string, ActiveStream>();
// Creator-scoped keys keep equal renderer-generated operation IDs independent.
// Cancellation aborts but deliberately keeps the owner's tombstone until its
// handler settles so same-owner reuse cannot race the old finally block.
const activeCompletes = new Map<string, ActiveAbort>();

function streamRegistryKey(webContentsId: number, streamId: string): string {
  return `${webContentsId}:${streamId}`;
}

function completionRegistryKey(webContentsId: number, operationId: string): string {
  return `${webContentsId}:${operationId}`;
}

/**
 * Resolve the provider's base URL and return a DNS-pinned, manual-redirect
 * Fetcher locked to it (wire mechanics in {@link makePinnedFetcher}).
 * `allowLocalhost` is gated by provider kind — true only for local runtimes
 * (Ollama, openai-compatible), never for cloud providers.
 */
async function buildSafeFetcher(provider: Provider, baseUrlOverride?: string): Promise<Fetcher> {
  return makePinnedFetcher(resolveBaseUrl(provider, baseUrlOverride), {
    allowLocalhost: isLocalProvider(provider),
  });
}

function buildSpec(data: {
  provider: Provider;
  model: string;
  messages: ChatRequestSpec['messages'];
  apiKeyHandleId?: string;
  baseUrlOverride?: string;
  rawMode: boolean;
  maxOutputTokens?: number;
  tools?: ChatRequestSpec['tools'];
}): ChatRequestSpec {
  return {
    provider: data.provider,
    model: data.model,
    messages: data.messages,
    apiKeyHandleId: data.apiKeyHandleId ?? '',
    rawMode: data.rawMode,
    ...(data.baseUrlOverride ? { baseUrlOverride: data.baseUrlOverride } : {}),
    ...(data.maxOutputTokens ? { maxOutputTokens: data.maxOutputTokens } : {}),
    ...(data.tools ? { tools: data.tools } : {}),
  };
}

async function runStream(
  spec: ChatRequestSpec,
  fetcher: Fetcher,
  streamId: string,
  activeStream: ActiveStream
): Promise<void> {
  const chunkChannel = eventChannel(EVENT_PREFIX.aiLab.chunk, streamId);
  const endChannel = eventChannel(EVENT_PREFIX.aiLab.end, streamId);
  const isCurrent = () =>
    activeStreams.getForOwner(activeStream.registryKey, activeStream.webContentsId) ===
    activeStream;
  try {
    for await (const ev of executeAiChat(
      { ...spec, signal: activeStream.abort.signal },
      fetcher,
      resolveSecretFn
    )) {
      if (!isCurrent()) return;
      emitTo(activeStream.webContentsId, chunkChannel, ev);
      if (ev.type === 'done') {
        emitTo(activeStream.webContentsId, endChannel, { reason: 'done' });
        return;
      }
    }
    if (isCurrent()) {
      emitTo(activeStream.webContentsId, endChannel, { reason: 'done' });
    }
  } catch (e) {
    // Explicit cancellation removes the live entry before abort rejection
    // reaches this catch. Preserve the existing error event for that exact
    // cancelled generation, while replaced/destroyed generations stay silent.
    const isLatestCancellation =
      activeStream.cancelled &&
      cancelledStreamGenerations.get(activeStream.registryKey) === activeStream;
    if (!isCurrent() && !isLatestCancellation) return;
    const msg = e instanceof Error ? e.message : String(e);
    // Persist the main-process trace — the renderer only sees the error event.
    log.warn('stream failed', { streamId, provider: spec.provider, error: msg });
    emitTo(activeStream.webContentsId, chunkChannel, {
      type: 'error',
      code: 'network',
      message: msg,
    });
    emitTo(activeStream.webContentsId, endChannel, { reason: 'error' });
  } finally {
    if (isCurrent()) activeStreams.remove(activeStream.registryKey);
    if (cancelledStreamGenerations.get(activeStream.registryKey) === activeStream) {
      cancelledStreamGenerations.delete(activeStream.registryKey);
    }
  }
}

export function registerAiLabHandlers(): void {
  ipcMain.handle(IPC.aiLab.exportTelemetry, async (event, raw: unknown) => {
    assertTrustedSender(IPC.aiLab.exportTelemetry, event);
    const parsed = AiLabTelemetryExportSchema.safeParse(raw);
    if (!parsed.success) return { ok: false as const, error: parsed.error.message };
    const delivery = agentTelemetry.enqueue(parsed.data.trace, parsed.data.config);
    await agentTelemetry.flush();
    return { ok: true as const, delivery };
  });
  // --- Non-streaming completion (eval cells + judge calls) ---------------
  ipcMain.handle(IPC.aiLab.complete, async (event, raw: unknown) => {
    assertTrustedSender(IPC.aiLab.complete, event);
    const parsed = AiLabCompleteSchema.safeParse(raw);
    if (!parsed.success) return { ok: false as const, error: parsed.error.message };
    const senderId = event.sender.id;
    // The concurrency semaphore (COMPLETE_CONCURRENCY) is the real throttle for
    // eval fan-out; completeRateLimiter is only a high abuse ceiling that sits
    // above sustainable throughput, so it won't spuriously fail a legitimate run.
    if (!completeRateLimiter.check(senderId)) {
      return { ok: false as const, error: 'Rate limited. Slow down.' };
    }
    const data = parsed.data;
    const abort = new AbortController();
    const activeComplete = { webContentsId: senderId, abort };
    const registryKey = completionRegistryKey(senderId, data.operationId);
    const existing = activeCompletes.get(registryKey);
    if (existing) {
      return {
        ok: false as const,
        error: 'A completion with this operation ID is already active.',
      };
    }
    activeCompletes.set(registryKey, activeComplete);
    bindRendererCleanup(activeCompletes, event.sender, (deadId) => {
      for (const [key, active] of activeCompletes) {
        if (active.webContentsId !== deadId) continue;
        active.abort.abort();
        if (activeCompletes.get(key) === active) {
          activeCompletes.delete(key);
        }
      }
    });

    let slotAcquired = false;
    try {
      const fetcher = await buildSafeFetcher(data.provider, data.baseUrlOverride);
      if (abort.signal.aborted) return { ok: false as const, error: 'Operation cancelled.' };
      await completeSlots.acquire(abort.signal);
      slotAcquired = true;
      if (abort.signal.aborted) return { ok: false as const, error: 'Operation cancelled.' };
      const result = await runToCompletion(
        { ...buildSpec(data), signal: abort.signal },
        fetcher,
        resolveSecretFn
      );
      return { ok: true as const, result };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn('complete failed', { provider: data.provider, model: data.model, error: msg });
      return { ok: false as const, error: msg };
    } finally {
      if (slotAcquired) completeSlots.release();
      if (activeCompletes.get(registryKey) === activeComplete) {
        activeCompletes.delete(registryKey);
      }
    }
  });

  ipcMain.handle(IPC.aiLab.completeCancel, async (event, raw: unknown) => {
    assertTrustedSender(IPC.aiLab.completeCancel, event);
    const parsed = AiLabCompleteCancelSchema.safeParse(raw);
    if (!parsed.success) return { ok: false as const, error: parsed.error.message };
    const registryKey = completionRegistryKey(event.sender.id, parsed.data.operationId);
    const active = activeCompletes.get(registryKey);
    if (!active) {
      return { ok: true as const, alreadyDone: true };
    }
    active.abort.abort();
    return { ok: true as const };
  });

  // --- Streaming completion (Playground multi-model compare) -------------
  ipcMain.handle(IPC.aiLab.stream, async (event, raw: unknown) => {
    assertTrustedSender(IPC.aiLab.stream, event);
    const parsed = AiLabStreamSchema.safeParse(raw);
    if (!parsed.success) return { ok: false as const, error: parsed.error.message };
    const senderId = event.sender.id;
    if (!streamRateLimiter.check(senderId)) {
      return { ok: false as const, error: 'Rate limited. Slow down.' };
    }
    if (activeStreams.countForSender(senderId) >= MAX_CONCURRENT_STREAMS) {
      return { ok: false as const, error: 'Too many concurrent AI Lab streams.' };
    }
    const data = parsed.data;
    const registryKey = streamRegistryKey(senderId, data.streamId);
    cancelledStreamGenerations.delete(registryKey);
    const activeStream: ActiveStream = {
      streamId: data.streamId,
      registryKey,
      webContentsId: senderId,
      abort: new AbortController(),
      cancelled: false,
    };
    activeStreams.add(registryKey, event.sender, activeStream);
    let fetcher: Fetcher;
    try {
      fetcher = await buildSafeFetcher(data.provider, data.baseUrlOverride);
    } catch (e) {
      if (activeStreams.getForOwner(registryKey, senderId) === activeStream) {
        activeStreams.remove(registryKey);
      }
      return { ok: false as const, error: (e as Error).message };
    }
    if (activeStreams.getForOwner(registryKey, senderId) !== activeStream) {
      return { ok: false as const, error: 'Renderer closed before stream started.' };
    }
    void runStream(buildSpec(data), fetcher, data.streamId, activeStream);
    return { ok: true as const, streamId: data.streamId };
  });

  ipcMain.handle(IPC.aiLab.streamCancel, async (event, raw: unknown) => {
    assertTrustedSender(IPC.aiLab.streamCancel, event);
    const parsed = AiLabStreamCancelSchema.safeParse(raw);
    if (!parsed.success) return { ok: false as const, error: parsed.error.message };
    const registryKey = streamRegistryKey(event.sender.id, parsed.data.streamId);
    const entry = activeStreams.getForOwner(registryKey, event.sender.id);
    if (!entry) return { ok: true as const, alreadyDone: true };
    // cancel() disposes (aborts) + removes; capture webContentsId first so the
    // end event still reaches the renderer after the entry is gone.
    const { webContentsId } = entry;
    entry.cancelled = true;
    cancelledStreamGenerations.set(registryKey, entry);
    activeStreams.cancelForOwner(registryKey, event.sender.id);
    emitTo(webContentsId, eventChannel(EVENT_PREFIX.aiLab.end, parsed.data.streamId), {
      reason: 'cancelled',
    });
    return { ok: true as const };
  });

  // --- Model discovery + connection test --------------------------------
  ipcMain.handle(IPC.aiLab.listModels, async (event, raw: unknown) => {
    assertTrustedSender(IPC.aiLab.listModels, event);
    const parsed = AiLabDiscoverSchema.safeParse(raw);
    if (!parsed.success) return { ok: false as const, error: parsed.error.message };
    if (!discoveryRateLimiter.check(event.sender.id)) {
      return { ok: false as const, error: 'Rate limited. Slow down.' };
    }
    const { provider, baseUrl, apiKeyHandleId } = parsed.data;
    try {
      const fetcher = await buildSafeFetcher(provider, baseUrl);
      const apiKey = apiKeyHandleId ? await resolveSecretFn(apiKeyHandleId) : parsed.data.apiKey;
      const models = await listModels({
        provider,
        baseUrl,
        fetcher,
        ...(apiKey ? { apiKey } : {}),
      });
      return { ok: true as const, models };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn('listModels failed', { provider, error: msg });
      return { ok: false as const, error: msg };
    }
  });

  ipcMain.handle(IPC.aiLab.testConnection, async (event, raw: unknown) => {
    assertTrustedSender(IPC.aiLab.testConnection, event);
    const parsed = AiLabDiscoverSchema.safeParse(raw);
    if (!parsed.success) return { ok: false as const, error: parsed.error.message };
    if (!discoveryRateLimiter.check(event.sender.id)) {
      return { ok: false as const, error: 'Rate limited. Slow down.' };
    }
    const { provider, baseUrl, apiKeyHandleId } = parsed.data;
    let fetcher: Fetcher;
    try {
      fetcher = await buildSafeFetcher(provider, baseUrl);
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
    try {
      const apiKey = apiKeyHandleId ? await resolveSecretFn(apiKeyHandleId) : parsed.data.apiKey;
      const result = await testConnection({
        provider,
        baseUrl,
        fetcher,
        ...(apiKey ? { apiKey } : {}),
      });
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn('testConnection failed', { provider, error: msg });
      return { ok: false as const, error: msg };
    }
  });
}

export function unregisterAiLabHandlers(): void {
  ipcMain.removeHandler(IPC.aiLab.exportTelemetry);
  ipcMain.removeHandler(IPC.aiLab.complete);
  ipcMain.removeHandler(IPC.aiLab.completeCancel);
  ipcMain.removeHandler(IPC.aiLab.stream);
  ipcMain.removeHandler(IPC.aiLab.streamCancel);
  ipcMain.removeHandler(IPC.aiLab.listModels);
  ipcMain.removeHandler(IPC.aiLab.testConnection);
  activeStreams.disposeAll();
  cancelledStreamGenerations.clear();
  for (const active of activeCompletes.values()) active.abort.abort();
  activeCompletes.clear();
  void agentTelemetry.shutdown();
}
