'use client';

import { cn } from '@/lib/shared/utils';
import { ConsoleEntry } from '@/store/useConsoleStore';
import { Badge } from '@/components/ui/badge';

interface RequestEntryItemProps {
  entry: ConsoleEntry;
  isSelected: boolean;
  onClick: () => void;
}

const methodColors: Record<string, string> = {
  GET: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
  POST: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30',
  PUT: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30',
  PATCH: 'bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/30',
  DELETE: 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30',
  OPTIONS: 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/30',
  HEAD: 'bg-gray-500/10 text-gray-600 dark:text-gray-400 border-gray-500/30',
};

const getStatusColor = (status: number) => {
  if (status >= 200 && status < 300) return 'text-emerald-600 dark:text-emerald-400';
  if (status >= 300 && status < 400) return 'text-blue-600 dark:text-blue-400';
  if (status >= 400 && status < 500) return 'text-amber-600 dark:text-amber-400';
  if (status >= 500) return 'text-red-600 dark:text-red-400';
  return 'text-muted-foreground';
};

const formatRelativeTime = (timestamp: number) => {
  const diff = Date.now() - timestamp;
  if (diff < 1000) return 'now';
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  return `${Math.floor(diff / 3600000)}h ago`;
};

const formatDuration = (ms: number) => {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
};

export default function RequestEntryItem({ entry, isSelected, onClick }: RequestEntryItemProps) {
  const { request, response, timestamp } = entry;
  const methodColor = methodColors[request.method] || methodColors.GET;
  const statusColor = getStatusColor(response.status);

  // Extract pathname from URL for display
  let displayUrl = request.url;
  try {
    const url = new URL(request.url);
    displayUrl = url.pathname + url.search;
    if (displayUrl.length > 40) {
      displayUrl = displayUrl.substring(0, 37) + '...';
    }
  } catch {
    if (displayUrl.length > 40) {
      displayUrl = displayUrl.substring(0, 37) + '...';
    }
  }

  return (
    <div
      onClick={onClick}
      className={cn(
        'px-3 py-2 cursor-pointer border-b border-border/50 hover:bg-accent/50 transition-colors',
        isSelected && 'bg-accent'
      )}
    >
      <div className="flex items-center gap-2 mb-1">
        <Badge variant="outline" className={cn('text-[10px] px-1.5 py-0 font-semibold', methodColor)}>
          {request.method}
        </Badge>
        <span className={cn('text-xs font-medium tabular-nums', statusColor)}>
          {response.status}
        </span>
        <span className="text-[10px] text-muted-foreground ml-auto">
          {formatRelativeTime(timestamp)}
        </span>
      </div>
      <div className="text-xs text-foreground/80 truncate font-mono">
        {displayUrl}
      </div>
      <div className="flex items-center gap-3 mt-1 text-[10px] text-muted-foreground">
        <span>{formatDuration(response.time)}</span>
        <span>{(response.size / 1024).toFixed(1)} KB</span>
      </div>
    </div>
  );
}
