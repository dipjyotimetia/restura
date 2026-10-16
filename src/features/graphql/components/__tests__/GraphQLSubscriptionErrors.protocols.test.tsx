import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Every subscription wire protocol (graphql-transport-ws, legacy
 * subscriptions-transport-ws, graphql-sse) funnels `next`/`data` payloads into
 * `type: 'data'` messages — an ExecutionResult that may carry `errors[]`.
 * Drive the real client per protocol and check those errors reach the panel.
 */

vi.mock('@/lib/shared/lazyComponent', async () => {
  const JsonTree = (await import('@/components/shared/JsonTree')).default;
  return { lazyComponent: () => JsonTree };
});

const PAYLOAD = {
  data: { tick: null },
  errors: [
    {
      message: 'tick exploded',
      locations: [{ line: 1, column: 16 }],
      path: ['tick'],
      extensions: { code: 'TICK_FAILED' },
    },
  ],
};

const sse = vi.hoisted(() => ({ body: '' }));
vi.mock('@/lib/shared/transport', () => ({
  executeProxiedStreamingRequest: async () =>
    new Response(sse.body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
}));

import { GraphQLSubscriptionClient, type SubscriptionMessage } from '../../lib/subscriptionClient';
import { GraphQLSubscriptionErrors } from '../GraphQLSubscriptionErrors';

/** Minimal in-memory server for both WebSocket subprotocols. */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = 0;
  protocol: string;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;

  constructor(_url: string, protocols?: string | string[]) {
    const offered = Array.isArray(protocols) ? protocols : protocols ? [protocols] : [];
    this.protocol = offered[0] ?? '';
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.({ type: 'open' });
    }, 0);
  }

  private reply(msg: Record<string, unknown>): void {
    setTimeout(() => this.onmessage?.({ data: JSON.stringify(msg) }), 0);
  }

  send(raw: string): void {
    const msg = JSON.parse(raw) as { type: string; id?: string };
    if (msg.type === 'connection_init') this.reply({ type: 'connection_ack' });
    // graphql-transport-ws
    if (msg.type === 'subscribe') {
      this.reply({ id: msg.id, type: 'next', payload: PAYLOAD });
      this.reply({ id: msg.id, type: 'complete' });
    }
    // legacy subscriptions-transport-ws
    if (msg.type === 'start') {
      this.reply({ id: msg.id, type: 'data', payload: PAYLOAD });
      this.reply({ id: msg.id, type: 'complete' });
    }
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    setTimeout(() => this.onclose?.({ code, reason }), 0);
  }

  addEventListener(): void {}
  removeEventListener(): void {}
}

function runSubscription(
  protocol: 'graphql-transport-ws' | 'subscriptions-transport-ws' | 'graphql-sse'
): Promise<SubscriptionMessage[]> {
  const messages: SubscriptionMessage[] = [];
  const client = new GraphQLSubscriptionClient('http://gql.test/graphql');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.disconnect();
      reject(new Error(`timeout: ${JSON.stringify(messages)}`));
    }, 4000);
    client.connect({
      url: 'http://gql.test/graphql',
      query: 'subscription { tick { n } }',
      protocol,
      onMessage: (m) => {
        messages.push(m);
        if (m.type === 'complete' || m.type === 'error') {
          clearTimeout(timer);
          resolve(messages);
        }
      },
    });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('subscription next-payload errors reach the panel on every protocol', () => {
  it.each(['graphql-transport-ws', 'subscriptions-transport-ws', 'graphql-sse'] as const)(
    '%s',
    async (protocol) => {
      vi.stubGlobal('WebSocket', FakeWebSocket);
      sse.body = `event: next\ndata: ${JSON.stringify(PAYLOAD)}\n\nevent: complete\ndata:\n\n`;

      const messages = await runSubscription(protocol);
      expect(messages.at(-1)?.type).toBe('complete');
      expect(messages.filter((m) => m.type === 'data')).toHaveLength(1);

      render(<GraphQLSubscriptionErrors messages={messages} tabId="t" />);
      expect(screen.getByText('1 error in events')).toBeTruthy();
      expect(screen.getByText('tick exploded')).toBeTruthy();
      expect(screen.getByText('TICK_FAILED')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Show tick in response' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Go to query line 1, column 16' })).toBeTruthy();
    }
  );
});
