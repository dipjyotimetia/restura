/**
 * AI chat IPC handler. Mirrors the pattern in sse-handler.ts:
 *  - ipc-rate-limiter (per-webContents, .check())
 *  - bindRendererCleanup so a destroyed webContents kills its in-flight streams
 *  - AbortController per streamId for cancellation
 *
 * Renderer flow:
 *  1. Generate a streamId (uuid v4).
 *  2. Call ai.chat(spec) — returns immediately after validation.
 *  3. Subscribe to webContents-scoped channels:
 *       ai:chat:chunk:<streamId> -> ChatStreamEvent
 *       ai:chat:end:<streamId>   -> { reason: 'done' | 'cancelled' | 'error' }
 *  4. Call ai.cancel({streamId}) any time before end.
 */

import { ipcMain } from 'electron';
import type { Fetcher } from '@shared/protocol/types';
import { createKeyedRateLimiter } from './ipc-rate-limiter';
import { emitTo } from './ipc-utils';
import { bindRendererCleanup, disposeByOwner } from './connection-cleanup';
import { resolveSafeAddress, createPinnedFetch } from './safe-connect';
import { resolveSecretHandle } from './secret-handle-store';
import { AiChatRequestSchema, AiChatCancelSchema, assertTrustedSender } from './ipc-validators';
import { IPC, EVENT_PREFIX, eventChannel } from '../shared/channels';
import { executeAiChat } from '@shared/protocol/ai/ai-proxy';
import { resolveBaseUrl } from '@shared/protocol/ai/provider-routes';
import type { ChatRequestSpec, Provider } from '@shared/protocol/ai/types';
import { makeFetchFetcher } from './fetch-fetcher';

const rateLimiter = createKeyedRateLimiter(30, 60_000); // 30 chat msgs / min / webContents
const MAX_CONCURRENT_STREAMS = 5;

interface ActiveStream {
  streamId: string;
  webContentsId: number;
  abort: AbortController;
}

const active = new Map<string, ActiveStream>();

/**
 * Validate + DNS-pin the host the chat request will reach and return a Fetcher
 * locked to it. Mirrors ai-lab-handler.ts's `buildSafeFetcher` (the chat and lab
 * paths are kept separate by design) — but chat is CLOUD-ONLY: AiChatRequestSchema
 * permits only openai/anthropic/openrouter, so `allowLocalhost` is hardcoded false
 * (the AI Lab owns the localhost carve-out for local runtimes). `redirect:'manual'`
 * stops a malicious upstream from 3xx-redirecting to a private/metadata host (the
 * bypass a bare `redirect:'follow'` fetcher allowed); the pinned IP closes the
 * DNS-rebind window a pre-flight string check leaves open.
 */
async function buildSafeFetcher(provider: Provider, baseUrlOverride?: string): Promise<Fetcher> {
  const effectiveBase = resolveBaseUrl(provider, baseUrlOverride);
  const pinned = await resolveSafeAddress(effectiveBase, { allowLocalhost: false });
  return makeFetchFetcher({
    redirect: 'manual',
    fetchImpl: createPinnedFetch(pinned.host, pinned.ip),
  });
}

async function resolveSecretFn(handleId: string): Promise<string | undefined> {
  const v = resolveSecretHandle(handleId);
  return typeof v === 'string' ? v : undefined;
}

async function runChat(
  spec: ChatRequestSpec,
  fetcher: Fetcher,
  streamId: string,
  webContentsId: number,
  abort: AbortController
): Promise<void> {
  const chunkChannel = eventChannel(EVENT_PREFIX.ai.chunk, streamId);
  const endChannel = eventChannel(EVENT_PREFIX.ai.end, streamId);
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
    emitTo(webContentsId, chunkChannel, { type: 'error', code: 'network', message: msg });
    emitTo(webContentsId, endChannel, { reason: 'error' });
  } finally {
    active.delete(streamId);
  }
}

export function registerAiHandlers(): void {
  ipcMain.handle(IPC.ai.chat, async (event, raw: unknown) => {
    assertTrustedSender(IPC.ai.chat, event);
    const parsed = AiChatRequestSchema.safeParse(raw);
    if (!parsed.success) return { ok: false as const, error: parsed.error.message };

    const senderId = event.sender.id;
    if (!rateLimiter.check(senderId)) {
      return { ok: false as const, error: 'Rate limited. Slow down.' };
    }

    const streamsForSender = [...active.values()].filter(
      (s) => s.webContentsId === senderId
    ).length;
    if (streamsForSender >= MAX_CONCURRENT_STREAMS) {
      return { ok: false as const, error: 'Too many concurrent AI streams.' };
    }

    const data = parsed.data;

    // Validate + DNS-pin the (default or overridden) provider host and get a
    // fetcher locked to it. Replaces the old pre-flight-only string check, which
    // left the default-provider path unpinned and let an overridden host follow a
    // 3xx to a private/metadata address.
    let fetcher: Fetcher;
    try {
      fetcher = await buildSafeFetcher(data.provider, data.baseUrlOverride);
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }

    const abort = new AbortController();
    active.set(data.streamId, { streamId: data.streamId, webContentsId: senderId, abort });
    bindRendererCleanup(active, event.sender, (deadId) =>
      disposeByOwner(active, deadId, (s) => s.abort.abort())
    );

    const spec: ChatRequestSpec = {
      provider: data.provider,
      model: data.model,
      messages: data.messages,
      apiKeyHandleId: data.apiKeyHandleId,
      rawMode: data.rawMode,
      ...(data.baseUrlOverride ? { baseUrlOverride: data.baseUrlOverride } : {}),
      ...(data.maxOutputTokens ? { maxOutputTokens: data.maxOutputTokens } : {}),
      ...(data.tools ? { tools: data.tools } : {}),
    };

    // Kick off the stream — do NOT await; the renderer receives events via channels.
    void runChat(spec, fetcher, data.streamId, senderId, abort);

    return { ok: true as const, streamId: data.streamId };
  });

  ipcMain.handle(IPC.ai.chatCancel, async (event, raw: unknown) => {
    assertTrustedSender(IPC.ai.chatCancel, event);
    const parsed = AiChatCancelSchema.safeParse(raw);
    if (!parsed.success) return { ok: false as const, error: parsed.error.message };
    const entry = active.get(parsed.data.streamId);
    if (!entry) return { ok: true as const, alreadyDone: true };
    entry.abort.abort();
    active.delete(parsed.data.streamId);
    emitTo(entry.webContentsId, eventChannel(EVENT_PREFIX.ai.end, parsed.data.streamId), {
      reason: 'cancelled',
    });
    return { ok: true as const };
  });
}

export function unregisterAiHandlers(): void {
  ipcMain.removeHandler(IPC.ai.chat);
  ipcMain.removeHandler(IPC.ai.chatCancel);
  for (const e of active.values()) e.abort.abort();
  active.clear();
}

export const __testing = { resolveSecretFn };
