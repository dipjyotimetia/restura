'use client';

import { cn } from '@/lib/shared/utils';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Check, AlertCircle, RefreshCw, FolderOpen, Loader2 } from 'lucide-react';
import { SyncState, useFileCollectionStore } from '@/store/useFileCollectionStore';

interface FileStatusBadgeProps {
  collectionId: string;
  className?: string;
  showTooltip?: boolean;
}

const stateConfig: Record<SyncState, { icon: React.ElementType; color: string; label: string }> = {
  synced: {
    icon: Check,
    color: 'text-green-500',
    label: 'Synced with files',
  },
  modified: {
    icon: RefreshCw,
    color: 'text-yellow-500',
    label: 'Changes pending sync',
  },
  conflict: {
    icon: AlertCircle,
    color: 'text-red-500',
    label: 'Conflict detected',
  },
  loading: {
    icon: Loader2,
    color: 'text-muted-foreground animate-spin',
    label: 'Syncing...',
  },
  error: {
    icon: AlertCircle,
    color: 'text-red-500',
    label: 'Sync error',
  },
};

export function FileStatusBadge({ collectionId, className, showTooltip = true }: FileStatusBadgeProps) {
  const fileInfo = useFileCollectionStore((state) => state.getFileInfo(collectionId));

  if (!fileInfo) {
    return null; // Not a file collection
  }

  const config = stateConfig[fileInfo.syncState];
  const Icon = config.icon;

  const badge = (
    <div className={cn('flex items-center gap-1', className)}>
      <FolderOpen className="h-3 w-3 text-muted-foreground" />
      <Icon className={cn('h-3 w-3', config.color)} />
    </div>
  );

  if (!showTooltip) {
    return badge;
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{badge}</TooltipTrigger>
        <TooltipContent side="right">
          <div className="text-xs">
            <div className="font-medium">{config.label}</div>
            {fileInfo.error && <div className="text-red-400 mt-1">{fileInfo.error}</div>}
            <div className="text-muted-foreground mt-1 truncate max-w-[200px]">
              {fileInfo.directoryPath}
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
