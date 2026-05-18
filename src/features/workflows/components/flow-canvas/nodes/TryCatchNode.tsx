import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { TryCatchFlowNode } from '@/types';
import { NodeChrome } from './NodeChrome';
import { ShieldAlert } from 'lucide-react';

type Data = TryCatchFlowNode['data'];

function TryCatchNodeImpl({ id, data, selected }: NodeProps) {
  const d = data as Data;
  const tryCount = d.trySubgraph?.nodes?.length ?? 0;
  const catchCount = d.catchSubgraph?.nodes?.length ?? 0;
  return (
    <>
      <Handle type="target" position={Position.Top} />
      <NodeChrome
        nodeId={id}
        kindLabel="Try / Catch"
        selected={Boolean(selected)}
      >
        <div className="flex items-start gap-2">
          <ShieldAlert className="h-4 w-4 mt-0.5 text-yellow-400" />
          <div className="min-w-0">
            <div className="text-xs font-medium">Error recovery</div>
            <div className="text-[10px] text-muted-foreground mt-0.5">
              try: {tryCount} · catch: {catchCount}
            </div>
          </div>
        </div>
      </NodeChrome>
      <Handle type="source" position={Position.Bottom} />
    </>
  );
}

export const TryCatchNode = memo(TryCatchNodeImpl);
TryCatchNode.displayName = 'TryCatchNode';
