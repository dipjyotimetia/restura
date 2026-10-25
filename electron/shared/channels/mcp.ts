// IPC channels: MCP client.
// Composed into IPC / EVENT / EVENT_PREFIX by ../channels.ts.

export const MCP_IPC = {
  mcp: {
    connect: 'mcp:connect',
    request: 'mcp:request',
    cancel: 'mcp:cancel',
    disconnect: 'mcp:disconnect',
    /** Clear every persisted stdio launch approval (narrows privilege only). */
    revokeStdioApprovals: 'mcp:stdio:revoke-approvals',
    /** Renderer → main answer to a server→client request (elicitation / sampling). */
    clientResponse: 'mcp:client-response',
    /** Replace a connection's roots; sends notifications/roots/list_changed. */
    setRoots: 'mcp:set-roots',
    oauthStatus: 'mcp:oauth:status',
    oauthSignOut: 'mcp:oauth:signOut',
    /** Read well-known MCP client configs or a user-picked file in main (#906). */
    importScan: 'mcp:import:scan',
    /** Turn a scan selection into drafts; secret env values become handles in main (#906). */
    importCommit: 'mcp:import:commit',
    conformance: 'mcp:conformance',
  },
} as const;

export const MCP_EVENT_PREFIX = {
  mcp: {
    open: 'mcp:open:',
    notification: 'mcp:notification:',
    error: 'mcp:error:',
    close: 'mcp:close:',
    /** Bounded stderr text from a stdio server process (desktop only). */
    stderr: 'mcp:stderr:',
    /** Main → renderer: a server→client request awaiting the user (elicitation / sampling). */
    clientRequest: 'mcp:client-request:',
    /** Main → renderer: a pending client request was cancelled, timed out, or its connection closed. */
    clientRequestCancelled: 'mcp:client-request-cancelled:',
  },
} as const;
