import { Code2, Database, Download, Plus, Rows3, Trash2, Upload, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { casesFromCsv, casesFromJsonl, casesToCsv, casesToJsonl } from '../lib/datasetIo';
import { useAiLabStore } from '../store/useAiLabStore';
import type { DatasetCase } from '../types';
import { EmptyState } from './EmptyState';
import { ImportFromHistoryDialog } from './ImportFromHistoryDialog';
import { OpenApiGenDialog } from './OpenApiGenDialog';
import { RedteamGenDialog } from './RedteamGenDialog';
import { useConfirmDialog } from '@/components/shared/ConfirmDialog';
import ResizableLayout from '@/components/shared/ResizableLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Floater, Segmented } from '@/components/ui/spatial';
import { Textarea } from '@/components/ui/textarea';
import { downloadBlob } from '@/lib/shared/file-utils';
import { cn } from '@/lib/shared/utils';

// JSON-mode reparse debounce — a keystroke updates the textarea immediately,
// but re-parsing + resyncing the canonical `cases` array is deferred so a
// large pasted array doesn't re-run JSON.parse on every character.
const JSON_REPARSE_DEBOUNCE_MS = 300;

type EditMode = 'structured' | 'json';

/** A case as edited in the UI (ids are minted/preserved on save). `turns` is
 *  carried opaquely so multi-turn cases survive structured-mode edits. */
interface EditableCase {
  vars: Record<string, string>;
  expected?: string;
  reference?: string;
  turns?: DatasetCase['turns'];
}

type ParseResult = { ok: true; cases: EditableCase[] } | { ok: false; error: string };

function normalizeCase(c: unknown): EditableCase {
  const obj = (c ?? {}) as Record<string, unknown>;
  const vars =
    obj.vars && typeof obj.vars === 'object' && !Array.isArray(obj.vars)
      ? (obj.vars as Record<string, string>)
      : {};
  return {
    vars,
    ...(typeof obj.expected === 'string' ? { expected: obj.expected } : {}),
    ...(typeof obj.reference === 'string' ? { reference: obj.reference } : {}),
    ...(obj.turns !== undefined ? { turns: obj.turns as DatasetCase['turns'] } : {}),
  };
}

function parseCases(text: string): ParseResult {
  try {
    const arr = JSON.parse(text) as unknown;
    if (!Array.isArray(arr)) return { ok: false, error: 'not an array' };
    return { ok: true, cases: arr.map(normalizeCase) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const serializeCases = (cs: EditableCase[]) => JSON.stringify(cs, null, 2);

/**
 * Cases are edited either as structured rows (vars/expected/reference) or as a
 * raw JSON array of { vars, expected?, reference?, turns? } — the JSON view is
 * the escape hatch for multi-turn / advanced shapes. The `cases` array is the
 * single source of truth (so structured edits don't re-serialise the whole
 * dataset on every keystroke); the JSON tab edits `jsonText` and syncs back
 * into `cases` whenever it parses. Ids are minted/preserved on save.
 */
export function DatasetEditor() {
  const datasets = useAiLabStore((s) => s.datasets);
  const upsertDataset = useAiLabStore((s) => s.upsertDataset);
  const removeDataset = useAiLabStore((s) => s.removeDataset);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [cases, setCases] = useState<EditableCase[]>([]);
  const [jsonText, setJsonText] = useState('[]');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [mode, setModeState] = useState<EditMode>('structured');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const reparseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(reparseTimer.current), []);

  const active = activeId ? datasets[activeId] : undefined;
  const { confirm: confirmDelete, DialogComponent: DeleteDatasetDialog } = useConfirmDialog({
    title: 'Delete dataset',
    description: active
      ? `Delete "${active.name}" and all ${active.cases.length} case(s)? This cannot be undone.`
      : '',
    confirmText: 'Delete',
    variant: 'destructive',
  });

  // Load the active dataset's cases into the editor. The array is canonical;
  // jsonText is seeded so the JSON tab opens in sync.
  const loadCases = (next: EditableCase[]) => {
    setCases(next);
    setJsonText(serializeCases(next));
    setJsonError(null);
  };

  useEffect(() => {
    if (!active) return;
    // Drop any reparse still pending from the PREVIOUS dataset — otherwise it
    // fires after loadCases() below and overwrites the newly-loaded cases with
    // the old dataset's stale JSON.
    clearTimeout(reparseTimer.current);
    setName(active.name);
    loadCases(active.cases.map(({ id: _id, ...rest }) => rest));
  }, [active]);

  // Structured edits mutate the canonical array directly — O(1) state updates,
  // no per-keystroke (re)serialisation of the whole dataset.
  const updateCase = (ci: number, patch: Partial<EditableCase>) =>
    setCases((prev) => prev.map((c, i) => (i === ci ? { ...c, ...patch } : c)));
  const setCaseVars = (ci: number, entries: Array<[string, string]>) =>
    updateCase(ci, { vars: Object.fromEntries(entries) });
  const removeCase = (ci: number) => setCases((prev) => prev.filter((_, i) => i !== ci));
  const addCase = () => setCases((prev) => [...prev, { vars: {} }]);

  // JSON tab edits: validate on the fly and mirror into the canonical array so
  // a Save (or a switch back to structured) always uses the latest valid text.
  // The reparse itself is debounced (large pasted arrays are expensive to
  // JSON.parse on every keystroke); flushJsonReparse forces it synchronously
  // for callers (Save, tab switch) that need `cases`/`jsonError` up to date
  // with whatever's in the textarea right now.
  const flushJsonReparse = (text: string) => {
    clearTimeout(reparseTimer.current);
    const res = parseCases(text);
    if (res.ok) {
      setCases(res.cases);
      setJsonError(null);
    } else {
      setJsonError(res.error);
    }
    return res;
  };

  const onJsonChange = (text: string) => {
    setJsonText(text);
    clearTimeout(reparseTimer.current);
    reparseTimer.current = setTimeout(() => flushJsonReparse(text), JSON_REPARSE_DEBOUNCE_MS);
  };

  const setMode = (next: EditMode) => {
    if (next === mode) return;
    if (next === 'json') {
      // Re-seed the textarea from the canonical array (this is the only place
      // structured edits get serialised).
      setJsonText(serializeCases(cases));
      setJsonError(null);
    } else {
      const res = flushJsonReparse(jsonText);
      if (!res.ok) {
        // Don't silently drop invalid JSON when leaving the JSON tab.
        toast.error(`Invalid cases JSON: ${res.error}`);
        return;
      }
    }
    setModeState(next);
  };

  const createNew = () => {
    const id = upsertDataset({ name: 'New dataset', cases: [] });
    setActiveId(id);
  };

  const save = () => {
    if (!activeId) return;
    // In JSON mode, force the pending debounced reparse so `cases` reflects
    // whatever is currently in the textarea, not a stale pre-debounce value.
    let sourceCases = cases;
    if (mode === 'json') {
      const res = flushJsonReparse(jsonText);
      if (!res.ok) {
        toast.error(`Invalid cases JSON: ${res.error}`);
        return;
      }
      sourceCases = res.cases;
    }
    const out: DatasetCase[] = sourceCases.map((c, i) => ({
      id: active?.cases[i]?.id ?? crypto.randomUUID(),
      vars: c.vars ?? {},
      ...(c.expected !== undefined ? { expected: c.expected } : {}),
      ...(c.reference !== undefined ? { reference: c.reference } : {}),
      ...(c.turns !== undefined ? { turns: c.turns } : {}),
    }));
    upsertDataset({ id: activeId, name: name.trim() || 'Untitled', cases: out });
    toast.success('Dataset saved');
  };

  const handleDeleteClick = async () => {
    if (!active) return;
    if (!(await confirmDelete())) return;
    removeDataset(active.id);
    setActiveId(null);
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
      loadCases(incoming.map(normalizeCase));
      toast.success(`Imported ${cases.length} cases`);
    } catch (e) {
      toast.error(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <>
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
              <span className="shrink-0 text-sp-12 text-sp-muted tabular-nums">
                {d.cases.length}
              </span>
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
                  <Label htmlFor="dataset-name" className="sp-label">
                    Name
                  </Label>
                  <Input id="dataset-name" value={name} onChange={(e) => setName(e.target.value)} />
                </div>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Delete dataset"
                  title="Delete dataset"
                  onClick={() => void handleDeleteClick()}
                >
                  <Trash2 className="h-3.5 w-3.5 text-destructive" />
                </Button>
              </div>
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="sp-label">Cases ({cases.length})</span>
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
                  <div className="space-y-3">
                    {cases.length === 0 && (
                      <Floater
                        radius="panel"
                        elevation="inset"
                        className="px-3 py-4 text-center text-sp-12 text-sp-muted"
                      >
                        No cases yet — add one below, or switch to JSON mode to paste an array.
                      </Floater>
                    )}
                    {cases.map((c, ci) => {
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
                            <Label htmlFor={`dataset-case-${ci}-expected`} className="sp-label">
                              Expected (optional)
                            </Label>
                            <Input
                              id={`dataset-case-${ci}-expected`}
                              value={c.expected ?? ''}
                              onChange={(e) =>
                                updateCase(ci, { expected: e.target.value || undefined })
                              }
                            />
                          </div>
                          <div className="space-y-1.5">
                            <Label htmlFor={`dataset-case-${ci}-reference`} className="sp-label">
                              Reference (optional)
                            </Label>
                            <Textarea
                              id={`dataset-case-${ci}-reference`}
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
                ) : (
                  <>
                    <Textarea
                      value={jsonText}
                      onChange={(e) => onJsonChange(e.target.value)}
                      className="min-h-[24rem] resize-none font-mono text-sp-13"
                    />
                    {jsonError && (
                      <p className="text-sp-11 text-destructive">Invalid JSON: {jsonError}</p>
                    )}
                  </>
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

      <DeleteDatasetDialog />
    </>
  );
}
