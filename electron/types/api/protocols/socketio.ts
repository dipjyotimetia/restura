// Socket.IO IPC types (`window.electron.socketio`).

export interface SocketIoConnectIpcConfig {
  connectionId: string;
  url: string;
  namespace?: string;
  path?: string;
  auth?: Record<string, string | number | boolean>;
  query?: Record<string, string>;
  extraHeaders?: Record<string, string>;
  transports?: Array<'websocket' | 'polling'>;
  reconnection?: boolean;
  reconnectionAttempts?: number;
  reconnectionDelay?: number;
  timeout?: number;
  forceNew?: boolean;
}

export interface SocketIoEmitIpcConfig {
  connectionId: string;
  eventName: string;
  args: unknown[];
  ackId?: string;
  ackTimeoutMs?: number;
}

export interface ElectronSocketIoAPI {
  connect: (config: SocketIoConnectIpcConfig) => Promise<{ success: boolean; error?: string }>;
  emit: (config: SocketIoEmitIpcConfig) => Promise<{ success: boolean; error?: string }>;
  disconnect: (config: { connectionId: string }) => Promise<{ success: boolean }>;
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeListener: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeAllListeners: (channel: string) => void;
}
