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

import { ipcMain } from 'electron';
import type { Fetcher } from '@shared/protocol/types';
import { createKeyedRateLimiter } from '../ipc/ipc-rate-limiter';
import { emitTo } from '../ipc/ipc-utils';
import { StreamRegistry } from '../ipc/stream-registry';
import { resolveSecretHandle } from '../security/secret-handle-store';
import {
  AiLabCompleteSchema,
  AiLabStreamSchema,
  AiLabStreamCancelSchema,
  AiLabDiscoverSchema,
  assertTrustedSender,
} from '../ipc/ipc-validators';
import { IPC, EVENT_PREFIX, eventChannel } from '../../shared/channels';
import { executeAiChat } from '@shared/protocol/ai/ai-proxy';
import { runToCompletion } from '@shared/protocol/ai/ai-complete';
import { listModels, testConnection } from '@shared/protocol/ai/model-discovery';
import { resolveBaseUrl } from '@shared/protocol/ai/provider-routes';
import { isLocalProvider, type ChatRequestSpec, type Provider } from '@shared/protocol/ai/types';
import { makePinnedFetcher } from './fetch-fetcher';
import { createLogger } from '../../../src/lib/shared/logger';

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

/** Minimal queueing semaphore — never rejects, just serialises past the cap. */
function makeSemaphore(max: number) {
  let inUse = 0;
  const waiters: Array<() => void> = [];
  const acquire = (): Promise<void> =>
    new Promise((resolve) => {
      if (inUse < max) {
        inUse += 1;
        resolve();
      } else {
        waiters.push(resolve);
      }
    });
  const release = () => {
    const next = waiters.shift();
    if (next) {
      next();
    } else {
      inUse = Math.max(0, inUse - 1);
    }
  };
  return { acquire, release };
}

const completeSlots = makeSemaphore(COMPLETE_CONCURRENCY);

interface ActiveAbort {
  webContentsId: number;
  abort: AbortController;
}

// Shared connection bookkeeping (map + renderer-destroyed cleanup + disposeAll).
// Emits use emitTo with the captured webContentsId, so the registries are used
// for bookkeeping only — dispose aborts the in-flight call.
const activeStreams = new StreamRegistry<ActiveAbort & { streamId: string }>({
  dispose: (s) => s.abort.abort(),
});
const activeCompletes = new StreamRegistry<ActiveAbort>({ dispose: (c) => c.abort.abort() });

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
  webContentsId: number,
  abort: AbortController
): Promise<void> {
  const chunkChannel = eventChannel(EVENT_PREFIX.aiLab.chunk, streamId);
  const endChannel = eventChannel(EVENT_PREFIX.aiLab.end, streamId);
  try {
    for await (const ev of executeAiChat(
      { ...spec, signal: abort.signal },
      fetcher,
      resolveSecretFn
    )) {
      emitTo(webContentsId, chunkChannel, ev);
      if (ev.type === 'done') {
        emitTo(webContentsId, endChannel, { reason: 'done' });
        return;
      }
    }
    emitTo(webContentsId, endChannel, { reason: 'done' });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Persist the main-process trace — the renderer only sees the error event.
    log.warn('stream failed', { streamId, provider: spec.provider, error: msg });
    emitTo(webContentsId, chunkChannel, { type: 'error', code: 'network', message: msg });
    emitTo(webContentsId, endChannel, { reason: 'error' });
  } finally {
    activeStreams.remove(streamId);
  }
}

export function registerAiLabHandlers(): void {
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
    let fetcher: Fetcher;
    try {
      fetcher = await buildSafeFetcher(data.provider, data.baseUrlOverride);
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }

    // Collision-free id (a timestamp-based key could collide for two completes
    // from the same sender in the same tick, leaking an AbortController).
    const completeId = crypto.randomUUID();
    const abort = new AbortController();
    activeCompletes.add(completeId, event.sender, { webContentsId: senderId, abort });

    await completeSlots.acquire();
    try {
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
      completeSlots.release();
      activeCompletes.remove(completeId);
    }
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
    let fetcher: Fetcher;
    try {
      fetcher = await buildSafeFetcher(data.provider, data.baseUrlOverride);
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
    const abort = new AbortController();
    activeStreams.add(data.streamId, event.sender, {
      streamId: data.streamId,
      webContentsId: senderId,
      abort,
    });
    void runStream(buildSpec(data), fetcher, data.streamId, senderId, abort);
    return { ok: true as const, streamId: data.streamId };
  });

  ipcMain.handle(IPC.aiLab.streamCancel, async (event, raw: unknown) => {
    assertTrustedSender(IPC.aiLab.streamCancel, event);
    const parsed = AiLabStreamCancelSchema.safeParse(raw);
    if (!parsed.success) return { ok: false as const, error: parsed.error.message };
    const entry = activeStreams.get(parsed.data.streamId);
    if (!entry) return { ok: true as const, alreadyDone: true };
    // cancel() disposes (aborts) + removes; capture webContentsId first so the
    // end event still reaches the renderer after the entry is gone.
    const { webContentsId } = entry;
    activeStreams.cancel(parsed.data.streamId);
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
      const apiKey = apiKeyHandleId ? await resolveSecretFn(apiKeyHandleId) : undefined;
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
      const apiKey = apiKeyHandleId ? await resolveSecretFn(apiKeyHandleId) : undefined;
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
  ipcMain.removeHandler(IPC.aiLab.complete);
  ipcMain.removeHandler(IPC.aiLab.stream);
  ipcMain.removeHandler(IPC.aiLab.streamCancel);
  ipcMain.removeHandler(IPC.aiLab.listModels);
  ipcMain.removeHandler(IPC.aiLab.testConnection);
  activeStreams.disposeAll();
  activeCompletes.disposeAll();
}
