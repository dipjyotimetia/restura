import { X } from 'lucide-react';
import { cn } from '@/lib/shared/utils';
import { ToggleField } from './ToggleField';
import { VariableText } from './VariableText';

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
}

export function ParamRow({
  row,
  onChange,
  onRemove,
  showVariableHighlight,
  className,
}: ParamRowProps) {
  const baseInput =
    'bg-transparent outline-none text-sp-text placeholder:text-sp-dim font-mono text-sp-12 w-full';

  return (
    <div
      className={cn(
        'grid items-center gap-2 px-2 py-1.5 border-b border-sp-line transition-colors',
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
      <input
        value={row.key}
        onChange={(e) => onChange({ ...row, key: e.target.value })}
        placeholder="key"
        className={baseInput}
      />
      <div className="relative">
        <input
          value={row.value}
          onChange={(e) => onChange({ ...row, value: e.target.value })}
          placeholder="value"
          className={baseInput}
        />
        {showVariableHighlight && row.value.includes('{{') && (
          <div
            aria-hidden="true"
            className="absolute inset-0 pointer-events-none flex items-center"
          >
            <VariableText text={row.value} className="font-mono text-sp-12 text-transparent" />
          </div>
        )}
      </div>
      <input
        value={row.description ?? ''}
        onChange={(e) => onChange({ ...row, description: e.target.value })}
        placeholder="description"
        className="bg-transparent outline-none text-sp-muted placeholder:text-sp-dim text-sp-11-5 w-full"
      />
      <button
        type="button"
        onClick={() => onRemove?.(row.id)}
        className="text-sp-dim hover:text-sp-text p-0.5 rounded-sp-chip hover:bg-sp-hover"
        aria-label="Remove row"
      >
        <X size={12} />
      </button>
    </div>
  );
}
