// @vitest-environment node
//
// Registration/policy surface of the http:request IPC handler ONLY —
// untrusted frame, Zod payload validation, rate limiting, and the error shape
// on a failed upstream. Body/decode/form-data behaviour is already covered by
// http-handler-{decode,formdata,graphql}.test.ts against the real fetcher.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockHandle = vi.hoisted(() => vi.fn());
const mockUndiciRequest = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  ipcMain: { handle: mockHandle, removeHandler: vi.fn() },
  session: { defaultSession: { resolveProxy: vi.fn() } },
}));
// No real sockets: fail/observe at the undici seam. Agent/ProxyAgent only need
// close() (the fetcher's cleanup path); buildConnector is never exercised
// because `request` itself is mocked.
vi.mock('undici', () => {
  class FakeAgent {
    close = vi.fn(async () => {});
  }
  return {
    request: mockUndiciRequest,
    Agent: FakeAgent,
    ProxyAgent: FakeAgent,
    buildConnector: vi.fn(() => vi.fn()),
  };
});
// The sandbox exports HTTP(S)_PROXY; pin the fetcher to the direct path so the
// test doesn't depend on the host environment.
vi.mock('../security/env-proxy', () => ({ resolveEnvProxy: () => undefined }));

import { IPC } from '../../shared/channels';
import { registerHttpHandlerIPC, httpRateLimiter } from '../handlers/http-handler';
import type { LogEntry } from '../lifecycle/request-logger';
import { setExecutionPolicy } from '../security/execution-policy';

type IpcHandler = (e: unknown, p: unknown) => Promise<unknown>;

function handlerFor(channel: string): IpcHandler {
  const call = mockHandle.mock.calls.find((c) => c[0] === channel);
  return call?.[1] as IpcHandler;
}

const TRUSTED_URL = 'file:///app/dist/web/index.html';
let nextSenderId = 3000;

/**
 * Fake IpcMainInvokeEvent. Fresh sender id per event so the real (module-level)
 * httpRateLimiter can't leak across tests.
 */
function makeEvent(frameUrl = TRUSTED_URL, senderId?: number) {
  const id = senderId ?? nextSenderId++;
  return {
    senderId: id,
    event: {
      sender: { id, isDestroyed: () => false, once: vi.fn() },
      senderFrame: { url: frameUrl, parent: null },
    },
  };
}

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const validConfig = {
  requestId: REQUEST_ID,
  method: 'GET',
  url: 'http://echo.example.com/get',
};

const onComplete = vi.fn<(entry: LogEntry) => void>();

describe('http-handler (registration/policy surface)', () => {
  beforeEach(() => {
    setExecutionPolicy({
      security: { allowLocalhost: true, allowPrivateIPs: false },
      proxy: { enabled: false, type: 'http', host: '', port: 8080, bypassList: [] },
      timeout: 30_000,
      tls: { verifySsl: true, serverCipherOrder: false },
      certificates: { clientCertificates: [], caCertificates: [] },
    });
    mockHandle.mockClear();
    mockUndiciRequest.mockReset();
    mockUndiciRequest.mockRejectedValue(new Error('socket hang up'));
    onComplete.mockClear();
    registerHttpHandlerIPC(onComplete);
  });

  it('registers exactly the IPC.http channels', () => {
    const channels = mockHandle.mock.calls.map((c) => c[0]).sort();
    expect(channels).toEqual(Object.values(IPC.http).sort());
  });

  it('rejects http:request from an untrusted frame before doing any work', async () => {
    const { event } = makeEvent('https://attacker.example/');
    await expect(handlerFor(IPC.http.request)(event, validConfig)).rejects.toThrow(
      /untrusted frame/
    );
    expect(mockUndiciRequest).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('rejects an invalid payload via the Zod schema (malformed URL)', async () => {
    const { event } = makeEvent();
    await expect(
      handlerFor(IPC.http.request)(event, { method: 'GET', url: 'not-a-url' })
    ).rejects.toThrow(/Invalid IPC payload for http:request/);
    expect(mockUndiciRequest).not.toHaveBeenCalled();
  });

  it('rejects a request once the sender has drained its rate-limit bucket', async () => {
    const { event, senderId } = makeEvent();
    try {
      let guard = 0;
      while (httpRateLimiter.check(senderId) && guard++ < 10_000) {
        /* drain the sender's bucket */
      }
      // rateLimited() wraps the validated handler, so the drained bucket
      // surfaces as a rejected invoke — not a { success: false } result.
      await expect(handlerFor(IPC.http.request)(event, validConfig)).rejects.toThrow(
        /Rate limit exceeded/
      );
      expect(mockUndiciRequest).not.toHaveBeenCalled();
    } finally {
      httpRateLimiter.dispose(senderId);
    }
  });

  it('surfaces an upstream failure as a rejected invoke and logs it via onComplete', async () => {
    const { event } = makeEvent();
    await expect(handlerFor(IPC.http.request)(event, validConfig)).rejects.toThrow(
      /socket hang up/
    );

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        url: validConfig.url,
        status: 0, // no response — the request never completed
        protocol: 'http',
        error: expect.stringContaining('socket hang up'),
      })
    );
  });

  it('rejects a duplicate active request ID', async () => {
    let rejectFirst!: (reason: Error) => void;
    mockUndiciRequest
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirst = reject;
          })
      )
      .mockRejectedValueOnce(new Error('unexpected second transport'));
    const { event } = makeEvent();
    const pending = handlerFor(IPC.http.request)(event, validConfig);
    await vi.waitFor(() => expect(mockUndiciRequest).toHaveBeenCalledOnce());

    await expect(handlerFor(IPC.http.request)(event, validConfig)).rejects.toThrow(
      /request ID is already active/i
    );
    expect(mockUndiciRequest).toHaveBeenCalledOnce();

    rejectFirst(new Error('test cleanup'));
    await expect(pending).rejects.toThrow(/test cleanup/);
  });

  it('refuses cancellation from another renderer', async () => {
    let rejectFirst!: (reason: Error) => void;
    mockUndiciRequest.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectFirst = reject;
        })
    );
    const owner = makeEvent();
    const other = makeEvent();
    const pending = handlerFor(IPC.http.request)(owner.event, validConfig);
    await vi.waitFor(() => expect(mockUndiciRequest).toHaveBeenCalledOnce());

    await expect(
      handlerFor(IPC.http.cancel)(other.event, { requestId: REQUEST_ID })
    ).resolves.toEqual({ ok: false, error: 'Request does not belong to this renderer.' });

    rejectFirst(new Error('test cleanup'));
    await expect(pending).rejects.toThrow(/test cleanup/);
  });

  it('aborts an in-flight request owned by the cancelling renderer', async () => {
    let upstreamSignal: AbortSignal | undefined;
    mockUndiciRequest.mockImplementationOnce(
      (_url: string, options: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          upstreamSignal = options.signal;
          options.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('The operation was aborted', 'AbortError')),
            { once: true }
          );
        })
    );
    const owner = makeEvent();
    const pending = handlerFor(IPC.http.request)(owner.event, validConfig);
    await vi.waitFor(() => expect(mockUndiciRequest).toHaveBeenCalledOnce());

    await expect(
      handlerFor(IPC.http.cancel)(owner.event, { requestId: REQUEST_ID })
    ).resolves.toEqual({ ok: true });
    expect(upstreamSignal?.aborted).toBe(true);
    await expect(pending).rejects.toThrow(/abort/i);
  });

  it('treats cancellation after completion as an idempotent no-op', async () => {
    const { event } = makeEvent();

    await expect(handlerFor(IPC.http.cancel)(event, { requestId: REQUEST_ID })).resolves.toEqual({
      ok: true,
      alreadyDone: true,
    });
    expect(mockUndiciRequest).not.toHaveBeenCalled();
  });
});
