import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({
  electron: false,
  api: undefined as unknown,
}));

vi.mock('@/lib/shared/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/shared/platform')>();
  return {
    ...actual,
    isElectron: () => platform.electron,
    getElectronAPI: () => platform.api,
  };
});

import { MCP_CANCEL_REASON, McpClient } from '../mcpClient';

function makeClient(): McpClient {
  return new McpClient({
    url: 'https://mcp.example.com',
    transport: 'streamable-http',
    headers: { 'x-a': 'b' },
    connectionId: 'conn-1',
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('McpClient cancellation (web / Worker proxy)', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    platform.electron = false;
    platform.api = undefined;
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A fetch that never answers until its signal aborts (like the browser). */
  function hangingFetch(init: RequestInit | undefined): Promise<Response> {
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('aborted', 'AbortError'))
      );
    });
  }

  it('aborts the fetch and sends notifications/cancelled with the same requestId and session id', async () => {
    const client = makeClient();
    // Seed a session id via a first, successful call.
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, jsonRpc: { result: {} }, sessionId: 'sess-9' }), {
        status: 200,
      })
    );
    await client.request('ping');
    fetchMock.mockClear();

    fetchMock.mockImplementation((_url, init) => {
      const body = JSON.parse(String(init?.body)) as { jsonRpc: { method: string } };
      return body.jsonRpc.method === 'tools/call'
        ? hangingFetch(init)
        : Promise.resolve(new Response(JSON.stringify({ ok: true, accepted: true })));
    });

    const controller = new AbortController();
    const pending = client.callTool('slow', {}, controller.signal);
    controller.abort();
    const result = await pending;

    expect(result).toMatchObject({ ok: false, cancelled: true });

    const bodies = fetchMock.mock.calls.map(
      ([, init]) =>
        JSON.parse(String(init?.body)) as {
          sessionId?: string;
          jsonRpc: { method: string; id?: number; params?: Record<string, unknown> };
        }
    );
    const call = bodies.find((b) => b.jsonRpc.method === 'tools/call')!;
    const cancel = bodies.find((b) => b.jsonRpc.method === 'notifications/cancelled')!;
    expect(cancel.jsonRpc.id).toBeUndefined();
    expect(cancel.jsonRpc.params).toEqual({
      requestId: call.jsonRpc.id,
      reason: MCP_CANCEL_REASON,
    });
    expect(cancel.sessionId).toBe('sess-9');
    expect(call.sessionId).toBe('sess-9');
  });

  it('does not send a request when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await makeClient().callTool('x', {}, controller.signal);
    expect(result).toMatchObject({ ok: false, cancelled: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not send a cancel notification when the call finished before abort', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, jsonRpc: { result: { done: true } } }), {
        status: 200,
      })
    );
    const controller = new AbortController();
    const result = await makeClient().callTool('x', {}, controller.signal);
    controller.abort();
    expect(result).toMatchObject({ ok: true, result: { done: true } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('McpClient cancellation (Electron IPC)', () => {
  const request = vi.fn();
  const cancel = vi.fn();

  beforeEach(() => {
    platform.electron = true;
    request.mockReset();
    cancel.mockReset().mockResolvedValue({ success: true });
    platform.api = { mcp: { request, cancel } };
  });

  it('calls mcp:cancel with the request id and ignores a late response', async () => {
    const late = deferred<{ success: boolean; result?: unknown }>();
    request.mockReturnValueOnce(late.promise);
    const controller = new AbortController();

    const pending = makeClient().callTool('slow', {}, controller.signal);
    const sent = request.mock.calls[0]![0] as { requestId: number; connectionId: string };
    controller.abort();

    expect(cancel).toHaveBeenCalledWith({
      connectionId: 'conn-1',
      requestId: sent.requestId,
    });
    const result = await pending;
    expect(result).toMatchObject({ ok: false, cancelled: true });

    // The server's late reply must not surface anywhere.
    late.resolve({ success: true, result: { content: 'too late' } });
    await Promise.resolve();
    expect(result).toMatchObject({ ok: false, cancelled: true });
  });

  it('maps a main-process cancelled response to the cancelled state, not an error', async () => {
    request.mockResolvedValueOnce({ success: false, cancelled: true });
    const result = await makeClient().callTool('x', {}, new AbortController().signal);
    expect(result).toMatchObject({ ok: false, cancelled: true });
  });

  it('does not call mcp:cancel for an uncancelled call', async () => {
    request.mockResolvedValueOnce({ success: true, result: { ok: 1 } });
    const controller = new AbortController();
    await makeClient().callTool('x', {}, controller.signal);
    controller.abort();
    expect(cancel).not.toHaveBeenCalled();
  });
});
