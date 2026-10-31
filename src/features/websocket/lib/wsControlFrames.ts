/**
 * WebSocket control-frame helpers for the renderer manager: close code/reason
 * (#915), desktop ping/pong with RTT (#919), and negotiated subprotocol /
 * extensions (#923). Kept out of `websocketManager.ts` so the manager stays a
 * thin transport switch.
 */
import { pingPayloadError } from '@shared/protocol/websocket-control';
import { useWebSocketStore } from '@/features/websocket/store/useWebSocketStore';
import type { getElectronAPI } from '@/lib/shared/platform';
import { EVENT_PREFIX, eventChannel } from '../../../../electron/shared/channels';

type ElectronApi = ReturnType<typeof getElectronAPI>;

/** Optional close frame chosen by the user; validated by `closeFrameError`. */
export interface WsCloseOptions {
  code: number;
  reason?: string;
}

export const WEB_PING_UNSUPPORTED =
  'Ping/pong frames are not exposed by the browser WebSocket API — use the desktop app to send pings and see pong round-trip times.';

/** Per-connection IPC event channels added for control frames (#919). */
export function controlFrameChannels(connectionId: string): string[] {
  return [
    eventChannel(EVENT_PREFIX.ws.pong, connectionId),
    eventChannel(EVENT_PREFIX.ws.pingReceived, connectionId),
  ];
}

/** `"Closing (code: 4000, reason: bye)"` — logged when a custom close frame is sent. */
export function describeClose(close: WsCloseOptions): string {
  return close.reason
    ? `Closing (code: ${close.code}, reason: ${close.reason})`
    : `Closing (code: ${close.code})`;
}

/**
 * Store what the server accepted on open and return the transcript suffix,
 * e.g. `" (subprotocol: mqtt; extensions: permessage-deflate)"` (empty when
 * nothing was negotiated).
 */
export function recordNegotiation(
  connectionId: string,
  protocol: string | undefined,
  extensions: string | undefined
): string {
  const negotiated = { protocol: protocol ?? '', extensions: extensions ?? '' };
  // A fresh connection also drops the previous connection's ping RTT.
  useWebSocketStore
    .getState()
    .patchControlState(connectionId, { negotiated, lastPingRttMs: undefined });
  const parts = [
    negotiated.protocol && `subprotocol: ${negotiated.protocol}`,
    negotiated.extensions && `extensions: ${negotiated.extensions}`,
  ].filter(Boolean);
  return parts.length > 0 ? ` (${parts.join('; ')})` : '';
}

/** Drop the last ping RTT once a connection ends so Latency never shows a stale value. */
export function clearPingRtt(connectionId: string): void {
  const s = useWebSocketStore.getState();
  if (s.connections[connectionId]?.lastPingRttMs !== undefined) {
    s.patchControlState(connectionId, { lastPingRttMs: undefined });
  }
}

const payloadSuffix = (data: string) => (data ? ` (payload: ${data})` : '');

/** Subscribe to the desktop `ws:pong:` / `ws:ping-received:` events (#919). */
export function attachControlFrameListeners(connectionId: string, api: ElectronApi): void {
  const ws = api?.websocket;
  if (!ws) return;
  ws.on(eventChannel(EVENT_PREFIX.ws.pong, connectionId), (payload: unknown) => {
    const { data, rttMs } = payload as { data: string; rttMs?: number };
    const s = useWebSocketStore.getState();
    if (rttMs === undefined) {
      s.addMessage(connectionId, 'system', `Pong received (unsolicited)${payloadSuffix(data)}`);
      return;
    }
    s.patchControlState(connectionId, { lastPingRttMs: rttMs });
    s.addMessage(connectionId, 'system', `Pong received · RTT ${rttMs} ms${payloadSuffix(data)}`);
  });
  ws.on(eventChannel(EVENT_PREFIX.ws.pingReceived, connectionId), (payload: unknown) => {
    const { data } = payload as { data: string };
    useWebSocketStore
      .getState()
      .addMessage(
        connectionId,
        'system',
        `Ping received from server (auto-replied with pong)${payloadSuffix(data)}`
      );
  });
}

/**
 * Send a desktop Ping control frame. Returns false (with a transcript note)
 * when the payload is too large or the IPC bridge is unavailable.
 */
export function sendElectronPing(connectionId: string, payload: string, api: ElectronApi): boolean {
  const s = useWebSocketStore.getState();
  const error = pingPayloadError(payload);
  if (error) {
    s.addMessage(connectionId, 'system', `Ping not sent: ${error}`);
    return false;
  }
  if (!api?.websocket) {
    s.addMessage(connectionId, 'system', WEB_PING_UNSUPPORTED);
    return false;
  }
  s.addMessage(connectionId, 'system', `Ping sent${payloadSuffix(payload)}`);
  const fail = (reason: string) =>
    useWebSocketStore.getState().addMessage(connectionId, 'system', `Ping failed: ${reason}`);
  void api.websocket
    .ping({ connectionId, payload })
    .then((res) => {
      if (!res.success) fail(res.error ?? 'unknown error');
    })
    .catch((err: unknown) => fail(err instanceof Error ? err.message : 'unknown error'));
  return true;
}
