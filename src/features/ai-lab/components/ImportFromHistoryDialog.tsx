import { Import } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { capturedRequestsToCases, type CapturedRequest } from '../lib/datasetFromHistory';
import { plural } from '../lib/plural';
import { useAiLabStore } from '../store/useAiLabStore';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useHistoryStore } from '@/store/useHistoryStore';
import type { CollectionItem } from '@/types/collection';
import type { HttpRequest, Response as HttpResponse } from '@/types/http';

interface Candidate {
  key: string;
  label: string;
  source: 'history' | 'collection';
  captured: CapturedRequest;
}

/** Flatten a collection tree into its HTTP request items. */
function collectRequests(items: CollectionItem[], path: string, out: Candidate[]): void {
  for (const item of items) {
    if (item.type === 'request' && item.request?.type === 'http') {
      const req = item.request;
      out.push({
        key: `col:${item.id}`,
        label: `${req.method} ${item.name || req.url}`,
        source: 'collection',
        captured: { request: req },
      });
    }
    if (item.items?.length) collectRequests(item.items, `${path}/${item.name}`, out);
  }
}

/** Build eval cases from saved request history / collections (secrets redacted). */
export function ImportFromHistoryDialog({
  onCreated,
}: {
  onCreated?: (datasetId: string) => void;
}) {
  const upsertDataset = useAiLabStore((s) => s.upsertDataset);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('Imported dataset');
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const candidates = useMemo<Candidate[]>(() => {
    if (!open) return [];
    const out: Candidate[] = [];
    for (const h of useHistoryStore.getState().getHttpHistory()) {
      if (h.request.type !== 'http') continue;
      const req = h.request as HttpRequest;
      out.push({
        key: `hist:${h.id}`,
        label: `${req.method} ${req.url}`,
        source: 'history',
        captured: { request: req, ...(h.response ? { response: h.response as HttpResponse } : {}) },
      });
    }
    collectRequests(
      useCollectionStore.getState().collections.flatMap((c) => c.items),
      '',
      out
    );
    return out;
  }, [open]);

  const toggle = (key: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const create = () => {
    const chosen = candidates.filter((c) => picked.has(c.key));
    if (chosen.length === 0) {
      toast.error('Select at least one request.');
      return;
    }
    const cases = capturedRequestsToCases(chosen.map((c) => c.captured)).map((c, i) => ({
      id: `${Date.now()}-${i}`,
      ...c,
    }));
    const id = upsertDataset({ name: name.trim() || 'Imported dataset', cases });
    toast.success(`Imported ${plural(cases.length, 'case')}`);
    setOpen(false);
    setPicked(new Set());
    onCreated?.(id);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="w-full">
          <Import className="mr-2 h-3.5 w-3.5" /> From history
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader icon={Import}>
          <DialogTitle>Import dataset from history</DialogTitle>
          <DialogDescription>
            Build cases from saved requests. Each request&apos;s method/url/headers/body become case
            variables and the captured response becomes the reference. Secrets are redacted.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="sp-label">Dataset name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="max-h-[20rem] space-y-1 overflow-auto rounded-md border border-sp-line p-2">
            {candidates.length === 0 ? (
              <p className="px-2 py-6 text-center text-sp-12 text-sp-muted">
                No saved HTTP requests found in history or collections.
              </p>
            ) : (
              candidates.map((c) => (
                <label
                  key={c.key}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sp-12 hover:bg-sp-surface"
                >
                  <Checkbox checked={picked.has(c.key)} onCheckedChange={() => toggle(c.key)} />
                  <span className="truncate text-sp-text">{c.label}</span>
                  <span className="ml-auto shrink-0 text-sp-11 text-sp-text-dim">{c.source}</span>
                </label>
              ))
            )}
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button size="sm" variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={create} disabled={picked.size === 0}>
            {picked.size === 0 ? 'Import cases' : `Import ${plural(picked.size, 'case')}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
