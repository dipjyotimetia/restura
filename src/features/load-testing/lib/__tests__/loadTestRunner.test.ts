import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveInheritedAuthFor } from '@/features/auth/lib/resolveInheritedAuthFor';
import { executeRequest } from '@/features/http/lib/requestExecutor';
import type { AuthConfig, HttpRequest } from '@/types';
import { runLoadTest } from '../loadTestRunner';

// The runner reuses the real send path + several stores. We only care about its
// orchestration (concurrency, abort, outcome classification, single summary),
// so stub the dependencies down to controllable shapes.
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
// Folder/collection auth inheritance reads the collection store; stub it so the
// runner's inheritance application is controllable (default: nothing inherited).
vi.mock('@/features/auth/lib/resolveInheritedAuthFor', () => ({
  resolveInheritedAuthFor: vi.fn(() => undefined),
}));

const mockExec = vi.mocked(executeRequest);
const mockInherit = vi.mocked(resolveInheritedAuthFor);

function req(): HttpRequest {
  return {
    id: 'r1',
    name: 'Load me',
    url: 'https://x.test/api',
    method: 'GET',
    auth: { type: 'none' },
  } as HttpRequest;
}
function ok(status = 200, time = 5) {
  return { response: { status, time } } as Awaited<ReturnType<typeof executeRequest>>;
}

beforeEach(() => {
  mockExec.mockReset();
  addEntry.mockReset();
  mockInherit.mockReset();
  mockInherit.mockReturnValue(undefined);
  mockExec.mockResolvedValue(ok());
});

describe('runLoadTest', () => {
  it('fires exactly `iterations` requests and reports completion', async () => {
    const onProgress = vi.fn();
    const final = await runLoadTest(
      req(),
      { iterations: 5, concurrency: 2 },
      onProgress,
      new AbortController().signal
    );

    expect(mockExec).toHaveBeenCalledTimes(5);
    expect(final.completed).toBe(5);
    expect(final.total).toBe(5);
    expect(final.done).toBe(true);
    expect(final.samples).toHaveLength(5);
  });

  it('clamps iterations and concurrency up to a minimum of 1', async () => {
    const final = await runLoadTest(
      req(),
      { iterations: 0, concurrency: 0 },
      vi.fn(),
      new AbortController().signal
    );
    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(final.total).toBe(1);
    expect(final.completed).toBe(1);
  });

  it('classifies 2xx/3xx as ok and everything else as not ok', async () => {
    mockExec
      .mockResolvedValueOnce(ok(200))
      .mockResolvedValueOnce(ok(302))
      .mockResolvedValueOnce(ok(404))
      .mockResolvedValueOnce(ok(500));

    const final = await runLoadTest(
      req(),
      { iterations: 4, concurrency: 1 },
      vi.fn(),
      new AbortController().signal
    );
    expect(final.samples.map((s) => s.ok)).toEqual([true, true, false, false]);
  });

  it('records a failed sample when a request throws', async () => {
    mockExec.mockRejectedValue(new Error('network down'));
    const final = await runLoadTest(
      req(),
      { iterations: 3, concurrency: 3 },
      vi.fn(),
      new AbortController().signal
    );

    expect(final.completed).toBe(3);
    expect(final.samples).toEqual([
      { timeMs: 0, status: 0, ok: false },
      { timeMs: 0, status: 0, ok: false },
      { timeMs: 0, status: 0, ok: false },
    ]);
  });

  it('launches nothing when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const final = await runLoadTest(
      req(),
      { iterations: 10, concurrency: 4 },
      vi.fn(),
      controller.signal
    );

    expect(mockExec).not.toHaveBeenCalled();
    expect(final.completed).toBe(0);
    expect(final.done).toBe(true);
  });

  it('emits a terminal done:true progress update', async () => {
    const onProgress = vi.fn();
    await runLoadTest(
      req(),
      { iterations: 2, concurrency: 1 },
      onProgress,
      new AbortController().signal
    );

    const last = onProgress.mock.calls.at(-1)?.[0];
    expect(last.done).toBe(true);
    expect(last.completed).toBe(2);
  });

  it('applies folder/collection auth inheritance to every fired request', async () => {
    // A request with no auth of its own that inherits an ancestor's bearer must
    // fire authenticated — matching a real send. Pre-fix the runner sent the
    // raw request, so inherited auth was silently dropped on every iteration.
    const inheritedBearer: AuthConfig = {
      type: 'bearer',
      bearer: { token: 'inherited-token' },
    } as AuthConfig;
    mockInherit.mockReturnValue({ auth: inheritedBearer } as ReturnType<
      typeof resolveInheritedAuthFor
    >);

    await runLoadTest(
      req(),
      { iterations: 2, concurrency: 1 },
      vi.fn(),
      new AbortController().signal
    );

    expect(mockExec).toHaveBeenCalledTimes(2);
    for (const call of mockExec.mock.calls) {
      expect(call[0].request.auth).toEqual(inheritedBearer);
    }
  });

  it('keeps a request’s own auth over an inherited one', async () => {
    const ownBearer: AuthConfig = { type: 'bearer', bearer: { token: 'own' } } as AuthConfig;
    // Own auth is configured ⇒ resolveInheritedAuthFor returns undefined (no inheritance).
    mockInherit.mockReturnValue(undefined);
    const ownReq = { ...req(), auth: ownBearer };

    await runLoadTest(
      ownReq,
      { iterations: 1, concurrency: 1 },
      vi.fn(),
      new AbortController().signal
    );

    expect(mockExec.mock.calls[0]?.[0].request.auth).toEqual(ownBearer);
  });

  it('pushes exactly one aggregate summary to the console', async () => {
    await runLoadTest(
      req(),
      { iterations: 8, concurrency: 4 },
      vi.fn(),
      new AbortController().signal
    );
    expect(addEntry).toHaveBeenCalledTimes(1);
  });
});
