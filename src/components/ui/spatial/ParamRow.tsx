import { X } from 'lucide-react';
import { cn } from '@/lib/shared/utils';
import { ToggleField } from './ToggleField';
import { VariableText } from './VariableText';
import { ComboboxInput, type ComboboxSuggestion } from './ComboboxInput';

export interface ParamRowData {
  id: string;
  enabled: boolean;
  key: string;
  value: string;
  description?: string;
}

export interface ParamRowProps {
  row: ParamRowData;
  onChange: (next: ParamRowData) => void;
  onRemove?: (id: string) => void;
  showVariableHighlight?: boolean;
  className?: string;
  /**
   * Suggestions for the KEY column. When set, the key input becomes a
   * combobox; selecting a suggestion that comes with a paired default value
   * auto-fills the value column when it's empty. When undefined, the row
   * renders a plain <input> (current behaviour — used by Params).
   */
  keySuggestions?: ReadonlyArray<ComboboxSuggestion>;
  /**
   * Resolves value-column suggestions for the current KEY. Called per render
   * with the row's current key; return `undefined` or an empty list to fall
   * back to a plain <input>. Used for header value suggestions
   * (Content-Type → application/json, …).
   */
  valueSuggestionsFor?: (key: string) => ReadonlyArray<string> | undefined;
}

export function ParamRow({
  row,
  onChange,
  onRemove,
  showVariableHighlight,
  className,
  keySuggestions,
  valueSuggestionsFor,
}: ParamRowProps) {
  const baseInput =
    'bg-transparent outline-none text-sp-text placeholder:text-sp-dim font-mono text-sp-12 w-full px-1.5 py-1 rounded-sp-chip focus:bg-sp-hover focus:ring-1 focus:ring-sp-accent/30 transition-colors';

  const valueOptions = valueSuggestionsFor?.(row.key);
  const valueSuggestions: ReadonlyArray<ComboboxSuggestion> | undefined =
    valueOptions && valueOptions.length > 0 ? valueOptions.map((v) => ({ value: v })) : undefined;

  const renderKey = () => {
    if (!keySuggestions || keySuggestions.length === 0) {
      return (
        <input
          value={row.key}
          onChange={(e) => onChange({ ...row, key: e.target.value })}
          placeholder="key"
          className={baseInput}
        />
      );
    }
    return (
      <ComboboxInput
        value={row.key}
        onChange={(next) => onChange({ ...row, key: next })}
        onSelectSuggestion={(s) => {
          // If the value column is empty and the just-selected key has known
          // default values, auto-fill the first one (mirrors Insomnia's UX).
          // Resolve against the suggestion's own value, not row.key — onChange
          // hasn't flushed yet so row.key is the previous value.
          const defaults = valueSuggestionsFor?.(s.value);
          const firstValue = defaults?.[0];
          if (!row.value && firstValue) {
            onChange({ ...row, key: s.value, value: firstValue });
          }
        }}
        suggestions={keySuggestions}
        placeholder="key"
        inputClassName={baseInput}
      />
    );
  };

  const renderValue = () => {
    if (!valueSuggestions) {
      return (
        <input
          value={row.value}
          onChange={(e) => onChange({ ...row, value: e.target.value })}
          placeholder="value"
          className={baseInput}
        />
      );
    }
    return (
      <ComboboxInput
        value={row.value}
        onChange={(next) => onChange({ ...row, value: next })}
        suggestions={valueSuggestions}
        placeholder="value"
        inputClassName={baseInput}
      />
    );
  };

  return (
    <div
      className={cn(
        'group grid items-center gap-2 px-2 py-1 border-b border-sp-line transition-colors',
        'hover:bg-sp-hover',
        !row.enabled && 'opacity-55',
        className
      )}
      style={{ gridTemplateColumns: '28px 1fr 1.5fr 1fr 22px' }}
    >
      <ToggleField
        checked={row.enabled}
        onChange={(enabled) => onChange({ ...row, enabled })}
        size="sm"
        ariaLabel="Enable parameter"
      />
      {renderKey()}
      <div className="relative">
        {renderValue()}
        {showVariableHighlight && row.value.includes('{{') && (
          <div
            aria-hidden="true"
            className="absolute inset-0 pointer-events-none flex items-center px-1.5"
          >
            <VariableText text={row.value} className="font-mono text-sp-12 text-transparent" />
          </div>
        )}
      </div>
      <input
        value={row.description ?? ''}
        onChange={(e) => onChange({ ...row, description: e.target.value })}
        placeholder="description"
        className="bg-transparent outline-none text-sp-muted placeholder:text-sp-dim text-sp-11-5 w-full px-1.5 py-1 rounded-sp-chip focus:bg-sp-hover focus:ring-1 focus:ring-sp-accent/30 transition-colors"
      />
      <button
        type="button"
        onClick={() => onRemove?.(row.id)}
        className="text-sp-dim opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover:text-sp-text p-0.5 rounded-sp-chip hover:bg-sp-line-strong transition-opacity focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent/40"
        aria-label="Remove row"
      >
        <X size={12} />
      </button>
    </div>
  );
}
