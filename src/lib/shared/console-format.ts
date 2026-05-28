/**
 * Formatting + colour helpers shared by every console subcomponent
 * (NetworkTab, FramesTab, DiskTab, RequestEntryItem, EntryCompareDialog).
 * Co-located here so the same status/method palette is used everywhere.
 */

export const methodColors: Record<string, string> = {
  GET: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
  POST: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30',
  PUT: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30',
  PATCH: 'bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/30',
  DELETE: 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30',
  OPTIONS: 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/30',
  HEAD: 'bg-gray-500/10 text-gray-600 dark:text-gray-400 border-gray-500/30',
};

export function getMethodColor(method: string): string {
  return methodColors[method] ?? methodColors.GET!;
}

/** Background + border classes for a status-pill badge. */
export function getStatusBadgeColor(status: number): string {
  if (status >= 200 && status < 300) return 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30';
  if (status >= 300 && status < 400) return 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30';
  if (status >= 400 && status < 500) return 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30';
  if (status >= 500) return 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30';
  return 'bg-gray-500/10 text-gray-600 dark:text-gray-400 border-gray-500/30';
}

/** Text-only colour classes — used in list rows where the badge background is the row's selection state. */
export function getStatusTextColor(status: number): string {
  if (status === 0) return 'text-red-600 dark:text-red-400';
  if (status >= 200 && status < 300) return 'text-emerald-600 dark:text-emerald-400';
  if (status >= 300 && status < 400) return 'text-blue-600 dark:text-blue-400';
  if (status >= 400 && status < 500) return 'text-amber-600 dark:text-amber-400';
  if (status >= 500) return 'text-red-600 dark:text-red-400';
  return 'text-muted-foreground';
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** HH:MM:SS.fff in 24h locale — for entry timestamps within the console panes. */
export function formatClockTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  });
}

/** "Mar 14, 21:03:08" — for entries old enough that a calendar date matters (disk log / compare). */
export function formatLongTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString('en-US', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/** Short relative time ("3s ago" / "5m ago" / "2h ago" / "3d ago" / "2w ago"). */
export function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 1000) return 'now';
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return `${Math.floor(diff / 604_800_000)}w ago`;
}

/** Best-effort syntax highlighting hint for the response viewer. */
export function detectLanguage(body: string, headers?: Record<string, string | string[]>): string {
  if (headers) {
    const ct = headers['content-type'] || headers['Content-Type'] || '';
    const value = Array.isArray(ct) ? ct[0] : ct;
    if (value?.includes('json')) return 'json';
    if (value?.includes('xml')) return 'xml';
    if (value?.includes('html')) return 'html';
    if (value?.includes('javascript')) return 'javascript';
    if (value?.includes('css')) return 'css';
  }
  const trimmed = body.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json';
  if (trimmed.startsWith('<')) return 'xml';
  return 'text';
}
