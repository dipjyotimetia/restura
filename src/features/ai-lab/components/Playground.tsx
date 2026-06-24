import { Play, Save, Sparkles, Square } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { specFor, streamLlm, type StreamHandle } from '../lib/llmClient';
import { renderTemplate, extractVars } from '../lib/promptTemplate';
import { useAiLabStore } from '../store/useAiLabStore';
import type { AiLabProviderConfig } from '../types';
import { EmptyState } from './EmptyState';
import { ModelChecklist } from './ModelChecklist';
import { StatusChip } from './StatusChip';
import { Button } from '@/components/ui/button';
import { Floater, Stat } from '@/components/ui/spatial';
import { Textarea } from '@/components/ui/textarea';

interface ModelOption {
  key: string;
  cfg: AiLabProviderConfig;
  model: string;
  label: string;
}

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
  const [system, setSystem] = useState('You are a helpful assistant.');
  const [user, setUser] = useState('Explain {{topic}} in one sentence.');
  const [varsText, setVarsText] = useState('{\n  "topic": "HTTP caching"\n}');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cells, setCells] = useState<Record<string, CellState>>({});
  const [activeCount, setActiveCount] = useState(0);
  const handlesRef = useRef<StreamHandle[]>([]);

  const modelOptions = useMemo<ModelOption[]>(() => {
    const out: ModelOption[] = [];
    for (const cfg of Object.values(providers)) {
      for (const model of cfg.models.length ? cfg.models : []) {
        out.push({ key: `${cfg.id}:${model}`, cfg, model, label: `${cfg.label} · ${model}` });
      }
    }
    return out;
  }, [providers]);

  const promptVars = useMemo(() => extractVars(`${system}\n${user}`), [system, user]);

  // Cancel any in-flight streams when this tab unmounts (AI Lab sub-tabs unmount
  // on switch). Without this, orphaned streams keep running and fire setState on
  // the unmounted component. Only `.cancel()` here — no setState on unmount.
  useEffect(() => {
    return () => {
      for (const h of handlesRef.current) h.cancel();
      handlesRef.current = [];
    };
  }, []);

  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const stop = () => {
    for (const h of handlesRef.current) h.cancel();
    handlesRef.current = [];
    setActiveCount(0);
  };

  /** Save the current vars + each finished model output as cases in a new dataset. */
  const saveAsCases = () => {
    let vars: Record<string, string> = {};
    try {
      vars = JSON.parse(varsText || '{}') as Record<string, string>;
    } catch {
      // tolerate — empty vars
    }
    const cases = modelOptions
      .filter((m) => cells[m.key] && cells[m.key]!.status === 'done' && cells[m.key]!.text)
      .map((m, i) => ({ id: `${Date.now()}-${i}`, vars, reference: cells[m.key]!.text }));
    if (cases.length === 0) {
      toast.error('No finished outputs to save.');
      return;
    }
    upsertDataset({ name: 'From Playground', cases });
    toast.success(`Saved ${cases.length} case(s) to a new dataset`);
  };

  const run = async () => {
    let vars: Record<string, string> = {};
    try {
      vars = JSON.parse(varsText || '{}') as Record<string, string>;
    } catch {
      // Tolerate empty/invalid — placeholders just render empty.
    }
    const sys = renderTemplate(system, vars).trim();
    const usr = renderTemplate(user, vars);
    const chosen = modelOptions.filter((m) => selected.has(m.key));
    if (chosen.length === 0) return;

    setActiveCount(chosen.length);
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
        return streamLlm(specFor(m.cfg, m.model, messages), {
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
        });
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

  const hasResults = Object.keys(cells).length > 0;

  return (
    <div className="flex h-full">
      {/* Config pane — fixed, readable measure; scrolls independently. */}
      <div className="flex w-[400px] shrink-0 flex-col overflow-auto border-r border-sp-line p-4">
        <div className="space-y-4">
          <div className="space-y-1.5">
            <span className="sp-label">System</span>
            <Textarea value={system} onChange={(e) => setSystem(e.target.value)} rows={3} />
          </div>
          <div className="space-y-1.5">
            <span className="sp-label">User prompt</span>
            <Textarea value={user} onChange={(e) => setUser(e.target.value)} rows={5} />
          </div>
          {promptVars.length > 0 && (
            <div className="space-y-1.5">
              <span className="sp-label">Variables ({promptVars.join(', ')})</span>
              <Textarea
                value={varsText}
                onChange={(e) => setVarsText(e.target.value)}
                rows={4}
                className="font-mono text-sp-13"
              />
            </div>
          )}
          <div className="space-y-1.5">
            <span className="sp-label">Models</span>
            <ModelChecklist
              models={modelOptions}
              selected={selected}
              onToggle={toggle}
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
            >
              <Play className="h-3.5 w-3.5" /> Run on {selected.size} model(s)
            </Button>
          )}
          {hasResults && activeCount === 0 && (
            <Button variant="outline" size="sm" onClick={saveAsCases} className="w-full">
              <Save className="h-3.5 w-3.5" /> Save outputs as dataset
            </Button>
          )}
        </div>
      </div>

      {/* Results pane — fills the window. */}
      <div className="min-w-0 flex-1 overflow-auto p-4">
        {hasResults ? (
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(320px,1fr))]">
            {modelOptions
              .filter((m) => cells[m.key])
              .map((m) => {
                const cell = cells[m.key]!;
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
                      <StatusChip state={cell.status} className="shrink-0" />
                    </div>
                    <div className="min-h-[6rem] whitespace-pre-wrap text-sp-13 text-sp-text">
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
    </div>
  );
}
