import { CodeEditorFrame, TextField } from '@/components/ui/spatial';
import { Switch } from '@/components/ui/switch';
import { useMcpCompletionField } from '@/features/mcp/components/McpCompletionSuggestions';
import type { McpCompleteFn } from '@/features/mcp/hooks/useMcpCompletion';

export interface McpArgumentField {
  name: string;
  type: string;
  required: boolean;
  description?: string;
  isComplex: boolean;
  /** Mask the value and warn: the name/format suggests a secret (MCP elicitation). */
  sensitive?: boolean;
  /** Allowed values (JSON Schema `enum`), rendered as a select. */
  enumValues?: string[];
  /** Number bounds (JSON Schema `minimum` / `maximum`). */
  minimum?: number;
  maximum?: number;
  /** JSON Schema `default`, used to prefill an unsaved form. */
  defaultValue?: unknown;
}

/** Range error for a parsed number, or null. */
export function mcpNumberRangeError(field: McpArgumentField, value: unknown): string | null {
  if (typeof value !== 'number') return null;
  if (field.minimum !== undefined && value < field.minimum) {
    return `Must be at least ${field.minimum}.`;
  }
  if (field.maximum !== undefined && value > field.maximum) {
    return `Must be at most ${field.maximum}.`;
  }
  return null;
}

const SELECT_CLASS =
  'h-8 w-full rounded-sp-btn border border-sp-line bg-sp-surface-lo px-2 font-mono text-sp-12 text-sp-text outline-none focus-visible:ring-2 focus-visible:ring-[var(--sp-accent-glow-33)]';

interface McpArgumentFieldProps {
  field: McpArgumentField;
  value: string;
  error?: string;
  onChange: (value: string) => void;
  /** `completion/complete` lookup (prompt / resource-template arguments only). */
  complete?: McpCompleteFn;
}

export function McpArgumentField({
  field,
  value,
  error,
  onChange,
  complete,
}: McpArgumentFieldProps) {
  const completion = useMcpCompletionField(complete, value, onChange);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-mono font-bold text-sp-12 text-sp-text">{field.name}</span>
        <span className="font-mono text-sp-11 text-sp-dim">{field.type}</span>
        {field.required && (
          <span
            className="inline-flex items-center px-1.5 h-4 rounded-[5px] font-mono font-bold text-sp-9"
            style={{
              color: 'var(--color-danger)',
              background: 'color-mix(in srgb, var(--color-danger) 14%, transparent)',
            }}
          >
            REQUIRED
          </span>
        )}
      </div>
      {field.description && <div className="text-sp-11-5 text-sp-muted">{field.description}</div>}
      {field.enumValues && field.enumValues.length > 0 ? (
        <select
          aria-label={field.name}
          aria-invalid={error !== undefined}
          aria-describedby={error ? `${field.name}-error` : undefined}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={SELECT_CLASS}
        >
          {(!field.required || !field.enumValues.includes(value)) && (
            <option value="">{field.required ? 'Choose…' : '(not set)'}</option>
          )}
          {field.enumValues.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : field.type === 'boolean' ? (
        <div className="flex items-center gap-2">
          <Switch
            aria-label={field.name}
            aria-invalid={error !== undefined}
            aria-describedby={error ? `${field.name}-error` : undefined}
            checked={value === 'true'}
            onCheckedChange={(checked) => onChange(checked ? 'true' : 'false')}
          />
          <span className="font-mono text-sp-11 text-sp-dim">
            {value === 'true' || value === 'false' ? value : 'not set'}
          </span>
        </div>
      ) : field.isComplex ? (
        <CodeEditorFrame gutter={false} className="min-h-[100px]">
          <textarea
            aria-label={field.name}
            aria-invalid={error !== undefined}
            aria-describedby={error ? `${field.name}-error` : undefined}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            spellCheck={false}
            className="w-full h-full min-h-[80px] bg-transparent outline-none resize-y font-mono text-sp-12 text-sp-text placeholder:text-sp-dim"
            placeholder={field.type === 'array' ? '[]' : '{}'}
          />
        </CodeEditorFrame>
      ) : (
        <TextField
          mono
          size="md"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-invalid={error !== undefined}
          aria-describedby={error ? `${field.name}-error` : undefined}
          aria-label={field.name}
          {...(field.sensitive ? { type: 'password', autoComplete: 'off' } : {})}
          {...(field.type === 'number' || field.type === 'integer'
            ? {
                type: 'number',
                step: field.type === 'integer' ? 1 : 'any',
                ...(field.minimum !== undefined ? { min: field.minimum } : {}),
                ...(field.maximum !== undefined ? { max: field.maximum } : {}),
              }
            : {})}
          placeholder={field.type}
          className="w-full"
          {...completion.focusProps}
        />
      )}
      {field.sensitive && (
        <p className="text-sp-11-5 text-amber-500 dark:text-amber-400" role="note">
          This looks like a secret. Restura never needs you to type passwords or keys here.
        </p>
      )}
      {(field.minimum !== undefined || field.maximum !== undefined) && (
        <p className="text-sp-11 text-sp-dim">
          {field.minimum !== undefined && field.maximum !== undefined
            ? `Between ${field.minimum} and ${field.maximum}`
            : field.minimum !== undefined
              ? `At least ${field.minimum}`
              : `At most ${field.maximum}`}
        </p>
      )}
      {!field.isComplex && !field.enumValues && field.type !== 'boolean' && completion.suggestions}
      {error && (
        <p id={`${field.name}-error`} className="text-sp-11-5 text-rose-400" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
