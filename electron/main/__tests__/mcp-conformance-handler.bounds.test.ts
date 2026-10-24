import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * #911 M3: the conformance handler must never hang or leak when the server
 * stalls: connect is bounded by the policy timeout, the client is closed, the
 * renderer slot is released, and a destroyed renderer tears the run down.
 */

const mockHandle = vi.hoisted(() => vi.fn());
const connectMock = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  ipcMain: { handle: mockHandle, removeHandler: vi.fn() },
}));
vi.mock('../handlers/mcp-sdk-client', () => ({ connectMcpSdkClient: connectMock }));

import {
  registerMcpConformanceIPC,
  stopMcpConformanceCleanup,
} from '../handlers/mcp-conformance-handler';
import { setExecutionPolicy } from '../security/execution-policy';

type IpcHandler = (event: unknown, payload: unknown) => Promise<Record<string, unknown>>;
const registered = new Map<string, IpcHandler>();

function event(id: number, onceCapture?: (cb: () => void) => void) {
  return {
    sender: {
      id,
      isDestroyed: () => false,
      once: (_name: string, cb: () => void) => onceCapture?.(cb),
    },
    senderFrame: { url: 'file:///app/dist/web/index.html' },
  };
}

const payload = { url: 'http://127.0.0.1:9/mcp', transport: 'streamable-http' };

beforeAll(() => {
  setExecutionPolicy({
    security: { allowLocalhost: true, allowPrivateIPs: false },
    proxy: { enabled: false, type: 'http', host: '', port: 8080, bypassList: [] },
    timeout: 150,
    tls: { verifySsl: true, serverCipherOrder: false },
    certificates: { clientCertificates: [], caCertificates: [] },
  });
  registerMcpConformanceIPC();
  for (const [channel, handler] of mockHandle.mock.calls) {
    registered.set(channel as string, handler as IpcHandler);
  }
});

afterEach(() => {
  stopMcpConformanceCleanup();
  connectMock.mockReset();
});

const run = (ev: unknown, extra: object = {}) =>
  (registered.get('mcp:conformance') as IpcHandler)(ev, { ...payload, ...extra });

describe('mcp:conformance bounds and cleanup', () => {
  it('times out an open() that never resolves, closes the client and frees the slot', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    connectMock.mockImplementation((opts: { onClientCreated: (c: unknown) => void }) => {
      opts.onClientCreated({ close });
      return new Promise(() => {});
    });
    const res = await run(event(1));
    expect(res.success).toBe(true);
    const report = res.report as { eras: Array<{ era: string; status: string }> };
    expect(report.eras.map((e) => e.status)).toEqual(['failed', 'failed']);
    expect(close).toHaveBeenCalled();

    // The renderer slot was released: a second run is accepted, not rejected as in-progress.
    connectMock.mockImplementation(() => new Promise(() => {}));
    const again = await run(event(1), { eras: ['legacy'] });
    expect(again.success).toBe(true);
  });

  it('closes a connect that completes after the timeout instead of leaking it', async () => {
    const late = { close: vi.fn().mockResolvedValue(undefined) };
    connectMock.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(late), 300))
    );
    await run(event(2), { eras: ['legacy'] });
    await new Promise((r) => setTimeout(r, 400));
    expect(late.close).toHaveBeenCalled();
  });

  it('rejects a concurrent run from the same renderer', async () => {
    connectMock.mockImplementation(() => new Promise(() => {}));
    const first = run(event(3), { eras: ['legacy'] });
    const second = await run(event(3), { eras: ['legacy'] });
    expect(second).toEqual({ success: false, error: 'A conformance run is already in progress.' });
    await first;
  });

  it('aborts and closes live clients when the renderer is destroyed mid-run', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    let destroyed: (() => void) | undefined;
    connectMock.mockImplementation((opts: { onClientCreated: (c: unknown) => void }) => {
      opts.onClientCreated({ close });
      return new Promise(() => {});
    });
    const pending = run(
      event(4, (cb) => {
        destroyed = cb;
      }),
      { eras: ['legacy'] }
    );
    await new Promise((r) => setTimeout(r, 20));
    destroyed?.();
    const res = await pending;
    expect(close).toHaveBeenCalled();
    expect((res.report as { eras: Array<{ error?: string }> }).eras[0]?.error).toMatch(/abort/i);
  });
});
