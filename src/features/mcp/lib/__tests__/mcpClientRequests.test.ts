import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMcpClientRequestStore } from '@/features/mcp/store/useMcpClientRequestStore';
import {
  isValidRootUri,
  pushMcpRoots,
  respondToElicitation,
  respondToSampling,
  subscribeMcpClientRequests,
} from '../mcpClientRequests';

type Listener = (...args: unknown[]) => void;

const listeners = new Map<string, Set<Listener>>();
const mcp = {
  on: vi.fn((channel: string, cb: Listener) => {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel)?.add(cb);
  }),
  removeListener: vi.fn((channel: string, cb: Listener) => listeners.get(channel)?.delete(cb)),
  respondClientRequest: vi.fn(),
  setRoots: vi.fn(),
};

function emit(channel: string, payload: unknown) {
  for (const cb of listeners.get(channel) ?? []) cb(payload);
}

const REQUEST_ID = '9b2f8a3e-4c1d-4e5f-8a9b-0c1d2e3f4a5b';

beforeEach(() => {
  listeners.clear();
  vi.clearAllMocks();
  useMcpClientRequestStore.setState({ requests: [] });
  mcp.respondClientRequest.mockResolvedValue({ success: true });
  (window as unknown as { electron: unknown }).electron = { isElectron: true, mcp };
});

afterEach(() => {
  delete (window as unknown as { electron?: unknown }).electron;
});

describe('subscribeMcpClientRequests', () => {
  it('queues requests and drops them when main withdraws them', () => {
    const unsubscribe = subscribeMcpClientRequests('conn-1');
    emit('mcp:client-request:conn-1', {
      requestId: REQUEST_ID,
      kind: 'elicitation',
      params: { message: 'hi' },
    });
    // Malformed payloads are ignored.
    emit('mcp:client-request:conn-1', { requestId: 1, kind: 'elicitation' });
    emit('mcp:client-request:conn-1', { requestId: 'x', kind: 'other' });
    expect(useMcpClientRequestStore.getState().requests).toEqual([
      expect.objectContaining({
        requestId: REQUEST_ID,
        connectionId: 'conn-1',
        kind: 'elicitation',
        params: { message: 'hi' },
      }),
    ]);

    emit('mcp:client-request-cancelled:conn-1', { requestId: REQUEST_ID, reason: 'timeout' });
    expect(useMcpClientRequestStore.getState().requests).toEqual([]);
    unsubscribe();
  });

  it('removes both listeners and clears the queue on unsubscribe (no leak)', () => {
    const unsubscribe = subscribeMcpClientRequests('conn-1');
    emit('mcp:client-request:conn-1', { requestId: REQUEST_ID, kind: 'sampling', params: {} });
    unsubscribe();
    // L4: the orphaned prompt is answered in main right away, not left to time out.
    expect(mcp.respondClientRequest).toHaveBeenCalledWith({
      kind: 'sampling',
      connectionId: 'conn-1',
      requestId: REQUEST_ID,
      response: { action: 'reject' },
    });
    expect(mcp.removeListener).toHaveBeenCalledTimes(2);
    expect(listeners.get('mcp:client-request:conn-1')?.size).toBe(0);
    expect(listeners.get('mcp:client-request-cancelled:conn-1')?.size).toBe(0);
    expect(useMcpClientRequestStore.getState().requests).toEqual([]);
  });

  it('is a no-op on web', () => {
    delete (window as unknown as { electron?: unknown }).electron;
    const unsubscribe = subscribeMcpClientRequests('conn-1');
    expect(mcp.on).not.toHaveBeenCalled();
    unsubscribe();
  });
});

describe('responding', () => {
  const request = {
    requestId: REQUEST_ID,
    connectionId: 'conn-1',
    kind: 'elicitation' as const,
    params: {},
    receivedAt: 0,
  };

  it('sends an elicitation answer and dequeues it on success', async () => {
    useMcpClientRequestStore.getState().add(request);
    mcp.respondClientRequest.mockResolvedValue({ success: true });
    await expect(respondToElicitation(request, { action: 'decline' })).resolves.toEqual({
      ok: true,
    });
    expect(mcp.respondClientRequest).toHaveBeenCalledWith({
      kind: 'elicitation',
      connectionId: 'conn-1',
      requestId: REQUEST_ID,
      response: { action: 'decline' },
    });
    expect(useMcpClientRequestStore.getState().requests).toEqual([]);
  });

  it('keeps the request and surfaces field errors when main rejects the content', async () => {
    useMcpClientRequestStore.getState().add(request);
    mcp.respondClientRequest.mockResolvedValue({
      success: false,
      error: 'Content does not match the requested schema',
      fieldErrors: { confirm: 'Required.' },
    });
    await expect(respondToElicitation(request, { action: 'accept', content: {} })).resolves.toEqual(
      {
        ok: false,
        error: 'Content does not match the requested schema',
        fieldErrors: { confirm: 'Required.' },
      }
    );
    expect(useMcpClientRequestStore.getState().requests).toHaveLength(1);
  });

  it('dequeues a request main already settled', async () => {
    const sampling = { ...request, kind: 'sampling' as const };
    useMcpClientRequestStore.getState().add(sampling);
    mcp.respondClientRequest.mockResolvedValue({
      success: false,
      error: 'Unknown client request',
    });
    await respondToSampling(sampling, { action: 'reject' });
    expect(mcp.respondClientRequest).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'sampling', response: { action: 'reject' } })
    );
    expect(useMcpClientRequestStore.getState().requests).toEqual([]);
  });

  it('reports IPC validation failures and missing bridges', async () => {
    mcp.respondClientRequest.mockRejectedValue(new Error('invalid payload'));
    await expect(respondToSampling(request, { action: 'reject' })).resolves.toEqual({
      ok: false,
      error: 'invalid payload',
    });
    delete (window as unknown as { electron?: unknown }).electron;
    await expect(respondToSampling(request, { action: 'reject' })).resolves.toMatchObject({
      ok: false,
    });
  });
});

describe('roots', () => {
  it('pushes roots to main and reports failures', async () => {
    mcp.setRoots.mockResolvedValueOnce({ success: true, notified: 1 });
    await expect(
      pushMcpRoots('conn-1', [
        { uri: 'file:///a', name: 'a' },
        { uri: 'file:///b', name: '' },
      ])
    ).resolves.toEqual({ ok: true });
    expect(mcp.setRoots).toHaveBeenCalledWith({
      connectionId: 'conn-1',
      roots: [{ uri: 'file:///a', name: 'a' }, { uri: 'file:///b' }],
    });

    mcp.setRoots.mockResolvedValueOnce({ success: false, error: 'nope' });
    await expect(pushMcpRoots('conn-1', [])).resolves.toEqual({ ok: false, error: 'nope' });
    mcp.setRoots.mockRejectedValueOnce(new Error('Root URI must be a file:// URI'));
    await expect(pushMcpRoots('conn-1', [])).resolves.toEqual({
      ok: false,
      error: 'Root URI must be a file:// URI',
    });
  });

  it('is a no-op on web and validates file:// URIs', async () => {
    delete (window as unknown as { electron?: unknown }).electron;
    await expect(pushMcpRoots('conn-1', [{ uri: 'file:///a' }])).resolves.toEqual({ ok: true });
    expect(isValidRootUri('file:///a')).toBe(true);
    expect(isValidRootUri('https://a')).toBe(false);
    expect(isValidRootUri('not a uri')).toBe(false);
  });

  it('stringifies non-Error IPC failures', async () => {
    mcp.setRoots.mockRejectedValueOnce('boom');
    await expect(pushMcpRoots('conn-1', [])).resolves.toEqual({ ok: false, error: 'boom' });
    mcp.respondClientRequest.mockRejectedValueOnce('bad');
    await expect(
      respondToElicitation(
        {
          requestId: REQUEST_ID,
          connectionId: 'conn-1',
          kind: 'elicitation',
          params: {},
          receivedAt: 0,
        },
        { action: 'cancel' }
      )
    ).resolves.toEqual({ ok: false, error: 'bad' });
  });
});

describe('useMcpClientRequestStore', () => {
  it('ignores duplicate request ids', () => {
    const request = {
      requestId: REQUEST_ID,
      connectionId: 'conn-1',
      kind: 'sampling' as const,
      params: {},
      receivedAt: 0,
    };
    useMcpClientRequestStore.getState().add(request);
    useMcpClientRequestStore.getState().add({ ...request, receivedAt: 1 });
    expect(useMcpClientRequestStore.getState().requests).toEqual([request]);
  });
});

describe('unsubscribe cancels queued prompts', () => {
  it('sends cancel for elicitation and leaves other connections alone', () => {
    const unsubscribe = subscribeMcpClientRequests('conn-1');
    emit('mcp:client-request:conn-1', { requestId: REQUEST_ID, kind: 'elicitation', params: {} });
    useMcpClientRequestStore.getState().add({
      requestId: 'other',
      connectionId: 'conn-2',
      kind: 'elicitation',
      params: {},
      receivedAt: 0,
    });
    unsubscribe();
    expect(mcp.respondClientRequest).toHaveBeenCalledTimes(1);
    expect(mcp.respondClientRequest).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: REQUEST_ID, response: { action: 'cancel' } })
    );
    expect(useMcpClientRequestStore.getState().requests.map((r) => r.requestId)).toEqual(['other']);
  });

  it('only accepts local file:// roots', () => {
    expect(isValidRootUri('file://localhost/a')).toBe(true);
    expect(isValidRootUri('file://server/share')).toBe(false);
  });
});
