import { Check, Download, Upload } from 'lucide-react';
import { type ChangeEvent, type DragEvent, useState } from 'react';
import { cn } from '@/lib/shared/utils';

export interface ImportFormatMeta {
  id: string;
  name: string;
  tagline: string;
  initials: string;
  color: string;
  accept: string;
}

interface FormatCardProps {
  format: ImportFormatMeta;
  active: boolean;
  onClick: () => void;
}

export function ImportFormatCard({ format, active, onClick }: FormatCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'relative flex items-center gap-2.5 p-3 rounded-sp-btn text-left',
        'border transition-all duration-150',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent',
        active
          ? 'border-sp-accent bg-sp-active'
          : 'border-sp-line bg-sp-surface-lo hover:bg-sp-hover hover:border-sp-line-strong'
      )}
      style={
        active
          ? { boxShadow: '0 0 0 1px var(--sp-accent), 0 8px 20px var(--sp-accent-glow-33)' }
          : undefined
      }
    >
      <span
        aria-hidden="true"
        className="flex items-center justify-center size-9 rounded-sp-btn shrink-0 text-sp-11 font-bold text-white tracking-wide"
        style={{
          background: format.color,
          boxShadow: `0 4px 10px ${format.color}55, inset 0 1px 0 rgba(255,255,255,0.2)`,
        }}
      >
        {format.initials}
      </span>
      <span className="flex flex-col min-w-0 flex-1">
        <span className="text-sp-13 font-semibold text-sp-text leading-tight">{format.name}</span>
        <span className="text-sp-11 text-sp-muted leading-tight mt-0.5 truncate">
          {format.tagline}
        </span>
      </span>
      {active && <Check size={14} className="text-sp-accent shrink-0" aria-hidden="true" />}
    </button>
  );
}

interface DropZoneProps {
  format: ImportFormatMeta;
  onFileUpload: (event: ChangeEvent<HTMLInputElement>) => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
}

export function ImportDropZone({ format, onFileUpload, onDrop }: DropZoneProps) {
  const [isDragging, setIsDragging] = useState(false);

  return (
    <div
      onDrop={(event) => {
        setIsDragging(false);
        onDrop(event);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        if (!isDragging) setIsDragging(true);
      }}
      onDragLeave={(event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && event.currentTarget.contains(next)) return;
        setIsDragging(false);
      }}
      className={cn(
        'relative rounded-sp-panel border-2 border-dashed p-8',
        'transition-all duration-150',
        isDragging
          ? 'border-sp-accent bg-sp-active'
          : 'border-sp-line bg-sp-surface-lo hover:border-sp-line-strong hover:bg-sp-hover'
      )}
      style={isDragging ? { boxShadow: '0 0 0 4px var(--sp-accent-glow-33)' } : undefined}
    >
      <div
        aria-hidden="true"
        className="absolute inset-0 pointer-events-none rounded-sp-panel"
        style={{
          background: isDragging
            ? 'radial-gradient(circle at 50% 0%, var(--sp-accent-glow-33), transparent 70%)'
            : undefined,
        }}
      />
      <input
        type="file"
        accept={format.accept}
        onChange={onFileUpload}
        aria-label={`Choose ${format.name} file`}
        className="hidden"
        id={`file-upload-${format.id}`}
      />
      <label
        htmlFor={`file-upload-${format.id}`}
        className="relative flex flex-col items-center gap-3 cursor-pointer text-center"
      >
        <div
          className="flex items-center justify-center size-14 rounded-full"
          style={{
            background: 'var(--sp-surface)',
            border: '1px solid var(--sp-line)',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)',
          }}
        >
          <Download
            size={22}
            className={cn('transition-colors', isDragging ? 'text-sp-accent' : 'text-sp-muted')}
          />
        </div>
        <div>
          <p className="text-sp-14 font-semibold text-sp-text">
            {isDragging ? `Release to import ${format.name}` : `Drop your ${format.name} file here`}
          </p>
          <p className="text-sp-12 text-sp-muted mt-0.5">
            or click to browse · accepts{' '}
            <code className="font-mono text-sp-11-5 text-sp-text/80">{format.accept}</code>
          </p>
        </div>
        <span
          className={cn(
            'inline-flex items-center gap-1.5 h-8 px-3 rounded-sp-btn pointer-events-none',
            'bg-sp-surface border border-sp-line-strong text-sp-text text-sp-12 font-medium',
            'shadow-sm'
          )}
        >
          <Upload size={12} aria-hidden="true" />
          Choose file
        </span>
      </label>
    </div>
  );
}
