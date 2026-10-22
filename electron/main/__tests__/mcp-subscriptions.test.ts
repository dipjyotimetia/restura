import { describe, expect, it, vi } from 'vitest';
import {
  MAX_MCP_RESOURCE_SUBSCRIPTIONS,
  MCP_SUBSCRIPTION_CLOSED_METHOD,
  type McpSubscriptionHost,
  McpSubscriptionManager,
} from '../handlers/mcp-subscriptions';

type Reason = 'local' | 'graceful' | 'remote';

function fakeSubscription(honored: { resourceSubscriptions?: string[] }) {
  let settle!: (reason: Reason) => void;
  const closed = new Promise<Reason>((resolve) => {
    settle = resolve;
  });
  const sub = {
    honoredFilter: honored,
    closed,
    close: vi.fn(async () => settle('local')),
    endRemotely: (reason: Reason) => settle(reason),
  };
  return sub;
}

function fakeHost(era: 'legacy' | 'modern', caps: unknown = {}) {
  const subs: Array<ReturnType<typeof fakeSubscription>> = [];
  const host = {
    getProtocolEra: vi.fn(() => era),
    getServerCapabilities: vi.fn(() => caps),
    subscribeResource: vi.fn(async () => ({})),
    unsubscribeResource: vi.fn(async () => ({})),
    listen: vi.fn(async (filter: { resourceSubscriptions?: string[] }) => {
      const sub = fakeSubscription(filter);
      subs.push(sub);
      return sub;
    }),
  };
  return { host: host as unknown as McpSubscriptionHost, raw: host, subs };
}

const opts = { timeout: 1000 };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('McpSubscriptionManager', () => {
  it('uses resources/subscribe + unsubscribe on legacy connections', async () => {
    const { host, raw } = fakeHost('legacy');
    const manager = new McpSubscriptionManager(host, vi.fn());

    await expect(manager.subscribeResource({ uri: 'a://1' }, opts)).resolves.toEqual({});
    await manager.unsubscribeResource({ uri: 'a://1' }, opts);

    expect(raw.subscribeResource).toHaveBeenCalledWith({ uri: 'a://1' }, opts);
    expect(raw.unsubscribeResource).toHaveBeenCalledWith({ uri: 'a://1' }, opts);
    expect(raw.listen).not.toHaveBeenCalled();
  });

  it('opens one subscriptions/listen stream per resource on modern connections', async () => {
    const { host, raw, subs } = fakeHost('modern');
    const manager = new McpSubscriptionManager(host, vi.fn());

    await manager.subscribeResource({ uri: 'a://1' }, opts);
    await manager.subscribeResource({ uri: 'a://1' }, opts); // idempotent
    expect(raw.listen).toHaveBeenCalledOnce();
    expect(raw.listen).toHaveBeenCalledWith({ resourceSubscriptions: ['a://1'] }, opts);
    expect(raw.subscribeResource).not.toHaveBeenCalled();
    expect(manager.activeResourceUris()).toEqual(['a://1']);

    await manager.unsubscribeResource({ uri: 'a://1' }, opts);
    expect(subs[0]!.close).toHaveBeenCalledOnce();
    expect(manager.activeResourceUris()).toEqual([]);
  });

  it('rejects when the server does not honor the resource filter', async () => {
    const { host, raw, subs } = fakeHost('modern');
    raw.listen.mockImplementationOnce(async () => {
      const sub = fakeSubscription({});
      subs.push(sub);
      return sub;
    });
    const manager = new McpSubscriptionManager(host, vi.fn());

    await expect(manager.subscribeResource({ uri: 'a://1' }, opts)).rejects.toThrow(
      'Server declined the subscription to a://1'
    );
    expect(subs[0]!.close).toHaveBeenCalledOnce();
    expect(manager.activeResourceUris()).toEqual([]);
  });

  it('closes a stream whose ack lands after the user already unsubscribed', async () => {
    const { host, raw } = fakeHost('modern');
    let resolveListen!: (sub: ReturnType<typeof fakeSubscription>) => void;
    raw.listen.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveListen = resolve;
        })
    );
    const manager = new McpSubscriptionManager(host, vi.fn());

    const pending = manager.subscribeResource({ uri: 'a://1' }, opts);
    await manager.unsubscribeResource({ uri: 'a://1' }, opts);
    const late = fakeSubscription({ resourceSubscriptions: ['a://1'] });
    resolveListen(late);
    await expect(pending).resolves.toEqual({});

    expect(late.close).toHaveBeenCalledOnce();
    expect(manager.activeResourceUris()).toEqual([]);
  });

  it('drops a failed listen so the user can retry', async () => {
    const { host, raw } = fakeHost('modern');
    raw.listen.mockRejectedValueOnce(new Error('capacity'));
    const manager = new McpSubscriptionManager(host, vi.fn());

    await expect(manager.subscribeResource({ uri: 'a://1' }, opts)).rejects.toThrow('capacity');
    expect(manager.activeResourceUris()).toEqual([]);
    await expect(manager.subscribeResource({ uri: 'a://1' }, opts)).resolves.toEqual({});
  });

  it('caps the number of concurrent resource streams', async () => {
    const { host } = fakeHost('modern');
    const manager = new McpSubscriptionManager(host, vi.fn());
    for (let i = 0; i < MAX_MCP_RESOURCE_SUBSCRIPTIONS; i++) {
      await manager.subscribeResource({ uri: `a://${i}` }, opts);
    }
    await expect(manager.subscribeResource({ uri: 'a://overflow' }, opts)).rejects.toThrow(
      /Too many resource subscriptions/
    );
  });

  it('rejects a missing uri', async () => {
    const { host } = fakeHost('modern');
    const manager = new McpSubscriptionManager(host, vi.fn());
    await expect(manager.subscribeResource({}, opts)).rejects.toThrow(/non-empty "uri"/);
    await expect(manager.unsubscribeResource(undefined, opts)).rejects.toThrow(/non-empty "uri"/);
  });

  it('reports a server-ended resource stream, but not a local close', async () => {
    const { host, subs } = fakeHost('modern');
    const emit = vi.fn();
    const manager = new McpSubscriptionManager(host, emit);

    await manager.subscribeResource({ uri: 'a://1' }, opts);
    await manager.subscribeResource({ uri: 'a://2' }, opts);
    subs[0]!.endRemotely('remote');
    await manager.unsubscribeResource({ uri: 'a://2' }, opts);
    await flush();

    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith({
      method: MCP_SUBSCRIPTION_CLOSED_METHOD,
      params: { scope: 'resource', uri: 'a://1', reason: 'remote' },
    });
    expect(manager.activeResourceUris()).toEqual([]);
  });

  it('opens a list_changed stream only for advertised lists on modern connections', async () => {
    const { host, raw } = fakeHost('modern', {
      tools: { listChanged: true },
      prompts: {},
      resources: { listChanged: true },
    });
    const manager = new McpSubscriptionManager(host, vi.fn());

    await expect(manager.openListChangedStream()).resolves.toBe(true);
    await expect(manager.openListChangedStream()).resolves.toBe(false); // already open
    expect(raw.listen).toHaveBeenCalledOnce();
    expect(raw.listen).toHaveBeenCalledWith(
      { toolsListChanged: true, resourcesListChanged: true },
      undefined
    );
  });

  it('skips the list_changed stream on legacy connections and when nothing is advertised', async () => {
    const legacy = fakeHost('legacy', { tools: { listChanged: true } });
    await expect(
      new McpSubscriptionManager(legacy.host, vi.fn()).openListChangedStream()
    ).resolves.toBe(false);
    const quiet = fakeHost('modern', { tools: {} });
    await expect(
      new McpSubscriptionManager(quiet.host, vi.fn()).openListChangedStream()
    ).resolves.toBe(false);
    expect(legacy.raw.listen).not.toHaveBeenCalled();
    expect(quiet.raw.listen).not.toHaveBeenCalled();
  });

  it('reports a server-ended list_changed stream', async () => {
    const { host, subs } = fakeHost('modern', { tools: { listChanged: true } });
    const emit = vi.fn();
    const manager = new McpSubscriptionManager(host, emit);
    await manager.openListChangedStream();

    subs[0]!.endRemotely('graceful');
    await flush();

    expect(emit).toHaveBeenCalledWith({
      method: MCP_SUBSCRIPTION_CLOSED_METHOD,
      params: { scope: 'listChanged', reason: 'graceful' },
    });
  });

  it('closeAll tears down every stream silently and refuses new subscriptions', async () => {
    const { host, subs } = fakeHost('modern', { tools: { listChanged: true } });
    const emit = vi.fn();
    const manager = new McpSubscriptionManager(host, emit);
    await manager.openListChangedStream();
    await manager.subscribeResource({ uri: 'a://1' }, opts);

    await manager.closeAll();
    await flush();

    expect(subs.every((sub) => sub.close.mock.calls.length === 1)).toBe(true);
    expect(emit).not.toHaveBeenCalled();
    await expect(manager.subscribeResource({ uri: 'a://2' }, opts)).rejects.toThrow(/closed/);
    await expect(manager.openListChangedStream()).resolves.toBe(false);
  });

  it('closes a list_changed stream that acks after closeAll', async () => {
    const { host, raw } = fakeHost('modern', { tools: { listChanged: true } });
    let resolveListen!: (sub: ReturnType<typeof fakeSubscription>) => void;
    raw.listen.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveListen = resolve;
        })
    );
    const manager = new McpSubscriptionManager(host, vi.fn());
    const opening = manager.openListChangedStream();
    await manager.closeAll();
    const late = fakeSubscription({});
    resolveListen(late);

    await expect(opening).resolves.toBe(false);
    expect(late.close).toHaveBeenCalledOnce();
  });
});
