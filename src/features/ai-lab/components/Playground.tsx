import { Check, Copy, Maximize2, Minimize2, Play, Save, Sparkles, Square } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { specFor, streamLlm, type StreamHandle } from '../lib/llmClient';
import { buildModelOptions, plural, toChecklistEntries } from '../lib/modelOptions';
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
  // Prompt/model config lives in the session UI store so switching sub-tabs
  // (which unmounts this component) doesn't wipe the composition. Streaming
  // results stay component-local: their streams are cancelled on unmount
  // anyway, and resurrecting half-streamed cells would read as live.
  const draft = useAiLabUiStore((s) => s.playgroundDraft);
  const patchDraft = useAiLabUiStore((s) => s.patchPlaygroundDraft);
  const openDataset = useAiLabUiStore((s) => s.openDataset);

  const [cells, setCells] = useState<Record<string, CellState>>({});
  const [activeCount, setActiveCount] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const handlesRef = useRef<StreamHandle[]>([]);

  const modelOptions = useMemo(() => buildModelOptions(providers), [providers]);
  const selected = useMemo(() => new Set(draft.selected), [draft.selected]);

  const promptVars = useMemo(
    () => extractVars(`${draft.system}\n${draft.user}`),
    [draft.system, draft.user]
  );

  // Live-validate the vars JSON so a typo doesn't silently render every
  // {{placeholder}} empty (the old behavior — "tolerated" with no feedback).
  const varsError = useMemo(() => {
    const text = draft.varsText.trim();
    if (!text || promptVars.length === 0) return null;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return 'Variables must be a JSON object of string values.';
      }
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }, [draft.varsText, promptVars.length]);

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
    };
  }, []);

  const toggle = (key: string) => {
    const next = new Set(draft.selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    patchDraft({ selected: [...next] });
  };

  const stop = () => {
    for (const h of handlesRef.current) h.cancel();
    handlesRef.current = [];
    setActiveCount(0);
  };

  const parseVars = (): Record<string, string> => {
    try {
      return JSON.parse(draft.varsText || '{}') as Record<string, string>;
    } catch {
      return {};
    }
  };

  const finishedCases = () => {
    const vars = parseVars();
    return modelOptions
      .filter((m) => cells[m.key] && cells[m.key]!.status === 'done' && cells[m.key]!.text)
      .map((m, i) => ({ id: `${Date.now()}-${i}`, vars, reference: cells[m.key]!.text }));
  };

  /** Save the current vars + each finished model output as cases in a new dataset. */
  const saveAsCases = () => {
    const cases = finishedCases();
    if (cases.length === 0) {
      toast.error('No finished outputs to save.');
      return;
    }
    const name = saveName.trim() || 'From Playground';
    const id = upsertDataset({ name, cases });
    setSaveOpen(false);
    toast.success(`Saved ${plural(cases.length, 'case')} to “${name}”`, {
      action: { label: 'Open dataset', onClick: () => openDataset(id) },
    });
  };

  const openSaveDialog = () => {
    if (finishedCases().length === 0) {
      toast.error('No finished outputs to save.');
      return;
    }
    // Unique-enough default so repeated saves don't pile up identical names.
    const stamp = new Date().toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    setSaveName(`Playground ${stamp}`);
    setSaveOpen(true);
  };

  const run = async () => {
    const vars = parseVars();
    const sys = renderTemplate(draft.system, vars).trim();
    const usr = renderTemplate(draft.user, vars);
    const chosen = modelOptions.filter((m) => selected.has(m.key));
    if (chosen.length === 0) return;

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
              setCells((prev) => {
                const cell = prev[m.key] ?? { text: '', status: 'streaming' as const };
                if (ev.type === 'delta')
                  return { ...prev, [m.key]: { ...cell, text: cell.text + ev.text } };
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

  const canRun = selected.size > 0 && activeCount === 0;

  // Cmd/Ctrl+Enter runs from anywhere in the tab, including inside the prompt
  // textareas (mirrors the HTTP builder's send shortcut).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canRun) {
        e.preventDefault();
        void run();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const copyCell = async (key: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1500);
  };

  const toggleExpanded = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

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
                models={toChecklistEntries(modelOptions)}
                selected={selected}
                onToggle={toggle}
                onChangeSelected={(next) => patchDraft({ selected: [...next] })}
                emptyText="No models. Add a provider and discover its models in the Providers tab."
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
                disabled={selected.size === 0}
                className="w-full"
                title="Cmd/Ctrl+Enter"
              >
                <Play className="h-3.5 w-3.5" /> Run on {plural(selected.size, 'model')}
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
