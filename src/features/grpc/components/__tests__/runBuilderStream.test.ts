/**
 * #917 — the builder's interactive stream send: retries (server streams only),
 * console frames for the stream lifecycle, outbound controls, and the single
 * console entry that carries script output.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamRunControls, StreamRunHooks } from '@/features/registry/types';
import type { RegistryRunResult } from '@/features/registry/useRequestRunner';
import { useConsoleStore } from '@/store/useConsoleStore';
import type { GrpcRequest, GrpcResponse } from '@/types';
import { GrpcStatusCode } from '@/types';
import {
  type BuilderStreamControl,
  type RunBuilderStreamArgs,
  runBuilderStream,
} from '../runBuilderStream';

type RunFn = RunBuilderStreamArgs['run'];

const toast = vi.hoisted(() => ({ info: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

function grpcRequest(overrides: Partial<GrpcRequest> = {}): GrpcRequest {
  return {
    id: 'req-1',
    name: 'Watch',
    type: 'grpc',
    methodType: 'server-streaming',
    url: 'https://grpc.example.com',
    service: 'feed.v1.Feed',
    method: 'Watch',
    metadata: [
      { id: 'm1', key: 'x-tenant', value: 'acme', enabled: true },
      { id: 'm2', key: 'x-off', value: 'no', enabled: false },
      { id: 'm3', key: '', value: 'blank', enabled: true },
    ],
    message: '{"topic":"a"}',
    auth: { type: 'none' },
    ...overrides,
  };
}

function response(status: GrpcStatusCode | undefined, statusText = ''): GrpcResponse {
  return {
    id: `res-${status}`,
    requestId: 'req-1',
    status: status ?? 0,
    statusText,
    headers: {},
    body: '[]',
    size: 2,
    time: 1,
    timestamp: 0,
    ...(status === undefined ? {} : { grpcStatus: status }),
    grpcStatusText: statusText,
    trailers: {},
  } as GrpcResponse;
}

function result(res: GrpcResponse, extra: Partial<RegistryRunResult> = {}): RegistryRunResult {
  return { response: res, durationMs: 1, ...extra };
}

function baseArgs(run: RunFn, request = grpcRequest()) {
  return {
    request,
    protocolOptions: { timeout: 5 },
    run,
    retryMaxAttempts: 1,
    retryDelayMs: 0,
    onMessage: vi.fn(),
    onReset: vi.fn(),
    setStreamControl: vi.fn<(c: BuilderStreamControl | null) => void>(),
  };
}

const systemFrames = () =>
  useConsoleStore
    .getState()
    .frames.filter((f) => f.direction === 'system')
    .map((f) => f.payload);

beforeEach(() => {
  vi.clearAllMocks();
  useConsoleStore.setState({ frames: [], entries: [], captureEnabled: true });
});

describe('runBuilderStream', () => {
  it('wires live messages and outbound controls, then records an OK stream', async () => {
    const controls: StreamRunControls = {
      send: vi.fn(async () => undefined),
      closeSend: vi.fn(),
      cancel: vi.fn(),
    };
    const run = vi.fn<RunFn>(async (_req, _id, options?: { stream?: StreamRunHooks }) => {
      options?.stream?.onOpen?.(controls);
      options?.stream?.onMessage?.({ n: 1 });
      return result(response(GrpcStatusCode.OK, 'OK'), {
        scriptResult: {
          preRequest: {
            success: true,
            logs: [{ type: 'log', message: 'pre', timestamp: 1 }],
            errors: [],
            variables: {},
          },
          test: {
            success: false,
            logs: [],
            errors: [],
            variables: {},
            tests: [
              { name: 'ok', passed: true },
              { name: 'bad', passed: false, error: 'boom' },
            ],
          },
        },
      });
    });
    const args = baseArgs(run, grpcRequest({ methodType: 'bidirectional-streaming' }));

    const res = await runBuilderStream(args);

    expect(res.grpcStatus).toBe(GrpcStatusCode.OK);
    expect(run).toHaveBeenCalledWith(args.request, 'grpc', {
      protocolOptions: { timeout: 5 },
      stream: expect.any(Object),
    });
    expect(args.onMessage).toHaveBeenCalledWith(JSON.stringify({ n: 1 }, null, 2));

    const control = args.setStreamControl.mock.calls[0]?.[0] as BuilderStreamControl;
    control.sendMessage({ q: 2 });
    control.sendMessage('raw text');
    control.endStream();
    control.cancelStream();
    expect(controls.send).toHaveBeenCalledWith({ q: 2 });
    expect(controls.closeSend).toHaveBeenCalled();
    expect(controls.cancel).toHaveBeenCalled();

    const frames = useConsoleStore.getState().frames;
    expect(frames.filter((f) => f.direction === 'out').map((f) => f.payload)).toEqual([
      JSON.stringify({ q: 2 }, null, 2),
      'raw text',
    ]);
    expect(frames.find((f) => f.direction === 'in')?.bytes).toBeGreaterThan(0);
    expect(systemFrames()).toEqual([
      'stream opened — bidirectional-streaming',
      'stream completed — OK',
    ]);
    expect(frames.find((f) => f.direction === 'system')?.bytes).toBeUndefined();
    expect(toast.success).toHaveBeenCalledWith('Stream completed');

    const [entry] = useConsoleStore.getState().entries;
    expect(entry?.request).toMatchObject({
      method: 'feed.v1.Feed/Watch',
      headers: { 'x-tenant': 'acme' },
      body: '{"topic":"a"}',
    });
    expect(entry?.scriptLogs?.map((l) => l.message)).toEqual(['pre']);
    expect(entry?.tests).toEqual([
      { name: 'ok', passed: true },
      { name: 'bad', passed: false, error: 'boom' },
    ]);
  });

  it('retries a failed server stream up to the limit, resetting shown messages', async () => {
    vi.useFakeTimers();
    try {
      const run = vi
        .fn<RunFn>()
        .mockResolvedValueOnce(result(response(GrpcStatusCode.UNAVAILABLE, 'down')))
        .mockResolvedValueOnce(result(response(GrpcStatusCode.UNAVAILABLE, 'down')))
        .mockResolvedValueOnce(result(response(GrpcStatusCode.UNAVAILABLE, '')));
      const args = { ...baseArgs(run), retryMaxAttempts: 3, retryDelayMs: 10 };
      const pending = runBuilderStream(args);
      await vi.runAllTimersAsync();
      const res = await pending;

      expect(run).toHaveBeenCalledTimes(3);
      expect(args.onReset).toHaveBeenCalledTimes(2);
      expect(toast.info).toHaveBeenLastCalledWith('Retrying... (attempt 3/3)');
      expect(res.grpcStatus).toBe(GrpcStatusCode.UNAVAILABLE);
      expect(toast.error).toHaveBeenCalledWith(`gRPC Error: ${GrpcStatusCode.UNAVAILABLE}`, {
        description: 'Stream error',
      });
      expect(systemFrames().at(-1)).toBe(
        `stream closed — ${GrpcStatusCode.UNAVAILABLE} Stream error`
      );
      const [entry] = useConsoleStore.getState().entries;
      expect(entry?.scriptLogs).toBeUndefined();
      expect(entry?.tests).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops retrying once the stream succeeds and never retries a cancel', async () => {
    const run = vi
      .fn<RunFn>()
      .mockResolvedValueOnce(result(response(GrpcStatusCode.INTERNAL, 'x')))
      .mockResolvedValueOnce(result(response(GrpcStatusCode.OK)));
    const res = await runBuilderStream({ ...baseArgs(run), retryMaxAttempts: 5 });
    expect(run).toHaveBeenCalledTimes(2);
    expect(res.grpcStatus).toBe(GrpcStatusCode.OK);

    const cancelled = vi.fn<RunFn>().mockResolvedValue(result(response(GrpcStatusCode.CANCELLED)));
    await runBuilderStream({ ...baseArgs(cancelled), retryMaxAttempts: 5 });
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(systemFrames().at(-1)).toBe('stream cancelled');
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('does not retry client-driven streams and treats a missing status as UNKNOWN', async () => {
    const run = vi.fn<RunFn>().mockResolvedValue(result(response(undefined)));
    const res = await runBuilderStream({
      ...baseArgs(run, grpcRequest({ methodType: 'client-streaming', message: '' })),
      retryMaxAttempts: 4,
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(res.grpcStatus).toBeUndefined();
    expect(systemFrames().at(-1)).toBe(`stream closed — ${GrpcStatusCode.UNKNOWN} Stream error`);
    expect(useConsoleStore.getState().entries[0]?.request.body).toBeUndefined();
  });

  it('records a start failure as a system frame and rethrows', async () => {
    const run = vi
      .fn<RunFn>()
      .mockRejectedValueOnce(new Error('no route'))
      .mockRejectedValueOnce('plain failure');
    await expect(runBuilderStream(baseArgs(run))).rejects.toThrow('no route');
    await expect(runBuilderStream(baseArgs(run))).rejects.toBe('plain failure');
    expect(systemFrames()).toEqual(['stream error — no route', 'stream error — plain failure']);
    expect(useConsoleStore.getState().entries).toEqual([]);
  });
});
