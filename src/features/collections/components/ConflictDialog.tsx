'use client';

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
import { AlertTriangle, FileText, Clock } from 'lucide-react';
import {
  ConflictInfo,
  useFileCollectionStore,
  loadCollectionFromDirectory,
  syncFileCollection,
} from '@/store/useFileCollectionStore';
import { useCollectionStore } from '@/store/useCollectionStore';

interface ConflictDialogProps {
  conflict: ConflictInfo | null;
  onClose: () => void;
}

export function ConflictDialog({ conflict, onClose }: ConflictDialogProps) {
  const [isLoading, setIsLoading] = useState(false);
  const removeConflict = useFileCollectionStore((state) => state.removeConflict);
  const getFileInfo = useFileCollectionStore((state) => state.getFileInfo);
  const deleteCollection = useCollectionStore((state) => state.deleteCollection);

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
        // Delete current collection
        deleteCollection(conflict.collectionId);
        // Reload from disk
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
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-yellow-500" />
            File Conflict Detected
          </DialogTitle>
          <DialogDescription>
            The file has been modified externally while you were editing. Choose how to resolve
            this conflict.
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
