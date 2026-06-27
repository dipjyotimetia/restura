import { FolderPlus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useRequestStore } from '@/store/useRequestStore';
import type { CollectionItem } from '@/types';

interface FolderEntry {
  id: string;
  name: string;
  depth: number;
}

function flatFolders(items: CollectionItem[], depth = 0): FolderEntry[] {
  return items.flatMap((i) =>
    i.type === 'folder'
      ? [{ id: i.id, name: i.name, depth }, ...flatFolders(i.items ?? [], depth + 1)]
      : []
  );
}

interface SaveToCollectionDialogProps {
  tabId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SaveToCollectionDialog({ tabId, open, onOpenChange }: SaveToCollectionDialogProps) {
  const tab = useRequestStore((s) => s.tabs.find((t) => t.id === tabId));
  const linkTabToSavedRequest = useRequestStore((s) => s.linkTabToSavedRequest);
  const { collections, addItemToCollection, createNewCollection, addCollection } =
    useCollectionStore();

  const [selectedCollectionId, setSelectedCollectionId] = useState('');
  const [selectedFolderId, setSelectedFolderId] = useState('');
  const [newCollectionName, setNewCollectionName] = useState('');
  const [requestName, setRequestName] = useState(tab?.request.name ?? 'New Request');
  const [mode, setMode] = useState<'existing' | 'new'>(collections.length > 0 ? 'existing' : 'new');

  // Reset form state each time the dialog opens
  useEffect(() => {
    if (open) {
      setRequestName(tab?.request.name ?? 'New Request');
      setMode(collections.length > 0 ? 'existing' : 'new');
      setSelectedCollectionId('');
      setSelectedFolderId('');
      setNewCollectionName('');
    }
    // collections.length intentionally omitted — only re-run when open changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Reset folder selection when collection changes
  useEffect(() => {
    setSelectedFolderId('');
  }, [selectedCollectionId]);

  if (!tab) return null;

  // Derive effective mode: if all collections were deleted while dialog is open,
  // fall back to 'new' so the user isn't stuck with no way to save.
  const effectiveMode = mode === 'existing' && collections.length === 0 ? 'new' : mode;

  const selectedCollection = collections.find((c) => c.id === selectedCollectionId);
  const folders = selectedCollection ? flatFolders(selectedCollection.items) : [];

  const handleSave = () => {
    let collectionId: string;

    if (effectiveMode === 'new') {
      if (!newCollectionName.trim()) return;
      const col = createNewCollection(newCollectionName.trim());
      addCollection(col);
      collectionId = col.id;
    } else {
      if (!selectedCollectionId) return;
      collectionId = selectedCollectionId;
    }

    const itemId = uuidv4();
    const name = requestName.trim() || tab.request.name;
    // Validate that the selected folder still exists — it may have been deleted
    // while the dialog was open, or selectedFolderId may be stale from a prior
    // 'existing' mode selection before the user switched to 'new'.
    const safeFolderId =
      selectedFolderId && folders.some((f) => f.id === selectedFolderId)
        ? selectedFolderId
        : undefined;
    addItemToCollection(
      collectionId,
      {
        id: itemId,
        name,
        type: 'request',
        request: { ...tab.request, name },
      },
      safeFolderId
    );
    linkTabToSavedRequest(tabId, itemId);
    onOpenChange(false);
  };

  const canSave =
    effectiveMode === 'new' ? newCollectionName.trim().length > 0 : selectedCollectionId.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader icon={FolderPlus}>
          <DialogTitle>Save to Collection</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label className="text-xs">Request name</Label>
            <Input
              value={requestName}
              onChange={(e) => setRequestName(e.target.value)}
              className="h-8 text-sm"
              placeholder="Request name"
              // eslint-disable-next-line jsx-a11y/no-autofocus -- intentional initial focus on the primary field when the dialog opens
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Collection</Label>
            {collections.length > 0 && (
              <div className="flex gap-2 mb-2">
                <Button
                  size="sm"
                  variant={effectiveMode === 'existing' ? 'default' : 'outline'}
                  className="h-7 text-xs flex-1"
                  onClick={() => setMode('existing')}
                >
                  Existing
                </Button>
                <Button
                  size="sm"
                  variant={effectiveMode === 'new' ? 'default' : 'outline'}
                  className="h-7 text-xs flex-1"
                  onClick={() => {
                    setMode('new');
                    setSelectedFolderId('');
                  }}
                >
                  New
                </Button>
              </div>
            )}

            {effectiveMode === 'existing' ? (
              <Select value={selectedCollectionId} onValueChange={setSelectedCollectionId}>
                <SelectTrigger className="h-8 text-sm">
                  <SelectValue placeholder="Choose a collection…" />
                </SelectTrigger>
                <SelectContent>
                  {collections.map((col) => (
                    <SelectItem key={col.id} value={col.id} className="text-sm">
                      {col.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                value={newCollectionName}
                onChange={(e) => setNewCollectionName(e.target.value)}
                className="h-8 text-sm"
                placeholder="New collection name"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && canSave) handleSave();
                }}
              />
            )}
          </div>

          {effectiveMode === 'existing' && folders.length > 0 && (
            <div className="space-y-1.5">
              <Label className="text-xs">Folder (optional)</Label>
              <Select value={selectedFolderId} onValueChange={setSelectedFolderId}>
                <SelectTrigger className="h-8 text-sm">
                  <SelectValue placeholder="Collection root" />
                </SelectTrigger>
                <SelectContent>
                  {folders.map(({ id, name, depth }) => (
                    <SelectItem key={id} value={id} className="text-sm">
                      <span style={{ paddingLeft: depth * 12 }}>
                        {'/ '}
                        {name}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={!canSave}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
