// Method color mapping for HTTP method badges
export const METHOD_COLORS: Record<string, string> = {
  GET: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20',
  POST: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20',
  PUT: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20',
  DELETE: 'bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20',
  PATCH: 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-500/20',
  OPTIONS: 'bg-muted text-muted-foreground border border-border',
  HEAD: 'bg-muted text-muted-foreground border border-border',
};

// Response status color mapping
export const STATUS_COLORS = {
  success: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  error: 'bg-red-500/10 text-red-600 dark:text-red-400',
  warning: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
};

// Sidebar dimensions
export const SIDEBAR_WIDTH = {
  collapsed: 'w-16',
  expanded: 'w-64 lg:w-72 xl:w-80',
};

// Per-protocol display label (for non-HTTP request types where there's no method to badge)
export const PROTOCOL_LABELS: Record<string, string> = {
  http: 'HTTP',
  grpc: 'gRPC',
  graphql: 'GQL',
  websocket: 'WS',
  sse: 'SSE',
  mcp: 'MCP',
};

// Per-protocol badge color, used in the sidebar request list and history
export const PROTOCOL_COLORS: Record<string, string> = {
  http: 'bg-muted text-muted-foreground border border-border',
  grpc: 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border border-cyan-500/20',
  graphql: 'bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-400 border border-fuchsia-500/20',
  websocket: 'bg-violet-500/10 text-violet-600 dark:text-violet-400 border border-violet-500/20',
  sse: 'bg-orange-500/10 text-orange-600 dark:text-orange-400 border border-orange-500/20',
  mcp: 'bg-teal-500/10 text-teal-600 dark:text-teal-400 border border-teal-500/20',
};

// Connection-status badge color, shared by streaming protocol UIs (SSE, MCP, etc.).
// 'reconnecting' shares the connecting palette; 'error' shares the destructive palette.
export const CONNECTION_STATUS_COLORS: Record<string, string> = {
  disconnected: 'bg-muted text-muted-foreground',
  connecting: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20',
  reconnecting: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20',
  connected: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20',
  error: 'bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20',
};
