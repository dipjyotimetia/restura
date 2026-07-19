import { CodeEditorFrame, TextField } from '@/components/ui/spatial';

export interface McpArgumentField {
  name: string;
  type: string;
  required: boolean;
  description?: string;
  isComplex: boolean;
}

interface McpArgumentFieldProps {
  field: McpArgumentField;
  value: string;
  error?: string;
  onChange: (value: string) => void;
}

export function McpArgumentField({ field, value, error, onChange }: McpArgumentFieldProps) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-mono font-bold text-sp-12 text-sp-text">{field.name}</span>
        <span className="font-mono text-sp-11 text-sp-dim">{field.type}</span>
        {field.required && (
          <span
            className="inline-flex items-center px-1.5 h-4 rounded-[5px] font-mono font-bold text-sp-9 tracking-wider"
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
          placeholder={field.type === 'boolean' ? 'true / false' : field.type}
          className="w-full"
        />
      )}
      {error && (
        <p id={`${field.name}-error`} className="text-sp-11-5 text-rose-400" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
