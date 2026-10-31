import type { WebContents } from 'electron';
import { eventChannel } from '../../shared/channels';
import { bindRendererCleanup, disposeByOwner } from './connection-cleanup';
import { emitTo } from './ipc-utils';

/**
 * Shared bookkeeping for the per-connection streaming handlers (SSE, WebSocket,
 * Socket.IO, Kafka, MQTT, gRPC streams, MCP), from the moment a connect is
 * reserved to teardown. Before this, each handler hand-rolled the same six things
 * and they drifted:
 *
 *   1. a `Map<owner+connectionId, Entry>` of live connections (every Entry carrying
 *      a `webContentsId` so it can be torn down when its renderer dies),
 *   2. "a reconnect with the same owner + id replaces the old connection"
 *      (dispose old, store new), while another renderer may use the same external id,
 *   3. one `bindRendererCleanup` + `disposeByOwner` wiring so a destroyed renderer
 *      kills exactly its own connections (not another window's),
 *   4. templated per-connection event emission (`emitTo(id, eventChannel(prefix, id), …)`),
 *   5. a `disposeAll()` for the handler's `stop*Cleanup()` IPC_MODULES teardown,
 *   6. the claim that spans the awaited dial (DNS, keychain, handshake) before an
 *      entry exists: reserved synchronously per owner + id, invalidated by cancel,
 *      renderer death or module teardown, and required live to register the entry.
 *
 * This owns all six. It deliberately does NOT own protocol policy — rate limiting,
 * concurrency caps, the connect/transport itself, and the per-protocol teardown
 * mechanics (abort vs ws.terminate() vs producer.close(), explicitlyClosed flags,
 * emitChain ordering, flush buffering) stay in the handler. `dispose(entry)` is the
 * single seam through which a handler plugs its teardown in; it must be idempotent
 * (a renderer-destroyed teardown and an explicit cancel can both fire).
 * `disposeClaim(claim)` is the same seam for a claim's protocol-specific fields.
 * Whether an explicit disconnect cancels a claim is protocol policy too: the handler
 * decides by calling {@link StreamRegistry.cancelClaim} or not.
 */

/** Every registry entry must carry the owning renderer's id so cleanup can target it. */
export interface StreamEntryBase {
  webContentsId: number;
}

/**
 * A live reservation for one owner + id. `X` carries the protocol's own fields
 * (abort controller, gRPC write buffer, in-flight producer or session), which the
 * handler may mutate while it dials. The claim object is its own token: once dropped
 * it can never become live again or disturb a newer claim for the same id.
 */
export type StreamClaim<E extends StreamEntryBase, X extends object = object> = X & {
  readonly connectionId: string;
  readonly webContentsId: number;
  /** The owner's entry at reserve time, if any: the only entry a commit may replace. */
  readonly ownerEntry?: E;
};

export interface StreamRegistryOptions<E extends StreamEntryBase, X extends object = object> {
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
  /**
   * Release whatever a dropped claim's protocol fields hold (abort its signal,
   * close its in-flight transport). Invoked on renderer death, on
   * {@link StreamRegistry.cancelClaim} and on {@link StreamRegistry.disposeAllClaims};
   * NOT on {@link StreamRegistry.releaseClaim}. Omit it when a claim holds nothing.
   */
  disposeClaim?: (claim: StreamClaim<E, X>) => void;
}

/** Scope a renderer-provided resource id to the renderer that owns it. */
export function ownerScopedKey(externalId: string, webContentsId: number): string {
  return `${webContentsId}:${externalId}`;
}

/**
 * Send to an entry's renderer through its cached `WebContents` when it has one
 * (no `fromId` lookup per message on high-throughput streams), falling back to the
 * id-based {@link emitTo} when the cache is absent or destroyed.
 */
export function emitToEntry(
  entry: StreamEntryBase & { wc?: WebContents },
  channel: string,
  ...args: unknown[]
): void {
  if (entry.wc && !entry.wc.isDestroyed()) {
    entry.wc.send(channel, ...args);
    return;
  }
  emitTo(entry.webContentsId, channel, ...args);
}

export class StreamRegistry<E extends StreamEntryBase, X extends object = object> {
  private readonly map = new Map<string, E>();
  private readonly claims = new Map<string, StreamClaim<E, X>>();
  private readonly prefixes?: Record<string, string>;
  private readonly disposeEntry: (entry: E) => void;
  private readonly disposeClaim: (claim: StreamClaim<E, X>) => void;

  constructor(options: StreamRegistryOptions<E, X>) {
    this.prefixes = options.prefixes;
    this.disposeEntry = options.dispose;
    this.disposeClaim = options.disposeClaim ?? (() => {});
  }

  /**
   * Reserve `connectionId` for this renderer, synchronously, before the first await
   * of a connect. Returns undefined when this owner + id already has a live claim,
   * or when the sender is already destroyed. Another renderer may hold a claim on
   * the same external id. The owner's current entry is captured as `ownerEntry`.
   *
   * Call AFTER the handler's rate-limit / concurrency checks, and release in a
   * `finally`.
   */
  reserveClaim(
    connectionId: string,
    webContents: WebContents,
    ...fields: object extends X ? [fields?: X] : [fields: X]
  ): StreamClaim<E, X> | undefined {
    const key = ownerScopedKey(connectionId, webContents.id);
    if (this.claims.has(key)) return undefined;
    const claim = {
      ...fields[0],
      connectionId,
      webContentsId: webContents.id,
      ownerEntry: this.getForOwner(connectionId, webContents.id),
    } as StreamClaim<E, X>;
    this.claims.set(key, claim);
    // Keyed apart from the entries' binding: claims and entries tear down
    // independently, each with one listener per sender.
    bindRendererCleanup(this.claims, webContents, (deadId) =>
      disposeByOwner(this.claims, deadId, this.disposeClaim)
    );
    // A sender that is already destroyed tore the claim down inside the bind.
    return this.claims.get(key) === claim ? claim : undefined;
  }

  /** The live claim for this owner + id. Wrong-owner ids look missing. */
  claimFor(connectionId: string, webContentsId: number): StreamClaim<E, X> | undefined {
    return this.claims.get(ownerScopedKey(connectionId, webContentsId));
  }

  /** False once the claim was cancelled, released, or dropped by renderer death or teardown. */
  isClaimLive(claim: StreamClaim<E, X>): boolean {
    return this.claimFor(claim.connectionId, claim.webContentsId) === claim;
  }

  /**
   * Register the dialed entry, only through a live claim. A first connect may not
   * displace an entry that appeared meanwhile; a reconnect may replace only the exact
   * entry captured at reserve time, so stale work cannot replace a newer connection.
   * On false nothing was stored and the caller must tear the unregistered entry down.
   */
  commitClaim(claim: StreamClaim<E, X>, webContents: WebContents, entry: E): boolean {
    if (!this.isClaimLive(claim)) return false;
    const { connectionId, webContentsId, ownerEntry } = claim;
    if (!ownerEntry) return this.tryAdd(connectionId, webContents, entry);
    return (
      this.get(connectionId, webContentsId) === ownerEntry &&
      this.replaceForOwner(connectionId, webContentsId, entry)
    );
  }

  /** Drop the claim WITHOUT `disposeClaim`. A stale claim cannot drop a newer one. */
  releaseClaim(claim: StreamClaim<E, X>): void {
    if (this.isClaimLive(claim)) {
      this.claims.delete(ownerScopedKey(claim.connectionId, claim.webContentsId));
    }
  }

  /**
   * Invalidate this owner's claim, then run `disposeClaim` — in that order, so a
   * dial that settles synchronously during disposal still cannot commit. Missing and
   * wrong-owner ids both return false.
   */
  cancelClaim(connectionId: string, webContentsId: number): boolean {
    const key = ownerScopedKey(connectionId, webContentsId);
    const claim = this.claims.get(key);
    if (!claim) return false;
    this.claims.delete(key);
    this.safeDisposeClaim(claim);
    return true;
  }

  /** Live claims, including those mid-dial — count them against concurrency caps. */
  pendingCount(): number {
    return this.claims.size;
  }

  /** Iterate live claims, for bespoke sweeps and awaited teardown. */
  pendingClaims(): IterableIterator<StreamClaim<E, X>> {
    return this.claims.values();
  }

  /** Drop every claim WITHOUT `disposeClaim` — the claim equivalent of {@link clear}. */
  clearClaims(): void {
    this.claims.clear();
  }

  /** Run `disposeClaim` on every claim, then drop them — for `stop*Cleanup()`. */
  disposeAllClaims(): void {
    for (const claim of this.claims.values()) this.safeDisposeClaim(claim);
    this.claims.clear();
  }

  /**
   * Register `entry` under the owner-scoped `connectionId`. If an entry already
   * exists for that owner + id (a reconnect), it is disposed and replaced. Binds
   * the renderer-cleanup listener so a destroyed `webContents` disposes exactly
   * its own entries — idempotent across calls (deduped per webContents).
   *
   * Call AFTER the handler's rate-limit / concurrency checks: this does the
   * state-keeping, not the policy.
   */
  add(connectionId: string, webContents: WebContents, entry: E): void {
    const key = ownerScopedKey(connectionId, webContents.id);
    const existing = this.map.get(key);
    if (existing) {
      this.safeDispose(existing);
    }
    this.map.set(key, entry);
    // `this` is a stable per-registry key, so bindRendererCleanup dedupes the
    // 'destroyed' listener across every add from the same webContents.
    bindRendererCleanup(this, webContents, (deadId) =>
      disposeByOwner(this.map, deadId, (e) => this.safeDispose(e))
    );
  }

  /**
   * Like {@link add}, but REJECTS (returns false) when an entry already exists
   * for this owner + `connectionId` instead of disposing+replacing it. For
   * handlers where a same-owner duplicate id is a caller bug rather than a
   * reconnect (gRPC stream ids).
   */
  tryAdd(connectionId: string, webContents: WebContents, entry: E): boolean {
    const key = ownerScopedKey(connectionId, webContents.id);
    if (this.map.has(key)) return false;
    this.map.set(key, entry);
    bindRendererCleanup(this, webContents, (deadId) =>
      disposeByOwner(this.map, deadId, (e) => this.safeDispose(e))
    );
    return true;
  }

  get(connectionId: string, webContentsId: number): E | undefined {
    return this.map.get(ownerScopedKey(connectionId, webContentsId));
  }

  /** Return an entry only when it belongs to the given renderer. */
  getForOwner(connectionId: string, webContentsId: number): E | undefined {
    return this.get(connectionId, webContentsId);
  }

  /**
   * Replace an existing entry only when it belongs to the given renderer.
   * Missing and wrong-owner entries both return false.
   */
  replaceForOwner(connectionId: string, webContentsId: number, entry: E): boolean {
    if (entry.webContentsId !== webContentsId) return false;
    const existing = this.getForOwner(connectionId, webContentsId);
    if (!existing) return false;
    this.safeDispose(existing);
    this.map.set(ownerScopedKey(connectionId, webContentsId), entry);
    return true;
  }

  has(connectionId: string, webContentsId: number): boolean {
    return this.map.has(ownerScopedKey(connectionId, webContentsId));
  }

  size(): number {
    return this.map.size;
  }

  /**
   * Iterate the live entries — for handlers whose teardown is async or otherwise
   * bespoke (Kafka/MQTT await a graceful `closeConnection`), which don't fit the
   * synchronous {@link dispose} seam. Pair with {@link clear} after disposing.
   */
  values(): IterableIterator<E> {
    return this.map.values();
  }

  /**
   * Drop every entry WITHOUT disposing — for a handler that has already torn its
   * connections down itself (e.g. an awaited async teardown loop over
   * {@link values}). Use {@link disposeAll} when you want the registry to dispose.
   */
  clear(): void {
    this.map.clear();
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
  remove(connectionId: string, webContentsId: number): void {
    this.map.delete(ownerScopedKey(connectionId, webContentsId));
  }

  /**
   * Dispose AND remove an entry — for explicit disconnect/cancel channels.
   * Returns true if an entry existed.
   */
  cancel(connectionId: string, webContentsId: number): boolean {
    const key = ownerScopedKey(connectionId, webContentsId);
    const entry = this.map.get(key);
    if (!entry) return false;
    this.safeDispose(entry);
    this.map.delete(key);
    return true;
  }

  /**
   * Dispose and remove an entry only when it belongs to the given renderer.
   * Missing and wrong-owner entries both return false.
   */
  cancelForOwner(connectionId: string, webContentsId: number): boolean {
    return this.cancel(connectionId, webContentsId);
  }

  /**
   * Emit a templated per-connection event to the entry's owning renderer using
   * the configured `prefixes`. No-op if the entry is gone or `prefixes` was not
   * supplied. `eventName` keys into `prefixes`.
   *
   * For a TERMINAL event (close/error that ends the connection) use
   * {@link emitAndRemove} instead — `emit` resolves the renderer from the live
   * map entry, so emitting after a bare {@link remove} would silently no-op.
   */
  emit(connectionId: string, webContentsId: number, eventName: string, payload?: unknown): void {
    const entry = this.get(connectionId, webContentsId);
    if (!entry || !this.prefixes) return;
    const prefix = this.prefixes[eventName];
    if (prefix === undefined) return;
    emitTo(entry.webContentsId, eventChannel(prefix, connectionId), payload);
  }

  /**
   * Emit a templated event and THEN drop the entry — the safe way to send a
   * terminal event. Bundles the emit + removal in the correct order so callers
   * can't accidentally remove first and silently no-op the final event (the
   * foot-gun that {@link emit}'s live-entry lookup creates).
   */
  emitAndRemove(
    connectionId: string,
    webContentsId: number,
    eventName: string,
    payload?: unknown
  ): void {
    this.emit(connectionId, webContentsId, eventName, payload);
    this.map.delete(ownerScopedKey(connectionId, webContentsId));
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

  private safeDisposeClaim(claim: StreamClaim<E, X>): void {
    try {
      this.disposeClaim(claim);
    } catch {
      /* best-effort — teardown must never throw out of cleanup */
    }
  }
}
