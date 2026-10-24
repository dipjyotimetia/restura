// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => Promise<unknown>>());
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) =>
      handlers.set(channel, fn),
  },
}));

import { IPC } from '../../shared/channels';
import type { KafkaRegistryClient } from '../handlers/kafka/registry';
import {
  type KafkaRegistryEntry,
  registerKafkaRegistryHandlers,
} from '../handlers/kafka/registry-handlers';
import { createKeyedRateLimiter } from '../ipc/ipc-rate-limiter';

let nextSender = 9000;
function event(url = 'file:///app/dist/web/index.html') {
  return { sender: { id: nextSender++ }, senderFrame: { url, parent: null } };
}

const registry = {
  listSubjects: vi.fn(async () => ['orders-value']),
  listVersions: vi.fn(async () => [1, 2]),
  getSchema: vi.fn(async () => ({
    id: 1,
    subject: 'orders-value',
    version: 2,
    schemaType: 'AVRO' as const,
    schema: '{}',
    references: [],
  })),
} as unknown as KafkaRegistryClient;

const entries = new Map<string, KafkaRegistryEntry>();
const call = (channel: string, input: unknown, ev = event()) => handlers.get(channel)!(ev, input);

beforeEach(() => {
  handlers.clear();
  entries.clear();
  vi.mocked(registry.listSubjects).mockClear();
  registerKafkaRegistryHandlers({
    getEntry: (connectionId) => entries.get(connectionId),
    rateLimiter: createKeyedRateLimiter(3, 60_000),
  });
});

describe('Kafka Schema Registry IPC handlers', () => {
  it('registers the three registry channels', () => {
    expect([...handlers.keys()].sort()).toEqual(
      [
        IPC.kafka.registryGetSchema,
        IPC.kafka.registryListSubjects,
        IPC.kafka.registryListVersions,
      ].sort()
    );
  });

  it('lists subjects, versions and schema detail for the owning connection', async () => {
    entries.set('c1', { registry });
    expect(await call(IPC.kafka.registryListSubjects, { connectionId: 'c1' })).toEqual({
      success: true,
      subjects: ['orders-value'],
    });
    expect(
      await call(IPC.kafka.registryListVersions, { connectionId: 'c1', subject: 'orders-value' })
    ).toEqual({ success: true, versions: [1, 2] });
    expect(
      await call(IPC.kafka.registryGetSchema, {
        connectionId: 'c1',
        subject: 'orders-value',
        version: 'latest',
      })
    ).toMatchObject({ success: true, schema: { id: 1, version: 2 } });
    expect(registry.getSchema).toHaveBeenCalledWith('orders-value', 'latest');
  });

  it('reports missing connections and connections without a registry', async () => {
    expect(await call(IPC.kafka.registryListSubjects, { connectionId: 'nope' })).toEqual({
      success: false,
      error: 'Not connected',
    });
    entries.set('c2', {});
    expect(await call(IPC.kafka.registryListSubjects, { connectionId: 'c2' })).toEqual({
      success: false,
      error: 'No Schema Registry is configured on this connection.',
    });
  });

  it('returns registry failures as error results', async () => {
    entries.set('c1', { registry });
    vi.mocked(registry.listSubjects).mockRejectedValueOnce(
      new Error('Schema Registry responded 401')
    );
    expect(await call(IPC.kafka.registryListSubjects, { connectionId: 'c1' })).toEqual({
      success: false,
      error: 'Schema Registry responded 401',
    });
  });

  it('rejects invalid input and untrusted frames before touching the registry', async () => {
    entries.set('c1', { registry });
    await expect(
      call(IPC.kafka.registryGetSchema, { connectionId: 'c1', subject: 'x', version: 'v1' })
    ).rejects.toThrow();
    await expect(
      call(IPC.kafka.registryListSubjects, { connectionId: 'c1' }, event('https://evil.example/'))
    ).rejects.toThrow(/untrusted frame/);
    expect(registry.listSubjects).not.toHaveBeenCalled();
  });

  it('rate-limits per renderer', async () => {
    entries.set('c1', { registry });
    const ev = event();
    for (let i = 0; i < 3; i += 1)
      await call(IPC.kafka.registryListSubjects, { connectionId: 'c1' }, ev);
    await expect(call(IPC.kafka.registryListSubjects, { connectionId: 'c1' }, ev)).rejects.toThrow(
      /Rate limit/
    );
  });
});
