'use client';

import { AlertTriangle, Clock, FileText } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { ConflictState } from '@/store/useFileCollectionStore';
import {
  loadCollectionFromDirectory,
  syncFileCollection,
  useFileCollectionStore,
} from '@/store/useFileCollectionStore';

interface ConflictDialogProps {
  conflict: ConflictState | null;
  onClose: () => void;
}

export function ConflictDialog({ conflict, onClose }: ConflictDialogProps) {
  const [isLoading, setIsLoading] = useState(false);
  const removeConflict = useFileCollectionStore((state) => state.removeConflict);
  const getFileInfo = useFileCollectionStore((state) => state.getFileInfo);

  if (!conflict) return null;

  const handleKeepLocal = async () => {
    setIsLoading(true);
    try {
      // Save local version to disk
      await syncFileCollection(conflict.collectionId);
      removeConflict(conflict.collectionId, conflict.itemId);
      onClose();
    } finally {
      setIsLoading(false);
    }
  };

  const handleLoadExternal = async () => {
    setIsLoading(true);
    try {
      const fileInfo = getFileInfo(conflict.collectionId);
      if (fileInfo) {
        // Reload replaces the existing collection in place, preserving tab and
        // file-registry identity.
        await loadCollectionFromDirectory(fileInfo.directoryPath);
      }
      removeConflict(conflict.collectionId, conflict.itemId);
      onClose();
    } finally {
      setIsLoading(false);
    }
  };

  const formatTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleString();
  };

  return (
    <Dialog open={!!conflict} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader icon={AlertTriangle} tone="warning">
          <DialogTitle>File Conflict Detected</DialogTitle>
          <DialogDescription>
            The file has been modified externally while you were editing. Choose how to resolve this
            conflict.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="flex items-start gap-3 p-3 rounded-md bg-muted">
            <FileText className="h-4 w-4 mt-0.5 text-muted-foreground" />
            <div className="flex-1 min-w-0">
              <div className="font-medium truncate">{conflict.itemName}</div>
              <div className="text-xs text-muted-foreground truncate">{conflict.filePath}</div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 text-sm">
            <div className="space-y-1">
              <div className="font-medium">Your version</div>
              <div className="flex items-center gap-1 text-muted-foreground">
                <Clock className="h-3 w-3" />
                {formatTime(conflict.localModified)}
              </div>
            </div>
            <div className="space-y-1">
              <div className="font-medium">External version</div>
              <div className="flex items-center gap-1 text-muted-foreground">
                <Clock className="h-3 w-3" />
                {formatTime(conflict.externalModified)}
              </div>
            </div>
          </div>

          {conflict.message && (
            <div className="text-sm text-muted-foreground">{conflict.message}</div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={handleLoadExternal} disabled={isLoading}>
            Load external
          </Button>
          <Button onClick={handleKeepLocal} disabled={isLoading}>
            {isLoading ? 'Saving...' : 'Keep local'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
