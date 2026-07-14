import { Search } from 'lucide-react';
import type { ReactNode } from 'react';
import { memo, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Floater } from '@/components/ui/spatial';
import type { AiLabModelDetail } from '../types';

export interface ModelChecklistEntry {
  key: string;
  label: string;
  /** Group header this entry renders under (provider label). */
  group?: string;
  /** Slash-namespaced model id, displayed as a tooltip + dim caption. */
  id?: string;
  /** Optional rich metadata (provider-specific). Drives the small chips. */
  detail?: AiLabModelDetail;
}

/** Show the filter box + bulk controls once the list stops being trivially scannable. */
const FILTER_THRESHOLD = 8;

/**
 * Bounded, scrollable multi-select of provider models. Shared by the
 * Playground, the eval builder, and the Arena, which all pick a set of models
 * to run against.
 *
 * Scales to large catalogs (a full OpenRouter discovery is 300+ models):
 * entries are grouped under their provider, a text filter narrows by
 * label/id, and select-all/clear operate on the currently filtered subset.
 *
 * When an entry carries a `detail` (from any provider's discovery), we render
 * a tiny one-line summary under the model name. The summary is provider-
 * agnostic and composes whatever useful fields the discovery returned:
 *   - context length: "200K ctx"
 *   - modality: "text+image→text"
 *   - parameter size + quantization (Ollama): "3.2B · Q4_K_M"
 *   - vendor (OpenAI/Anthropic/OpenRouter): "anthropic"
 *   - created date (any cloud provider): "2024-10-22"
 *
 * Without this, every model reads as an opaque slash-namespaced slug and the
 * user has to remember which `claude-3-5-sonnet-20241022` is the dated one.
 *
 * Memoized: parents re-render per streamed token / progress tick, and this
 * list (potentially 300+ rows) only needs to re-render when the catalog or
 * selection changes — callers keep `models`/callbacks referentially stable.
 */
export const ModelChecklist = memo(function ModelChecklist({
  models,
  selected,
  onToggle,
  onChangeSelected,
  emptyText,
  emptyAction,
}: {
  models: ModelChecklistEntry[];
  selected: Set<string>;
  onToggle: (key: string) => void;
  /** Enables the bulk select-all / clear controls when provided. */
  onChangeSelected?: (next: Set<string>) => void;
  emptyText: string;
  emptyAction?: ReactNode;
}) {
  const [filter, setFilter] = useState('');

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return models;
    return models.filter(
      (m) =>
        m.label.toLowerCase().includes(q) ||
        (m.id ?? '').toLowerCase().includes(q) ||
        (m.group ?? '').toLowerCase().includes(q)
    );
  }, [models, filter]);

  // Group in first-seen order; entries without a group render at the top.
  const groups = useMemo(() => {
    const order: string[] = [];
    const byGroup = new Map<string, ModelChecklistEntry[]>();
    for (const m of filtered) {
      const g = m.group ?? '';
      if (!byGroup.has(g)) {
        byGroup.set(g, []);
        order.push(g);
      }
      byGroup.get(g)!.push(m);
    }
    return order.map((g) => ({ name: g, entries: byGroup.get(g)! }));
  }, [filtered]);

  if (models.length === 0) {
    return (
      <div className="flex flex-col items-start gap-2 rounded-sp-btn border border-dashed border-sp-line px-3 py-3">
        <p className="text-sp-12 text-sp-muted">{emptyText}</p>
        {emptyAction}
      </div>
    );
  }

  const showControls = models.length > FILTER_THRESHOLD;
  const selectAllFiltered = () => {
    if (!onChangeSelected) return;
    const next = new Set(selected);
    for (const m of filtered) next.add(m.key);
    onChangeSelected(next);
  };
  const clearAll = () => onChangeSelected?.(new Set());

  return (
    <div className="space-y-1.5">
      {showControls && (
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-sp-muted" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={`Filter ${models.length} models…`}
            aria-label="Filter models"
            className="pl-8"
          />
        </div>
      )}
      <Floater radius="btn" elevation="inset" className="max-h-72 space-y-0.5 overflow-auto p-1.5">
        {filtered.length === 0 && (
          <p className="px-2 py-3 text-center text-sp-12 text-sp-muted">
            No models match “{filter.trim()}”.
          </p>
        )}
        {groups.map((group) => (
          <div key={group.name || '__ungrouped'}>
            {group.name && (
              <div className="sticky top-0 z-10 -mx-1.5 bg-sp-surface-2/95 px-3 py-1 text-sp-10 font-semibold uppercase tracking-wide text-sp-muted backdrop-blur-sm">
                {group.name}
              </div>
            )}
            {group.entries.map((m) => {
              const summary = summarizeDetail(m.detail);
              const idSuffix = m.id && m.id !== m.label ? m.id : undefined;
              return (
                <label
                  key={m.key}
                  className="flex cursor-pointer items-start gap-2 rounded-sp-btn px-2 py-1.5 text-sp-12 text-sp-text hover:bg-sp-hover"
                >
                  <Checkbox
                    checked={selected.has(m.key)}
                    onCheckedChange={() => onToggle(m.key)}
                    className="mt-0.5"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium" title={idSuffix ?? m.label}>
                      {m.label}
                    </div>
                    {summary && (
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sp-11 text-sp-muted">
                        {summary.map((part, i) => (
                          <span key={i} className="whitespace-nowrap">
                            {part}
                          </span>
                        ))}
                      </div>
                    )}
                    {!summary && idSuffix && (
                      <div className="mt-0.5 truncate font-mono text-sp-10 text-sp-muted">
                        {idSuffix}
                      </div>
                    )}
                  </div>
                </label>
              );
            })}
          </div>
        ))}
      </Floater>
      <div className="flex items-center justify-between gap-2 px-0.5 text-sp-11 text-sp-muted">
        <span className="tabular-nums">
          {selected.size} of {models.length} selected
        </span>
        {onChangeSelected && showControls && (
          <span className="flex items-center gap-0.5">
            <Button variant="ghost" size="sm" onClick={selectAllFiltered}>
              Select {filter.trim() ? 'matching' : 'all'}
            </Button>
            <Button variant="ghost" size="sm" onClick={clearAll} disabled={selected.size === 0}>
              Clear
            </Button>
          </span>
        )}
      </div>
    </div>
  );
});

/**
 * Compose a one-line subtitle from whatever fields the discovery returned.
 * Order matters: the most useful chip (param size, context) goes first, the
 * least useful (a generic vendor name) goes last. Returns an empty array when
 * nothing useful is known — the checklist falls back to showing the id.
 */
function summarizeDetail(detail: AiLabModelDetail | undefined): string[] {
  if (!detail) return [];
  const parts: string[] = [];
  // Ollama's parameter size ("3.2B") is the single most useful chip — it
  // distinguishes a tiny local model from a 70B cloud-tier one.
  if (detail.parameterSize) parts.push(detail.parameterSize);
  if (detail.quantizationLevel) parts.push(detail.quantizationLevel);
  if (detail.contextLength !== undefined) parts.push(formatContext(detail.contextLength));
  if (detail.modality) parts.push(detail.modality as string);
  if (detail.vendor) parts.push(detail.vendor);
  if (detail.createdAt) {
    const d = formatDate(detail.createdAt);
    if (d) parts.push(d);
  }
  return parts;
}

function formatContext(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '';
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M ctx`;
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K ctx`;
  return `${tokens} ctx`;
}

function formatDate(iso: string): string {
  // Only the YYYY-MM-DD prefix; the rest of the ISO string is too noisy for a
  // chip and varies in precision per provider. Tolerant of already-truncated
  // strings so a renderer-side optimisation can pre-trim. Returns the empty
  // string (not undefined) so the caller can push it into a `string[]` after
  // a truthiness check without an extra non-null assertion.
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
  return m?.[1] ?? '';
}
