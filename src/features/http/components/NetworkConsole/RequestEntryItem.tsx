'use client';

import { cn } from '@/lib/shared/utils';
import {
  entryToCurl,
  entryToHttpRequest,
  useConsoleStore,
  type ConsoleEntry,
} from '@/store/useConsoleStore';
import { Badge } from '@/components/ui/badge';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Checkbox } from '@/components/ui/checkbox';
import { Copy, ExternalLink, GitCompare, RotateCw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useRequestStore } from '@/store/useRequestStore';
import { useActiveTab } from '@/store/selectors';
import {
  formatRelativeTime,
  getMethodColor,
  getStatusTextColor,
} from '@/lib/shared/console-format';

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
}

const formatDuration = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`);

export default function RequestEntryItem({
  entry,
  isSelected,
  onClick,
  isCompareChecked,
  onToggleCompare,
  onPinForCompare,
}: RequestEntryItemProps) {
  const { request, response, timestamp } = entry;
  const methodColor = getMethodColor(request.method);
  const statusColor = getStatusTextColor(response.status);
  const removeEntry = useConsoleStore((s) => s.removeEntry);
  const openTab = useRequestStore((s) => s.openTab);
  const updateRequest = useRequestStore((s) => s.updateRequest);
  const activeTab = useActiveTab();

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
      await navigator.clipboard.writeText(entry.request.url);
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
          onClick={onClick}
          className={cn(
            'px-3 py-2 cursor-pointer border-b border-border/50 hover:bg-accent/50 transition-colors',
            isSelected && 'bg-accent'
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
            <Badge variant="outline" className={cn('text-[10px] px-1.5 py-0 font-semibold', methodColor)}>
              {request.method}
            </Badge>
            <span className={cn('text-xs font-medium tabular-nums', statusColor)}>
              {response.status || 'ERR'}
            </span>
            {entry.protocol && entry.protocol !== 'http' && (
              <Badge variant="outline" className="text-[9px] px-1 py-0 uppercase">
                {entry.protocol}
              </Badge>
            )}
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
