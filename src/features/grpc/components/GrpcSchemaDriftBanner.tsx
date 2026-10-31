import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { UseGrpcSchemaDrift } from '@/features/grpc/hooks/useGrpcSchemaDrift';
import { cn } from '@/lib/shared/utils';

function summary(breaking: number, nonBreaking: number): string {
  const parts: string[] = [];
  if (breaking > 0) parts.push(`${breaking} breaking`);
  if (nonBreaking > 0) parts.push(`${nonBreaking} non-breaking`);
  return parts.join(', ');
}

/**
 * "Schema changed since saved" notice (#937). Shown when re-reflecting a gRPC
 * server returns a schema that differs from the request's saved snapshot;
 * lists each classified change and lets the user adopt the new snapshot or
 * keep the saved one.
 */
export function GrpcSchemaDriftBanner({ drift: state }: { drift: UseGrpcSchemaDrift }) {
  const [open, setOpen] = useState(false);
  const drift = state.drift;
  if (!drift) return null;
  const { diff, saved } = drift;
  const breaking = diff.breaking > 0;
  const savedAt = saved?.fetchedAt ? new Date(saved.fetchedAt).toLocaleString() : null;

  return (
    <div
      role="status"
      aria-label="gRPC schema drift"
      className={cn(
        'mx-3 mt-2 rounded-sp-btn text-sp-11',
        breaking ? 'bg-red-500/10 text-destructive' : 'bg-amber-500/10 text-sp-text'
      )}
    >
      <div className="flex items-center gap-1.5 p-2">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        <span className="flex-1 min-w-0 truncate">
          Schema changed since saved — {summary(diff.breaking, diff.nonBreaking)}
          {savedAt && <span className="text-sp-muted"> (saved {savedAt})</span>}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-sp-11"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          Details
        </Button>
        <Button variant="ghost" size="sm" className="h-6 px-2 text-sp-11" onClick={state.dismiss}>
          Keep saved
        </Button>
        <Button variant="outline" size="sm" className="h-6 px-2 text-sp-11" onClick={state.accept}>
          Update snapshot
        </Button>
      </div>
      {open && (
        <ul className="max-h-48 overflow-auto border-t border-sp-line px-2 py-1.5 space-y-1 font-mono">
          {diff.changes.map((c) => (
            <li key={`${c.rule}:${c.path}`} className="flex gap-2">
              <span
                className={cn(
                  'shrink-0',
                  c.severity === 'breaking' ? 'text-destructive' : 'text-sp-muted'
                )}
              >
                {c.severity === 'breaking' ? 'breaking' : 'additive'}
              </span>
              <span className="shrink-0 text-sp-muted">{c.rule}</span>
              <span className="min-w-0 break-words text-sp-text">
                {c.path} — {c.message}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
