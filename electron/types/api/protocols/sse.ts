// Server-Sent Events IPC types (`window.electron.sse`).

import type { ProtocolSecretValue } from './shared';

/**
 * `sse:close:<id>` payload. `fatal` marks the WHATWG "fail the connection"
 * cases (non-2xx, 204, wrong Content-Type) — the renderer must not
 * auto-reconnect. `lastEventId` / `retry` are the parser's stream state at
 * close, which data-less `id:` / `retry:` blocks may have moved without any
 * event crossing IPC; the renderer resumes from them.
 */
export interface SseClosePayload {
  reason: string;
  fatal?: boolean;
  lastEventId?: string;
  retry?: number;
}

export interface ElectronSseAPI {
  connect: (config: {
    connectionId: string;
    url: string;
    headers?: Record<string, string>;
    /** graphql-sse: header-shaped auth with SecretRef handles, resolved main-side (ADR-0007). */
    auth?: import('../../../../shared/types/auth').AuthConfig;
    /** graphql-sse: SecretRef-backed `{{vars}}` referenced from url/headers/auth. */
    secretVariables?: Record<string, ProtocolSecretValue>;
    /** POST this JSON body instead of a plain GET (GraphQL over SSE). */
    jsonBody?: string;
    /** Header names removed on a redirect to another origin (auth-added ones). */
    stripOnOriginChange?: string[];
  }) => Promise<{ success: boolean; error?: string }>;
  disconnect: (config: { connectionId: string }) => Promise<{ success: boolean }>;
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeListener: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeAllListeners: (channel: string) => void;
}
