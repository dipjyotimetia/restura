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

import { executeAiChat } from '@shared/protocol/ai/ai-proxy';
import { resolveBaseUrl } from '@shared/protocol/ai/provider-routes';
import { type ChatRequestSpec, isLocalProvider, type Provider } from '@shared/protocol/ai/types';
import type { Fetcher } from '@shared/protocol/types';
import { ipcMain } from 'electron';
import { createLogger } from '@shared/runtime/logger';
import { EVENT_PREFIX, eventChannel, IPC } from '../../shared/channels';
import { createKeyedRateLimiter } from '../ipc/ipc-rate-limiter';
import { emitTo } from '../ipc/ipc-utils';
import {
  AiChatCancelSchema,
  AiChatRequestSchema,
  assertTrustedSender,
} from '../ipc/ipc-validators';
import { StreamRegistry } from '../ipc/stream-registry';
import { resolveSecretHandle } from '../security/secret-handle-store';
import { makePinnedFetcher } from './fetch-fetcher';

const log = createLogger('ai');

const rateLimiter = createKeyedRateLimiter(30, 60_000); // 30 chat msgs / min / webContents
const MAX_CONCURRENT_STREAMS = 5;

interface ActiveStream {
  streamId: string;
  webContentsId: number;
  abort: AbortController;
}

// Shared connection bookkeeping (map + same-id replace + renderer-destroyed
// cleanup + disposeAll). Chat emits go through emitTo with the captured
// webContentsId (an end event fires after the entry is removed on cancel), so
// the registry is used for bookkeeping only — dispose aborts the in-flight stream.
const active = new StreamRegistry<ActiveStream>({ dispose: (s) => s.abort.abort() });

/**
 * Resolve the chat provider's base URL and return a DNS-pinned, manual-redirect
 * Fetcher locked to it (wire mechanics in {@link makePinnedFetcher}). localhost
 * is allowed ONLY for local providers (openai-compatible) — same carve-out as the
 * AI Lab (ai-lab-handler.ts); cloud providers can never target localhost, even
 * via a base-URL override, so the override can't smuggle an SSRF.
 */
async function buildSafeFetcher(provider: Provider, baseUrlOverride?: string): Promise<Fetcher> {
  return makePinnedFetcher(resolveBaseUrl(provider, baseUrlOverride), {
    allowLocalhost: isLocalProvider(provider),
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
    // Persist the main-process trace — the renderer only sees the error event,
    // so without this an upstream/provider failure leaves nothing in main.log.
    log.warn('chat stream failed', { streamId, provider: spec.provider, error: msg });
    emitTo(webContentsId, chunkChannel, { type: 'error', code: 'network', message: msg });
    emitTo(webContentsId, endChannel, { reason: 'error' });
  } finally {
    active.remove(streamId);
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

    if (active.countForSender(senderId) >= MAX_CONCURRENT_STREAMS) {
      return { ok: false as const, error: 'Too many concurrent AI streams.' };
    }

    const data = parsed.data;

    // Register the stream + renderer-cleanup listener BEFORE the async
    // buildSafeFetcher await (which does a DNS resolve). add() binds the
    // renderer-destroyed cleanup — as sse-handler does — closing the window
    // where a renderer destroyed mid-connect would leave no teardown attached.
    const abort = new AbortController();
    active.add(data.streamId, event.sender, {
      streamId: data.streamId,
      webContentsId: senderId,
      abort,
    });

    // Validate + DNS-pin the (default or overridden) provider host and get a
    // fetcher locked to it. Replaces the old pre-flight-only string check, which
    // left the default-provider path unpinned and let an overridden host follow a
    // 3xx to a private/metadata address.
    let fetcher: Fetcher;
    try {
      fetcher = await buildSafeFetcher(data.provider, data.baseUrlOverride);
    } catch (e) {
      active.remove(data.streamId);
      return { ok: false as const, error: (e as Error).message };
    }

    // If the renderer went away during the await, the cleanup listener already
    // aborted + removed the entry — don't start the stream.
    if (!active.has(data.streamId)) {
      return { ok: false as const, error: 'Renderer closed before stream started.' };
    }

    const spec: ChatRequestSpec = {
      provider: data.provider,
      model: data.model,
      messages: data.messages,
      // Empty handle ⇒ resolveSecret returns undefined ⇒ no Authorization header
      // (clean key-less request for a local openai-compatible provider).
      apiKeyHandleId: data.apiKeyHandleId ?? '',
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
    // cancel() disposes (aborts) + removes; capture webContentsId first so the
    // end event still reaches the renderer after the entry is gone.
    const { webContentsId } = entry;
    active.cancel(parsed.data.streamId);
    emitTo(webContentsId, eventChannel(EVENT_PREFIX.ai.end, parsed.data.streamId), {
      reason: 'cancelled',
    });
    return { ok: true as const };
  });
}

export function unregisterAiHandlers(): void {
  ipcMain.removeHandler(IPC.ai.chat);
  ipcMain.removeHandler(IPC.ai.chatCancel);
  active.disposeAll();
}

export const __testing = { resolveSecretFn };
