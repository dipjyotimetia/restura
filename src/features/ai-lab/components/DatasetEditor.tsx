import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useAiLabStore } from '../store/useAiLabStore';
import { OpenApiGenDialog } from './OpenApiGenDialog';
import type { DatasetCase } from '../types';

/**
 * Cases are edited as a JSON array of { vars, expected?, reference? } — compact
 * and good enough for the workbench. Ids are minted/preserved on save.
 */
export function DatasetEditor() {
  const datasets = useAiLabStore((s) => s.datasets);
  const upsertDataset = useAiLabStore((s) => s.upsertDataset);
  const removeDataset = useAiLabStore((s) => s.removeDataset);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [casesText, setCasesText] = useState('[]');

  const active = activeId ? datasets[activeId] : undefined;

  useEffect(() => {
    if (active) {
      setName(active.name);
      setCasesText(
        JSON.stringify(
          active.cases.map(({ id: _id, ...rest }) => rest),
          null,
          2
        )
      );
    }
  }, [active]);

  const createNew = () => {
    const id = upsertDataset({ name: 'New dataset', cases: [] });
    setActiveId(id);
  };

  const save = () => {
    if (!activeId) return;
    let parsed: Array<Omit<DatasetCase, 'id'>>;
    try {
      parsed = JSON.parse(casesText) as Array<Omit<DatasetCase, 'id'>>;
      if (!Array.isArray(parsed)) throw new Error('not an array');
    } catch (e) {
      toast.error(`Invalid cases JSON: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const cases: DatasetCase[] = parsed.map((c, i) => ({
      id: active?.cases[i]?.id ?? crypto.randomUUID(),
      vars: c.vars ?? {},
      ...(c.expected !== undefined ? { expected: c.expected } : {}),
      ...(c.reference !== undefined ? { reference: c.reference } : {}),
    }));
    upsertDataset({ id: activeId, name: name.trim() || 'Untitled', cases });
    toast.success('Dataset saved');
  };

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr]">
      <div className="space-y-2">
        <Button size="sm" onClick={createNew} className="w-full">
          <Plus className="mr-2 h-3.5 w-3.5" /> New dataset
        </Button>
        <div className="flex justify-center">
          <OpenApiGenDialog onCreated={(id) => setActiveId(id)} />
        </div>
        {Object.values(datasets).map((d) => (
          <button
            key={d.id}
            onClick={() => setActiveId(d.id)}
            className={`flex w-full items-center justify-between rounded border px-3 py-2 text-left text-sm ${
              activeId === d.id ? 'border-primary bg-primary/5' : 'border-border/40'
            }`}
          >
            <span className="truncate">{d.name}</span>
            <span className="text-xs text-muted-foreground">{d.cases.length}</span>
          </button>
        ))}
      </div>

      {active ? (
        <div className="space-y-3">
          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-1">
              <Label className="text-xs">Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                removeDataset(active.id);
                setActiveId(null);
              }}
            >
              <Trash2 className="h-3.5 w-3.5 text-destructive" />
            </Button>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">
              Cases — JSON array of {'{ vars, expected?, reference? }'}
            </Label>
            <Textarea
              value={casesText}
              onChange={(e) => setCasesText(e.target.value)}
              rows={16}
              className="font-mono text-xs"
            />
          </div>
          <Button size="sm" onClick={save}>
            Save dataset
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Select or create a dataset.</p>
      )}
    </div>
  );
}
