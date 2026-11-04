import { beforeEach, describe, expect, it, vi } from 'vitest';
import { executeRequest } from '@/features/http/lib/requestExecutor';
import type { HttpRequest } from '@/types';
import { runLoadTest } from '../loadTestRunner';

const { addEntry } = vi.hoisted(() => ({ addEntry: vi.fn() }));

vi.mock('@/features/http/lib/requestExecutor', () => ({ executeRequest: vi.fn() }));
vi.mock('@/store/useEnvironmentStore', () => ({
  useEnvironmentStore: {
    getState: () => ({ getActiveEnvironment: () => null, resolveVariables: (t: string) => t }),
  },
}));
vi.mock('@/store/useSettingsStore', () => ({
  useSettingsStore: { getState: () => ({ settings: {} }) },
}));
vi.mock('@/store/useConsoleStore', () => ({
  useConsoleStore: { getState: () => ({ addEntry }) },
  createProtocolConsoleEntry: (entry: unknown) => entry,
}));
vi.mock('@/features/auth/lib/resolveInheritedAuthFor', () => ({
  resolveInheritedAuthForSend: vi.fn(() => undefined),
}));
vi.mock('@/lib/shared/activeRequestScopes', () => ({
  buildActiveRequestVariableResolution: vi.fn(() => ({
    values: {},
    secretVariables: {},
    secretNames: [],
    sendSecretNames: [],
  })),
}));
vi.mock('@/store/useRequestStore', () => ({
  useRequestStore: { getState: () => ({ getActiveTab: () => ({ savedRequestId: 'saved-1' }) }) },
}));
vi.mock('@/store/useCollectionStore', () => ({
  useCollectionStore: { getState: () => ({ getCollectionByItemId: () => undefined }) },
}));

const mockExec = vi.mocked(executeRequest);

beforeEach(() => {
  mockExec.mockReset();
  addEntry.mockReset();
});

describe('load test console summary percentiles', () => {
  it('uses the same nearest-rank percentiles and ok-only samples as the dialog', async () => {
    // 10 ok samples 1..10ms, plus 2 failed samples with large timings that the
    // dialog excludes from latency stats.
    let n = 0;
    mockExec.mockImplementation(async () => {
      n++;
      if (n <= 10) return { response: { status: 200, time: n } } as never;
      return { response: { status: 500, time: 900 } } as never;
    });
    await runLoadTest(
      {
        id: 'r',
        name: 'r',
        url: 'https://x.test',
        method: 'GET',
        auth: { type: 'none' },
      } as HttpRequest,
      { iterations: 12, concurrency: 1 },
      vi.fn(),
      new AbortController().signal
    );
    const entry = addEntry.mock.calls[0]?.[0] as { body: string };
    const summary = JSON.parse(entry.body) as { latencyMs: Record<string, number> };
    expect(summary.latencyMs).toEqual({ min: 1, p50: 5, p95: 10, max: 10 });
  });
});
