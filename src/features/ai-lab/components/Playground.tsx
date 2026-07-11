import { Check, Copy, Maximize2, Minimize2, Play, Save, Sparkles, Square } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useCmdEnterRun } from '../hooks/useCmdEnterRun';
import { useModelSelection } from '../hooks/useModelSelection';
import { specFor, streamLlm, type StreamHandle } from '../lib/llmClient';
import { toggleSetKey } from '../lib/modelOptions';
import { plural } from '../lib/plural';
import { renderTemplate, extractVars } from '../lib/promptTemplate';
import { useAiLabStore } from '../store/useAiLabStore';
import { useAiLabUiStore } from '../store/useAiLabUiStore';
import { EmptyState } from './EmptyState';
import { ModelChecklist } from './ModelChecklist';
import { StatusChip } from './StatusChip';
import ResizableLayout from '@/components/shared/ResizableLayout';
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
import { Floater, Stat } from '@/components/ui/spatial';
import { Textarea } from '@/components/ui/textarea';
import { formatLongTimestamp } from '@/lib/shared/console-format';

interface CellState {
  text: string;
  status: 'streaming' | 'done' | 'error';
  error?: string;
  promptTokens?: number;
  completionTokens?: number;
  cost?: number | null;
}

export function Playground() {
  const providers = useAiLabStore((s) => s.providers);
  const upsertDataset = useAiLabStore((s) => s.upsertDataset);
  const recordRecentModels = useAiLabStore((s) => s.recordRecentModels);
  // Prompt/model config lives in the session UI store so switching sub-tabs
  // (which unmounts this component) doesn't wipe the composition. Streaming
  // results stay component-local: their streams are cancelled on unmount
  // anyway, and resurrecting half-streamed cells would read as live.
  const draft = useAiLabUiStore((s) => s.playgroundDraft);
  const patchDraft = useAiLabUiStore((s) => s.patchPlaygroundDraft);
  const openDataset = useAiLabUiStore((s) => s.openDataset);
  const setTab = useAiLabUiStore((s) => s.setTab);

  const [cells, setCells] = useState<Record<string, CellState>>({});
  const [activeCount, setActiveCount] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const handlesRef = useRef<StreamHandle[]>([]);
  // Token deltas are buffered here and flushed on a short timer: each chunk
  // arrives as its own IPC event (React can't batch across them), so applying
  // them directly meant a full re-render per token per model. Usage/error/end
  // events still update state directly — they're rare.
  const pendingDeltasRef = useRef<Record<string, string>>({});
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushDeltas = useCallback(() => {
    flushTimerRef.current = null;
    const pending = pendingDeltasRef.current;
    if (Object.keys(pending).length === 0) return;
    pendingDeltasRef.current = {};
    setCells((prev) => {
      const next = { ...prev };
      for (const [key, text] of Object.entries(pending)) {
        const cell = next[key] ?? { text: '', status: 'streaming' as const };
        next[key] = { ...cell, text: cell.text + text };
      }
      return next;
    });
  }, []);

  const queueDelta = useCallback(
    (key: string, text: string) => {
      pendingDeltasRef.current[key] = (pendingDeltasRef.current[key] ?? '') + text;
      flushTimerRef.current ??= setTimeout(flushDeltas, 80);
    },
    [flushDeltas]
  );

  const onSelectionChange = useCallback(
    (sel: string[]) => patchDraft({ selected: sel }),
    [patchDraft]
  );
  const { modelOptions, checklistEntries, selectedSet, toggle, setSelected } = useModelSelection(
    providers,
    draft.selected,
    onSelectionChange
  );

  const promptVars = useMemo(
    () => extractVars(`${draft.system}\n${draft.user}`),
    [draft.system, draft.user]
  );

  // Parse the vars JSON once for both the inline error banner and run/save —
  // a typo used to silently render every {{placeholder}} empty.
  const parsedVars = useMemo((): { vars: Record<string, string>; error: string | null } => {
    const text = draft.varsText.trim();
    if (!text) return { vars: {}, error: null };
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { vars: {}, error: 'Variables must be a JSON object of string values.' };
      }
      return { vars: parsed as Record<string, string>, error: null };
    } catch (e) {
      return { vars: {}, error: e instanceof Error ? e.message : String(e) };
    }
  }, [draft.varsText]);
  const varsError = promptVars.length > 0 ? parsedVars.error : null;

  const maxTokens = useMemo(() => {
    const n = Number(draft.maxTokensText);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
  }, [draft.maxTokensText]);

  // Cancel any in-flight streams when this tab unmounts (AI Lab sub-tabs unmount
  // on switch). Without this, orphaned streams keep running and fire setState on
  // the unmounted component. Only `.cancel()` here — no setState on unmount.
  useEffect(() => {
    return () => {
      for (const h of handlesRef.current) h.cancel();
      handlesRef.current = [];
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    };
  }, []);

  const stop = () => {
    for (const h of handlesRef.current) h.cancel();
    handlesRef.current = [];
    setActiveCount(0);
  };

  // Finished outputs as dataset cases. The save dialog gates on this being
  // non-empty and blocks any state change while open, so saveAsCases can use
  // it unguarded.
  const finishedCases = useMemo(
    () =>
      modelOptions
        .filter((m) => cells[m.key] && cells[m.key]!.status === 'done' && cells[m.key]!.text)
        .map((m, i) => ({
          id: `${Date.now()}-${i}`,
          vars: parsedVars.vars,
          reference: cells[m.key]!.text,
        })),
    [modelOptions, cells, parsedVars.vars]
  );

  /** Save the current vars + each finished model output as cases in a new dataset. */
  const saveAsCases = () => {
    const name = saveName.trim() || 'From Playground';
    const id = upsertDataset({ name, cases: finishedCases });
    setSaveOpen(false);
    toast.success(`Saved ${plural(finishedCases.length, 'case')} to “${name}”`, {
      action: { label: 'Open dataset', onClick: () => openDataset(id) },
    });
  };

  const openSaveDialog = () => {
    if (finishedCases.length === 0) {
      toast.error('No finished outputs to save.');
      return;
    }
    // Unique-enough default so repeated saves don't pile up identical names.
    setSaveName(`Playground ${formatLongTimestamp(Date.now())}`);
    setSaveOpen(true);
  };

  const run = async () => {
    const { vars } = parsedVars;
    const sys = renderTemplate(draft.system, vars).trim();
    const usr = renderTemplate(draft.user, vars);
    const chosen = modelOptions.filter((m) => selectedSet.has(m.key));
    if (chosen.length === 0) return;
    recordRecentModels(chosen.map((model) => model.key));

    setActiveCount(chosen.length);
    setExpanded(new Set());
    setCells(
      Object.fromEntries(chosen.map((m) => [m.key, { text: '', status: 'streaming' as const }]))
    );

    // allSettled (not all): if one stream fails to start (e.g. hitting the
    // per-sender concurrency cap), the others still run and remain cancellable,
    // and the failed cell shows an error instead of stranding the UI in "Stop".
    const settled = await Promise.allSettled(
      chosen.map(async (m) => {
        const messages = sys
          ? [
              { role: 'system' as const, content: sys },
              { role: 'user' as const, content: usr },
            ]
          : [{ role: 'user' as const, content: usr }];
        return streamLlm(
          specFor(m.cfg, m.model, messages, maxTokens ? { maxOutputTokens: maxTokens } : {}),
          {
            onChunk: (ev) => {
              if (ev.type === 'delta') {
                queueDelta(m.key, ev.text);
                return;
              }
              setCells((prev) => {
                const cell = prev[m.key] ?? { text: '', status: 'streaming' as const };
                if (ev.type === 'usage') {
                  const cost =
                    m.cfg.provider === 'ollama'
                      ? 0
                      : m.cfg.pricingKnown
                        ? ev.usage.estimatedCostUSD
                        : null;
                  return {
                    ...prev,
                    [m.key]: {
                      ...cell,
                      promptTokens: ev.usage.promptTokens,
                      completionTokens: ev.usage.completionTokens,
                      cost,
                    },
                  };
                }
                if (ev.type === 'error')
                  return { ...prev, [m.key]: { ...cell, status: 'error', error: ev.message } };
                return prev;
              });
            },
            onEnd: (reason) => {
              // Apply any buffered tail before finalising the cell status.
              flushDeltas();
              setActiveCount((c) => Math.max(0, c - 1));
              setCells((prev) => {
                const cell = prev[m.key];
                if (!cell) return prev;
                return {
                  ...prev,
                  [m.key]: { ...cell, status: reason === 'error' ? 'error' : 'done' },
                };
              });
            },
          }
        );
      })
    );

    const handles: StreamHandle[] = [];
    settled.forEach((r, i) => {
      const m = chosen[i];
      if (!m) return;
      if (r.status === 'fulfilled') {
        handles.push(r.value);
      } else {
        // Stream never started: surface the error and release its activeCount slot.
        setActiveCount((c) => Math.max(0, c - 1));
        const message = r.reason instanceof Error ? r.reason.message : String(r.reason);
        setCells((prev) => ({
          ...prev,
          [m.key]: { ...(prev[m.key] ?? { text: '' }), status: 'error', error: message },
        }));
      }
    });
    handlesRef.current = handles;
  };

  const canRun = selectedSet.size > 0 && activeCount === 0;

  useCmdEnterRun(() => {
    if (canRun) void run();
  });

  const copyCell = async (key: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedKey(key);
    // 2000ms matches the copy-feedback convention elsewhere in the app.
    setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 2000);
  };

  const toggleExpanded = (key: string) => setExpanded((prev) => toggleSetKey(prev, key));

  const hasResults = Object.keys(cells).length > 0;

  return (
    <>
      <ResizableLayout defaultSplit={32} minSplit={22} maxSplit={55}>
        {/* Config pane — readable measure; scrolls independently. */}
        <div className="flex-1 overflow-auto p-4">
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="playground-system" className="sp-label">
                System
              </Label>
              <Textarea
                id="playground-system"
                value={draft.system}
                onChange={(e) => patchDraft({ system: e.target.value })}
                rows={3}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="playground-user" className="sp-label">
                User prompt
              </Label>
              <Textarea
                id="playground-user"
                value={draft.user}
                onChange={(e) => patchDraft({ user: e.target.value })}
                rows={5}
              />
            </div>
            {promptVars.length > 0 && (
              <div className="space-y-1.5">
                <Label htmlFor="playground-vars" className="sp-label">
                  Variables ({promptVars.join(', ')})
                </Label>
                <Textarea
                  id="playground-vars"
                  value={draft.varsText}
                  onChange={(e) => patchDraft({ varsText: e.target.value })}
                  rows={4}
                  className="font-mono text-sp-13"
                  aria-invalid={!!varsError}
                />
                {varsError && (
                  <p className="text-sp-11 text-destructive">
                    Invalid JSON — placeholders will render empty: {varsError}
                  </p>
                )}
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="playground-max-tokens" className="sp-label">
                Max output tokens (optional)
              </Label>
              <Input
                id="playground-max-tokens"
                type="number"
                min={1}
                className="w-40"
                placeholder="provider default"
                value={draft.maxTokensText}
                onChange={(e) => patchDraft({ maxTokensText: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <span className="sp-label">Models</span>
              <ModelChecklist
                models={checklistEntries}
                selected={selectedSet}
                onToggle={toggle}
                onChangeSelected={setSelected}
                emptyText="No models are ready yet. Connect a provider to populate the catalog."
                emptyAction={
                  <Button variant="outline" size="sm" onClick={() => setTab('providers')}>
                    Open Models
                  </Button>
                }
              />
            </div>
            {activeCount > 0 ? (
              <Button variant="destructive" size="cta" onClick={stop} className="w-full">
                <Square className="h-3.5 w-3.5" /> Stop
              </Button>
            ) : (
              <Button
                variant="cta"
                size="cta"
                onClick={() => void run()}
                disabled={selectedSet.size === 0}
                className="w-full"
                title="Cmd/Ctrl+Enter"
              >
                <Play className="h-3.5 w-3.5" /> Run on {plural(selectedSet.size, 'model')}
              </Button>
            )}
            {hasResults && activeCount === 0 && (
              <Button variant="outline" size="sm" onClick={openSaveDialog} className="w-full">
                <Save className="h-3.5 w-3.5" /> Save outputs as dataset
              </Button>
            )}
          </div>
        </div>

        {/* Results pane — fills the window. */}
        <div className="flex-1 overflow-auto p-4">
          {hasResults ? (
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(320px,1fr))]">
              {modelOptions
                .filter((m) => cells[m.key])
                .map((m) => {
                  const cell = cells[m.key]!;
                  const isExpanded = expanded.has(m.key);
                  return (
                    <Floater
                      key={m.key}
                      radius="panel"
                      elevation="float"
                      className="flex flex-col bg-sp-surface p-3"
                    >
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <span className="truncate text-sp-12 font-medium text-sp-text">
                          {m.label}
                        </span>
                        <span className="flex shrink-0 items-center gap-1">
                          <StatusChip state={cell.status} />
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label="Copy output"
                            title="Copy output"
                            disabled={!cell.text}
                            onClick={() => void copyCell(m.key, cell.text)}
                          >
                            {copiedKey === m.key ? (
                              <Check className="h-3.5 w-3.5 text-emerald-500" />
                            ) : (
                              <Copy className="h-3.5 w-3.5" />
                            )}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={isExpanded ? 'Collapse output' : 'Expand output'}
                            title={isExpanded ? 'Collapse output' : 'Expand output'}
                            onClick={() => toggleExpanded(m.key)}
                          >
                            {isExpanded ? (
                              <Minimize2 className="h-3.5 w-3.5" />
                            ) : (
                              <Maximize2 className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        </span>
                      </div>
                      <div
                        className={`min-h-[6rem] overflow-auto whitespace-pre-wrap text-sp-13 text-sp-text ${
                          isExpanded ? '' : 'max-h-80'
                        }`}
                      >
                        {cell.error ? (
                          <span className="text-destructive">{cell.error}</span>
                        ) : (
                          cell.text
                        )}
                      </div>
                      {cell.completionTokens !== undefined && (
                        <div className="mt-3 flex gap-6 border-t border-sp-line pt-2.5">
                          <Stat
                            label="Tokens"
                            value={`${cell.promptTokens}+${cell.completionTokens}`}
                          />
                          <Stat
                            label="Cost"
                            value={
                              cell.cost == null
                                ? 'unknown'
                                : cell.cost === 0
                                  ? 'free'
                                  : `$${cell.cost.toFixed(5)}`
                            }
                          />
                        </div>
                      )}
                    </Floater>
                  );
                })}
            </div>
          ) : (
            <EmptyState
              fill
              icon={Sparkles}
              message="Compose a prompt, pick one or more models, and run to compare their outputs side by side."
            />
          )}
        </div>
      </ResizableLayout>

      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader icon={Save}>
            <DialogTitle>Save outputs as dataset</DialogTitle>
            <DialogDescription>
              The current variables plus each finished model output become cases (output as the
              reference) in a new dataset.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="playground-save-name" className="sp-label">
              Dataset name
            </Label>
            <Input
              id="playground-save-name"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveAsCases();
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setSaveOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={saveAsCases}>
              Save dataset
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
