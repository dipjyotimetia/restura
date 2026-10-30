import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applySocketIoPreset,
  socketIoPresetFromConnection,
} from '@/features/socketio/lib/socketioPreset';
import { useSocketIOStore } from '@/features/socketio/store/useSocketIOStore';
import {
  applyWebSocketPreset,
  webSocketPresetFromConnection,
} from '@/features/websocket/lib/websocketPreset';
import { useWebSocketStore } from '@/features/websocket/store/useWebSocketStore';
import {
  clearComposerDrafts,
  getSocketIoComposerDraft,
  getWebSocketComposerDraft,
  setSocketIoComposerDraft,
  setWebSocketComposerDraft,
  type WebSocketComposerDraft,
} from '@/lib/shared/streaming/composerDrafts';
import { useComposerDraftSync } from '@/lib/shared/streaming/useComposerDraftSync';
import type { SocketIoRequest, WebSocketRequest } from '@/types';

/** Apply / snapshot edge cases and the composer draft sync hook (#1209). */

const WS: WebSocketRequest = {
  id: 'w',
  name: 'W',
  type: 'websocket',
  url: 'wss://x',
  protocols: [],
  headers: [],
  message: { body: 'm', format: 'text' },
  templates: [],
};

const SIO: SocketIoRequest = {
  id: 's',
  name: 'S',
  type: 'socketio',
  url: 'https://x',
  namespace: '',
  path: '',
  handshakeAuth: [],
  query: [],
  headers: [],
  transports: [],
  subscribedEvents: [],
  emit: { eventName: 'e', args: '', ack: false },
  templates: [],
};

beforeEach(() => {
  useWebSocketStore.setState({ connections: {}, activeConnectionId: null, connectionByTabId: {} });
  useSocketIOStore.setState({ connections: {}, activeConnectionId: null, connectionByTabId: {} });
});

describe('WebSocket apply / snapshot', () => {
  it('applies an item without options, then with partial options', () => {
    const id = useWebSocketStore.getState().createConnection('wss://old');
    applyWebSocketPreset(id, WS);
    const before = useWebSocketStore.getState().connections[id]!;
    expect(before).toMatchObject({ url: 'wss://x', autoReconnect: true, heartbeatMessage: 'ping' });
    applyWebSocketPreset(id, { ...WS, options: { heartbeatMessage: 'hb', reconnectDelay: 7 } });
    expect(useWebSocketStore.getState().connections[id]).toMatchObject({
      heartbeatInterval: 0,
      heartbeatMessage: 'hb',
      reconnectDelay: 7,
      maxReconnectAttempts: before.maxReconnectAttempts,
    });
    applyWebSocketPreset(id, {
      ...WS,
      options: { heartbeatInterval: 9, perMessageDeflate: false },
    });
    expect(useWebSocketStore.getState().connections[id]).toMatchObject({
      heartbeatInterval: 9,
      heartbeatMessage: 'hb',
      perMessageDeflate: false,
    });
    // An unknown connection is a no-op for the direct state patch.
    applyWebSocketPreset('missing', { ...WS, options: { maxReconnectAttempts: 1 } });
    expect(useWebSocketStore.getState().connections.missing).toBeUndefined();
  });

  it('snapshots without a draft and carries permessage-deflate when set', () => {
    const id = useWebSocketStore.getState().createConnection('wss://y');
    clearComposerDrafts(id);
    const plain = webSocketPresetFromConnection(useWebSocketStore.getState().connections[id]!, 'P');
    expect(plain.message).toEqual({ body: '', format: 'text' });
    expect(plain.options).not.toHaveProperty('perMessageDeflate');
    expect(plain).not.toHaveProperty('frameAssertion');
    useWebSocketStore.getState().patchControlState(id, { perMessageDeflate: false });
    const snap = webSocketPresetFromConnection(useWebSocketStore.getState().connections[id]!, 'P');
    expect(snap.options?.perMessageDeflate).toBe(false);
  });
});

describe('Socket.IO apply / snapshot', () => {
  it('falls back to the default namespace / path and keeps transports when none are saved', () => {
    const id = useSocketIOStore.getState().createConnection('https://old');
    applySocketIoPreset(id, SIO);
    expect(useSocketIOStore.getState().connections[id]).toMatchObject({
      url: 'https://x',
      namespace: '/',
      path: '/socket.io',
      transports: ['websocket', 'polling'],
    });
    applySocketIoPreset(id, {
      ...SIO,
      options: { autoReconnect: false, reconnectionAttempts: 1, reconnectionDelay: 2 },
    });
    expect(useSocketIOStore.getState().connections[id]).toMatchObject({
      autoReconnect: false,
      reconnectionAttempts: 1,
      reconnectionDelay: 2,
    });
    expect(getSocketIoComposerDraft(id)).toEqual(SIO.emit);
  });

  it('snapshots the default emit when no draft exists', () => {
    const id = useSocketIOStore.getState().createConnection('https://z');
    clearComposerDrafts(id);
    const snap = socketIoPresetFromConnection(useSocketIOStore.getState().connections[id]!, 'Z');
    expect(snap.emit).toEqual({ eventName: 'message', args: '', ack: false });
    // A fresh connection saves neither a JSON auth mode nor its default `{}` text.
    expect(snap.handshakeAuthMode).toBeUndefined();
    expect(snap.handshakeAuthJson).toBeUndefined();
  });

  it('round-trips JSON auth, reconnection tuning and emit options through a saved item', () => {
    const s = useSocketIOStore.getState();
    const src = s.createConnection('https://json');
    s.updateConnectionField(src, 'authMode', 'json');
    s.updateConnectionField(src, 'authJson', '{"token":"{{token}}","user":{"id":{{uid}}}}');
    s.updateConnectionField(src, 'reconnectionDelayMax', 9_000);
    s.updateConnectionField(src, 'randomizationFactor', 0.25);
    s.updateConnectionField(src, 'emitOptions', {
      volatile: true,
      compress: false,
      ackTimeoutMs: 2_500,
    });
    const snap = socketIoPresetFromConnection(useSocketIOStore.getState().connections[src]!, 'J');
    expect(snap).toMatchObject({
      handshakeAuthMode: 'json',
      handshakeAuthJson: '{"token":"{{token}}","user":{"id":{{uid}}}}',
      options: {
        reconnectionDelayMax: 9_000,
        randomizationFactor: 0.25,
        volatile: true,
        compress: false,
        ackTimeoutMs: 2_500,
      },
    });

    const dst = s.createConnection('https://other');
    applySocketIoPreset(dst, snap);
    expect(useSocketIOStore.getState().connections[dst]).toMatchObject({
      authMode: 'json',
      authJson: '{"token":"{{token}}","user":{"id":{{uid}}}}',
      reconnectionDelayMax: 9_000,
      randomizationFactor: 0.25,
      emitOptions: { volatile: true, compress: false, ackTimeoutMs: 2_500 },
    });
  });

  it('ignores a zero ack timeout and keeps defaults for items saved before JSON auth', () => {
    const id = useSocketIOStore.getState().createConnection('https://legacy');
    applySocketIoPreset(id, { ...SIO, options: { ackTimeoutMs: 0, volatile: true } });
    expect(useSocketIOStore.getState().connections[id]).toMatchObject({
      authMode: 'kv',
      authJson: '{}',
      emitOptions: { volatile: true, compress: true, ackTimeoutMs: 15_000 },
    });
  });
});

describe('composer drafts', () => {
  it('ignore a null connection and are cleared with their connection', () => {
    expect(getWebSocketComposerDraft(null)).toBeUndefined();
    expect(getSocketIoComposerDraft(null)).toBeUndefined();
    setWebSocketComposerDraft('c', { body: 'b', format: 'text' });
    setSocketIoComposerDraft('c', { eventName: 'e', args: '1', ack: true });
    clearComposerDrafts('c');
    expect(getWebSocketComposerDraft('c')).toBeUndefined();
    expect(getSocketIoComposerDraft('c')).toBeUndefined();
  });

  it("A → B switch then save: B snapshots what is on screen, not A's text", () => {
    const a = useWebSocketStore.getState().createConnection('wss://a');
    const b = useWebSocketStore.getState().createConnection('wss://b');
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => {
        const [draft, setDraft] = useState<WebSocketComposerDraft>({ body: '', format: 'json' });
        useComposerDraftSync(
          id,
          draft,
          getWebSocketComposerDraft,
          setWebSocketComposerDraft,
          setDraft,
          { body: '', format: 'json' }
        );
        return { draft, setDraft };
      },
      { initialProps: { id: a } }
    );
    act(() => result.current.setDraft({ body: 'typed on A', format: 'text' }));
    rerender({ id: b });
    const conn = useWebSocketStore.getState().connections[b]!;
    expect(result.current.draft.body).toBe('');
    expect(webSocketPresetFromConnection(conn, 'B').message).toEqual(result.current.draft);
    clearComposerDrafts(a);
    clearComposerDrafts(b);
  });

  it('useComposerDraftSync seeds from a stored draft and mirrors later edits', () => {
    setWebSocketComposerDraft('a', { body: 'seeded', format: 'json' });
    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => {
        const [draft, setDraft] = useState<WebSocketComposerDraft>({ body: '', format: 'text' });
        useComposerDraftSync(
          id,
          draft,
          getWebSocketComposerDraft,
          setWebSocketComposerDraft,
          setDraft,
          { body: '', format: 'json' }
        );
        return { draft, setDraft };
      },
      { initialProps: { id: 'a' as string | null } }
    );
    expect(result.current.draft).toEqual({ body: 'seeded', format: 'json' });
    act(() => result.current.setDraft({ body: 'edited', format: 'text' }));
    expect(getWebSocketComposerDraft('a')).toEqual({ body: 'edited', format: 'text' });
    // Switching to a connection without a draft resets the composer to its
    // defaults and stores them, so what is on screen is what a save captures
    // (never the previous connection's text).
    rerender({ id: 'b' });
    expect(result.current.draft).toEqual({ body: '', format: 'json' });
    expect(getWebSocketComposerDraft('b')).toEqual({ body: '', format: 'json' });
    // Switching back restores A's text.
    rerender({ id: 'a' });
    expect(result.current.draft).toEqual({ body: 'edited', format: 'text' });
    rerender({ id: 'b' });
    act(() => result.current.setDraft({ body: 'for b', format: 'text' }));
    expect(getWebSocketComposerDraft('b')).toEqual({ body: 'for b', format: 'text' });
    rerender({ id: null });
    expect(result.current.draft.body).toBe('for b');
    clearComposerDrafts('a');
    clearComposerDrafts('b');
  });
});
