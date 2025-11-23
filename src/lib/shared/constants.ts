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
