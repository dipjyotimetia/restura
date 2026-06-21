import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { ParallelFlowNode } from '@/types';
import { NodeChrome } from './NodeChrome';
import { GitFork } from 'lucide-react';

type Data = ParallelFlowNode['data'];

function ParallelNodeImpl({ id, data, selected }: NodeProps) {
  const d = data as Data;
  return (
    <>
      <Handle type="target" position={Position.Top} />
      <NodeChrome nodeId={id} kindLabel="Parallel" selected={Boolean(selected)}>
        <div className="flex items-start gap-2">
          <GitFork className="h-4 w-4 mt-0.5 text-cyan-400" />
          <div className="min-w-0">
            <div className="text-xs font-medium">
              Fan-out · wait <span className="font-mono">{d.waitMode}</span>
            </div>
            <div className="text-[10px] text-muted-foreground mt-0.5">
              merge: <span className="font-mono">{d.mergeStrategy ?? 'fail-on-conflict'}</span>
            </div>
          </div>
        </div>
      </NodeChrome>
      <Handle type="source" position={Position.Bottom} />
    </>
  );
}

export const ParallelNode = memo(ParallelNodeImpl);
ParallelNode.displayName = 'ParallelNode';
