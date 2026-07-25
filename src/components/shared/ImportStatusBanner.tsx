import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { Floater } from '@/components/ui/spatial';
import type { ImportWarning } from '@/features/collections/lib/importers';
import { cn } from '@/lib/shared/utils';

interface ImportStatusBannerProps {
  status: 'idle' | 'success' | 'error';
  warnings: ImportWarning[];
  environmentOnlyName: string | null;
  errorMessage: string;
  onDismiss: () => void;
}

export function ImportStatusBanner({
  status,
  warnings,
  environmentOnlyName,
  errorMessage,
  onDismiss,
}: ImportStatusBannerProps) {
  if (status === 'idle') return null;

  if (status === 'success' && warnings.length === 0) {
    return (
      <Floater
        radius="panel"
        elevation="inset"
        className="p-3.5 flex items-center gap-2.5 border border-emerald-500/30"
        style={{ background: 'rgba(16,185,129,0.08)' }}
      >
        <CheckCircle2 size={16} className="text-emerald-400 shrink-0" />
        <span className="text-sp-13 text-emerald-300 font-medium">
          {environmentOnlyName
            ? `Imported environment: ${environmentOnlyName}`
            : 'Collection imported successfully'}
        </span>
      </Floater>
    );
  }

  if (status === 'success' && warnings.length > 0) {
    return (
      <Floater
        radius="panel"
        elevation="inset"
        className="p-3.5 border border-amber-500/30"
        style={{ background: 'rgba(245,158,11,0.08)' }}
      >
        <div className="flex items-center justify-between gap-3 mb-2">
          <div className="flex items-center gap-2 text-amber-300 font-medium text-sp-13">
            <AlertCircle size={16} className="shrink-0" />
            <span>
              Imported with {warnings.length} warning{warnings.length === 1 ? '' : 's'}
            </span>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            className={cn(
              'inline-flex items-center h-7 px-3 rounded-sp-btn',
              'bg-sp-surface border border-sp-line text-sp-text text-sp-11 font-medium',
              'hover:bg-sp-hover transition-colors'
            )}
          >
            Dismiss
          </button>
        </div>
        <ul className="space-y-1 text-sp-12 text-sp-muted max-h-40 overflow-y-auto pr-1">
          {warnings.slice(0, 20).map((warning, index) => (
            <li key={index} className="flex gap-2">
              <span className="text-amber-400/70 shrink-0">›</span>
              <span>{describeWarning(warning)}</span>
            </li>
          ))}
          {warnings.length > 20 && (
            <li className="text-sp-muted italic">… and {warnings.length - 20} more</li>
          )}
        </ul>
      </Floater>
    );
  }

  return (
    <Floater
      radius="panel"
      elevation="inset"
      className="p-3.5 flex items-start gap-2.5 border border-rose-500/30"
      style={{ background: 'rgba(244,63,94,0.08)' }}
    >
      <AlertCircle size={16} className="text-rose-400 shrink-0 mt-0.5" />
      <div className="min-w-0">
        <div className="text-sp-13 text-rose-300 font-medium">Import failed</div>
        <p className="text-sp-12 text-rose-300/80 mt-0.5 break-words">{errorMessage}</p>
      </div>
    </Floater>
  );
}

function describeWarning(warning: ImportWarning): string {
  switch (warning.kind) {
    case 'unrecognized-body':
      return `Unknown body shape in "${warning.requestName}" — preserved on round-trip but not editable`;
    case 'unrecognized-script-type':
      return `Script type "${warning.scriptType}" dropped from "${warning.requestName}"`;
    case 'unsupported-auth':
      return `Auth "${warning.authType}" not supported in "${warning.requestName}"`;
    case 'unsupported-method':
      return `Method "${warning.method}" not supported — "${warning.requestName}" imported as GET`;
    case 'unknown-dynamic-var':
      return `{{$${warning.varName}}} referenced ${warning.count}× but not implemented`;
    case 'bruno-syntax':
      return `Bruno-specific syntax "${warning.pattern}" in "${warning.requestName}"`;
    case 'platform-unsupported':
      return `${warning.feature} not available on this platform (${warning.requestName})`;
    case 'schema-version':
      return `${warning.format} v${warning.version}: ${warning.note}`;
    default:
      return 'Unknown warning';
  }
}
