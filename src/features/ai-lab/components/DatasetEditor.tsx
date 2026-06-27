import { Code2, Database, Download, Plus, Rows3, Trash2, Upload, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { casesFromCsv, casesFromJsonl, casesToCsv, casesToJsonl } from '../lib/datasetIo';
import { useAiLabStore } from '../store/useAiLabStore';
import type { DatasetCase } from '../types';
import { EmptyState } from './EmptyState';
import { ImportFromHistoryDialog } from './ImportFromHistoryDialog';
import { OpenApiGenDialog } from './OpenApiGenDialog';
import { RedteamGenDialog } from './RedteamGenDialog';
import ResizableLayout from '@/components/shared/ResizableLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Floater, Segmented } from '@/components/ui/spatial';
import { Textarea } from '@/components/ui/textarea';
import { downloadBlob } from '@/lib/shared/file-utils';
import { cn } from '@/lib/shared/utils';

type EditMode = 'structured' | 'json';

/** A case as edited in the UI (ids are minted/preserved on save). `turns` is
 *  carried opaquely so multi-turn cases survive structured-mode edits. */
interface EditableCase {
  vars: Record<string, string>;
  expected?: string;
  reference?: string;
  turns?: unknown;
}

/**
 * Cases are edited either as structured rows (vars/expected/reference) or as a
 * raw JSON array of { vars, expected?, reference?, turns? } — the JSON view is
 * the escape hatch for multi-turn / advanced shapes. Ids are minted/preserved
 * on save.
 */
export function DatasetEditor() {
  const datasets = useAiLabStore((s) => s.datasets);
  const upsertDataset = useAiLabStore((s) => s.upsertDataset);
  const removeDataset = useAiLabStore((s) => s.removeDataset);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [casesText, setCasesText] = useState('[]');
  const [mode, setMode] = useState<EditMode>('structured');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const active = activeId ? datasets[activeId] : undefined;

  // `casesText` stays the single source of truth (Save reads it directly). The
  // structured editor parses it on the fly and re-serialises on every edit, so
  // unknown fields like `turns` survive a structured round-trip untouched.
  const parsedCases = useMemo<EditableCase[] | null>(() => {
    try {
      const arr = JSON.parse(casesText) as unknown;
      if (!Array.isArray(arr)) return null;
      return arr.map((c) => {
        const obj = (c ?? {}) as Record<string, unknown>;
        const vars =
          obj.vars && typeof obj.vars === 'object' && !Array.isArray(obj.vars)
            ? (obj.vars as Record<string, string>)
            : {};
        return {
          vars,
          ...(typeof obj.expected === 'string' ? { expected: obj.expected } : {}),
          ...(typeof obj.reference === 'string' ? { reference: obj.reference } : {}),
          ...(obj.turns !== undefined ? { turns: obj.turns } : {}),
        };
      });
    } catch {
      return null;
    }
  }, [casesText]);

  const writeCases = (next: EditableCase[]) => setCasesText(JSON.stringify(next, null, 2));

  const updateCase = (ci: number, patch: Partial<EditableCase>) => {
    if (!parsedCases) return;
    writeCases(parsedCases.map((c, i) => (i === ci ? { ...c, ...patch } : c)));
  };
  const setCaseVars = (ci: number, entries: Array<[string, string]>) =>
    updateCase(ci, { vars: Object.fromEntries(entries) });
  const removeCase = (ci: number) => {
    if (!parsedCases) return;
    writeCases(parsedCases.filter((_, i) => i !== ci));
  };
  const addCase = () => writeCases([...(parsedCases ?? []), { vars: {} }]);

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
      ...(c.turns !== undefined ? { turns: c.turns } : {}),
    }));
    upsertDataset({ id: activeId, name: name.trim() || 'Untitled', cases });
    toast.success('Dataset saved');
  };

  /** Export the active dataset's cases (sans ids) as CSV or JSONL. */
  const exportCases = (format: 'jsonl' | 'csv') => {
    if (!active) return;
    const cases = active.cases.map(({ id: _id, ...rest }) => rest);
    const safeName = active.name.replace(/[^a-z0-9-_]+/gi, '_') || 'dataset';
    if (format === 'jsonl') {
      downloadBlob(casesToJsonl(cases), `${safeName}.jsonl`, 'application/x-ndjson');
    } else {
      downloadBlob(casesToCsv(cases), `${safeName}.csv`, 'text/csv');
    }
  };

  /** Import cases from a picked .jsonl/.csv file into the active dataset. */
  const onImportFile = async (file: File) => {
    if (!activeId) return;
    const text = await file.text();
    try {
      const incoming = file.name.toLowerCase().endsWith('.csv')
        ? casesFromCsv(text)
        : casesFromJsonl(text);
      if (incoming.length === 0) {
        toast.error('No cases found in file.');
        return;
      }
      const cases: DatasetCase[] = incoming.map((c) => ({ id: crypto.randomUUID(), ...c }));
      upsertDataset({ id: activeId, name: name.trim() || active?.name || 'Untitled', cases });
      setCasesText(JSON.stringify(incoming, null, 2));
      toast.success(`Imported ${cases.length} cases`);
    } catch (e) {
      toast.error(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <ResizableLayout defaultSplit={24} minSplit={18} maxSplit={45}>
      {/* Dataset list — master pane. */}
      <div className="flex flex-1 flex-col gap-2 overflow-auto p-3">
        <Button variant="secondary" size="sm" onClick={createNew} className="w-full">
          <Plus className="mr-2 h-3.5 w-3.5" /> New dataset
        </Button>
        <OpenApiGenDialog onCreated={(id) => setActiveId(id)} />
        <RedteamGenDialog onCreated={(id) => setActiveId(id)} />
        <ImportFromHistoryDialog onCreated={(id) => setActiveId(id)} />
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
      <div className="flex-1 overflow-auto p-4">
        {active ? (
          <Floater
            radius="panel"
            elevation="float"
            className="flex flex-col gap-3 bg-sp-surface p-4"
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
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <span className="sp-label">Cases ({parsedCases?.length ?? '—'})</span>
                <Segmented<EditMode>
                  size="sm"
                  ariaLabel="Case editor mode"
                  value={mode}
                  onChange={setMode}
                  options={[
                    {
                      value: 'structured',
                      label: 'Structured',
                      icon: <Rows3 className="h-3 w-3" />,
                    },
                    { value: 'json', label: 'JSON', icon: <Code2 className="h-3 w-3" /> },
                  ]}
                />
              </div>
              {mode === 'structured' ? (
                parsedCases === null ? (
                  <Floater
                    radius="panel"
                    elevation="inset"
                    className="px-3 py-4 text-center text-sp-12 text-amber-500"
                  >
                    Cases aren&apos;t valid JSON — switch to JSON mode to fix them.
                  </Floater>
                ) : (
                  <div className="space-y-3">
                    {parsedCases.map((c, ci) => {
                      const entries = Object.entries(c.vars);
                      return (
                        <Floater
                          key={ci}
                          radius="panel"
                          elevation="inset"
                          className="space-y-2.5 p-3"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-sp-12 font-semibold text-sp-text">
                              Case {ci + 1}
                            </span>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Remove case ${ci + 1}`}
                              title="Remove case"
                              onClick={() => removeCase(ci)}
                            >
                              <X className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                          <div className="space-y-1.5">
                            <span className="sp-label">Variables</span>
                            {entries.length === 0 && (
                              <p className="text-sp-11 text-sp-muted">No variables yet.</p>
                            )}
                            {entries.map(([k, v], vi) => (
                              <div key={vi} className="flex items-center gap-2">
                                <Input
                                  aria-label="Variable name"
                                  placeholder="key"
                                  value={k}
                                  onChange={(e) =>
                                    setCaseVars(
                                      ci,
                                      entries.map((pair, i) =>
                                        i === vi ? [e.target.value, pair[1]] : pair
                                      )
                                    )
                                  }
                                  className="w-1/3 font-mono text-sp-12"
                                />
                                <Input
                                  aria-label="Variable value"
                                  placeholder="value"
                                  value={v}
                                  onChange={(e) =>
                                    setCaseVars(
                                      ci,
                                      entries.map((pair, i) =>
                                        i === vi ? [pair[0], e.target.value] : pair
                                      )
                                    )
                                  }
                                  className="flex-1 font-mono text-sp-12"
                                />
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  aria-label="Remove variable"
                                  title="Remove variable"
                                  onClick={() =>
                                    setCaseVars(
                                      ci,
                                      entries.filter((_, i) => i !== vi)
                                    )
                                  }
                                >
                                  <X className="h-3.5 w-3.5" />
                                </Button>
                              </div>
                            ))}
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setCaseVars(ci, [...entries, ['', '']])}
                            >
                              <Plus className="mr-1.5 h-3.5 w-3.5" /> Add variable
                            </Button>
                          </div>
                          <div className="space-y-1.5">
                            <span className="sp-label">Expected (optional)</span>
                            <Input
                              value={c.expected ?? ''}
                              onChange={(e) =>
                                updateCase(ci, { expected: e.target.value || undefined })
                              }
                            />
                          </div>
                          <div className="space-y-1.5">
                            <span className="sp-label">Reference (optional)</span>
                            <Textarea
                              rows={2}
                              value={c.reference ?? ''}
                              onChange={(e) =>
                                updateCase(ci, { reference: e.target.value || undefined })
                              }
                            />
                          </div>
                          {c.turns !== undefined && (
                            <p className="text-sp-11 text-sp-muted">
                              Multi-turn conversation preserved — edit turns in JSON mode.
                            </p>
                          )}
                        </Floater>
                      );
                    })}
                    <Button variant="secondary" size="sm" onClick={addCase}>
                      <Plus className="mr-1.5 h-3.5 w-3.5" /> Add case
                    </Button>
                  </div>
                )
              ) : (
                <Textarea
                  value={casesText}
                  onChange={(e) => setCasesText(e.target.value)}
                  className="min-h-[24rem] resize-none font-mono text-sp-13"
                />
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="cta" size="cta" onClick={save}>
                Save dataset
              </Button>
              <span className="mx-1 h-4 w-px bg-sp-line" />
              <input
                ref={fileInputRef}
                type="file"
                aria-label="Import dataset file"
                accept=".jsonl,.csv,.json,.ndjson,text/csv"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onImportFile(f);
                  e.target.value = '';
                }}
              />
              <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
                <Upload className="mr-1.5 h-3.5 w-3.5" /> Import file
              </Button>
              <Button variant="outline" size="sm" onClick={() => exportCases('jsonl')}>
                <Download className="mr-1.5 h-3.5 w-3.5" /> JSONL
              </Button>
              <Button variant="outline" size="sm" onClick={() => exportCases('csv')}>
                <Download className="mr-1.5 h-3.5 w-3.5" /> CSV
              </Button>
            </div>
          </Floater>
        ) : (
          <EmptyState
            fill
            icon={Database}
            message="Select or create a dataset to edit its cases."
          />
        )}
      </div>
    </ResizableLayout>
  );
}
