import { Import } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useGlobalsStore } from '@/store/useGlobalsStore';
import { useHistoryStore } from '@/store/useHistoryStore';
import type { CollectionItem } from '@/types/collection';
import type { HttpRequest, Response as HttpResponse } from '@/types/http';
import {
  type CapturedRequest,
  capturedRequestsToCases,
  previewRedactions,
  secretValuesFromScopes,
} from '../lib/datasetFromHistory';
import { plural } from '../lib/plural';
import { useAiLabStore } from '../store/useAiLabStore';

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

/** Collect variables of every folder beneath a collection (nested folders included). */
function folderScopes(
  items: CollectionItem[],
  out: Array<ReadonlyArray<{ value: string }> | undefined>
): void {
  for (const item of items) {
    if (item.variables?.length) out.push(item.variables);
    if (item.items?.length) folderScopes(item.items, out);
  }
}

/**
 * Every known variable value across all scopes (a history entry may predate
 * the active environment): globals, every environment, and collection and folder
 * variables. Disabled variables are included; over-stripping is harmless.
 */
function collectSecretValues(): string[] {
  const scopes: Array<ReadonlyArray<{ value: string }> | undefined> = [
    Object.values(useGlobalsStore.getState().vars).map((value) => ({ value })),
  ];
  for (const env of useEnvironmentStore.getState().environments) scopes.push(env.variables);
  for (const collection of useCollectionStore.getState().collections) {
    scopes.push(collection.variables);
    folderScopes(collection.items, scopes);
  }
  return secretValuesFromScopes(scopes);
}

const clip = (text: string) => (text.length > 160 ? `${text.slice(0, 160)}…` : text);

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
  const [reviewing, setReviewing] = useState(false);

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

  const chosen = useMemo(() => candidates.filter((c) => picked.has(c.key)), [candidates, picked]);
  const secretValues = useMemo(() => (reviewing ? collectSecretValues() : []), [reviewing]);
  const changes = useMemo(
    () =>
      reviewing
        ? chosen.map((c) => ({
            label: c.label,
            diff: previewRedactions(c.captured, { secretValues }),
          }))
        : [],
    [reviewing, chosen, secretValues]
  );

  const create = () => {
    if (chosen.length === 0) {
      toast.error('Select at least one request.');
      return;
    }
    const cases = capturedRequestsToCases(
      chosen.map((c) => c.captured),
      { secretValues: collectSecretValues() }
    ).map((c, i) => ({
      id: `${Date.now()}-${i}`,
      ...c,
    }));
    const id = upsertDataset({ name: name.trim() || 'Imported dataset', cases });
    toast.success(`Imported ${plural(cases.length, 'case')}`);
    setOpen(false);
    setReviewing(false);
    setPicked(new Set());
    onCreated?.(id);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setReviewing(false);
      }}
    >
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
            variables and the captured response becomes the reference. Credentials, environment
            values and URL query/userinfo are redacted; review the changes before saving.
          </DialogDescription>
        </DialogHeader>
        {reviewing ? (
          <div className="max-h-[24rem] space-y-3 overflow-auto" aria-label="Redaction preview">
            {changes.every((c) => c.diff.length === 0) && (
              <p className="px-2 py-6 text-center text-sp-12 text-sp-muted">
                Nothing needed redacting in the selected requests.
              </p>
            )}
            {changes
              .filter((c) => c.diff.length > 0)
              .map((c) => (
                <div key={c.label} className="space-y-1 rounded-md border border-sp-line p-2">
                  <p className="truncate text-sp-12 font-medium text-sp-text">{c.label}</p>
                  {c.diff.map((d) => (
                    <div key={d.field} className="space-y-0.5 text-sp-11">
                      <span className="sp-label">{d.field}</span>
                      <p className="break-all font-mono text-sp-muted line-through">
                        {clip(d.before)}
                      </p>
                      <p className="break-all font-mono text-sp-text">{clip(d.after)}</p>
                    </div>
                  ))}
                </div>
              ))}
          </div>
        ) : (
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
                    <span className="ml-auto shrink-0 text-sp-11 text-sp-dim">{c.source}</span>
                  </label>
                ))
              )}
            </div>
          </div>
        )}
        <DialogFooter className="gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => (reviewing ? setReviewing(false) : setOpen(false))}
          >
            {reviewing ? 'Back' : 'Cancel'}
          </Button>
          {reviewing ? (
            <Button size="sm" onClick={create}>
              {`Save ${plural(picked.size, 'case')}`}
            </Button>
          ) : (
            <Button size="sm" onClick={() => setReviewing(true)} disabled={picked.size === 0}>
              Review redactions
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
