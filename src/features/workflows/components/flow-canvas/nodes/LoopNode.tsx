import { Handle, Position, type NodeProps } from '@xyflow/react';
import { RotateCw } from 'lucide-react';
import { memo } from 'react';
import { NodeChrome } from './NodeChrome';
import type { LoopFlowNode } from '@/types';

type Data = LoopFlowNode['data'];

function LoopNodeImpl({ id, data, selected }: NodeProps) {
  const d = data as Data;
  const nodeCount = d.subgraph?.nodes?.length ?? 0;
  return (
    <>
      <Handle type="target" position={Position.Top} />
      <NodeChrome nodeId={id} kindLabel="Loop" selected={Boolean(selected)}>
        <div className="flex items-start gap-2">
          <RotateCw className="h-4 w-4 mt-0.5 text-lime-400" />
          <div className="min-w-0">
            <div className="text-xs font-mono truncate" title={d.conditionExpression}>
              {d.conditionExpression || '— set condition —'}
            </div>
            <div className="text-[10px] text-muted-foreground mt-0.5">
              {d.mode ?? 'while'}
              {' · max '}
              <span className="font-mono">{d.maxIterations ?? 10}</span>
              {' · '}
              {nodeCount} sub-node{nodeCount === 1 ? '' : 's'}
            </div>
          </div>
        </div>
      </NodeChrome>
      <Handle type="source" position={Position.Bottom} />
    </>
  );
}

export const LoopNode = memo(LoopNodeImpl);
LoopNode.displayName = 'LoopNode';
