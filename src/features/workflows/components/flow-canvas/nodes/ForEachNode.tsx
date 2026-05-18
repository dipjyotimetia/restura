import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { ForEachFlowNode } from '@/types';
import { NodeChrome } from './NodeChrome';
import { Repeat } from 'lucide-react';

type Data = ForEachFlowNode['data'];

function ForEachNodeImpl({ id, data, selected }: NodeProps) {
  const d = data as Data;
  const nodeCount = d.subgraph?.nodes?.length ?? 0;
  return (
    <>
      <Handle type="target" position={Position.Top} />
      <NodeChrome
        nodeId={id}
        kindLabel="For Each"
        selected={Boolean(selected)}
      >
        <div className="flex items-start gap-2">
          <Repeat className="h-4 w-4 mt-0.5 text-orange-400" />
          <div className="min-w-0">
            <div
              className="text-xs font-mono truncate"
              title={d.collectionExpression}
            >
              {d.collectionExpression || '— set collection —'}
            </div>
            <div className="text-[10px] text-muted-foreground mt-0.5">
              iter: <span className="font-mono">{d.iteratorVar || '?'}</span>
              {' · '}
              concurrency: <span className="font-mono">{d.concurrency ?? 8}</span>
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

export const ForEachNode = memo(ForEachNodeImpl);
ForEachNode.displayName = 'ForEachNode';
