// @vitest-environment node
import './setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockRunConnectStream = vi.hoisted(() => vi.fn());
const mockResolveGrpcDialAddress = vi.hoisted(() => vi.fn());
const mockExecuteConnectUnary = vi.hoisted(() => vi.fn());
const mockExecuteConnectServerStreamCollect = vi.hoisted(() => vi.fn());

vi.mock('../handlers/grpc-connect', () => ({
  executeConnectServerStreamCollect: mockExecuteConnectServerStreamCollect,
  executeConnectUnary: mockExecuteConnectUnary,
  resolveGrpcDialAddress: mockResolveGrpcDialAddress,
  runConnectStream: mockRunConnectStream,
}));

vi.mock('../handlers/grpc-credentials', () => ({
  resolveGrpcExecutionPolicy: (config: unknown) => config,
}));

// Resolve handle ids deterministically so the gRPC auth merge is testable
// without the real OS-keychain-backed store.
vi.mock('../security/secret-handle-store', () => ({
  unwrapSecretValueMain: (v: unknown) =>
    v && typeof v === 'object' && (v as { kind?: string }).kind === 'handle'
      ? 'resolved-secret'
      : typeof v === 'object' && v !== null
        ? (v as { value?: string }).value
        : v,
}));

import { ipcMain } from 'electron';
import { IPC } from '../../shared/channels';
import {
  DEFAULT_SYNC_DEADLINE_MS,
  mergeMainSideAuth,
  registerGrpcHandlerIPC,
  STREAM_IDLE_TIMEOUT_MS,
  stopStreamCleanup,
  sweepIdleStreams,
} from '../handlers/grpc-handler';

type StreamControls = {
  cancel: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
};

type StreamCallbacks = {
  onMessage: (message: unknown) => void;
  onHeaders: (headers: Record<string, string>) => void;
  onTrailers: (trailers: Record<string, string>) => void;
  onClose: (code: number, details: string, statusDetails?: unknown[]) => void;
  onCancelled: () => void;
};

type IpcListener = (event: unknown, ...args: unknown[]) => void;

const mockOn = vi.mocked(ipcMain.on);
const TRUSTED_URL = 'file:///app/dist/web/index.html';
let nextSenderId = 4000;

function listenerFor(channel: string): IpcListener {
  const call = mockOn.mock.calls.find((entry) => entry[0] === channel);
  return call?.[1] as IpcListener;
}

function makeEvent(frameUrl = TRUSTED_URL, senderId?: number) {
  const id = senderId ?? nextSenderId++;
  const destroyedListeners: Array<() => void> = [];
  let destroyed = false;
  const send = vi.fn();
  return {
    senderId: id,
    send,
    event: {
      sender: {
        id,
        isDestroyed: () => destroyed,
        once: (name: string, callback: () => void) => {
          if (name === 'destroyed') destroyedListeners.push(callback);
        },
        send,
      },
      senderFrame: { url: frameUrl, parent: null },
    },
    destroy: () => {
      destroyed = true;
      destroyedListeners.splice(0).forEach((callback) => callback());
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const pinnedDial = {
  host: 'grpc.example.com',
  ip: '203.0.113.10',
  port: 443,
  family: 4 as const,
  authority: 'grpc.example.com:443',
};

const validStream = (id: string) => ({
  id,
  url: 'https://grpc.example.com',
  service: 'echo.EchoService',
  method: 'Chat',
  methodType: 'bidirectional-streaming' as const,
  metadata: {},
  message: {},
  protoContent: 'syntax = "proto3"; service EchoService {}',
});

function makeControls(): StreamControls {
  return {
    cancel: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
  };
}

async function waitForStreamCount(expected: number): Promise<void> {
  await vi.waitFor(() => expect(mockRunConnectStream).toHaveBeenCalledTimes(expected));
}

describe('grpc stream ownership', () => {
  beforeEach(() => {
    mockOn.mockClear();
    mockRunConnectStream.mockReset();
    mockResolveGrpcDialAddress.mockReset();
    mockResolveGrpcDialAddress.mockResolvedValue(pinnedDial);
    mockRunConnectStream.mockImplementation(() => makeControls());
    registerGrpcHandlerIPC();
  });

  afterEach(() => {
    stopStreamCleanup();
    vi.clearAllTimers();
  });

  it('lets two renderers independently use the same stream id and cleans up only one owner', async () => {
    const first = makeEvent();
    const second = makeEvent();
    const firstControls = makeControls();
    const secondControls = makeControls();
    mockRunConnectStream.mockReturnValueOnce(firstControls).mockReturnValueOnce(secondControls);

    listenerFor(IPC.grpc.startStream)(first.event, validStream('shared'));
    await waitForStreamCount(1);
    listenerFor(IPC.grpc.sendMessage)(second.event, 'shared', { text: 'not-owned' });
    listenerFor(IPC.grpc.endStream)(second.event, 'shared');
    listenerFor(IPC.grpc.cancelStream)(second.event, 'shared');
    expect(firstControls.write).not.toHaveBeenCalled();
    expect(firstControls.end).not.toHaveBeenCalled();
    expect(firstControls.cancel).not.toHaveBeenCalled();

    listenerFor(IPC.grpc.startStream)(second.event, validStream('shared'));
    await waitForStreamCount(2);
    listenerFor(IPC.grpc.sendMessage)(first.event, 'shared', { text: 'first' });
    listenerFor(IPC.grpc.sendMessage)(second.event, 'shared', { text: 'second' });
    expect(firstControls.write).toHaveBeenCalledWith({ text: 'first' });
    expect(secondControls.write).toHaveBeenCalledWith({ text: 'second' });

    first.destroy();
    expect(firstControls.cancel).toHaveBeenCalledOnce();
    expect(secondControls.cancel).not.toHaveBeenCalled();
    listenerFor(IPC.grpc.endStream)(second.event, 'shared');
    expect(secondControls.end).toHaveBeenCalledOnce();
  });

  it('buffers only the pending creator messages and half-close while DNS is in flight', async () => {
    const owner = makeEvent();
    const nonOwner = makeEvent();
    const dns = deferred<typeof pinnedDial>();
    const controls = makeControls();
    mockResolveGrpcDialAddress.mockReturnValueOnce(dns.promise);
    mockRunConnectStream.mockReturnValueOnce(controls);

    listenerFor(IPC.grpc.startStream)(owner.event, validStream('pending'));
    listenerFor(IPC.grpc.sendMessage)(owner.event, 'pending', { text: 'owner' });
    listenerFor(IPC.grpc.sendMessage)(nonOwner.event, 'pending', { text: 'intruder' });
    listenerFor(IPC.grpc.endStream)(nonOwner.event, 'pending');
    listenerFor(IPC.grpc.cancelStream)(nonOwner.event, 'pending');
    listenerFor(IPC.grpc.endStream)(owner.event, 'pending');

    dns.resolve(pinnedDial);
    await waitForStreamCount(1);

    expect(controls.write).toHaveBeenCalledTimes(1);
    expect(controls.write).toHaveBeenCalledWith({ text: 'owner' });
    expect(controls.end).toHaveBeenCalledOnce();
    expect(controls.cancel).not.toHaveBeenCalled();
    expect(nonOwner.send).not.toHaveBeenCalled();
  });

  it('does not let controls for an unknown id seed a future owner pending buffer', async () => {
    const attacker = makeEvent();
    const owner = makeEvent();
    const controls = makeControls();
    mockRunConnectStream.mockReturnValueOnce(controls);

    listenerFor(IPC.grpc.cancelStream)(attacker.event, 'future');
    listenerFor(IPC.grpc.sendMessage)(attacker.event, 'future', { text: 'seeded' });
    listenerFor(IPC.grpc.endStream)(attacker.event, 'future');
    listenerFor(IPC.grpc.startStream)(owner.event, validStream('future'));
    await waitForStreamCount(1);

    expect(controls.write).not.toHaveBeenCalled();
    expect(controls.end).not.toHaveBeenCalled();
    expect(controls.cancel).not.toHaveBeenCalled();
    expect(attacker.send).not.toHaveBeenCalled();
  });

  it('reserves the same pending stream id independently for each renderer', async () => {
    const first = makeEvent();
    const second = makeEvent();
    const firstDns = deferred<typeof pinnedDial>();
    mockResolveGrpcDialAddress.mockReturnValueOnce(firstDns.promise);

    listenerFor(IPC.grpc.startStream)(first.event, validStream('reserved'));
    listenerFor(IPC.grpc.startStream)(second.event, validStream('reserved'));

    expect(mockResolveGrpcDialAddress).toHaveBeenCalledTimes(2);
    await waitForStreamCount(1);

    firstDns.resolve(pinnedDial);
    await waitForStreamCount(2);
    expect(first.send).not.toHaveBeenCalled();
    expect(second.send).not.toHaveBeenCalled();
  });

  it('releases a destroyed pending owner and rejects its late stream setup', async () => {
    const first = makeEvent();
    const successor = makeEvent();
    const firstDns = deferred<typeof pinnedDial>();
    const successorControls = makeControls();
    mockResolveGrpcDialAddress
      .mockReturnValueOnce(firstDns.promise)
      .mockResolvedValueOnce(pinnedDial);
    mockRunConnectStream.mockReturnValueOnce(successorControls);

    listenerFor(IPC.grpc.startStream)(first.event, validStream('released'));
    first.destroy();
    listenerFor(IPC.grpc.startStream)(successor.event, validStream('released'));
    await waitForStreamCount(1);

    firstDns.resolve(pinnedDial);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockRunConnectStream).toHaveBeenCalledTimes(1);
    expect(successorControls.cancel).not.toHaveBeenCalled();
  });

  it('cancels an active stream when its owner renderer is destroyed', async () => {
    const owner = makeEvent();
    const controls = makeControls();
    mockRunConnectStream.mockReturnValueOnce(controls);

    listenerFor(IPC.grpc.startStream)(owner.event, validStream('lifecycle'));
    await waitForStreamCount(1);
    owner.destroy();

    expect(controls.cancel).toHaveBeenCalledOnce();
  });

  it('forwards decoded status details on the stream error event (#883)', async () => {
    const owner = makeEvent();
    let callbacks: StreamCallbacks | undefined;
    mockRunConnectStream.mockImplementation((_args: unknown, cb: StreamCallbacks) => {
      callbacks = cb;
      return makeControls();
    });
    listenerFor(IPC.grpc.startStream)(owner.event, validStream('details'));
    await waitForStreamCount(1);
    const statusDetails = [{ type: 'google.rpc.ErrorInfo', value: { reason: 'QUOTA' } }];
    callbacks?.onClose(3, 'bad', statusDetails);
    expect(owner.send).toHaveBeenCalledWith(
      'grpc:error:details',
      expect.objectContaining({ status: 3, statusDetails })
    );
  });

  it.each([
    ['onCancelled', (callbacks: StreamCallbacks) => callbacks.onCancelled()],
    ['onClose', (callbacks: StreamCallbacks) => callbacks.onClose(0, 'OK')],
    [
      'oversized onMessage',
      (callbacks: StreamCallbacks) =>
        callbacks.onMessage({ payload: 'x'.repeat(10 * 1024 * 1024) }),
    ],
  ])(
    'ignores stale %s callbacks after a successor reuses the stream id',
    async (_label, fireStaleCallback) => {
      const first = makeEvent();
      const successor = makeEvent();
      const firstControls = makeControls();
      const successorControls = makeControls();
      const callbackSets: StreamCallbacks[] = [];
      mockRunConnectStream.mockImplementation((_args: unknown, callbacks: StreamCallbacks) => {
        callbackSets.push(callbacks);
        return callbackSets.length === 1 ? firstControls : successorControls;
      });

      listenerFor(IPC.grpc.startStream)(first.event, validStream('reused'));
      await waitForStreamCount(1);
      listenerFor(IPC.grpc.cancelStream)(first.event, 'reused');

      listenerFor(IPC.grpc.startStream)(successor.event, validStream('reused'));
      await waitForStreamCount(2);
      first.send.mockClear();

      fireStaleCallback(callbackSets[0]!);

      expect(first.send).not.toHaveBeenCalled();
      expect(successorControls.cancel).not.toHaveBeenCalled();

      listenerFor(IPC.grpc.sendMessage)(successor.event, 'reused', {
        text: 'still-current',
      });
      listenerFor(IPC.grpc.endStream)(successor.event, 'reused');
      expect(successorControls.write).toHaveBeenCalledWith({
        text: 'still-current',
      });
      expect(successorControls.end).toHaveBeenCalledOnce();
    }
  );

  it('retains trusted-sender validation on fire-and-forget stream controls', async () => {
    const owner = makeEvent();
    const untrusted = makeEvent('https://attacker.example/', owner.senderId);
    const streamControls = makeControls();
    mockRunConnectStream.mockReturnValueOnce(streamControls);
    listenerFor(IPC.grpc.startStream)(owner.event, validStream('trusted-boundary'));
    await waitForStreamCount(1);

    const controls = [
      [IPC.grpc.sendMessage, ['trusted-boundary', { value: 1 }]],
      [IPC.grpc.endStream, ['trusted-boundary']],
      [IPC.grpc.cancelStream, ['trusted-boundary']],
    ] as const;

    for (const [channel, args] of controls) {
      listenerFor(channel)(untrusted.event, ...args);
    }

    expect(streamControls.write).not.toHaveBeenCalled();
    expect(streamControls.end).not.toHaveBeenCalled();
    expect(streamControls.cancel).not.toHaveBeenCalled();
    expect(untrusted.send).not.toHaveBeenCalled();
  });
});

describe('mergeMainSideAuth (SecretRef handle resolution)', () => {
  it('returns metadata unchanged when no auth descriptor is present', () => {
    const md = { traceparent: 'x' };
    expect(mergeMainSideAuth(md, undefined)).toBe(md);
  });

  it('resolves a bearer handle main-side and adds a lowercase authorization metadata key', () => {
    const merged = mergeMainSideAuth({ traceparent: 'x' }, {
      type: 'bearer',
      bearer: { token: { kind: 'handle', id: 'h-1' } },
    } as never);
    expect(merged['authorization']).toBe('Bearer resolved-secret');
    expect(merged['traceparent']).toBe('x');
  });

  it('resolves an api-key handle into its (lowercased) header key', () => {
    const merged = mergeMainSideAuth({}, {
      type: 'api-key',
      apiKey: { key: 'X-API-Key', value: { kind: 'handle', id: 'h-2' }, in: 'header' },
    } as never);
    expect(merged['x-api-key']).toBe('resolved-secret');
  });

  it('does not mutate the input metadata object', () => {
    const original = { traceparent: 'x' };
    const merged = mergeMainSideAuth(original, {
      type: 'bearer',
      bearer: { token: { kind: 'handle', id: 'h-3' } },
    } as never);
    expect(original['traceparent' as keyof typeof original]).toBe('x');
    expect(Object.keys(original)).toEqual(['traceparent']);
    expect(merged).not.toBe(original);
  });
});

// GRPC-3 (#879): long-lived streams — idle (not age) sweep, a terminal event on
// every termination path, and opt-in "no deadline" for streaming only.
describe('grpc stream lifetime', () => {
  let callbacks: StreamCallbacks[];
  let controls: StreamControls[];

  beforeEach(() => {
    mockOn.mockClear();
    mockRunConnectStream.mockReset();
    mockResolveGrpcDialAddress.mockReset();
    mockResolveGrpcDialAddress.mockResolvedValue(pinnedDial);
    callbacks = [];
    controls = [];
    mockRunConnectStream.mockImplementation((_args: unknown, cb: StreamCallbacks) => {
      callbacks.push(cb);
      const c = makeControls();
      controls.push(c);
      return c;
    });
    registerGrpcHandlerIPC();
  });

  afterEach(() => {
    stopStreamCleanup();
    vi.restoreAllMocks();
  });

  const errorEvents = (send: ReturnType<typeof vi.fn>, id: string) =>
    send.mock.calls.filter(([channel]) => channel === `grpc:error:${id}`).map(([, p]) => p);

  it('does not sweep a stream that stays active past the old 5-minute age limit', async () => {
    const owner = makeEvent();
    const t0 = Date.now();
    listenerFor(IPC.grpc.startStream)(owner.event, validStream('active'));
    await waitForStreamCount(1);

    // Traffic keeps arriving well past 5 minutes of age.
    vi.spyOn(Date, 'now').mockReturnValue(t0 + STREAM_IDLE_TIMEOUT_MS - 1000);
    callbacks[0]!.onMessage({ tick: 1 });
    sweepIdleStreams(t0 + STREAM_IDLE_TIMEOUT_MS + 60_000);

    expect(controls[0]!.cancel).not.toHaveBeenCalled();
    expect(errorEvents(owner.send, 'active')).toEqual([]);
    // Still registered: outbound writes reach the call.
    listenerFor(IPC.grpc.sendMessage)(owner.event, 'active', { text: 'still-open' });
    expect(controls[0]!.write).toHaveBeenCalledWith({ text: 'still-open' });
  });

  it('counts outbound writes as activity', async () => {
    const owner = makeEvent();
    const t0 = Date.now();
    listenerFor(IPC.grpc.startStream)(owner.event, validStream('outbound'));
    await waitForStreamCount(1);

    vi.spyOn(Date, 'now').mockReturnValue(t0 + STREAM_IDLE_TIMEOUT_MS - 1000);
    listenerFor(IPC.grpc.sendMessage)(owner.event, 'outbound', { text: 'ping' });
    sweepIdleStreams(t0 + STREAM_IDLE_TIMEOUT_MS + 60_000);

    expect(controls[0]!.cancel).not.toHaveBeenCalled();
  });

  it('sweeps an idle stream and emits a final CANCELLED event so the UI settles', async () => {
    const owner = makeEvent();
    const t0 = Date.now();
    listenerFor(IPC.grpc.startStream)(owner.event, validStream('idle'));
    await waitForStreamCount(1);
    callbacks[0]!.onHeaders({ 'x-server': 'a' });

    sweepIdleStreams(t0 + STREAM_IDLE_TIMEOUT_MS + 60_000);

    expect(controls[0]!.cancel).toHaveBeenCalledOnce();
    const errors = errorEvents(owner.send, 'idle');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      status: 1,
      details: expect.stringMatching(/idle/i),
      headers: { 'x-server': 'a' },
    });

    // The late onCancelled from the aborted call does not emit a second event.
    callbacks[0]!.onCancelled();
    expect(errorEvents(owner.send, 'idle')).toHaveLength(1);
    // And the stream is gone.
    listenerFor(IPC.grpc.sendMessage)(owner.event, 'idle', { text: 'late' });
    expect(controls[0]!.write).not.toHaveBeenCalled();
  });

  it('emits a final CANCELLED event on an explicit cancel', async () => {
    const owner = makeEvent();
    listenerFor(IPC.grpc.startStream)(owner.event, validStream('cancel-me'));
    await waitForStreamCount(1);

    listenerFor(IPC.grpc.cancelStream)(owner.event, 'cancel-me');

    expect(controls[0]!.cancel).toHaveBeenCalledOnce();
    expect(errorEvents(owner.send, 'cancel-me')).toEqual([expect.objectContaining({ status: 1 })]);
  });

  it('emits a final CANCELLED event when the call aborts on its own', async () => {
    const owner = makeEvent();
    listenerFor(IPC.grpc.startStream)(owner.event, validStream('aborted'));
    await waitForStreamCount(1);

    callbacks[0]!.onCancelled();

    expect(errorEvents(owner.send, 'aborted')).toEqual([expect.objectContaining({ status: 1 })]);
  });

  it('caps each live message, not the stream total, so long streams are not cut at 10 MB', async () => {
    const owner = makeEvent();
    listenerFor(IPC.grpc.startStream)(owner.event, validStream('long'));
    await waitForStreamCount(1);

    const chunk = { payload: 'x'.repeat(1024 * 1024) };
    for (let i = 0; i < 12; i++) callbacks[0]!.onMessage(chunk);
    expect(controls[0]!.cancel).not.toHaveBeenCalled();
    expect(errorEvents(owner.send, 'long')).toEqual([]);

    // A single message over the cap still ends the stream with RESOURCE_EXHAUSTED.
    callbacks[0]!.onMessage({ payload: 'x'.repeat(10 * 1024 * 1024 + 1) });
    expect(controls[0]!.cancel).toHaveBeenCalledOnce();
    expect(errorEvents(owner.send, 'long')).toEqual([expect.objectContaining({ status: 8 })]);
  });

  it('forwards "no deadline" (timeoutMs 0) for a stream without a deadline', async () => {
    const owner = makeEvent();
    listenerFor(IPC.grpc.startStream)(owner.event, { ...validStream('forever'), timeoutMs: 0 });
    await waitForStreamCount(1);
    const args = mockRunConnectStream.mock.calls[0]![0] as { timeoutMs?: number };
    expect(args.timeoutMs ?? 0).toBe(0);
  });
});

describe('grpc:request deadlines', () => {
  type Handler = (event: unknown, config: unknown) => Promise<unknown>;
  const mockHandle = vi.mocked(ipcMain.handle);

  beforeEach(() => {
    mockHandle.mockClear();
    mockExecuteConnectUnary.mockReset();
    mockExecuteConnectServerStreamCollect.mockReset();
    mockResolveGrpcDialAddress.mockReset();
    mockResolveGrpcDialAddress.mockResolvedValue(pinnedDial);
    mockExecuteConnectUnary.mockResolvedValue({
      status: 0,
      statusText: 'OK',
      headers: {},
      trailers: {},
    });
    mockExecuteConnectServerStreamCollect.mockResolvedValue({
      status: 0,
      statusText: 'OK',
      headers: {},
      trailers: {},
      messages: [],
    });
    registerGrpcHandlerIPC();
  });

  afterEach(() => stopStreamCleanup());

  const invoke = (config: unknown) => {
    const call = mockHandle.mock.calls.find(([channel]) => channel === IPC.grpc.request);
    return (call?.[1] as Handler)(makeEvent().event, config);
  };

  it('applies the default deadline to a unary call that omits one', async () => {
    await invoke({ ...validStream('u1'), methodType: 'unary' });
    const args = mockExecuteConnectUnary.mock.calls[0]![0] as { timeoutMs?: number };
    expect(args.timeoutMs).toBe(DEFAULT_SYNC_DEADLINE_MS);
  });

  it('keeps an explicit unary deadline', async () => {
    await invoke({ ...validStream('u2'), methodType: 'unary', timeoutMs: 5000 });
    const args = mockExecuteConnectUnary.mock.calls[0]![0] as { timeoutMs?: number };
    expect(args.timeoutMs).toBe(5000);
  });

  it('never runs a buffered server-stream collect without a deadline', async () => {
    await invoke({ ...validStream('s1'), methodType: 'server-streaming', timeoutMs: 0 });
    const args = mockExecuteConnectServerStreamCollect.mock.calls[0]![0] as {
      timeoutMs?: number;
    };
    expect(args.timeoutMs).toBe(DEFAULT_SYNC_DEADLINE_MS);
  });
});
