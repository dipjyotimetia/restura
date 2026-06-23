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
import { createKeyedRateLimiter } from '../ipc/ipc-rate-limiter';
import { emitTo } from '../ipc/ipc-utils';
import { bindRendererCleanup, disposeByOwner } from '../ipc/connection-cleanup';
import { resolveSecretHandle } from '../security/secret-handle-store';
import {
  AiChatRequestSchema,
  AiChatCancelSchema,
  assertTrustedSender,
} from '../ipc/ipc-validators';
import { IPC, EVENT_PREFIX, eventChannel } from '../../shared/channels';
import { executeAiChat } from '@shared/protocol/ai/ai-proxy';
import { resolveBaseUrl } from '@shared/protocol/ai/provider-routes';
import { isLocalProvider, type ChatRequestSpec, type Provider } from '@shared/protocol/ai/types';
import { makePinnedFetcher } from './fetch-fetcher';
import { createLogger } from '../../../src/lib/shared/logger';

const log = createLogger('ai');

const rateLimiter = createKeyedRateLimiter(30, 60_000); // 30 chat msgs / min / webContents
const MAX_CONCURRENT_STREAMS = 5;

interface ActiveStream {
  streamId: string;
  webContentsId: number;
  abort: AbortController;
}

const active = new Map<string, ActiveStream>();

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
