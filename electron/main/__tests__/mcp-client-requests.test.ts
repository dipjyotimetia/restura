import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as IpcUtils from '../ipc/ipc-utils';

const mockHandle = vi.hoisted(() => vi.fn());
const mockEmitTo = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  ipcMain: { handle: mockHandle, removeHandler: vi.fn() },
}));
vi.mock('../ipc/ipc-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof IpcUtils>();
  return { ...actual, emitTo: mockEmitTo };
});

import {
  MAX_PENDING_CLIENT_REQUESTS,
  MCP_CLIENT_REQUEST_ERRORS,
  McpClientRequestBridge,
  type McpClientRequestEvent,
  pendingMcpClientRequestCount,
  registerMcpClientRequestIPC,
  resolveMcpClientResponse,
  setMcpRoots,
  stopMcpClientRequests,
} from '../handlers/mcp-client-requests';

type IpcHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

const ELICIT_PARAMS = {
  mode: 'form',
  message: 'Deploy?',
  requestedSchema: {
    type: 'object',
    properties: { confirm: { type: 'boolean' }, note: { type: 'string', maxLength: 3 } },
    required: ['confirm'],
  },
};

const SAMPLING_PARAMS = {
  messages: [{ role: 'user', content: { type: 'text', text: 'Summarise' } }],
  maxTokens: 64,
};

function lastRequestEvent(): McpClientRequestEvent {
  const call = mockEmitTo.mock.calls.filter((c) => String(c[1]).startsWith('mcp:client-request:'));
  const last = call.at(-1);
  if (!last) throw new Error('no client request emitted');
  return last[2] as McpClientRequestEvent;
}

function cancelledEvents() {
  return mockEmitTo.mock.calls
    .filter((c) => String(c[1]).startsWith('mcp:client-request-cancelled:'))
    .map((c) => ({ webContentsId: c[0], channel: c[1], payload: c[2] }));
}

function trustedEvent(senderId: number) {
  const listeners: Array<() => void> = [];
  return {
    event: {
      sender: {
        id: senderId,
        isDestroyed: () => false,
        once: (name: string, listener: () => void) => {
          if (name === 'destroyed') listeners.push(listener);
        },
      },
      senderFrame: { url: 'file:///app/dist/web/index.html' },
    },
    destroy: () => {
      for (const listener of listeners.splice(0)) listener();
    },
  };
}

function handlerFor(channel: string): IpcHandler {
  const call = mockHandle.mock.calls.find((c) => c[0] === channel);
  if (!call) throw new Error(`No handler registered for ${channel}`);
  return call[1] as IpcHandler;
}

beforeEach(() => {
  mockEmitTo.mockClear();
  mockHandle.mockClear();
});

afterEach(() => {
  stopMcpClientRequests();
  vi.useRealTimers();
});

describe('McpClientRequestBridge — elicitation', () => {
  it('forwards to the owning renderer and resolves an accepted, schema-valid answer', async () => {
    const bridge = new McpClientRequestBridge('conn-1', 7);
    const pending = bridge.elicit(ELICIT_PARAMS, new AbortController().signal);

    const event = lastRequestEvent();
    expect(mockEmitTo).toHaveBeenCalledWith(7, 'mcp:client-request:conn-1', {
      requestId: event.requestId,
      kind: 'elicitation',
      params: ELICIT_PARAMS,
    });

    expect(
      resolveMcpClientResponse(
        {
          kind: 'elicitation',
          connectionId: 'conn-1',
          requestId: event.requestId,
          response: { action: 'accept', content: { confirm: true } },
        },
        7
      )
    ).toEqual({ success: true });
    await expect(pending).resolves.toEqual({ action: 'accept', content: { confirm: true } });
    expect(pendingMcpClientRequestCount()).toBe(0);
  });

  it('keeps the request pending when accepted content violates the requested schema', async () => {
    const bridge = new McpClientRequestBridge('conn-1', 7);
    const pending = bridge.elicit(ELICIT_PARAMS, new AbortController().signal);
    const { requestId } = lastRequestEvent();

    const invalid = resolveMcpClientResponse(
      {
        kind: 'elicitation',
        connectionId: 'conn-1',
        requestId,
        response: { action: 'accept', content: { note: 'too long' } },
      },
      7
    );
    expect(invalid).toMatchObject({
      success: false,
      fieldErrors: { confirm: 'Required.', note: expect.stringContaining('at most') },
    });
    expect(pendingMcpClientRequestCount()).toBe(1);

    resolveMcpClientResponse(
      {
        kind: 'elicitation',
        connectionId: 'conn-1',
        requestId,
        response: { action: 'accept', content: { confirm: false, note: 'ok' } },
      },
      7
    );
    await expect(pending).resolves.toEqual({
      action: 'accept',
      content: { confirm: false, note: 'ok' },
    });
  });

  it.each(['decline', 'cancel'] as const)('answers %s per spec without content', async (action) => {
    const bridge = new McpClientRequestBridge('conn-1', 7);
    const pending = bridge.elicit(ELICIT_PARAMS, new AbortController().signal);
    const { requestId } = lastRequestEvent();
    expect(
      resolveMcpClientResponse(
        { kind: 'elicitation', connectionId: 'conn-1', requestId, response: { action } },
        7
      )
    ).toEqual({ success: true });
    await expect(pending).resolves.toEqual({ action });
  });
});

describe('McpClientRequestBridge — sampling', () => {
  it('only produces a CreateMessageResult from an explicit approval', async () => {
    const bridge = new McpClientRequestBridge('conn-1', 7);
    const pending = bridge.createMessage(SAMPLING_PARAMS, new AbortController().signal);
    const { requestId, kind } = lastRequestEvent();
    expect(kind).toBe('sampling');

    resolveMcpClientResponse(
      {
        kind: 'sampling',
        connectionId: 'conn-1',
        requestId,
        response: { action: 'approve', text: 'Summary.', model: 'manual' },
      },
      7
    );
    await expect(pending).resolves.toEqual({
      role: 'assistant',
      content: { type: 'text', text: 'Summary.' },
      model: 'manual',
      stopReason: 'endTurn',
    });
  });

  it('rejects with the user-rejected JSON-RPC code when the user declines', async () => {
    const bridge = new McpClientRequestBridge('conn-1', 7);
    const pending = bridge.createMessage(SAMPLING_PARAMS, new AbortController().signal);
    const { requestId } = lastRequestEvent();
    resolveMcpClientResponse(
      { kind: 'sampling', connectionId: 'conn-1', requestId, response: { action: 'reject' } },
      7
    );
    await expect(pending).rejects.toMatchObject({
      code: MCP_CLIENT_REQUEST_ERRORS.userRejected,
      message: 'User rejected sampling request',
    });
  });
});

describe('McpClientRequestBridge — lifecycle', () => {
  it('times out an unanswered prompt and tells the renderer to drop it', async () => {
    vi.useFakeTimers();
    const bridge = new McpClientRequestBridge('conn-1', 7, { timeoutMs: 1_000 });
    const pending = bridge.elicit(ELICIT_PARAMS, new AbortController().signal);
    const assertion = expect(pending).rejects.toMatchObject({
      code: MCP_CLIENT_REQUEST_ERRORS.timeout,
    });
    const { requestId } = lastRequestEvent();

    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    expect(cancelledEvents()).toEqual([
      {
        webContentsId: 7,
        channel: 'mcp:client-request-cancelled:conn-1',
        payload: { requestId, reason: 'timeout' },
      },
    ]);
    // A late answer after the timeout is indistinguishable from an unknown id.
    expect(
      resolveMcpClientResponse(
        { kind: 'elicitation', connectionId: 'conn-1', requestId, response: { action: 'cancel' } },
        7
      )
    ).toEqual({ success: false, error: 'Unknown client request' });
  });

  it('settles when the server cancels the request (SDK abort signal)', async () => {
    const bridge = new McpClientRequestBridge('conn-1', 7);
    const controller = new AbortController();
    const pending = bridge.createMessage(SAMPLING_PARAMS, controller.signal);
    const { requestId } = lastRequestEvent();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ message: 'Request cancelled' });
    expect(cancelledEvents().at(-1)?.payload).toEqual({ requestId, reason: 'cancelled' });
    expect(pendingMcpClientRequestCount()).toBe(0);
  });

  it('rejects an already-aborted request without prompting', async () => {
    const bridge = new McpClientRequestBridge('conn-1', 7);
    const controller = new AbortController();
    controller.abort();
    await expect(bridge.elicit(ELICIT_PARAMS, controller.signal)).rejects.toMatchObject({
      message: 'Request cancelled',
    });
    expect(mockEmitTo).not.toHaveBeenCalled();
  });

  it('rejects every pending request when the connection is disposed', async () => {
    const bridge = new McpClientRequestBridge('conn-1', 7);
    const first = bridge.elicit(ELICIT_PARAMS, new AbortController().signal);
    const second = bridge.createMessage(SAMPLING_PARAMS, new AbortController().signal);
    const other = new McpClientRequestBridge('conn-2', 7);
    const unrelated = other.elicit(ELICIT_PARAMS, new AbortController().signal);

    bridge.dispose();
    await expect(first).rejects.toMatchObject({ message: 'MCP connection closed' });
    await expect(second).rejects.toMatchObject({ message: 'MCP connection closed' });
    expect(cancelledEvents().map((e) => e.payload.reason)).toEqual(['closed', 'closed']);
    expect(pendingMcpClientRequestCount()).toBe(1);
    expect(bridge.isDisposed).toBe(true);
    bridge.dispose(); // idempotent

    await expect(bridge.elicit(ELICIT_PARAMS, new AbortController().signal)).rejects.toMatchObject({
      message: 'MCP connection closed',
    });
    other.dispose();
    await expect(unrelated).rejects.toBeDefined();
  });

  it('caps the number of prompts a server can park on one connection', async () => {
    const bridge = new McpClientRequestBridge('conn-1', 7);
    const parked = Array.from({ length: MAX_PENDING_CLIENT_REQUESTS }, () =>
      bridge.elicit(ELICIT_PARAMS, new AbortController().signal).catch(() => undefined)
    );
    await expect(bridge.elicit(ELICIT_PARAMS, new AbortController().signal)).rejects.toMatchObject({
      message: expect.stringContaining('Too many pending'),
    });
    bridge.dispose();
    await Promise.all(parked);
  });

  it('stopMcpClientRequests rejects everything', async () => {
    const bridge = new McpClientRequestBridge('conn-1', 7);
    const pending = bridge.elicit(ELICIT_PARAMS, new AbortController().signal);
    stopMcpClientRequests();
    await expect(pending).rejects.toMatchObject({ message: 'MCP connection closed' });
    expect(pendingMcpClientRequestCount()).toBe(0);
  });
});

describe('owner scoping', () => {
  it('ignores answers from another renderer, connection, or request kind', async () => {
    const bridge = new McpClientRequestBridge('conn-1', 7);
    const pending = bridge.elicit(ELICIT_PARAMS, new AbortController().signal);
    const { requestId } = lastRequestEvent();
    const unknown = { success: false, error: 'Unknown client request' };

    expect(
      resolveMcpClientResponse(
        { kind: 'elicitation', connectionId: 'conn-1', requestId, response: { action: 'decline' } },
        8
      )
    ).toEqual(unknown);
    expect(
      resolveMcpClientResponse(
        { kind: 'elicitation', connectionId: 'conn-2', requestId, response: { action: 'decline' } },
        7
      )
    ).toEqual(unknown);
    expect(
      resolveMcpClientResponse(
        { kind: 'sampling', connectionId: 'conn-1', requestId, response: { action: 'reject' } },
        7
      )
    ).toEqual(unknown);
    expect(pendingMcpClientRequestCount()).toBe(1);

    resolveMcpClientResponse(
      { kind: 'elicitation', connectionId: 'conn-1', requestId, response: { action: 'decline' } },
      7
    );
    await expect(pending).resolves.toEqual({ action: 'decline' });
  });
});

describe('roots', () => {
  it('stores roots per owner + connection and notifies live sessions', async () => {
    const bridge = new McpClientRequestBridge('conn-1', 7);
    const client = { sendRootsListChanged: vi.fn(async () => undefined) };
    bridge.attachClient(client);
    expect(bridge.listRoots()).toEqual({ roots: [] });

    const roots = [{ uri: 'file:///work/repo', name: 'repo' }];
    await expect(setMcpRoots('conn-1', roots, { id: 7 })).resolves.toEqual({
      success: true,
      notified: 1,
    });
    expect(client.sendRootsListChanged).toHaveBeenCalledTimes(1);
    expect(bridge.listRoots()).toEqual({ roots });

    // Another renderer using the same external id never sees or changes these roots.
    const foreign = new McpClientRequestBridge('conn-1', 8);
    expect(foreign.listRoots()).toEqual({ roots: [] });
    await setMcpRoots('conn-1', [{ uri: 'file:///other' }], { id: 8 });
    expect(bridge.listRoots()).toEqual({ roots });
    expect(client.sendRootsListChanged).toHaveBeenCalledTimes(1);
  });

  it('stores roots before connect and stops notifying a disposed session', async () => {
    await setMcpRoots('conn-3', [{ uri: 'file:///pre' }], { id: 9 });
    const bridge = new McpClientRequestBridge('conn-3', 9);
    expect(bridge.listRoots()).toEqual({ roots: [{ uri: 'file:///pre' }] });

    const client = { sendRootsListChanged: vi.fn(async () => undefined) };
    bridge.attachClient(client);
    bridge.dispose();
    await expect(setMcpRoots('conn-3', [], { id: 9 })).resolves.toEqual({
      success: true,
      notified: 0,
    });
    expect(client.sendRootsListChanged).not.toHaveBeenCalled();
  });

  it('treats a failed list_changed notification as best-effort', async () => {
    const bridge = new McpClientRequestBridge('conn-4', 9);
    bridge.attachClient({
      sendRootsListChanged: vi.fn(async () => {
        throw new Error('closed');
      }),
    });
    await expect(setMcpRoots('conn-4', [], { id: 9 })).resolves.toEqual({
      success: true,
      notified: 0,
    });
  });
});

describe('IPC registration', () => {
  it('validates client responses and set-roots input, owner-scoped by sender', async () => {
    registerMcpClientRequestIPC();
    const respond = handlerFor('mcp:client-response');
    const setRoots = handlerFor('mcp:set-roots');
    const renderer = trustedEvent(11);

    await expect(
      setRoots(renderer.event, { connectionId: 'conn-5', roots: [{ uri: 'https://x' }] })
    ).rejects.toThrow(/file:\/\//);
    await expect(
      setRoots(renderer.event, { connectionId: 'conn-5', roots: [{ uri: 'file:///ok' }] })
    ).resolves.toEqual({ success: true, notified: 0 });

    const bridge = new McpClientRequestBridge('conn-5', 11);
    expect(bridge.listRoots()).toEqual({ roots: [{ uri: 'file:///ok' }] });
    const pending = bridge.elicit(ELICIT_PARAMS, new AbortController().signal);
    const { requestId } = lastRequestEvent();

    await expect(
      respond(renderer.event, {
        kind: 'elicitation',
        connectionId: 'conn-5',
        requestId: 'not-a-uuid',
        response: { action: 'cancel' },
      })
    ).rejects.toThrow();
    await expect(
      respond(trustedEvent(12).event, {
        kind: 'elicitation',
        connectionId: 'conn-5',
        requestId,
        response: { action: 'cancel' },
      })
    ).resolves.toEqual({ success: false, error: 'Unknown client request' });
    await expect(
      respond(renderer.event, {
        kind: 'elicitation',
        connectionId: 'conn-5',
        requestId,
        response: { action: 'cancel' },
      })
    ).resolves.toEqual({ success: true });
    await expect(pending).resolves.toEqual({ action: 'cancel' });

    // Renderer destruction forgets its stored roots.
    renderer.destroy();
    expect(new McpClientRequestBridge('conn-5', 11).listRoots()).toEqual({ roots: [] });
  });
});
