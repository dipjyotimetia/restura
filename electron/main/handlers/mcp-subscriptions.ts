import type { Client, McpSubscription, SubscriptionFilter } from '@modelcontextprotocol/client';

/**
 * Era-aware MCP subscription bookkeeping for one SDK client (#858, #872).
 *
 * - **Legacy (2025-era)** servers push change notifications unsolicited (GET
 *   SSE stream / http-sse stream) and take resource subscriptions through
 *   `resources/subscribe` + `resources/unsubscribe`.
 * - **Modern (2026-07-28)** servers only push on a `subscriptions/listen`
 *   stream: `resources/subscribe` is rejected as unsupported by the protocol
 *   version, and `list_changed` notifications only flow on a listen stream
 *   that opted into them. Each subscribed resource gets its own listen stream
 *   so unsubscribing is a plain `close()` of that stream.
 *
 * Notifications delivered on a listen stream reach the client's normal
 * notification handlers (Restura's `fallbackNotificationHandler`), so the
 * renderer sees the same `notifications/*` messages in both eras.
 */

export type McpSubscriptionHost = Pick<
  Client,
  | 'getProtocolEra'
  | 'getServerCapabilities'
  | 'subscribeResource'
  | 'unsubscribeResource'
  | 'listen'
>;

export interface McpSubscriptionRequestOptions {
  timeout: number;
}

/** Synthetic notification emitted when a server ends a listen stream we did not close. */
export const MCP_SUBSCRIPTION_CLOSED_METHOD = 'restura/subscriptionClosed';

/** Defensive cap: each modern subscription holds an open SSE stream. */
export const MAX_MCP_RESOURCE_SUBSCRIPTIONS = 32;

export interface McpSubscriptionClosedNotification {
  method: typeof MCP_SUBSCRIPTION_CLOSED_METHOD;
  params: { scope: 'resource' | 'listChanged'; uri?: string; reason: 'graceful' | 'remote' };
}

type ResourceStream = McpSubscription | Promise<McpSubscription>;

function requireUri(params: unknown): string {
  const uri = (params as { uri?: unknown } | null | undefined)?.uri;
  if (typeof uri !== 'string' || uri.length === 0) {
    throw new Error('Resource subscription requires a non-empty "uri" string');
  }
  return uri;
}

export class McpSubscriptionManager {
  private readonly resourceStreams = new Map<string, ResourceStream>();
  private listChangedStream: McpSubscription | undefined;
  private closed = false;

  constructor(
    private readonly host: McpSubscriptionHost,
    private readonly emit: (notification: McpSubscriptionClosedNotification) => void
  ) {}

  private isModern(): boolean {
    return this.host.getProtocolEra() === 'modern';
  }

  /** URIs with a live (or pending) modern listen stream. Test/introspection only. */
  activeResourceUris(): string[] {
    return [...this.resourceStreams.keys()];
  }

  async subscribeResource(
    params: unknown,
    options: McpSubscriptionRequestOptions
  ): Promise<Record<string, never>> {
    const uri = requireUri(params);
    if (this.closed) throw new Error('MCP client is closed');
    if (!this.isModern()) {
      await this.host.subscribeResource({ uri }, options);
      return {};
    }
    if (this.resourceStreams.has(uri)) return {};
    if (this.resourceStreams.size >= MAX_MCP_RESOURCE_SUBSCRIPTIONS) {
      throw new Error(
        `Too many resource subscriptions (max ${MAX_MCP_RESOURCE_SUBSCRIPTIONS}); unsubscribe one first`
      );
    }

    const pending = this.host.listen({ resourceSubscriptions: [uri] }, options);
    this.resourceStreams.set(uri, pending);
    let subscription: McpSubscription;
    try {
      subscription = await pending;
    } catch (err) {
      if (this.resourceStreams.get(uri) === pending) this.resourceStreams.delete(uri);
      throw err;
    }

    // Unsubscribed (or the client closed) while the ack was in flight.
    if (this.closed || this.resourceStreams.get(uri) !== pending) {
      await subscription.close().catch(() => undefined);
      return {};
    }
    if (!subscription.honoredFilter.resourceSubscriptions?.includes(uri)) {
      this.resourceStreams.delete(uri);
      await subscription.close().catch(() => undefined);
      throw new Error(`Server declined the subscription to ${uri}`);
    }

    this.resourceStreams.set(uri, subscription);
    void subscription.closed.then((reason) => {
      if (this.resourceStreams.get(uri) !== subscription) return;
      this.resourceStreams.delete(uri);
      if (reason !== 'local' && !this.closed) {
        this.emit({
          method: MCP_SUBSCRIPTION_CLOSED_METHOD,
          params: { scope: 'resource', uri, reason },
        });
      }
    });
    return {};
  }

  async unsubscribeResource(
    params: unknown,
    options: McpSubscriptionRequestOptions
  ): Promise<Record<string, never>> {
    const uri = requireUri(params);
    if (!this.isModern()) {
      await this.host.unsubscribeResource({ uri }, options);
      return {};
    }
    const stream = this.resourceStreams.get(uri);
    // Deleting first makes an in-flight subscribe close its stream on ack.
    this.resourceStreams.delete(uri);
    if (stream && !(stream instanceof Promise)) await stream.close();
    return {};
  }

  /**
   * Modern servers only deliver `*\/list_changed` on a listen stream. Open one
   * for every list the server advertises as `listChanged`; a no-op on legacy
   * connections, where those notifications arrive unsolicited.
   */
  async openListChangedStream(options?: McpSubscriptionRequestOptions): Promise<boolean> {
    if (this.closed || this.listChangedStream || !this.isModern()) return false;
    const caps = this.host.getServerCapabilities() as
      | {
          tools?: { listChanged?: boolean };
          prompts?: { listChanged?: boolean };
          resources?: { listChanged?: boolean };
        }
      | undefined;
    const filter: SubscriptionFilter = {
      ...(caps?.tools?.listChanged ? { toolsListChanged: true } : {}),
      ...(caps?.prompts?.listChanged ? { promptsListChanged: true } : {}),
      ...(caps?.resources?.listChanged ? { resourcesListChanged: true } : {}),
    };
    if (Object.keys(filter).length === 0) return false;

    const subscription = await this.host.listen(filter, options);
    if (this.closed) {
      await subscription.close().catch(() => undefined);
      return false;
    }
    this.listChangedStream = subscription;
    void subscription.closed.then((reason) => {
      if (this.listChangedStream !== subscription) return;
      this.listChangedStream = undefined;
      if (reason !== 'local' && !this.closed) {
        this.emit({
          method: MCP_SUBSCRIPTION_CLOSED_METHOD,
          params: { scope: 'listChanged', reason },
        });
      }
    });
    return true;
  }

  /** Close every listen stream. Idempotent; never throws. */
  async closeAll(): Promise<void> {
    this.closed = true;
    const streams: ResourceStream[] = [...this.resourceStreams.values()];
    this.resourceStreams.clear();
    if (this.listChangedStream) streams.push(this.listChangedStream);
    this.listChangedStream = undefined;
    await Promise.allSettled(
      streams
        .filter((stream): stream is McpSubscription => !(stream instanceof Promise))
        .map((stream) => stream.close())
    );
  }
}
