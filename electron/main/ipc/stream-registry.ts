import type { WebContents } from 'electron';
import { emitTo } from './ipc-utils';
import { bindRendererCleanup, disposeByOwner } from './connection-cleanup';
import { eventChannel } from '../../shared/channels';

/**
 * Shared bookkeeping for the per-connection streaming handlers (SSE, WebSocket,
 * Socket.IO, Kafka, MQTT, gRPC streams, MCP). Before this, each handler hand-rolled
 * the same five things and they drifted:
 *
 *   1. a `Map<connectionId, Entry>` of live connections (every Entry carrying a
 *      `webContentsId` so it can be torn down when its renderer dies),
 *   2. "a reconnect with the same id replaces the old connection" (dispose old, store new),
 *   3. one `bindRendererCleanup` + `disposeByOwner` wiring so a destroyed renderer
 *      kills exactly its own connections (not another window's),
 *   4. templated per-connection event emission (`emitTo(id, eventChannel(prefix, id), …)`),
 *   5. a `disposeAll()` for the handler's `stop*Cleanup()` IPC_MODULES teardown.
 *
 * This owns all five. It deliberately does NOT own protocol policy — rate limiting,
 * concurrency caps, the connect/transport itself, and the per-protocol teardown
 * mechanics (abort vs ws.terminate() vs producer.close(), explicitlyClosed flags,
 * emitChain ordering, flush buffering) stay in the handler. `dispose(entry)` is the
 * single seam through which a handler plugs its teardown in; it must be idempotent
 * (a renderer-destroyed teardown and an explicit cancel can both fire).
 */

/** Every registry entry must carry the owning renderer's id so cleanup can target it. */
export interface StreamEntryBase {
  webContentsId: number;
}

export interface StreamRegistryOptions<E extends StreamEntryBase> {
  /**
   * The `EVENT_PREFIX` group for this protocol, e.g. `EVENT_PREFIX.sse`. Used by
   * {@link StreamRegistry.emit} to build `eventChannel(prefixes[name], id)`.
   * Optional — handlers whose channel names live elsewhere (Socket.IO's
   * `socketioChannels`) can omit it and emit themselves.
   */
  prefixes?: Record<string, string>;
  /**
   * Tear a single entry's underlying resource down (abort / close / terminate).
   * MUST be idempotent: invoked on explicit cancel, on same-id replace, on
   * renderer-destroyed cleanup, and on {@link StreamRegistry.disposeAll}.
   */
  dispose: (entry: E) => void;
}

export class StreamRegistry<E extends StreamEntryBase> {
  private readonly map = new Map<string, E>();
  private readonly prefixes?: Record<string, string>;
  private readonly disposeEntry: (entry: E) => void;

  constructor(options: StreamRegistryOptions<E>) {
    this.prefixes = options.prefixes;
    this.disposeEntry = options.dispose;
  }

  /**
   * Register `entry` under `connectionId`, owned by `webContents`. If an entry
   * already exists for that id (a reconnect), it is disposed and replaced. Binds
   * the renderer-cleanup listener so a destroyed `webContents` disposes exactly
   * its own entries — idempotent across calls (deduped per webContents).
   *
   * Call AFTER the handler's rate-limit / concurrency checks: this does the
   * state-keeping, not the policy.
   */
  add(connectionId: string, webContents: WebContents, entry: E): void {
    const existing = this.map.get(connectionId);
    if (existing) {
      this.safeDispose(existing);
    }
    this.map.set(connectionId, entry);
    // `this` is a stable per-registry key, so bindRendererCleanup dedupes the
    // 'destroyed' listener across every add from the same webContents.
    bindRendererCleanup(this, webContents, (deadId) =>
      disposeByOwner(this.map, deadId, (e) => this.safeDispose(e))
    );
  }

  get(connectionId: string): E | undefined {
    return this.map.get(connectionId);
  }

  has(connectionId: string): boolean {
    return this.map.has(connectionId);
  }

  size(): number {
    return this.map.size;
  }

  /** Number of live entries owned by a given renderer — for per-sender caps. */
  countForSender(webContentsId: number): number {
    let n = 0;
    for (const e of this.map.values()) if (e.webContentsId === webContentsId) n += 1;
    return n;
  }

  /**
   * Remove an entry WITHOUT disposing it — for when the underlying stream has
   * already ended on its own (the read loop drained, the socket closed) and the
   * handler only needs to drop the bookkeeping. Mirrors the old `map.delete(id)`.
   */
  remove(connectionId: string): void {
    this.map.delete(connectionId);
  }

  /**
   * Dispose AND remove an entry — for explicit disconnect/cancel channels.
   * Returns true if an entry existed.
   */
  cancel(connectionId: string): boolean {
    const entry = this.map.get(connectionId);
    if (!entry) return false;
    this.safeDispose(entry);
    this.map.delete(connectionId);
    return true;
  }

  /**
   * Emit a templated per-connection event to the entry's owning renderer using
   * the configured `prefixes`. No-op if the entry is gone or `prefixes` was not
   * supplied. `eventName` keys into `prefixes`.
   */
  emit(connectionId: string, eventName: string, payload?: unknown): void {
    const entry = this.map.get(connectionId);
    if (!entry || !this.prefixes) return;
    const prefix = this.prefixes[eventName];
    if (prefix === undefined) return;
    emitTo(entry.webContentsId, eventChannel(prefix, connectionId), payload);
  }

  /** Dispose every entry and clear the map — for the handler's `stop*Cleanup()`. */
  disposeAll(): void {
    for (const entry of this.map.values()) this.safeDispose(entry);
    this.map.clear();
  }

  private safeDispose(entry: E): void {
    try {
      this.disposeEntry(entry);
    } catch {
      /* best-effort — teardown must never throw out of cleanup */
    }
  }
}
