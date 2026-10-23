// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type MockMcpLegacySessionServerHandle,
  startMockMcpLegacySessionServer,
} from '../../../e2e/mocks/mcpLegacySessionServer';
import { type MockMcpV2ServerHandle, startMockMcpV2Server } from '../../../e2e/mocks/mcpV2Server';
import { connectMcpSdkClient, type McpSdkClient } from '../handlers/mcp-sdk-client';

/**
 * #858 / #872 regression: the real v2 SDK client against a sessionful legacy
 * server and the modern (2026-07-28) v2 mock. Resource subscriptions must use
 * `resources/subscribe` on legacy and `subscriptions/listen` on modern, and
 * every server push must reach the `onNotification` event that the IPC handler
 * forwards to the renderer.
 */

let legacy: MockMcpLegacySessionServerHandle | undefined;
let modern: MockMcpV2ServerHandle | undefined;
let client: McpSdkClient | undefined;

afterEach(async () => {
  await client?.close().catch(() => undefined);
  client = undefined;
  await legacy?.close();
  legacy = undefined;
  await modern?.close();
  modern = undefined;
});

function collector() {
  const notifications: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const events = {
    onNotification: vi.fn(async (n: unknown) => {
      notifications.push(n as { method: string; params?: Record<string, unknown> });
    }),
    onError: vi.fn(),
    onClose: vi.fn(),
  };
  const waitFor = (
    predicate: (n: { method: string; params?: Record<string, unknown> }) => boolean
  ) =>
    vi.waitFor(
      () => {
        const hit = notifications.find(predicate);
        if (!hit) throw new Error('notification not received yet');
        return hit;
      },
      { timeout: 5000, interval: 20 }
    );
  /** Re-publish until the push lands (the GET/listen stream opens asynchronously). */
  const publishUntil = (publish: () => unknown, method: string) =>
    vi.waitFor(
      async () => {
        await publish();
        const hit = notifications.find((n) => n.method === method);
        if (!hit) throw new Error(`${method} not received yet`);
        return hit;
      },
      { timeout: 5000, interval: 50 }
    );
  return { notifications, events, waitFor, publishUntil };
}

async function connect(url: string, events: ReturnType<typeof collector>['events']) {
  return connectMcpSdkClient({
    url: new URL(url),
    transport: 'streamable-http',
    transportOptions: { fetch: globalThis.fetch, requestInit: {} },
    events,
  });
}

describe('MCP subscriptions — legacy (2025-era) sessionful server', () => {
  it('subscribes with resources/subscribe and forwards resources/updated', async () => {
    legacy = await startMockMcpLegacySessionServer();
    const { events, publishUntil } = collector();
    client = await connect(legacy.url, events);
    expect(client.getProtocolVersion()).not.toBe('2026-07-28');

    await expect(
      client.request('resources/subscribe', { uri: 'restura-legacy://config.json' }, 5000)
    ).resolves.toEqual({});
    expect(legacy.subscribedUris()).toEqual(['restura-legacy://config.json']);

    const updated = await publishUntil(
      () => legacy!.publishResourceUpdated('restura-legacy://config.json'),
      'notifications/resources/updated'
    );
    expect(updated.params).toMatchObject({ uri: 'restura-legacy://config.json' });

    await client.request('resources/unsubscribe', { uri: 'restura-legacy://config.json' }, 5000);
    expect(legacy.subscribedUris()).toEqual([]);
  });

  it('forwards unsolicited list_changed and logging messages', async () => {
    legacy = await startMockMcpLegacySessionServer();
    const { events, waitFor, publishUntil } = collector();
    client = await connect(legacy.url, events);

    await publishUntil(() => legacy!.publishToolsChanged(), 'notifications/tools/list_changed');
    await legacy.publishLog('warning', { detail: 'disk almost full' });
    const log = await waitFor((n) => n.method === 'notifications/message');
    expect(log.params).toMatchObject({ level: 'warning', data: { detail: 'disk almost full' } });
  });

  it('forwards progress for an in-flight tool call', async () => {
    legacy = await startMockMcpLegacySessionServer();
    const { events, notifications } = collector();
    client = await connect(legacy.url, events);

    const result = await client.request(
      'tools/call',
      { name: 'slow-count', arguments: { steps: 3 } },
      5000
    );
    expect(result).toMatchObject({ content: [{ type: 'text', text: 'counted:3' }] });
    const progress = notifications.filter((n) => n.method === 'notifications/progress');
    expect(progress.map((n) => n.params?.progress)).toEqual([1, 2, 3]);
    expect(progress[0]?.params).toMatchObject({
      total: 3,
      requestMethod: 'tools/call',
      name: 'slow-count',
    });
    // One progressKey per call so the renderer can coalesce updates into one bar.
    expect(new Set(progress.map((n) => n.params?.progressKey)).size).toBe(1);
  });
});

describe('MCP subscriptions — modern (2026-07-28) server', () => {
  it('subscribes with subscriptions/listen and forwards resources/updated', async () => {
    modern = await startMockMcpV2Server();
    const { events, waitFor } = collector();
    client = await connect(modern.url, events);
    expect(client.getProtocolVersion()).toBe('2026-07-28');

    // Before the fix this hit `client.subscribeResource`, which the SDK rejects
    // as METHOD_NOT_SUPPORTED_BY_PROTOCOL_VERSION on a modern connection.
    await expect(
      client.request('resources/subscribe', { uri: 'restura-v2://config.json' }, 5000)
    ).resolves.toEqual({});

    modern.publishChanges();
    const updated = await waitFor((n) => n.method === 'notifications/resources/updated');
    expect(updated.params).toMatchObject({ uri: 'restura-v2://config.json' });

    await expect(
      client.request('resources/unsubscribe', { uri: 'restura-v2://config.json' }, 5000)
    ).resolves.toEqual({});
  });

  it('opens a list_changed listen stream automatically after connect', async () => {
    modern = await startMockMcpV2Server();
    const { events, publishUntil } = collector();
    client = await connect(modern.url, events);

    await publishUntil(() => modern!.publishChanges(), 'notifications/tools/list_changed');
    expect(events.onError).not.toHaveBeenCalled();
  });

  it('rejects raw subscriptions/listen with a pointer to the managed path', async () => {
    modern = await startMockMcpV2Server();
    const { events } = collector();
    client = await connect(modern.url, events);

    await expect(
      client.request('subscriptions/listen', { notifications: { toolsListChanged: true } }, 5000)
    ).rejects.toThrow(/managed by Restura/);
  });
});
