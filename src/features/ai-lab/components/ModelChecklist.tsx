import type { AiLabModelDetail } from '../types';
import { Checkbox } from '@/components/ui/checkbox';
import { Floater } from '@/components/ui/spatial';

export interface ModelChecklistEntry {
  key: string;
  label: string;
  /** Slash-namespaced model id, displayed as a tooltip + dim caption. */
  id?: string;
  /** Optional rich metadata (provider-specific). Drives the small chips. */
  detail?: AiLabModelDetail;
}

/**
 * Bounded, scrollable multi-select of provider models. Shared by the Playground
 * and the eval builder, which both pick a set of models to run against.
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
 */
export function ModelChecklist({
  models,
  selected,
  onToggle,
  emptyText,
}: {
  models: ModelChecklistEntry[];
  selected: Set<string>;
  onToggle: (key: string) => void;
  emptyText: string;
}) {
  if (models.length === 0) {
    return <p className="px-2 py-1.5 text-sp-12 text-sp-muted">{emptyText}</p>;
  }
  return (
    <Floater radius="btn" elevation="inset" className="max-h-56 space-y-0.5 overflow-auto p-1.5">
      {models.map((m) => {
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
                <div className="mt-0.5 truncate font-mono text-sp-10 text-sp-muted">{idSuffix}</div>
              )}
            </div>
          </label>
        );
      })}
    </Floater>
  );
}

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
