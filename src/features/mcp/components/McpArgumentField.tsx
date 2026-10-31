import { CodeEditorFrame, TextField } from '@/components/ui/spatial';
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
}

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
      {field.isComplex ? (
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
          placeholder={field.type === 'boolean' ? 'true / false' : field.type}
          className="w-full"
          {...completion.focusProps}
        />
      )}
      {field.sensitive && (
        <p className="text-sp-11-5 text-amber-500 dark:text-amber-400" role="note">
          This looks like a secret. Restura never needs you to type passwords or keys here.
        </p>
      )}
      {!field.isComplex && completion.suggestions}
      {error && (
        <p id={`${field.name}-error`} className="text-sp-11-5 text-rose-400" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
