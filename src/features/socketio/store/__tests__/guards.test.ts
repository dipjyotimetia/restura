import { beforeEach, describe, expect, it } from 'vitest';
import { useWebSocketStore } from '@/features/websocket/store/useWebSocketStore';
import {
  getSocketIoComposerDraft,
  setSocketIoComposerDraft,
} from '@/lib/shared/streaming/composerDrafts';
import { useSocketIOStore } from '../useSocketIOStore';

/**
 * Unknown-connection guards and no-op paths of the Socket.IO / WebSocket
 * stores, plus composer-draft cleanup on removal (#1209).
 */

beforeEach(() => {
  useSocketIOStore.setState({ connections: {}, activeConnectionId: null, connectionByTabId: {} });
  useWebSocketStore.setState({ connections: {}, activeConnectionId: null, connectionByTabId: {} });
});

describe('useSocketIOStore guards', () => {
  it('every per-connection action is a no-op for an unknown id', () => {
    const s = useSocketIOStore.getState();
    const before = useSocketIOStore.getState().connections;
    s.updateConnectionStatus('x', 'connected');
    s.updateConnectionField('x', 'url', 'u');
    s.setReconnectAttemptCount('x', 1);
    s.setLastConnectedAt('x', 1);
    s.addEvent('x', { direction: 'sent', eventName: 'e', args: [] });
    s.resolveAck('x', 'a', [], 'ok');
    s.clearEvents('x');
    s.setKv('x', 'auth', []);
    s.addSubscribedEvent('x', 'e');
    s.removeSubscribedEvent('x', 'e');
    s.cleanupConnectionForTab('no-tab');
    expect(useSocketIOStore.getState().connections).toBe(before);
    expect(s.getFilteredEvents('x')).toEqual([]);
    expect(s.getActiveConnection()).toBeNull();
  });

  it('skips unchanged values, dedupes subscriptions and maps every event direction', () => {
    const s = useSocketIOStore.getState();
    const id = s.ensureConnectionForTab('t', 'https://x');
    expect(s.ensureConnectionForTab('t')).toBe(id);
    s.setActiveConnection(null);
    expect(useSocketIOStore.getState().ensureConnectionForTab('t')).toBe(id);
    const snapshot = useSocketIOStore.getState().connections;
    s.updateConnectionStatus(id, 'disconnected');
    s.updateConnectionField(id, 'url', 'https://x');
    s.setReconnectAttemptCount(id, 0);
    expect(useSocketIOStore.getState().connections).toBe(snapshot);
    s.addSubscribedEvent(id, 'e');
    s.addSubscribedEvent(id, 'e');
    expect(useSocketIOStore.getState().connections[id]?.subscribedEvents).toEqual(['e']);
    s.removeSubscribedEvent(id, 'e');
    for (const direction of ['sent', 'received', 'ack', 'system'] as const) {
      s.addEvent(id, { direction, eventName: direction, args: [1], ackId: 'k' });
    }
    s.resolveAck(id, 'k', ['late'], 'timeout');
    s.resolveAck(id, 'k', ['ok'], 'ok');
    const events = useSocketIOStore.getState().connections[id]!.events;
    expect(events.find((e) => e.direction === 'sent')?.ackStatus).toBe('ok');
    expect(events.filter((e) => e.direction === 'ack').map((e) => e.eventName)).toContain(
      '<ack timeout>'
    );
    s.setLastConnectedAt(id, 5);
    s.clearEvents(id);
    expect(useSocketIOStore.getState().connections[id]).toMatchObject({
      events: [],
      lastConnectedAt: 5,
    });
    expect(useSocketIOStore.getState().getActiveConnection()?.id).toBe(id);
  });

  it('drops the composer draft with its connection (tab cleanup and removal)', () => {
    const s = useSocketIOStore.getState();
    const a = s.ensureConnectionForTab('a');
    const b = s.createConnection('https://b');
    s.setActiveConnection(b);
    setSocketIoComposerDraft(a, { eventName: 'e', args: '', ack: false });
    setSocketIoComposerDraft(b, { eventName: 'e', args: '', ack: false });
    s.cleanupConnectionForTab('a');
    s.removeConnection(b);
    expect(getSocketIoComposerDraft(a)).toBeUndefined();
    expect(getSocketIoComposerDraft(b)).toBeUndefined();
    expect(useSocketIOStore.getState().activeConnectionId).toBeNull();
  });
});

describe('useWebSocketStore guards', () => {
  it('every per-connection action is a no-op for an unknown id', () => {
    const s = useWebSocketStore.getState();
    const before = useWebSocketStore.getState().connections;
    s.updateConnectionStatus('x', 'connected');
    s.updateConnectionUrl('x', 'u');
    s.setReconnectAttempts('x', 1);
    s.setAutoReconnect('x', false);
    s.setLastConnectedAt('x', 1);
    s.addMessage('x', 'sent', 'hi');
    s.clearMessages('x');
    s.setHeaders('x', []);
    s.setProtocols('x', []);
    s.patchControlState('x', { lastPingRttMs: 1 });
    s.setTemplates('x', []);
    s.setFrameAssertion('x', { enabled: true, script: '' });
    s.setHeartbeatConfig('x', 1, 'p');
    s.cleanupConnectionForTab('no-tab');
    expect(useWebSocketStore.getState().connections).toBe(before);
    expect(s.getFilteredMessages('x')).toEqual([]);
  });

  it('removing the active connection clears it and its tab binding', () => {
    const s = useWebSocketStore.getState();
    const id = s.ensureConnectionForTab('t');
    s.removeConnection(id);
    expect(useWebSocketStore.getState()).toMatchObject({
      activeConnectionId: null,
      connectionByTabId: {},
    });
  });
});
