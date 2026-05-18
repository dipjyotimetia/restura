import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { cn } from '@/lib/shared/utils';

function EndNodeImpl({ selected }: NodeProps) {
  return (
    <>
      <Handle type="target" position={Position.Top} />
      <div
        className={cn(
          'glass-2 rounded-full px-4 py-1.5 text-[11px] font-mono uppercase tracking-wider text-muted-foreground',
          'ring-1 ring-[hsl(var(--foreground)/var(--border-default))]',
          'transition-all duration-150',
          selected && 'ring-2 ring-primary/70'
        )}
      >
        End
      </div>
    </>
  );
}

export const EndNode = memo(EndNodeImpl);
EndNode.displayName = 'EndNode';
