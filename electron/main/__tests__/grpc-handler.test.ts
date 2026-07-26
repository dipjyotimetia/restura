// @vitest-environment node
import './setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockRunConnectStream = vi.hoisted(() => vi.fn());
const mockResolveGrpcDialAddress = vi.hoisted(() => vi.fn());

vi.mock('../handlers/grpc-connect', () => ({
  executeConnectServerStreamCollect: vi.fn(),
  executeConnectUnary: vi.fn(),
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
  mergeMainSideAuth,
  registerGrpcHandlerIPC,
  stopStreamCleanup,
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
  onClose: (code: number, details: string) => void;
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

  it.each([
    ['onCancelled', (callbacks: StreamCallbacks) => callbacks.onCancelled()],
    ['onClose', (callbacks: StreamCallbacks) => callbacks.onClose(0, 'OK')],
    [
      'oversized onMessage',
      (callbacks: StreamCallbacks) =>
        callbacks.onMessage({ payload: 'x'.repeat(10 * 1024 * 1024) }),
    ],
  ])('ignores stale %s callbacks after a successor reuses the stream id', async (_label, fireStaleCallback) => {
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
  });

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
