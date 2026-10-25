// MCP client IPC types (`window.electron.mcp`).

/** SecretRef-shaped env value for a stdio MCP server; handles resolve in main. */
export type McpStdioEnvValueIpc =
  | string
  | { kind: 'inline'; value: string }
  | { kind: 'handle'; id: string; label?: string };

export type McpConnectIpcConfig =
  | {
      connectionId: string;
      url: string;
      transport: 'streamable-http' | 'http-sse';
      headers?: Record<string, string>;
      /**
       * Header-shaped connection auth (#896). SecretRef handles are resolved in
       * Electron main at connect time — the renderer never sees the plaintext.
       */
      auth?: import('../../../../shared/types/auth').AuthConfig;
    }
  | {
      connectionId: string;
      transport: 'stdio';
      command: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, McpStdioEnvValueIpc>;
    };

export interface McpOAuthStatusIpc {
  signedIn: boolean;
  canRefresh: boolean;
  expiresAt?: number;
  scope?: string;
  dynamicallyRegistered: boolean;
}

export interface McpImportScanResult {
  /** Null when the user cancelled the picker or nothing was found. */
  sessionId: string | null;
  sources: import('../../../../shared/mcp-import/mcp-import-model').McpImportPreviewSource[];
}

export interface McpImportCommitResult {
  drafts: import('../../../../shared/mcp-import/mcp-import-model').McpImportDraft[];
  skipped: Array<{ key: string; name: string; reason: string }>;
}

export interface ElectronMcpAPI {
  connect: (config: McpConnectIpcConfig) => Promise<{
    success: boolean;
    error?: string;
    /** #856: the OAuth sign-in lapsed and can't refresh — prompt to sign in again. */
    authRequired?: boolean;
  }>;
  request: (config: {
    connectionId: string;
    method: string;
    params?: unknown;
    requestId?: string | number;
    timeout?: number;
  }) => Promise<{
    success: boolean;
    result?: unknown;
    error?: string;
    jsonRpcError?: { code: number; message: string; data?: unknown };
    /** #856: the OAuth sign-in lapsed and can't refresh — prompt to sign in again. */
    authRequired?: boolean;
    /** True when the request was aborted via `cancel` (distinct from an error). */
    cancelled?: boolean;
  }>;
  /** Abort one in-flight request; the SDK sends `notifications/cancelled`. */
  cancel: (config: {
    connectionId: string;
    requestId: string | number;
  }) => Promise<{ success: boolean }>;
  disconnect: (config: { connectionId: string }) => Promise<{ success: boolean }>;
  /** Forget every "Always allow" stdio launch approval. */
  revokeStdioApprovals: () => Promise<{ success: boolean; revoked: number }>;
  /** Answer a server→client request delivered on `mcp:client-request:<connectionId>` (#860). */
  respondClientRequest: (
    response: McpClientResponseIpc
  ) => Promise<
    { success: true } | { success: false; error: string; fieldErrors?: Record<string, string> }
  >;
  /** Replace the connection's roots; live sessions get notifications/roots/list_changed. */
  setRoots: (config: {
    connectionId: string;
    roots: McpRootIpc[];
  }) => Promise<{ success: true; notified: number } | { success: false; error: string }>;
  /** MCP OAuth 2.1 (#856): plaintext-free sign-in status (+ static client id); no tokens. */
  oauthStatus: (target: { url: string; clientId?: string }) => Promise<McpOAuthStatusIpc>;
  /** Forget the stored MCP OAuth tokens / registration for a server. */
  oauthSignOut: (target: { url: string; clientId?: string }) => Promise<{ success: boolean }>;
  /** Scan well-known MCP client configs, or a file the user picks in a main-owned dialog. */
  importScan: (input: { source: 'detect' | 'pick' }) => Promise<McpImportScanResult>;
  /** Create drafts for the selected scan entries; secret env values are stored as handles in main. */
  importCommit: (input: { sessionId: string; keys: string[] }) => Promise<McpImportCommitResult>;
  /** Era/conformance run (#911); the report is JSON-safe (`McpConformanceReport`). */
  conformance: (config: {
    url: string;
    transport: 'streamable-http' | 'http-sse';
    headers?: Record<string, string>;
    /** Header-shaped auth, resolved in main exactly as for `connect`. */
    auth?: import('../../../../shared/types/auth').AuthConfig;
    sampleCalls?: 'off' | 'read-only' | 'selected';
    approvedTools?: string[];
    eras?: Array<'legacy' | 'modern'>;
  }) => Promise<
    | {
        success: true;
        report: import('../../../../shared/protocol/mcp-conformance').McpConformanceReport;
      }
    | { success: false; error: string }
  >;
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeListener: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeAllListeners: (channel: string) => void;
}

export interface McpRootIpc {
  uri: string;
  name?: string;
}

export type McpClientResponseIpc =
  | {
      kind: 'elicitation';
      connectionId: string;
      requestId: string;
      response:
        | { action: 'accept'; content: Record<string, string | number | boolean | string[]> }
        | { action: 'decline' }
        | { action: 'cancel' };
    }
  | {
      kind: 'sampling';
      connectionId: string;
      requestId: string;
      response: { action: 'approve'; text: string; model: string } | { action: 'reject' };
    };
