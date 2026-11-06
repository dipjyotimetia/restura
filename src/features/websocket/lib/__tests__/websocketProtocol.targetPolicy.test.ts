import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/shared/platform', () => ({
  isElectron: () => false,
  getElectronAPI: () => undefined,
}));

import { useSettingsStore } from '@/store/useSettingsStore';
import { websocketProtocol } from '../../protocol';

const start = (url: string) =>
  websocketProtocol.startStream!(
    { type: 'websocket', url },
    { signal: new AbortController().signal, variables: {} }
  );

// The workflow `wsExchange` web path is a browser-direct socket: the Worker's
// SSRF guard never sees it, so it must apply the same scheme + browser socket
// target policy as the interactive websocketManager (#898).
describe('websocketProtocol.startStream (web) target policy', () => {
  const constructed: string[] = [];

  beforeEach(() => {
    constructed.length = 0;
    vi.stubEnv('DEV', false);
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, allowPrivateIPs: false } }));
    vi.stubGlobal(
      'WebSocket',
      class extends EventTarget {
        static OPEN = 1;
        readyState = 0;
        onerror: (() => void) | null = null;
        constructor(url: string) {
          super();
          constructed.push(url);
          // Fail fast instead of hanging the open-wait when a socket IS built.
          setTimeout(() => {
            this.onerror?.();
            this.dispatchEvent(new Event('error'));
          }, 0);
        }
        close() {}
      }
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each([
    'ws://127.0.0.1:9000',
    'ws://localhost:8080/socket',
    'wss://10.0.0.5',
    'ws://[::1]:8080',
  ])('refuses blocked loopback/private target %s without constructing a WebSocket', async (url) => {
    await expect(start(url)).rejects.toThrow(/Connection refused/);
    expect(constructed).toEqual([]);
  });

  it('refuses cloud-metadata hosts even with private IPs allowed', async () => {
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, allowPrivateIPs: true } }));
    await expect(start('ws://169.254.169.254')).rejects.toThrow(/Connection refused/);
    expect(constructed).toEqual([]);
  });

  it.each(['http://echo.example.com', 'https://echo.example.com', 'ftp://x.test'])(
    'refuses non-ws scheme %s',
    async (url) => {
      await expect(start(url)).rejects.toThrow(/ws:\/\/ or wss:\/\//);
      expect(constructed).toEqual([]);
    }
  );

  it('refuses a malformed URL', async () => {
    await expect(start('not a url')).rejects.toThrow(/Invalid URL/);
    expect(constructed).toEqual([]);
  });
});
