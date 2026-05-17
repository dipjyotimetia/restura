import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/shared/utils';

export function CodeEditorSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn('border border-border rounded-lg p-4 space-y-2 bg-background', className)}>
      <Skeleton className="h-3.5 w-3/4 rounded" />
      <Skeleton className="h-3.5 w-1/2 rounded" />
      <Skeleton className="h-3.5 w-2/3 rounded" />
      <Skeleton className="h-3.5 w-4/5 rounded" />
    </div>
  );
}
