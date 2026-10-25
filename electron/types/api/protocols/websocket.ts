// WebSocket IPC types (`window.electron.websocket`).

import type { ProtocolSecretValue } from './shared';

export interface ElectronWebSocketAPI {
  connect: (config: {
    connectionId: string;
    url: string;
    headers?: Record<string, string>;
    protocols?: string[];
    /**
     * Header-shaped auth descriptor whose SecretRef handle(s) the renderer
     * can't read; resolved main-side into the handshake (ADR-0007).
     * Validated by `WsConnectSchema` (AuthConfigSchema).
     */
    auth?: import('../../../../shared/types/auth').AuthConfig;
    /** SecretRef-backed `{{vars}}` referenced from url/headers/auth. */
    secretVariables?: Record<string, ProtocolSecretValue>;
    /** false disables the permessage-deflate offer (default true). */
    perMessageDeflate?: boolean;
  }) => Promise<{ success: boolean; error?: string }>;
  send: (config: {
    connectionId: string;
    message: string;
    binary?: boolean;
  }) => Promise<{ success: boolean; error?: string }>;
  /** Send a Ping control frame; `payload` is UTF-8 text, at most 125 bytes. */
  ping: (config: {
    connectionId: string;
    payload?: string;
  }) => Promise<{ success: boolean; error?: string }>;
  /** `code` must be 1000 or 3000-4999; `reason` at most 123 UTF-8 bytes. */
  disconnect: (config: {
    connectionId: string;
    code?: number;
    reason?: string;
  }) => Promise<{ success: boolean }>;
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeListener: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeAllListeners: (channel: string) => void;
}
