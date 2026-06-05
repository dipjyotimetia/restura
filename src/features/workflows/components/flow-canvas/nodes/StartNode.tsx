import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { cn } from '@/lib/shared/utils';

function StartNodeImpl({ selected }: NodeProps) {
  return (
    <>
      <div
        className={cn(
          'glass-2 rounded-full px-4 py-1.5 text-[11px] font-mono uppercase tracking-wider text-muted-foreground',
          'ring-1 ring-sp-line',
          'transition-all duration-150',
          selected && 'ring-2 ring-primary/70'
        )}
      >
        Start
      </div>
      <Handle type="source" position={Position.Bottom} />
    </>
  );
}

export const StartNode = memo(StartNodeImpl);
StartNode.displayName = 'StartNode';
