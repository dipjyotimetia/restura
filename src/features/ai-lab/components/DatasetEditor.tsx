import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Database, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Floater } from '@/components/ui/spatial';
import { cn } from '@/lib/shared/utils';
import { useAiLabStore } from '../store/useAiLabStore';
import { OpenApiGenDialog } from './OpenApiGenDialog';
import { EmptyState } from './EmptyState';
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
    <div className="flex h-full">
      {/* Dataset list — master pane. */}
      <div className="flex w-[280px] shrink-0 flex-col gap-2 overflow-auto border-r border-sp-line p-3">
        <Button variant="secondary" size="sm" onClick={createNew} className="w-full">
          <Plus className="mr-2 h-3.5 w-3.5" /> New dataset
        </Button>
        <OpenApiGenDialog onCreated={(id) => setActiveId(id)} />
        {Object.values(datasets).map((d) => (
          <button
            key={d.id}
            onClick={() => setActiveId(d.id)}
            className={cn(
              'flex w-full items-center justify-between gap-2 rounded-sp-btn border px-3 py-2.5 text-left text-sp-13 transition-colors',
              activeId === d.id
                ? 'border-sp-accent bg-[var(--sp-accent-glow-15)] text-sp-text'
                : 'border-sp-line text-sp-text hover:bg-sp-hover'
            )}
          >
            <span className="truncate">{d.name}</span>
            <span className="shrink-0 text-sp-12 text-sp-muted tabular-nums">{d.cases.length}</span>
          </button>
        ))}
      </div>

      {/* Editor — detail pane, fills the window. */}
      <div className="min-w-0 flex-1 overflow-auto p-4">
        {active ? (
          <Floater
            radius="panel"
            elevation="float"
            className="flex h-full flex-col gap-3 bg-sp-surface p-4"
          >
            <div className="flex items-end gap-2">
              <div className="flex-1 space-y-1.5">
                <span className="sp-label">Name</span>
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Delete dataset"
                title="Delete dataset"
                onClick={() => {
                  removeDataset(active.id);
                  setActiveId(null);
                }}
              >
                <Trash2 className="h-3.5 w-3.5 text-destructive" />
              </Button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-1.5">
              <span className="sp-label">
                Cases — JSON array of {'{ vars, expected?, reference? }'}
              </span>
              <Textarea
                value={casesText}
                onChange={(e) => setCasesText(e.target.value)}
                className="min-h-[16rem] flex-1 resize-none font-mono text-sp-13"
              />
            </div>
            <Button variant="secondary" size="sm" onClick={save} className="self-start">
              Save dataset
            </Button>
          </Floater>
        ) : (
          <EmptyState
            fill
            icon={Database}
            message="Select or create a dataset to edit its cases."
          />
        )}
      </div>
    </div>
  );
}
