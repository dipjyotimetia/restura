'use client';

import {
  Copy,
  ExternalLink,
  GitCompare,
  Pin,
  PinOff,
  RotateCw,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  formatBytes,
  formatRelativeTime,
  getMethodColor,
  getStatusTextColor,
  httpLikeStatus,
} from '@/lib/shared/console-format';
import { cn } from '@/lib/shared/utils';
import { useActiveTab } from '@/store/selectors';
import {
  type ConsoleEntry,
  entryToCurl,
  entryToHttpRequest,
  useConsoleStore,
} from '@/store/useConsoleStore';
import { useRequestStore } from '@/store/useRequestStore';

interface RequestEntryItemProps {
  entry: ConsoleEntry;
  isSelected: boolean;
  onClick: () => void;
  /** When true, render a compare-mode checkbox at the left edge of the row. */
  isCompareChecked?: boolean;
  /** Toggle this entry's membership in the compare set. */
  onToggleCompare?: () => void;
  /** When non-null, "Compare with selected" appears in the context menu. */
  onPinForCompare?: () => void;
  /** Slowest response time in the current list — scales the waterfall bar. */
  maxTime?: number;
  /** Requests slower than this (ms) get a "slow" marker. */
  slowThresholdMs?: number;
}

const formatDuration = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`);

export default function RequestEntryItem({
  entry,
  isSelected,
  onClick,
  isCompareChecked,
  onToggleCompare,
  onPinForCompare,
  maxTime,
  slowThresholdMs = 1000,
}: RequestEntryItemProps) {
  const { request, response, timestamp } = entry;
  const methodColor = getMethodColor(request.method);
  const displayStatus = httpLikeStatus(entry.protocol, response.status);
  const statusColor = getStatusTextColor(displayStatus);
  const removeEntry = useConsoleStore((s) => s.removeEntry);
  const togglePin = useConsoleStore((s) => s.togglePin);
  const openTab = useRequestStore((s) => s.openTab);

  const isSlow = response.time >= slowThresholdMs;
  const barPct = maxTime && maxTime > 0 ? Math.max(2, (response.time / maxTime) * 100) : 0;
  const passedTests = entry.tests?.filter((t) => t.passed).length ?? 0;
  const totalTests = entry.tests?.length ?? 0;
  const updateRequest = useRequestStore((s) => s.updateRequest);
  const activeTab = useActiveTab();

  // Extract pathname from URL for display — prefer the resolved URL (falls
  // back to the raw, possibly templated `request.url` for older entries).
  const fullUrl = entry.resolvedUrl ?? request.url;
  let displayUrl = fullUrl;
  try {
    const url = new URL(fullUrl);
    displayUrl = url.pathname + url.search;
    if (displayUrl.length > 40) {
      displayUrl = displayUrl.substring(0, 37) + '...';
    }
  } catch {
    if (displayUrl.length > 40) {
      displayUrl = displayUrl.substring(0, 37) + '...';
    }
  }

  const handleCopyCurl = async () => {
    try {
      await navigator.clipboard.writeText(entryToCurl(entry));
      toast.success('Copied as cURL');
    } catch {
      toast.error('Failed to copy');
    }
  };

  const handleCopyUrl = async () => {
    try {
      await navigator.clipboard.writeText(fullUrl);
      toast.success('URL copied');
    } catch {
      toast.error('Failed to copy');
    }
  };

  const handleOpenInNewTab = () => {
    const req = entryToHttpRequest(entry);
    openTab(req, { switchTo: true });
    toast.success('Opened in a new tab');
  };

  const handleReplaceActive = () => {
    // Only safe for HTTP tabs — other protocols have different request shapes.
    if (activeTab?.request.type !== 'http') {
      handleOpenInNewTab();
      return;
    }
    const req = entryToHttpRequest(entry);
    updateRequest({
      method: req.method,
      url: req.url,
      headers: req.headers,
      params: req.params,
      body: req.body,
      auth: req.auth,
    });
    toast.success('Replayed in active tab');
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          onClick={onClick}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onClick();
            }
          }}
          className={cn(
            'group/entry px-3 py-2 cursor-pointer border-b border-border/50 hover:bg-accent/50 transition-colors',
            isSelected && 'bg-accent',
            entry.pinned && 'bg-primary/[0.04]'
          )}
        >
          <div className="flex items-center gap-2 mb-1">
            {onToggleCompare && (
              <Checkbox
                checked={isCompareChecked ?? false}
                onCheckedChange={onToggleCompare}
                onClick={(e) => e.stopPropagation()}
                aria-label="Select for compare"
                className="h-3.5 w-3.5"
              />
            )}
            <Badge
              variant="outline"
              className={cn('text-[10px] px-1.5 py-0 font-semibold', methodColor)}
            >
              {request.method}
            </Badge>
            <span className={cn('text-xs font-medium tabular-nums', statusColor)}>
              {displayStatus || 'ERR'}
            </span>
            {entry.protocol && entry.protocol !== 'http' && (
              <Badge variant="outline" className="text-[9px] px-1 py-0 uppercase">
                {entry.protocol}
              </Badge>
            )}
            {isSlow && (
              <span title={`Slow (≥${slowThresholdMs}ms)`}>
                <Zap className="h-3 w-3 text-amber-500" />
              </span>
            )}
            {entry.pinned && <Pin className="h-3 w-3 text-primary fill-primary" />}
            {/* Quick actions — pin + remove, on hover. */}
            <div className="ml-auto flex items-center gap-0.5">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  togglePin(entry.id);
                }}
                className="opacity-0 group-hover/entry:opacity-100 p-0.5 rounded text-muted-foreground hover:text-foreground transition-opacity"
                aria-label={entry.pinned ? 'Unpin entry' : 'Pin entry'}
                title={entry.pinned ? 'Unpin' : 'Pin (keeps across clears)'}
              >
                {entry.pinned ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  removeEntry(entry.id);
                }}
                className="opacity-0 group-hover/entry:opacity-100 p-0.5 rounded text-muted-foreground hover:text-red-500 transition-opacity"
                aria-label="Remove entry"
                title="Remove"
              >
                <X className="h-3 w-3" />
              </button>
              <span className="text-[10px] text-muted-foreground group-hover/entry:hidden">
                {formatRelativeTime(timestamp)}
              </span>
            </div>
          </div>
          <div className="text-xs text-sp-muted truncate font-mono">{displayUrl}</div>
          {/* Waterfall bar — duration relative to the slowest entry in view. */}
          {barPct > 0 && (
            <div className="mt-1 h-1 rounded-full bg-muted overflow-hidden">
              <div
                className={cn(
                  'h-full rounded-full',
                  isSlow ? 'bg-red-500' : response.time < 200 ? 'bg-emerald-500' : 'bg-amber-500'
                )}
                style={{ width: `${barPct}%` }}
              />
            </div>
          )}
          <div className="flex items-center gap-3 mt-1 text-[10px] text-muted-foreground">
            <span className={cn(isSlow && 'text-amber-600 dark:text-amber-400')}>
              {formatDuration(response.time)}
            </span>
            {entry.requestSize != null && (
              <span title="Request size">↑ {formatBytes(entry.requestSize)}</span>
            )}
            <span title="Response size">↓ {formatBytes(response.size)}</span>
            {totalTests > 0 && (
              <span
                className={cn(
                  'font-mono tabular-nums',
                  passedTests === totalTests
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-red-600 dark:text-red-400'
                )}
                title="Test assertions"
              >
                {passedTests}/{totalTests} ✓
              </span>
            )}
            {entry.runLabel && (
              <span
                className="ml-auto truncate max-w-[90px] text-primary/70"
                title={`Run: ${entry.runLabel}`}
              >
                ⚡ {entry.runLabel}
              </span>
            )}
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuItem onClick={handleReplaceActive}>
          <RotateCw className="h-3.5 w-3.5 mr-2" />
          Replay in active tab
        </ContextMenuItem>
        <ContextMenuItem onClick={handleOpenInNewTab}>
          <ExternalLink className="h-3.5 w-3.5 mr-2" />
          Open in new tab
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={handleCopyCurl}>
          <Copy className="h-3.5 w-3.5 mr-2" />
          Copy as cURL
        </ContextMenuItem>
        <ContextMenuItem onClick={handleCopyUrl}>
          <Copy className="h-3.5 w-3.5 mr-2" />
          Copy URL
        </ContextMenuItem>
        {onPinForCompare && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={onPinForCompare}>
              <GitCompare className="h-3.5 w-3.5 mr-2" />
              {isCompareChecked ? 'Unselect for compare' : 'Select for compare'}
            </ContextMenuItem>
          </>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => togglePin(entry.id)}>
          {entry.pinned ? (
            <>
              <PinOff className="h-3.5 w-3.5 mr-2" />
              Unpin entry
            </>
          ) : (
            <>
              <Pin className="h-3.5 w-3.5 mr-2" />
              Pin entry
            </>
          )}
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() => removeEntry(entry.id)}
          className="text-red-500 focus:text-red-500"
        >
          <Trash2 className="h-3.5 w-3.5 mr-2" />
          Remove entry
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
