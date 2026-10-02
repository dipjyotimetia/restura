import { Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { Button } from '@/components/ui/button';
import {
  ComboboxInput,
  type ComboboxSuggestion,
  PARAM_GRID,
  ParamRow,
  type ParamRowData,
  type VariableStatus,
} from '@/components/ui/spatial';
import type { VariableScope } from '@/hooks/useVariableStatus';
import { fromBulkText, toBulkText } from '@/lib/shared/bulkEdit';
import { getHeaderDef, STANDARD_HTTP_HEADERS } from '@/lib/shared/http-headers';
import { cn } from '@/lib/shared/utils';
import type { KeyValue } from '@/types';

/** Standard HTTP header names for the key column. */
export const HEADER_KEY_SUGGESTIONS: ReadonlyArray<ComboboxSuggestion> = STANDARD_HTTP_HEADERS.map(
  (h) => ({
    value: h.name,
    ...(h.description !== undefined && { description: h.description }),
  })
);

/** Known values for a header (Content-Type → application/json, …). */
export function headerValueSuggestionsFor(key: string): ReadonlyArray<string> | undefined {
  const def = getHeaderDef(key);
  return def?.values && def.values.length > 0 ? def.values : undefined;
}

export function toParamRow(kv: KeyValue): ParamRowData {
  const row: ParamRowData = {
    id: kv.id,
    enabled: kv.enabled,
    key: kv.key,
    value: kv.value,
  };
  if (kv.description !== undefined) row.description = kv.description;
  return row;
}

interface ParamHeaderTableProps {
  rows: ParamRowData[];
  onRowChange: (row: ParamRowData) => void;
  onRowRemove: (id: string) => void;
  onAdd: (overrides?: Partial<Pick<ParamRowData, 'key' | 'value' | 'description'>>) => void;
  /** The stored rows, for bulk edit (keeps descriptions/ids across the text round-trip). */
  source: KeyValue[];
  onReplaceAll: (rows: KeyValue[]) => void;
  /** Singular noun for accessible names, e.g. 'parameter' or 'header'. */
  itemLabel: string;
  keySuggestions?: ReadonlyArray<ComboboxSuggestion>;
  valueSuggestionsFor?: (key: string) => ReadonlyArray<string> | undefined;
  getStatus?: (varName: string) => VariableStatus;
  /** Highlight `{{var}}` values — only where the send path substitutes them. */
  showVariableHighlight?: boolean;
  /** Which resolver the values feed (suggestions + hover cards). */
  variableScope?: VariableScope;
  /** Footer add-button text. */
  addLabel?: string;
  /**
   * `fill` grows to its panel and scrolls rows internally (HTTP sub-tabs);
   * `auto` sizes to its rows, for config sections inside a scrolling panel.
   */
  layout?: 'fill' | 'auto';
}

const GHOST_FIELDS = [
  { label: 'Key', field: 'key' as const, extraClass: '' },
  { label: 'Value', field: 'value' as const, extraClass: '' },
  { label: 'Description', field: 'desc' as const, extraClass: 'text-sp-11-5 text-sp-muted' },
] as const;

const COLUMN_LABELS = ['KEY', 'VALUE', 'DESCRIPTION'] as const;

/**
 * Key/value table (params, headers, metadata): toggle, key, value and
 * description columns, an always-present ghost row for adding, bulk edit,
 * and an active-count footer.
 */
export function ParamHeaderTable({
  rows,
  onRowChange,
  onRowRemove,
  onAdd,
  source,
  onReplaceAll,
  itemLabel,
  keySuggestions,
  valueSuggestionsFor,
  getStatus,
  showVariableHighlight = true,
  variableScope = 'request',
  addLabel = 'Add row',
  layout = 'fill',
}: ParamHeaderTableProps) {
  const fill = layout === 'fill';
  const [draft, setDraft] = useState({ key: '', value: '', desc: '' });
  // Bulk edit: null = table view; otherwise the text being edited.
  const [bulkText, setBulkText] = useState<string | null>(null);
  const applyBulk = () => {
    if (bulkText !== null) onReplaceAll(fromBulkText(bulkText, source, uuidv4));
    setBulkText(null);
  };
  const newRowRef = useRef<HTMLInputElement>(null);
  // Set when a commit should pull focus into the freshly-added row (Enter only,
  // never blur — a blur commit means the user is leaving, so stealing focus
  // would hijack wherever they clicked).
  const focusNewRow = useRef(false);
  const prevRowCount = useRef(rows.length);
  const activeCount = rows.filter((r) => r.enabled && r.key.trim()).length;

  // Focus the appended row's key input once it has actually rendered. Keyed on
  // the row count growing rather than a single requestAnimationFrame, so it
  // survives deferred store updates and concurrent rendering.
  useEffect(() => {
    if (rows.length > prevRowCount.current && focusNewRow.current) {
      newRowRef.current?.focus();
    }
    focusNewRow.current = false;
    prevRowCount.current = rows.length;
  }, [rows.length]);

  function commitDraft(refocus: boolean) {
    if (!draft.key.trim() && !draft.value.trim()) return;
    focusNewRow.current = refocus;
    onAdd({
      key: draft.key,
      value: draft.value,
      ...(draft.desc ? { description: draft.desc } : {}),
    });
    setDraft({ key: '', value: '', desc: '' });
  }

  function handleGhostKeyDown(e: React.KeyboardEvent) {
    // A defaultPrevented Enter means a ComboboxInput consumed it to pick a
    // suggestion — the user is still composing the row, so don't commit yet.
    if (e.key === 'Enter' && !e.defaultPrevented) {
      e.preventDefault();
      commitDraft(true);
    }
  }

  function handleGhostBlur(e: React.FocusEvent<HTMLDivElement>) {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      commitDraft(false);
    }
  }

  const ghostInput =
    'bg-transparent outline-none placeholder:text-sp-dim/50 font-mono text-sp-12 w-full px-2 py-1.5 focus:bg-sp-hover/50 transition-colors';

  return (
    <div className={cn('relative flex flex-col', fill && 'h-full min-h-0')}>
      {/* Column header — pinned */}
      <div
        className="grid items-center border-b border-sp-line bg-sp-surface-lo/30 flex-none"
        style={{ gridTemplateColumns: PARAM_GRID }}
      >
        <span aria-hidden="true" />
        {COLUMN_LABELS.map((col) => (
          <span
            key={col}
            className="sp-label uppercase tracking-wider text-[10px] px-2 py-2 border-l border-sp-line/40"
          >
            {col}
          </span>
        ))}
        <span aria-hidden="true" />
      </div>

      {/* Scrollable rows + ghost row — only this region scrolls, so the header
          and footer stay pinned and never clip against the panel edge. */}
      <div
        className={cn(
          fill && 'flex-1 overflow-auto min-h-0',
          // Auto layout has no overlay: the bulk textarea replaces the rows.
          !fill && bulkText !== null && 'hidden'
        )}
      >
        <div role="rowgroup">
          {rows.map((row, i) => (
            <ParamRow
              key={row.id}
              row={row}
              onChange={onRowChange}
              onRemove={onRowRemove}
              itemLabel={itemLabel}
              showVariableHighlight={showVariableHighlight}
              variableScope={variableScope}
              {...(getStatus && { getStatus })}
              {...(i === rows.length - 1 && { inputRef: newRowRef })}
              {...(keySuggestions && { keySuggestions })}
              {...(valueSuggestionsFor && { valueSuggestionsFor })}
            />
          ))}
        </div>

        {/*
          Ghost row — always-visible add affordance. Drafts get the same
          key/value autocomplete as committed rows (that's when suggestions
          matter most — while typing the new header); variable highlighting
          still applies only once the row is committed above.
        */}
        {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- container delegates blur/keydown from the nested ghost-row inputs */}
        <div
          className="grid items-stretch border-b border-sp-line/50 opacity-40 focus-within:opacity-75 transition-opacity"
          style={{ gridTemplateColumns: PARAM_GRID }}
          onBlur={handleGhostBlur}
          onKeyDown={handleGhostKeyDown}
        >
          <div className="flex items-center justify-center">
            <span aria-hidden="true" className="h-3 w-3 rounded-full border border-sp-line/60" />
          </div>
          {GHOST_FIELDS.map(({ label, field, extraClass }) => {
            const suggestions =
              field === 'key'
                ? keySuggestions
                : field === 'value'
                  ? valueSuggestionsFor?.(draft.key)?.map((v) => ({ value: v }))
                  : undefined;
            return (
              <div key={field} className="border-l border-sp-line/40 min-w-0">
                {suggestions && suggestions.length > 0 ? (
                  <ComboboxInput
                    value={draft[field]}
                    onChange={(val) => setDraft((d) => ({ ...d, [field]: val }))}
                    suggestions={suggestions}
                    placeholder={label}
                    inputClassName={cn(ghostInput, extraClass)}
                    aria-label={`New entry ${label.toLowerCase()}`}
                  />
                ) : (
                  <input
                    value={draft[field]}
                    onChange={(e) => setDraft((d) => ({ ...d, [field]: e.target.value }))}
                    placeholder={label}
                    className={cn(ghostInput, extraClass)}
                    aria-label={`New entry ${label.toLowerCase()}`}
                  />
                )}
              </div>
            );
          })}
          <div />
        </div>
      </div>

      {bulkText !== null && (
        <div
          className={cn(
            'flex flex-col bg-sp-surface p-2',
            fill ? 'absolute inset-0 top-9 bottom-10 z-10' : 'border-t border-sp-line/50'
          )}
        >
          <textarea
            autoFocus
            aria-label={`Bulk edit ${itemLabel}s`}
            value={bulkText}
            onChange={(e) => setBulkText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                setBulkText(null);
              }
            }}
            spellCheck={false}
            placeholder={'key: value\n//disabled-key: value'}
            rows={fill ? undefined : 6}
            className="flex-1 resize-none rounded-sp-btn border border-sp-line bg-sp-code p-2 font-mono text-sp-12 text-sp-text outline-none focus-visible:ring-2 focus-visible:ring-sp-accent"
          />
          <p className="mt-1 text-sp-11 text-sp-dim">
            One <code className="font-mono">key: value</code> per line; prefix with{' '}
            <code className="font-mono">//</code> to disable.
          </p>
        </div>
      )}

      {/* Footer — pinned */}
      <div className="flex items-center justify-between px-3 py-2 border-t border-sp-line/50 flex-none">
        {bulkText !== null ? (
          <div className="flex items-center gap-2">
            <Button size="sm" className="h-7" onClick={applyBulk}>
              Apply
            </Button>
            <Button size="sm" variant="ghost" className="h-7" onClick={() => setBulkText(null)}>
              Cancel
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => onAdd()}
              className={cn(
                'inline-flex items-center gap-1 text-sp-11 text-sp-dim',
                'hover:text-sp-accent transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent/40 rounded-sp-chip'
              )}
            >
              <Plus size={11} />
              <span>{addLabel}</span>
            </button>
            <button
              type="button"
              onClick={() => setBulkText(toBulkText(source))}
              className={cn(
                'text-sp-11 text-sp-dim hover:text-sp-accent transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent/40 rounded-sp-chip'
              )}
            >
              Bulk edit
            </button>
          </div>
        )}
        {rows.length > 0 && (
          <span className="text-sp-11 text-sp-dim font-mono tabular-nums">
            {activeCount} of {rows.length} active
          </span>
        )}
      </div>
    </div>
  );
}
