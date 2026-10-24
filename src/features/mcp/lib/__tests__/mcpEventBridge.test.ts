import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type FakeMcpBridge,
  installFakeMcpBridge,
} from '../../../../../tests/helpers/fakeMcpBridge';
import { subscribeMcpEvents, supportsMcpServerEvents } from '../mcpEventBridge';

let bridge: FakeMcpBridge | undefined;

afterEach(() => {
  bridge?.uninstall();
  bridge = undefined;
});

function handlers() {
  return { onNotification: vi.fn(), onError: vi.fn(), onClose: vi.fn() };
}

describe('subscribeMcpEvents (#858)', () => {
  it('routes each per-connection channel to its handler', () => {
    bridge = installFakeMcpBridge();
    const h = handlers();
    subscribeMcpEvents('c1', h);

    expect(bridge.channels()).toEqual(['mcp:close:c1', 'mcp:error:c1', 'mcp:notification:c1']);

    const note = { method: 'notifications/message', params: { level: 'info', data: 'hi' } };
    bridge.emit('mcp:notification:c1', note);
    bridge.emit('mcp:error:c1', { message: 'upstream 502' });
    bridge.emit('mcp:close:c1', { reason: 'stream ended' });
    // Another connection's events never reach these handlers.
    bridge.emit('mcp:notification:c2', note);

    expect(h.onNotification).toHaveBeenCalledOnce();
    expect(h.onNotification).toHaveBeenCalledWith(note);
    expect(h.onError).toHaveBeenCalledWith('upstream 502');
    expect(h.onClose).toHaveBeenCalledWith('stream ended');
  });

  it('falls back to generic messages for malformed error/close payloads', () => {
    bridge = installFakeMcpBridge();
    const h = handlers();
    subscribeMcpEvents('c1', h);

    bridge.emit('mcp:error:c1', undefined);
    bridge.emit('mcp:close:c1', { reason: '' });

    expect(h.onError).toHaveBeenCalledWith('Unknown MCP error');
    expect(h.onClose).toHaveBeenCalledWith('connection closed');
  });

  it('removes exactly its own listeners and is idempotent (no leak)', () => {
    bridge = installFakeMcpBridge();
    const first = subscribeMcpEvents('c1', handlers());
    const second = subscribeMcpEvents('c1', handlers());
    expect(bridge.listenerCount()).toBe(6);

    first();
    first();
    expect(bridge.listenerCount()).toBe(3);
    expect(bridge.mcp.removeListener).toHaveBeenCalledTimes(3);

    second();
    expect(bridge.listenerCount()).toBe(0);
  });

  it('is a no-op on web (no server→client channel)', () => {
    expect(supportsMcpServerEvents()).toBe(false);
    const unsubscribe = subscribeMcpEvents('c1', handlers());
    expect(() => unsubscribe()).not.toThrow();
  });

  it('reports desktop support only when the bridge exposes `on`', () => {
    bridge = installFakeMcpBridge();
    expect(supportsMcpServerEvents()).toBe(true);
    bridge.uninstall();
    bridge = installFakeMcpBridge({ on: undefined });
    expect(supportsMcpServerEvents()).toBe(false);
    expect(() => subscribeMcpEvents('c1', handlers())()).not.toThrow();
  });
});
