import { useEffect, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { FolderPlus } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useRequestStore } from '@/store/useRequestStore';
import { useCollectionStore } from '@/store/useCollectionStore';

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
  const [newCollectionName, setNewCollectionName] = useState('');
  const [requestName, setRequestName] = useState(tab?.request.name ?? 'New Request');
  const [mode, setMode] = useState<'existing' | 'new'>(collections.length > 0 ? 'existing' : 'new');

  // Reset form state each time the dialog opens
  useEffect(() => {
    if (open) {
      setRequestName(tab?.request.name ?? 'New Request');
      setMode(collections.length > 0 ? 'existing' : 'new');
      setSelectedCollectionId('');
      setNewCollectionName('');
    }
    // collections.length intentionally omitted — only re-run when open changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!tab) return null;

  const handleSave = () => {
    let collectionId: string;

    if (mode === 'new') {
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
    addItemToCollection(collectionId, {
      id: itemId,
      name,
      type: 'request',
      request: { ...tab.request, name },
    });
    linkTabToSavedRequest(tabId, itemId);
    onOpenChange(false);
  };

  const canSave =
    mode === 'new' ? newCollectionName.trim().length > 0 : selectedCollectionId.length > 0;

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
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Collection</Label>
            {collections.length > 0 && (
              <div className="flex gap-2 mb-2">
                <Button
                  size="sm"
                  variant={mode === 'existing' ? 'default' : 'outline'}
                  className="h-7 text-xs flex-1"
                  onClick={() => setMode('existing')}
                >
                  Existing
                </Button>
                <Button
                  size="sm"
                  variant={mode === 'new' ? 'default' : 'outline'}
                  className="h-7 text-xs flex-1"
                  onClick={() => setMode('new')}
                >
                  New
                </Button>
              </div>
            )}

            {mode === 'existing' ? (
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
