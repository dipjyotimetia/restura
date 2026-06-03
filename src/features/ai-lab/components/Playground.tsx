import { useMemo, useRef, useState } from 'react';
import { Play, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { renderTemplate, extractVars } from '../lib/promptTemplate';
import { specFor, streamLlm, type StreamHandle } from '../lib/llmClient';
import { useAiLabStore } from '../store/useAiLabStore';
import type { AiLabProviderConfig } from '../types';

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

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[360px_1fr]">
      <div className="space-y-3">
        <div className="space-y-1">
          <Label className="text-xs">System</Label>
          <Textarea value={system} onChange={(e) => setSystem(e.target.value)} rows={3} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">User prompt</Label>
          <Textarea value={user} onChange={(e) => setUser(e.target.value)} rows={4} />
        </div>
        {promptVars.length > 0 && (
          <div className="space-y-1">
            <Label className="text-xs">Variables ({promptVars.join(', ')})</Label>
            <Textarea
              value={varsText}
              onChange={(e) => setVarsText(e.target.value)}
              rows={4}
              className="font-mono text-xs"
            />
          </div>
        )}
        <div className="space-y-1">
          <Label className="text-xs">Models</Label>
          {modelOptions.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No models. Add a provider and discover its models in the Providers tab.
            </p>
          ) : (
            <div className="max-h-48 space-y-1 overflow-auto rounded border border-border/40 p-2">
              {modelOptions.map((m) => (
                <label key={m.key} className="flex items-center gap-2 text-xs">
                  <Checkbox checked={selected.has(m.key)} onCheckedChange={() => toggle(m.key)} />
                  {m.label}
                </label>
              ))}
            </div>
          )}
        </div>
        {activeCount > 0 ? (
          <Button variant="destructive" size="sm" onClick={stop} className="w-full">
            <Square className="mr-2 h-3.5 w-3.5" /> Stop
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={() => void run()}
            disabled={selected.size === 0}
            className="w-full"
          >
            <Play className="mr-2 h-3.5 w-3.5" /> Run on {selected.size} model(s)
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {modelOptions
          .filter((m) => cells[m.key])
          .map((m) => {
            const cell = cells[m.key]!;
            return (
              <div
                key={m.key}
                className="glass-1 flex flex-col rounded-lg border border-border/40 p-3"
              >
                <div className="mb-2 flex items-center justify-between">
                  <span className="truncate text-xs font-medium">{m.label}</span>
                  <span className="text-[10px] text-muted-foreground">
                    {cell.status === 'streaming' ? '…' : cell.status}
                  </span>
                </div>
                <div className="min-h-[6rem] whitespace-pre-wrap text-sm">
                  {cell.error ? <span className="text-destructive">{cell.error}</span> : cell.text}
                </div>
                {cell.completionTokens !== undefined && (
                  <div className="mt-2 border-t border-border/40 pt-2 text-[10px] text-muted-foreground">
                    {cell.promptTokens}+{cell.completionTokens} tok ·{' '}
                    {cell.cost == null
                      ? 'cost unknown'
                      : cell.cost === 0
                        ? 'free'
                        : `$${cell.cost.toFixed(5)}`}
                  </div>
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
}
