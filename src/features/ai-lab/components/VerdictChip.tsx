import { cn } from '@/lib/shared/utils';

/**
 * Pass / fail / n-a verdict pill for an eval cell. Shared by the EvalBuilder
 * live-results grid and the ReportView per-case drill-down so the colours and
 * labels stay in one place.
 */
export function VerdictChip({
  passed,
  notEvaluated,
  className,
}: {
  passed: boolean;
  notEvaluated?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'shrink-0 rounded px-1.5 py-0.5 text-sp-11',
        notEvaluated
          ? 'bg-sp-hover text-sp-muted'
          : passed
            ? 'bg-emerald-500/15 text-emerald-500'
            : 'bg-destructive/15 text-destructive',
        className
      )}
    >
      {notEvaluated ? 'n/a' : passed ? 'pass' : 'fail'}
    </span>
  );
}
