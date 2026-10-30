// Browser-direct socket private-network policy regression (#898, SEC-W1).
//
// On the web build WebSocket, Socket.IO and GraphQL subscriptions connect
// straight from the browser, so the Worker's SSRF guard never sees them. The
// renderer must refuse loopback / private / cloud-metadata targets itself
// (unless a dev build or the user's "Allow private / internal IPs" opt-in),
// BEFORE any socket is constructed. Desktop is unaffected (IPC + DNS pinning).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ electron: false }));
vi.mock('@/lib/shared/platform', () => ({
  isElectron: () => platform.electron,
  getElectronAPI: () => undefined,
}));
const mockIo = vi.hoisted(() => vi.fn());
vi.mock('socket.io-client', () => ({ io: mockIo }));

import { openSubscriptionSocket } from '@/features/graphql/lib/subscriptionSocket';
import { socketioManager } from '@/features/socketio/lib/socketioManager';
import { useSocketIOStore } from '@/features/socketio/store/useSocketIOStore';
import { websocketManager } from '@/features/websocket/lib/websocketManager';
import { useWebSocketStore } from '@/features/websocket/store/useWebSocketStore';
import { needsCleartextConfirm } from '@/hooks/useCleartextCredentialsGuard';
import {
  carriesCredentials,
  checkBrowserSocketTarget,
  isCleartextSocketUrl,
} from '@/lib/shared/browserSocketPolicy';
import { useSettingsStore } from '@/store/useSettingsStore';

const REFUSED = [
  'ws://127.0.0.1:4000/graphql',
  'ws://localhost:8080/',
  'ws://[::1]:9000/',
  'ws://10.0.0.5/socket',
  'wss://192.168.1.20/ws',
  'http://172.16.0.1:3000',
  'ws://169.254.169.254/latest/meta-data',
  'ws://2130706433/', // decimal 127.0.0.1
];

describe('checkBrowserSocketTarget', () => {
  it.each(REFUSED)('refuses %s by default', (url) => {
    const r = checkBrowserSocketTarget(url, { allowPrivateNetwork: false, devBuild: false });
    expect(r.ok).toBe(false);
  });

  it('allows public targets', () => {
    for (const url of ['wss://echo.example.com/ws', 'https://api.example.com/socket.io']) {
      expect(
        checkBrowserSocketTarget(url, { allowPrivateNetwork: false, devBuild: false })
      ).toEqual({ ok: true });
    }
  });

  it('relaxes loopback/private for the opt-in or a dev build, never cloud metadata', () => {
    for (const opts of [
      { allowPrivateNetwork: true, devBuild: false },
      { allowPrivateNetwork: false, devBuild: true },
    ]) {
      expect(checkBrowserSocketTarget('ws://127.0.0.1:4000', opts).ok).toBe(true);
      expect(checkBrowserSocketTarget('ws://10.0.0.5', opts).ok).toBe(true);
      expect(checkBrowserSocketTarget('ws://169.254.169.254/', opts).ok).toBe(false);
    }
  });
});

describe('cleartext credential detection', () => {
  it('flags ws:// and http:// only', () => {
    expect(isCleartextSocketUrl('ws://x.example.com')).toBe(true);
    expect(isCleartextSocketUrl('http://x.example.com')).toBe(true);
    expect(isCleartextSocketUrl('wss://x.example.com')).toBe(false);
    expect(isCleartextSocketUrl('https://x.example.com')).toBe(false);
  });

  it('detects credential headers, query params, userinfo and auth payloads', () => {
    expect(carriesCredentials({ headers: { Authorization: 'Bearer t' } })).toBe(true);
    expect(carriesCredentials({ headers: { 'X-My-Token': 'abc' } })).toBe(true);
    expect(carriesCredentials({ url: 'ws://h.example.com/?access_token=abc' })).toBe(true);
    expect(carriesCredentials({ url: 'ws://u:p@h.example.com/' })).toBe(true);
    expect(carriesCredentials({ authPayload: { anything: 'x' } })).toBe(true);
    expect(
      carriesCredentials({
        url: 'ws://h.example.com/?room=1',
        headers: { 'Content-Type': 'application/json', Authorization: '' },
      })
    ).toBe(false);
  });
});

describe('needsCleartextConfirm', () => {
  it('asks only for credentials over an unencrypted scheme', () => {
    const headers = { Authorization: 'Bearer t' };
    expect(needsCleartextConfirm('ws://h.example.com/graphql', { headers })).toBe(true);
    expect(needsCleartextConfirm('http://h.example.com/socket.io', { headers })).toBe(true);
    expect(needsCleartextConfirm('wss://h.example.com/graphql', { headers })).toBe(false);
    expect(needsCleartextConfirm('ws://h.example.com/graphql', { headers: {} })).toBe(false);
    // Desktop main-side (keychain) auth is invisible to the renderer but still sent.
    expect(needsCleartextConfirm('ws://h.example.com/graphql', { force: true })).toBe(true);
  });
});

describe('web socket clients refuse private targets before connecting', () => {
  const WebSocketSpy = vi.fn();

  beforeEach(() => {
    platform.electron = false;
    vi.stubEnv('DEV', false);
    useSettingsStore.getState().updateSettings({ allowPrivateIPs: false });
    WebSocketSpy.mockReset();
    mockIo.mockReset();
    vi.stubGlobal('WebSocket', WebSocketSpy);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('WebSocket manager', () => {
    const id = useWebSocketStore.getState().createConnection('ws://127.0.0.1:9000');
    websocketManager.connect(id, 'ws://127.0.0.1:9000');
    expect(WebSocketSpy).not.toHaveBeenCalled();
    const conn = useWebSocketStore.getState().connections[id];
    expect(conn?.status).toBe('disconnected');
    expect(conn?.messages.at(-1)?.content).toMatch(/Connection refused/);
  });

  it('Socket.IO manager', () => {
    const id = useSocketIOStore.getState().createConnection('http://192.168.0.10:3000');
    socketioManager.connect(id);
    expect(mockIo).not.toHaveBeenCalled();
    expect(useSocketIOStore.getState().connections[id]?.status).toBe('disconnected');
  });

  it('GraphQL subscription socket', () => {
    expect(() =>
      openSubscriptionSocket('ws://10.1.2.3/graphql', ['graphql-transport-ws'], {})
    ).toThrow(/Connection refused/);
    expect(WebSocketSpy).not.toHaveBeenCalled();
  });

  it('honours the "Allow private / internal IPs" opt-in', () => {
    useSettingsStore.getState().updateSettings({ allowPrivateIPs: true });
    openSubscriptionSocket('ws://10.1.2.3/graphql', ['graphql-transport-ws'], {});
    expect(WebSocketSpy).toHaveBeenCalledTimes(1);
  });
});
