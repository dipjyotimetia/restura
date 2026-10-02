import { beforeEach, describe, expect, it } from 'vitest';
import { useSocketIOStore } from '@/features/socketio/store/useSocketIOStore';
import { useWebSocketStore } from '@/features/websocket/store/useWebSocketStore';
import { useRequestStore } from '@/store/useRequestStore';
import type { HttpRequest, RequestMode, RequestTab } from '@/types';
import { carriesUrl, convertUrlForMode, seedUrl, sourceUrlOf, tabMode } from '../openAs';

const http = (url: string): HttpRequest => ({
  id: 'r',
  name: 'R',
  type: 'http',
  method: 'GET',
  url,
  headers: [],
  params: [],
  body: { type: 'none' },
  auth: { type: 'none' },
});

const tab = (over: Partial<RequestTab> = {}): RequestTab =>
  ({ id: 't1', request: http('https://api.dev/x'), isDirty: false, ...over }) as RequestTab;

describe('openAs', () => {
  beforeEach(() => {
    useRequestStore.setState({ tabs: [], activeTabId: null });
    useWebSocketStore.setState({ connections: {}, connectionByTabId: {} });
    useSocketIOStore.setState({ connections: {}, connectionByTabId: {} });
  });

  it('reads the mode and the URL from wherever the protocol keeps it', () => {
    expect(tabMode(tab())).toBe('http');
    expect(sourceUrlOf(tab())).toBe('https://api.dev/x');

    const ws = tab({ id: 'ws-tab', modeOverride: 'websocket' });
    expect(tabMode(ws)).toBe('websocket');
    expect(sourceUrlOf(ws)).toBe('');
    useWebSocketStore.getState().ensureConnectionForTab('ws-tab', 'wss://echo.dev/ws');
    expect(sourceUrlOf(ws)).toBe('wss://echo.dev/ws');

    expect(sourceUrlOf(tab({ modeOverride: 'kafka' }))).toBe('');
  });

  it('converts between http and ws schemes for the target', () => {
    expect(convertUrlForMode('https://h/p', 'websocket')).toBe('wss://h/p');
    expect(convertUrlForMode('http://h', 'websocket')).toBe('ws://h');
    expect(convertUrlForMode('wss://h/p', 'http')).toBe('https://h/p');
    expect(convertUrlForMode('https://h', 'grpc')).toBe('https://h');
  });

  it('only seeds targets that keep a URL per tab', () => {
    const seeded: RequestMode[] = ['http', 'graphql', 'grpc', 'websocket', 'socketio'];
    const shared: RequestMode[] = ['sse', 'mcp', 'kafka', 'mqtt'];
    expect(seeded.every(carriesUrl)).toBe(true);
    expect(shared.some(carriesUrl)).toBe(false);
  });

  it('seeds WebSocket and Socket.IO connections for the new tab, and request URLs', () => {
    seedUrl('new-ws', 'websocket', 'https://echo.dev/ws');
    const wsId = useWebSocketStore.getState().connectionByTabId['new-ws']!;
    expect(useWebSocketStore.getState().connections[wsId]?.url).toBe('wss://echo.dev/ws');

    seedUrl('new-io', 'socketio', 'https://io.dev');
    const ioId = useSocketIOStore.getState().connectionByTabId['new-io']!;
    expect(useSocketIOStore.getState().connections[ioId]?.url).toBe('https://io.dev');

    useRequestStore.getState().openTab(http(''));
    seedUrl('ignored', 'grpc', 'wss://h');
    expect(useRequestStore.getState().getActiveTab()?.request.url).toBe('https://h');

    seedUrl('none', 'sse', 'https://h');
    seedUrl('none', 'http', '');
    expect(useWebSocketStore.getState().connectionByTabId.none).toBeUndefined();
  });
});
