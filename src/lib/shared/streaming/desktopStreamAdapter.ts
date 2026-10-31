import { EVENT_PREFIX, eventChannel } from '../../../../electron/shared/channels';
import type { ElectronSseAPI } from '../../../../electron/types/api/protocols';
import type { StreamAdapter, StreamConnectResult } from './streamSession';

/** One connection's event channels, per kind: `{ open: 'sse:open:<id>', … }`. */
export function connectionChannels<K extends string>(
  prefixes: Readonly<Record<K, string>>,
  connectionId: string
): Record<K, string> {
  const channels = {} as Record<K, string>;
  for (const kind of Object.keys(prefixes) as K[]) {
    channels[kind] = eventChannel(prefixes[kind], connectionId);
  }
  return channels;
}

/** The slice of a preload protocol bridge a stream's listeners go through. */
interface IpcEventBridge {
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeAllListeners: (channel: string) => void;
}

/** Desktop IPC adapter: per-kind event channels plus the bridge's connect/disconnect calls. */
export function createIpcStreamAdapter<K extends string>(
  bridge: IpcEventBridge,
  channels: Readonly<Record<K, string>>,
  transport: {
    connect: () => Promise<StreamConnectResult>;
    disconnect: () => Promise<unknown>;
  }
): StreamAdapter<K> {
  return {
    addListener: (kind, listener) =>
      bridge.on(channels[kind], listener as (...args: unknown[]) => void),
    removeListeners: () => {
      for (const channel of Object.values<string>(channels)) bridge.removeAllListeners(channel);
    },
    connect: transport.connect,
    disconnect: transport.disconnect,
  };
}

export type SseConnectConfig = Parameters<ElectronSseAPI['connect']>[0];
export type SseEventKind = keyof typeof EVENT_PREFIX.sse;

/** An `sse:connect` stream over the desktop bridge, as the SSE and graphql-sse consumers open it. */
export function createSseDesktopAdapter(
  sse: ElectronSseAPI,
  config: SseConnectConfig
): StreamAdapter<SseEventKind> {
  const { connectionId } = config;
  return createIpcStreamAdapter(sse, connectionChannels(EVENT_PREFIX.sse, connectionId), {
    connect: () => sse.connect(config),
    disconnect: () => sse.disconnect({ connectionId }),
  });
}
