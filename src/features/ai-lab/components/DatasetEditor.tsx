import {
  ChevronDown,
  ChevronRight,
  Code2,
  Database,
  Download,
  Plus,
  Rows3,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  caseSummary,
  draftFromDataset,
  normalizeCase,
  parseCases,
  serializeCases,
  type EditableCase,
  type EditMode,
} from '../lib/datasetDraft';
import { casesFromCsv, casesFromJsonl, casesToCsv, casesToJsonl } from '../lib/datasetIo';
import { toggleSetKey } from '../lib/modelOptions';
import { plural } from '../lib/plural';
import { useAiLabStore } from '../store/useAiLabStore';
import { useAiLabUiStore } from '../store/useAiLabUiStore';
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

// Above this many cases the structured view starts rows collapsed — rendering
// hundreds of full editing cards at once made big imports unusable.
const COLLAPSE_THRESHOLD = 20;

const defaultExpandedKeys = (cases: EditableCase[]): Set<string> =>
  cases.length > COLLAPSE_THRESHOLD ? new Set() : new Set(cases.map((c) => c._key));

/**
 * Cases are edited either as structured rows (vars/expected/reference) or as a
 * raw JSON array of { vars, expected?, reference?, turns? } — the JSON view is
 * the escape hatch for multi-turn / advanced shapes. The draft's `cases` array
 * is the single source of truth (so structured edits don't re-serialise the
 * whole dataset on every keystroke); the JSON tab edits `jsonText` and syncs
 * back into `cases` whenever it parses.
 *
 * The whole work buffer lives in useAiLabUiStore (see lib/datasetDraft), like
 * every other tab draft, so neither sub-tab switches nor in-tab dataset
 * switches can silently discard edits — the latter additionally gate on a
 * discard confirm while dirty.
 */
export function DatasetEditor() {
  const datasets = useAiLabStore((s) => s.datasets);
  const upsertDataset = useAiLabStore((s) => s.upsertDataset);
  const removeDataset = useAiLabStore((s) => s.removeDataset);

  const activeId = useAiLabUiStore((s) => s.datasetId);
  const setActiveId = useAiLabUiStore((s) => s.setDatasetId);
  const draft = useAiLabUiStore((s) => s.datasetDraft);
  const setDraft = useAiLabUiStore((s) => s.setDatasetDraft);
  const patchDraft = useAiLabUiStore((s) => s.patchDatasetDraft);
  const updateCases = useAiLabUiStore((s) => s.updateDatasetDraftCases);

  // View-local ephemera: parse-error banner and row expansion (fine to reset
  // on unmount, unlike the edit buffer itself).
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const reparseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Snapshot of jsonText as seeded on entering JSON mode; if it's unchanged on
  // exit we keep the existing cases (a reparse would mint fresh `_key`s and
  // needlessly reassign case ids on save).
  const jsonSeedRef = useRef<string | null>(null);

  useEffect(() => () => clearTimeout(reparseTimer.current), []);

  const active = activeId ? datasets[activeId] : undefined;
  const dirty = draft?.dirty ?? false;
  const mode = draft?.mode ?? 'structured';
  const cases = draft?.cases ?? [];

  const { confirm: confirmDelete, DialogComponent: DeleteDatasetDialog } = useConfirmDialog({
    title: 'Delete dataset',
    description: active
      ? `Delete "${active.name}" and all ${plural(active.cases.length, 'case')}? This cannot be undone.`
      : '',
    confirmText: 'Delete',
    variant: 'destructive',
  });
  const { confirm: confirmDiscard, DialogComponent: DiscardChangesDialog } = useConfirmDialog({
    title: 'Discard unsaved changes?',
    description: `"${draft?.name || 'This dataset'}" has unsaved edits. Switching now discards them.`,
    confirmText: 'Discard',
    variant: 'destructive',
  });

  // (Re)build the work buffer when the selection points at a dataset the
  // current draft doesn't cover. A save updates the store dataset object but
  // keeps datasetId === activeId, so in-progress edits are never clobbered.
  useEffect(() => {
    if (!active || draft?.datasetId === active.id) return;
    clearTimeout(reparseTimer.current);
    const next = draftFromDataset(active, draft?.mode ?? 'structured');
    setDraft(next);
    setJsonError(null);
    jsonSeedRef.current = next.mode === 'json' ? next.jsonText : null;
    setExpandedKeys(defaultExpandedKeys(next.cases));
  }, [active, draft?.datasetId, draft?.mode, setDraft]);

  /** Route every selection change through the dirty guard. */
  const switchTo = useCallback(
    async (id: string | null) => {
      if (id === useAiLabUiStore.getState().datasetId) return;
      if (useAiLabUiStore.getState().datasetDraft?.dirty && !(await confirmDiscard())) return;
      setActiveId(id);
    },
    [confirmDiscard, setActiveId]
  );

  // Case mutations go through the store's functional updater (marks dirty);
  // all stable so the memoized CaseRow only re-renders the row that changed.
  const updateCase = useCallback(
    (key: string, patch: Partial<EditableCase>) =>
      updateCases((prev) => prev.map((c) => (c._key === key ? { ...c, ...patch } : c))),
    [updateCases]
  );
  const removeCase = useCallback(
    (key: string) => updateCases((prev) => prev.filter((c) => c._key !== key)),
    [updateCases]
  );
  const addCase = () => {
    const c: EditableCase = { _key: crypto.randomUUID(), vars: {} };
    updateCases((prev) => [...prev, c]);
    setExpandedKeys((prev) => new Set(prev).add(c._key));
  };
  const toggleExpanded = useCallback(
    (key: string) => setExpandedKeys((prev) => toggleSetKey(prev, key)),
    []
  );

  // JSON tab edits: validate on the fly and mirror into the canonical array so
  // a Save (or a switch back to structured) always uses the latest valid text.
  // The reparse itself is debounced (large pasted arrays are expensive to
  // JSON.parse on every keystroke); flushJsonReparse forces it synchronously
  // for callers (Save, tab switch) that need cases/jsonError up to date with
  // whatever's in the textarea right now.
  const flushJsonReparse = (text: string) => {
    clearTimeout(reparseTimer.current);
    const res = parseCases(text);
    if (res.ok) {
      updateCases(() => res.cases);
      setJsonError(null);
    } else {
      setJsonError(res.error);
    }
    return res;
  };

  const onJsonChange = (text: string) => {
    patchDraft({ jsonText: text, dirty: true });
    clearTimeout(reparseTimer.current);
    reparseTimer.current = setTimeout(() => flushJsonReparse(text), JSON_REPARSE_DEBOUNCE_MS);
  };

  const setMode = (next: EditMode) => {
    if (!draft || next === draft.mode) return;
    if (next === 'json') {
      // Seed the textarea from the canonical array (this is the only place
      // structured edits get serialised).
      const seeded = serializeCases(draft.cases);
      jsonSeedRef.current = seeded;
      patchDraft({ mode: 'json', jsonText: seeded });
      setJsonError(null);
      return;
    }
    // Untouched JSON → keep the existing cases (and their identities).
    if (draft.jsonText === jsonSeedRef.current) {
      patchDraft({ mode: 'structured' });
      return;
    }
    const res = flushJsonReparse(draft.jsonText);
    if (!res.ok) {
      // Don't silently drop invalid JSON when leaving the JSON tab.
      toast.error(`Invalid cases JSON: ${res.error}`);
      return;
    }
    patchDraft({ mode: 'structured' });
    setExpandedKeys(defaultExpandedKeys(res.cases));
  };

  const createNew = async () => {
    if (dirty && !(await confirmDiscard())) return;
    const id = upsertDataset({ name: 'New dataset', cases: [] });
    setActiveId(id);
  };

  const save = () => {
    if (!draft || !activeId) return;
    // In JSON mode, force the pending debounced reparse so `cases` reflects
    // whatever is currently in the textarea, not a stale pre-debounce value.
    let sourceCases = draft.cases;
    if (draft.mode === 'json' && draft.jsonText !== jsonSeedRef.current) {
      const res = flushJsonReparse(draft.jsonText);
      if (!res.ok) {
        toast.error(`Invalid cases JSON: ${res.error}`);
        return;
      }
      sourceCases = res.cases;
    }
    // `_key` is seeded from the persisted case id on load, so ids survive
    // removals/reorders.
    const out: DatasetCase[] = sourceCases.map((c) => ({
      id: c._key,
      vars: c.vars ?? {},
      ...(c.expected !== undefined ? { expected: c.expected } : {}),
      ...(c.reference !== undefined ? { reference: c.reference } : {}),
      ...(c.turns !== undefined ? { turns: c.turns } : {}),
    }));
    upsertDataset({ id: activeId, name: draft.name.trim() || 'Untitled', cases: out });
    patchDraft({ dirty: false });
    toast.success('Dataset saved');
  };

  const handleDeleteClick = async () => {
    if (!active) return;
    if (!(await confirmDelete())) return;
    removeDataset(active.id);
    setActiveId(null);
    setDraft(null);
  };

  /** Export the active dataset's cases (sans ids) as CSV or JSONL. */
  const exportCases = (format: 'jsonl' | 'csv') => {
    if (!active) return;
    const exportable = active.cases.map(({ id: _id, ...rest }) => rest);
    const safeName = active.name.replace(/[^a-z0-9-_]+/gi, '_') || 'dataset';
    if (format === 'jsonl') {
      downloadBlob(casesToJsonl(exportable), `${safeName}.jsonl`, 'application/x-ndjson');
    } else {
      downloadBlob(casesToCsv(exportable), `${safeName}.csv`, 'text/csv');
    }
  };

  /** Import cases from a picked .jsonl/.csv file into the active dataset. */
  const onImportFile = async (file: File) => {
    if (!draft || !activeId) return;
    const text = await file.text();
    try {
      const incoming = file.name.toLowerCase().endsWith('.csv')
        ? casesFromCsv(text)
        : casesFromJsonl(text);
      if (incoming.length === 0) {
        toast.error('No cases found in file.');
        return;
      }
      const imported: DatasetCase[] = incoming.map((c) => ({ id: crypto.randomUUID(), ...c }));
      const name = draft.name.trim() || active?.name || 'Untitled';
      upsertDataset({ id: activeId, name, cases: imported });
      const nextCases = incoming.map(normalizeCase);
      const jsonText = draft.mode === 'json' ? serializeCases(nextCases) : '[]';
      jsonSeedRef.current = draft.mode === 'json' ? jsonText : null;
      setDraft({ ...draft, name, cases: nextCases, jsonText, dirty: false });
      setJsonError(null);
      setExpandedKeys(defaultExpandedKeys(nextCases));
      toast.success(`Imported ${plural(imported.length, 'case')}`);
    } catch (e) {
      toast.error(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const datasetList = useMemo(() => Object.values(datasets), [datasets]);

  return (
    <>
      <ResizableLayout defaultSplit={24} minSplit={18} maxSplit={45}>
        {/* Dataset list — master pane. */}
        <div className="flex flex-1 flex-col gap-2 overflow-auto p-3">
          <Button variant="secondary" size="sm" onClick={() => void createNew()} className="w-full">
            <Plus className="mr-2 h-3.5 w-3.5" /> New dataset
          </Button>
          {/* Generated/imported datasets route through switchTo so the dirty
              guard covers them too — a raw setActiveId would silently reload
              over unsaved edits. */}
          <OpenApiGenDialog onCreated={(id) => void switchTo(id)} />
          <RedteamGenDialog onCreated={(id) => void switchTo(id)} />
          <ImportFromHistoryDialog onCreated={(id) => void switchTo(id)} />
          {datasetList.map((d) => (
            <button
              key={d.id}
              onClick={() => void switchTo(d.id)}
              className={cn(
                'flex w-full items-center justify-between gap-2 rounded-sp-btn border px-3 py-2.5 text-left text-sp-13 transition-colors',
                activeId === d.id
                  ? 'border-sp-accent bg-[var(--sp-accent-glow-15)] text-sp-text'
                  : 'border-sp-line text-sp-text hover:bg-sp-hover'
              )}
            >
              <span className="truncate">
                {d.name}
                {activeId === d.id && dirty && (
                  <span className="text-sp-accent" title="Unsaved changes">
                    {' '}
                    •
                  </span>
                )}
              </span>
              <span className="shrink-0 text-sp-12 text-sp-muted tabular-nums">
                {d.cases.length}
              </span>
            </button>
          ))}
        </div>

        {/* Editor — detail pane, fills the window. */}
        <div className="flex-1 overflow-auto p-4">
          {active && draft && draft.datasetId === active.id ? (
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
                  <Input
                    id="dataset-name"
                    value={draft.name}
                    onChange={(e) => patchDraft({ name: e.target.value, dirty: true })}
                  />
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
                  <div className="flex items-center gap-2">
                    {cases.length > COLLAPSE_THRESHOLD && mode === 'structured' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setExpandedKeys((prev) =>
                            prev.size > 0 ? new Set() : new Set(cases.map((c) => c._key))
                          )
                        }
                      >
                        {expandedKeys.size > 0 ? 'Collapse all' : 'Expand all'}
                      </Button>
                    )}
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
                </div>
                {mode === 'structured' ? (
                  <div className="space-y-2">
                    {cases.length === 0 && (
                      <Floater
                        radius="panel"
                        elevation="inset"
                        className="px-3 py-4 text-center text-sp-12 text-sp-muted"
                      >
                        No cases yet — add one below, or switch to JSON mode to paste an array.
                      </Floater>
                    )}
                    {cases.map((c, ci) => (
                      <CaseRow
                        key={c._key}
                        c={c}
                        index={ci}
                        isOpen={expandedKeys.has(c._key)}
                        onUpdate={updateCase}
                        onRemove={removeCase}
                        onToggle={toggleExpanded}
                      />
                    ))}
                    <Button variant="secondary" size="sm" onClick={addCase}>
                      <Plus className="mr-1.5 h-3.5 w-3.5" /> Add case
                    </Button>
                  </div>
                ) : (
                  <>
                    <Textarea
                      value={draft.jsonText}
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
                {dirty && <span className="text-sp-11 text-sp-accent">Unsaved changes</span>}
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
      <DiscardChangesDialog />
    </>
  );
}

/**
 * One case row (collapsed one-liner or expanded editor). Memoized with stable
 * parent callbacks so a keystroke in one case (or the dataset name) doesn't
 * re-render every other row — with "Expand all" on a big import that was
 * hundreds of rows of derived work (entries, dup-key scan, summary) per
 * keystroke.
 */
const CaseRow = memo(function CaseRow({
  c,
  index,
  isOpen,
  onUpdate,
  onRemove,
  onToggle,
}: {
  c: EditableCase;
  index: number;
  isOpen: boolean;
  onUpdate: (key: string, patch: Partial<EditableCase>) => void;
  onRemove: (key: string) => void;
  onToggle: (key: string) => void;
}) {
  const removeButton = (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={`Remove case ${index + 1}`}
      title="Remove case"
      onClick={() => onRemove(c._key)}
    >
      <X className="h-3.5 w-3.5" />
    </Button>
  );

  if (!isOpen) {
    return (
      <Floater radius="panel" elevation="inset" className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => onToggle(c._key)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={false}
          aria-label={`Expand case ${index + 1}`}
        >
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-sp-muted" />
          <span className="shrink-0 text-sp-12 font-semibold text-sp-text">Case {index + 1}</span>
          <span className="truncate text-sp-11 text-sp-muted">{caseSummary(c)}</span>
        </button>
        {removeButton}
      </Floater>
    );
  }

  const entries = Object.entries(c.vars);
  const setVars = (nextEntries: Array<[string, string]>) =>
    onUpdate(c._key, { vars: Object.fromEntries(nextEntries) });
  const keyCounts = new Map<string, number>();
  for (const [k] of entries) keyCounts.set(k, (keyCounts.get(k) ?? 0) + 1);
  const dupKeys = [...keyCounts.entries()].filter(([k, n]) => k && n > 1).map(([k]) => k);

  return (
    <Floater radius="panel" elevation="inset" className="space-y-2.5 p-3">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => onToggle(c._key)}
          className="flex items-center gap-2 text-left"
          aria-expanded
          aria-label={`Collapse case ${index + 1}`}
        >
          <ChevronDown className="h-3.5 w-3.5 text-sp-muted" />
          <span className="text-sp-12 font-semibold text-sp-text">Case {index + 1}</span>
        </button>
        {removeButton}
      </div>
      <div className="space-y-1.5">
        <span className="sp-label">Variables</span>
        {entries.length === 0 && <p className="text-sp-11 text-sp-muted">No variables yet.</p>}
        {entries.map(([k, v], vi) => (
          <div key={vi} className="flex items-center gap-2">
            <Input
              aria-label="Variable name"
              placeholder="key"
              value={k}
              onChange={(e) =>
                setVars(entries.map((pair, i) => (i === vi ? [e.target.value, pair[1]] : pair)))
              }
              className="w-1/3 font-mono text-sp-12"
            />
            <Input
              aria-label="Variable value"
              placeholder="value"
              value={v}
              onChange={(e) =>
                setVars(entries.map((pair, i) => (i === vi ? [pair[0], e.target.value] : pair)))
              }
              className="flex-1 font-mono text-sp-12"
            />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Remove variable"
              title="Remove variable"
              onClick={() => setVars(entries.filter((_, i) => i !== vi))}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
        {dupKeys.length > 0 && (
          <p className="text-sp-11 text-amber-500">
            Duplicate variable {dupKeys.length === 1 ? 'name' : 'names'} ({dupKeys.join(', ')}) —
            only the last value survives.
          </p>
        )}
        <Button variant="ghost" size="sm" onClick={() => setVars([...entries, ['', '']])}>
          <Plus className="mr-1.5 h-3.5 w-3.5" /> Add variable
        </Button>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`dataset-case-${index}-expected`} className="sp-label">
          Expected (optional)
        </Label>
        <Input
          id={`dataset-case-${index}-expected`}
          value={c.expected ?? ''}
          onChange={(e) => onUpdate(c._key, { expected: e.target.value || undefined })}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`dataset-case-${index}-reference`} className="sp-label">
          Reference (optional)
        </Label>
        <Textarea
          id={`dataset-case-${index}-reference`}
          rows={2}
          value={c.reference ?? ''}
          onChange={(e) => onUpdate(c._key, { reference: e.target.value || undefined })}
        />
      </div>
      {c.turns !== undefined && (
        <p className="text-sp-11 text-sp-muted">
          Multi-turn conversation preserved — edit turns in JSON mode.
        </p>
      )}
    </Floater>
  );
});
