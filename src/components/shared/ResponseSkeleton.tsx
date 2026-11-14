import { Scale, Stagger, StaggerItem } from '@/components/ui/motion';
import { Skeleton } from '@/components/ui/skeleton';
import { Floater } from '@/components/ui/spatial';

export function ResponseSkeleton() {
  return (
    <Scale className="h-full flex flex-col relative z-20">
      <Floater radius="panel" elevation="float-lg" className="h-full flex flex-col overflow-hidden">
        <div className="flex items-center gap-4 px-4 py-2.5 border-b border-sp-line">
          <Skeleton className="h-7 w-28 rounded-md" />
          <div className="h-5 w-px bg-sp-line" />
          <Skeleton className="h-5 w-20 rounded" />
          <div className="h-5 w-px bg-sp-line" />
          <Skeleton className="h-5 w-16 rounded" />
        </div>
        <div className="flex-1 p-4">
          <Stagger className="space-y-2 font-mono text-sm">
            <StaggerItem>
              <Skeleton className="h-3.5 w-12 rounded" />
            </StaggerItem>
            <StaggerItem className="pl-4 space-y-2">
              <Skeleton className="h-3.5 w-3/4 rounded" />
              <Skeleton className="h-3.5 w-1/2 rounded" />
              <div className="pl-4 space-y-2">
                <Skeleton className="h-3.5 w-2/3 rounded" />
                <Skeleton className="h-3.5 w-4/5 rounded" />
                <Skeleton className="h-3.5 w-1/3 rounded" />
              </div>
              <Skeleton className="h-3.5 w-2/5 rounded" />
            </StaggerItem>
            <StaggerItem>
              <Skeleton className="h-3.5 w-8 rounded" />
            </StaggerItem>
          </Stagger>
        </div>
      </Floater>
    </Scale>
  );
}
