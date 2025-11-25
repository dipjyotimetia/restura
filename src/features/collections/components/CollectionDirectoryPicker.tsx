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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FolderOpen, FolderPlus } from 'lucide-react';
import {
  selectCollectionDirectory,
  loadCollectionFromDirectory,
  exportCollectionToFiles,
  isElectronEnvironment,
} from '@/store/useFileCollectionStore';
import { useCollectionStore } from '@/store/useCollectionStore';

interface CollectionDirectoryPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'open' | 'save';
  collectionId?: string; // For save mode - which collection to export
  onSuccess?: (collectionId: string) => void;
}

export function CollectionDirectoryPicker({
  open,
  onOpenChange,
  mode,
  collectionId,
  onSuccess,
}: CollectionDirectoryPickerProps) {
  const [directoryPath, setDirectoryPath] = useState('');
  const [collectionName, setCollectionName] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createNewCollection = useCollectionStore((state) => state.createNewCollection);
  const addCollection = useCollectionStore((state) => state.addCollection);
  const getCollectionById = useCollectionStore((state) => state.getCollectionById);

  const handleSelectDirectory = async () => {
    const selected = await selectCollectionDirectory();
    if (selected) {
      setDirectoryPath(selected);
      setError(null);

      // Auto-fill collection name from directory
      if (mode === 'open') {
        const name = selected.split('/').pop() || selected.split('\\').pop() || 'Collection';
        setCollectionName(name.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()));
      }
    }
  };

  const handleConfirm = async () => {
    if (!directoryPath) {
      setError('Please select a directory');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      if (mode === 'open') {
        // Load collection from directory
        const result = await loadCollectionFromDirectory(directoryPath);
        if (result.success && result.collection) {
          onSuccess?.(result.collection.id);
          onOpenChange(false);
          resetState();
        } else {
          setError(result.error || 'Failed to load collection');
        }
      } else if (mode === 'save' && collectionId) {
        // Export existing collection to directory
        const result = await exportCollectionToFiles(collectionId, directoryPath);
        if (result.success) {
          onSuccess?.(collectionId);
          onOpenChange(false);
          resetState();
        } else {
          setError(result.error || 'Failed to export collection');
        }
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreateNew = async () => {
    if (!directoryPath) {
      setError('Please select a directory');
      return;
    }

    if (!collectionName.trim()) {
      setError('Please enter a collection name');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      // Create new collection
      const collection = createNewCollection(collectionName.trim());
      addCollection(collection);

      // Export to directory
      const result = await exportCollectionToFiles(collection.id, directoryPath);
      if (result.success) {
        onSuccess?.(collection.id);
        onOpenChange(false);
        resetState();
      } else {
        setError(result.error || 'Failed to create collection');
      }
    } finally {
      setIsLoading(false);
    }
  };

  const resetState = () => {
    setDirectoryPath('');
    setCollectionName('');
    setError(null);
  };

  if (!isElectronEnvironment()) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>File Collections</DialogTitle>
            <DialogDescription>
              File-based collections are only available in the desktop app.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) resetState();
        onOpenChange(value);
      }}
    >
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {mode === 'open' ? (
              <>
                <FolderOpen className="h-5 w-5" />
                Open Collection from Folder
              </>
            ) : (
              <>
                <FolderPlus className="h-5 w-5" />
                Save Collection to Folder
              </>
            )}
          </DialogTitle>
          <DialogDescription>
            {mode === 'open'
              ? 'Select a folder containing a collection to open. The folder should contain a _collection.yaml file.'
              : 'Select a folder to save this collection as YAML files for Git version control.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label>Directory</Label>
            <div className="flex gap-2">
              <Input
                value={directoryPath}
                onChange={(e) => setDirectoryPath(e.target.value)}
                placeholder="/path/to/collection"
                className="flex-1"
              />
              <Button variant="outline" onClick={handleSelectDirectory}>
                Browse
              </Button>
            </div>
          </div>

          {mode === 'open' && (
            <div className="space-y-2">
              <Label>Collection Name (optional)</Label>
              <Input
                value={collectionName}
                onChange={(e) => setCollectionName(e.target.value)}
                placeholder="Will use folder name if empty"
              />
            </div>
          )}

          {mode === 'save' && collectionId && (
            <div className="p-3 rounded-md bg-muted text-sm">
              Saving: <span className="font-medium">{getCollectionById(collectionId)?.name}</span>
            </div>
          )}

          {error && <div className="text-sm text-red-500">{error}</div>}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {mode === 'open' && !directoryPath && (
            <Button onClick={handleCreateNew} disabled={isLoading || !collectionName.trim()}>
              <FolderPlus className="h-4 w-4 mr-2" />
              Create New
            </Button>
          )}
          <Button onClick={handleConfirm} disabled={isLoading || !directoryPath}>
            {isLoading ? 'Loading...' : mode === 'open' ? 'Open' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
