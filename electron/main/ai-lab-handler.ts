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
import { createKeyedRateLimiter } from './ipc-rate-limiter';
import { emitTo } from './ipc-utils';
import { bindRendererCleanup, disposeByOwner } from './connection-cleanup';
import { assertUrlHostnameSafe } from './dns-guard';
import { resolveSecretHandle } from './secret-handle-store';
import {
  AiLabCompleteSchema,
  AiLabStreamSchema,
  AiLabStreamCancelSchema,
  AiLabDiscoverSchema,
  assertTrustedSender,
} from './ipc-validators';
import { IPC, EVENT_PREFIX, eventChannel } from '../shared/channels';
import { executeAiChat } from '@shared/protocol/ai/ai-proxy';
import { runToCompletion } from '@shared/protocol/ai/ai-complete';
import { listModels, testConnection } from '@shared/protocol/ai/model-discovery';
import { isLocalProvider, type ChatRequestSpec, type Provider } from '@shared/protocol/ai/types';
import { makeFetchFetcher } from './fetch-fetcher';

// Evals fan out into many completes; the per-minute budget is generous but still
// an abuse ceiling. Concurrency (not rate) is the real throttle — see semaphore.
const rateLimiter = createKeyedRateLimiter(300, 60_000);
const MAX_CONCURRENT_STREAMS = 6; // Playground compares a handful of models at once.
const COMPLETE_CONCURRENCY = 8; // Hard ceiling on simultaneous upstream model calls.

const nodeFetcher = makeFetchFetcher();

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

const activeStreams = new Map<string, ActiveAbort & { streamId: string }>();
const activeCompletes = new Map<string, ActiveAbort>();

/** SSRF guard for a user-supplied base/target URL, gated by provider kind. */
async function guardUrl(provider: Provider, url: string): Promise<void> {
  await assertUrlHostnameSafe(url, { allowLocalhost: isLocalProvider(provider) });
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
  streamId: string,
  webContentsId: number,
  abort: AbortController
): Promise<void> {
  const chunkChannel = eventChannel(EVENT_PREFIX.aiLab.chunk, streamId);
  const endChannel = eventChannel(EVENT_PREFIX.aiLab.end, streamId);
  try {
    for await (const ev of executeAiChat(
      { ...spec, signal: abort.signal },
      nodeFetcher,
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
    emitTo(webContentsId, chunkChannel, { type: 'error', code: 'network', message: msg });
    emitTo(webContentsId, endChannel, { reason: 'error' });
  } finally {
    activeStreams.delete(streamId);
  }
}

export function registerAiLabHandlers(): void {
  // --- Non-streaming completion (eval cells + judge calls) ---------------
  ipcMain.handle(IPC.aiLab.complete, async (event, raw: unknown) => {
    assertTrustedSender(IPC.aiLab.complete, event);
    const parsed = AiLabCompleteSchema.safeParse(raw);
    if (!parsed.success) return { ok: false as const, error: parsed.error.message };
    const senderId = event.sender.id;
    // No per-minute rate cap here: a single eval run fans out cases × models into
    // hundreds of completes, and the concurrency semaphore (COMPLETE_CONCURRENCY)
    // is the real throttle. A per-minute cap would spuriously fail evals midway.
    const data = parsed.data;
    if (data.baseUrlOverride) {
      try {
        await guardUrl(data.provider, data.baseUrlOverride);
      } catch (e) {
        return { ok: false as const, error: (e as Error).message };
      }
    }

    // Collision-free id (a timestamp-based key could collide for two completes
    // from the same sender in the same tick, leaking an AbortController).
    const completeId = crypto.randomUUID();
    const abort = new AbortController();
    activeCompletes.set(completeId, { webContentsId: senderId, abort });
    bindRendererCleanup(activeCompletes, event.sender, (deadId) =>
      disposeByOwner(activeCompletes, deadId, (c) => c.abort.abort())
    );

    await completeSlots.acquire();
    try {
      const result = await runToCompletion(
        { ...buildSpec(data), signal: abort.signal },
        nodeFetcher,
        resolveSecretFn
      );
      return { ok: true as const, result };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    } finally {
      completeSlots.release();
      activeCompletes.delete(completeId);
    }
  });

  // --- Streaming completion (Playground multi-model compare) -------------
  ipcMain.handle(IPC.aiLab.stream, async (event, raw: unknown) => {
    assertTrustedSender(IPC.aiLab.stream, event);
    const parsed = AiLabStreamSchema.safeParse(raw);
    if (!parsed.success) return { ok: false as const, error: parsed.error.message };
    const senderId = event.sender.id;
    if (!rateLimiter.check(senderId)) {
      return { ok: false as const, error: 'Rate limited. Slow down.' };
    }
    const streamsForSender = [...activeStreams.values()].filter(
      (s) => s.webContentsId === senderId
    ).length;
    if (streamsForSender >= MAX_CONCURRENT_STREAMS) {
      return { ok: false as const, error: 'Too many concurrent AI Lab streams.' };
    }
    const data = parsed.data;
    if (data.baseUrlOverride) {
      try {
        await guardUrl(data.provider, data.baseUrlOverride);
      } catch (e) {
        return { ok: false as const, error: (e as Error).message };
      }
    }
    const abort = new AbortController();
    activeStreams.set(data.streamId, { streamId: data.streamId, webContentsId: senderId, abort });
    bindRendererCleanup(activeStreams, event.sender, (deadId) =>
      disposeByOwner(activeStreams, deadId, (s) => s.abort.abort())
    );
    void runStream(buildSpec(data), data.streamId, senderId, abort);
    return { ok: true as const, streamId: data.streamId };
  });

  ipcMain.handle(IPC.aiLab.streamCancel, async (event, raw: unknown) => {
    assertTrustedSender(IPC.aiLab.streamCancel, event);
    const parsed = AiLabStreamCancelSchema.safeParse(raw);
    if (!parsed.success) return { ok: false as const, error: parsed.error.message };
    const entry = activeStreams.get(parsed.data.streamId);
    if (!entry) return { ok: true as const, alreadyDone: true };
    entry.abort.abort();
    activeStreams.delete(parsed.data.streamId);
    emitTo(entry.webContentsId, eventChannel(EVENT_PREFIX.aiLab.end, parsed.data.streamId), {
      reason: 'cancelled',
    });
    return { ok: true as const };
  });

  // --- Model discovery + connection test --------------------------------
  ipcMain.handle(IPC.aiLab.listModels, async (event, raw: unknown) => {
    assertTrustedSender(IPC.aiLab.listModels, event);
    const parsed = AiLabDiscoverSchema.safeParse(raw);
    if (!parsed.success) return { ok: false as const, error: parsed.error.message };
    const { provider, baseUrl, apiKeyHandleId } = parsed.data;
    try {
      await guardUrl(provider, baseUrl);
      const apiKey = apiKeyHandleId ? await resolveSecretFn(apiKeyHandleId) : undefined;
      const models = await listModels({
        provider,
        baseUrl,
        fetcher: nodeFetcher,
        ...(apiKey ? { apiKey } : {}),
      });
      return { ok: true as const, models };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle(IPC.aiLab.testConnection, async (event, raw: unknown) => {
    assertTrustedSender(IPC.aiLab.testConnection, event);
    const parsed = AiLabDiscoverSchema.safeParse(raw);
    if (!parsed.success) return { ok: false as const, error: parsed.error.message };
    const { provider, baseUrl, apiKeyHandleId } = parsed.data;
    try {
      await guardUrl(provider, baseUrl);
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
    const apiKey = apiKeyHandleId ? await resolveSecretFn(apiKeyHandleId) : undefined;
    const result = await testConnection({
      provider,
      baseUrl,
      fetcher: nodeFetcher,
      ...(apiKey ? { apiKey } : {}),
    });
    return result;
  });
}

export function unregisterAiLabHandlers(): void {
  ipcMain.removeHandler(IPC.aiLab.complete);
  ipcMain.removeHandler(IPC.aiLab.stream);
  ipcMain.removeHandler(IPC.aiLab.streamCancel);
  ipcMain.removeHandler(IPC.aiLab.listModels);
  ipcMain.removeHandler(IPC.aiLab.testConnection);
  for (const s of activeStreams.values()) s.abort.abort();
  for (const c of activeCompletes.values()) c.abort.abort();
  activeStreams.clear();
  activeCompletes.clear();
}
