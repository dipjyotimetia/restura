import { createClient, type Client, type Sink } from 'graphql-ws';
import { createElectronGraphQLSocketClass } from './electronGraphQLSocket';
import { isElectron } from '@/lib/shared/platform';

export interface SubscriptionMessage {
  id: string;
  type: 'data' | 'error' | 'complete' | 'connecting' | 'connected';
  payload?: unknown;
  error?: string;
  timestamp: number;
}

export interface SubscriptionOptions {
  url: string;
  query: string;
  variables?: Record<string, unknown>;
  headers?: Record<string, string>;
  onMessage: (msg: SubscriptionMessage) => void;
  onConnected?: () => void;
  onError?: (err: unknown) => void;
  onComplete?: () => void;
}

export class GraphQLSubscriptionClient {
  private client: Client | null = null;
  private unsubscribe: (() => void) | null = null;
  private headers: Record<string, string>;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;

  constructor(_url: string, headers: Record<string, string> = {}) {
    this.headers = headers;
  }

  private toWebSocketUrl(url: string): string {
    return url.replace(/^http:\/\//, 'ws://').replace(/^https:\/\//, 'wss://');
  }

  connect(options: SubscriptionOptions): void {
    this.disconnect();

    const wsUrl = this.toWebSocketUrl(options.url);
    const makeId = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    options.onMessage({
      id: makeId(),
      type: 'connecting',
      timestamp: Date.now(),
    });

    this.timeoutId = setTimeout(() => {
      this.timeoutId = null;
      options.onMessage({
        id: makeId(),
        type: 'error',
        error: 'Connection timeout',
        timestamp: Date.now(),
      });
      this.disconnect();
    }, 30_000);

    this.client = createClient({
      url: wsUrl,
      connectionParams: Object.keys(this.headers).length > 0 ? this.headers : undefined,
      // Desktop: a renderer-direct WebSocket is CSP-blocked, so tunnel graphql-ws
      // over the WebSocket IPC bridge. Web keeps the native WebSocket.
      ...(isElectron() ? { webSocketImpl: createElectronGraphQLSocketClass(this.headers) } : {}),
      on: {
        connected: () => {
          if (this.timeoutId !== null) {
            clearTimeout(this.timeoutId);
            this.timeoutId = null;
          }
          options.onMessage({
            id: makeId(),
            type: 'connected',
            timestamp: Date.now(),
          });
          options.onConnected?.();
        },
        error: (err) => {
          if (this.timeoutId !== null) {
            clearTimeout(this.timeoutId);
            this.timeoutId = null;
          }
          options.onMessage({
            id: makeId(),
            type: 'error',
            error: err instanceof Error ? err.message : 'Connection error',
            timestamp: Date.now(),
          });
          options.onError?.(err);
        },
      },
    });

    const sink: Sink = {
      next: (value) => {
        options.onMessage({
          id: makeId(),
          type: 'data',
          payload: value,
          timestamp: Date.now(),
        });
      },
      error: (err) => {
        options.onMessage({
          id: makeId(),
          type: 'error',
          error:
            err instanceof Error
              ? err.message
              : Array.isArray(err)
                ? err.map((e) => (e instanceof Error ? e.message : String(e))).join(', ')
                : 'Subscription error',
          timestamp: Date.now(),
        });
        options.onError?.(err);
      },
      complete: () => {
        options.onMessage({
          id: makeId(),
          type: 'complete',
          timestamp: Date.now(),
        });
        options.onComplete?.();
      },
    };

    this.unsubscribe = this.client.subscribe(
      {
        query: options.query,
        variables: options.variables,
      },
      sink
    );
  }

  disconnect(): void {
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.client?.dispose();
    this.client = null;
  }

  get isConnected(): boolean {
    return this.client !== null && this.unsubscribe !== null;
  }
}
