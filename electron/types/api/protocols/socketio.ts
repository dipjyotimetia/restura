// Socket.IO IPC types (`window.electron.socketio`).

export interface SocketIoConnectIpcConfig {
  connectionId: string;
  url: string;
  namespace?: string;
  path?: string;
  /** Any JSON-serialisable handshake auth object (nested values allowed). */
  auth?: Record<string, unknown>;
  query?: Record<string, string>;
  extraHeaders?: Record<string, string>;
  transports?: Array<'websocket' | 'polling'>;
  reconnection?: boolean;
  reconnectionAttempts?: number;
  reconnectionDelay?: number;
  reconnectionDelayMax?: number;
  randomizationFactor?: number;
  timeout?: number;
  forceNew?: boolean;
}

export interface SocketIoEmitIpcConfig {
  connectionId: string;
  eventName: string;
  args: unknown[];
  ackId?: string;
  ackTimeoutMs?: number;
  /** `socket.volatile` — drop the emit if the transport isn't writable. */
  volatile?: boolean;
  /** `false` → `socket.compress(false)`. */
  compress?: boolean;
}

/** Reply to a server-requested acknowledgement surfaced as `serverAckId` on an event. */
export interface SocketIoReplyAckIpcConfig {
  connectionId: string;
  serverAckId: string;
  args: unknown[];
}

export interface ElectronSocketIoAPI {
  connect: (config: SocketIoConnectIpcConfig) => Promise<{ success: boolean; error?: string }>;
  emit: (config: SocketIoEmitIpcConfig) => Promise<{ success: boolean; error?: string }>;
  replyAck: (config: SocketIoReplyAckIpcConfig) => Promise<{ success: boolean; error?: string }>;
  disconnect: (config: { connectionId: string }) => Promise<{ success: boolean }>;
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeListener: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeAllListeners: (channel: string) => void;
}
