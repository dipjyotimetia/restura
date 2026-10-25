// Server-Sent Events IPC types (`window.electron.sse`).

import type { ProtocolSecretValue } from './shared';

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
  }) => Promise<{ success: boolean; error?: string }>;
  disconnect: (config: { connectionId: string }) => Promise<{ success: boolean }>;
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeListener: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeAllListeners: (channel: string) => void;
}
