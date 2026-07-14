import { Handle, type NodeProps, Position } from '@xyflow/react';
import { Code2 } from 'lucide-react';
import { memo } from 'react';
import type { TransformFlowNode } from '@/types';
import { NodeChrome } from './NodeChrome';

type Data = TransformFlowNode['data'];

function TransformNodeImpl({ id, data, selected }: NodeProps) {
  const d = data as Data;
  const lineCount = d.script ? d.script.split('\n').length : 0;
  return (
    <>
      <Handle type="target" position={Position.Top} />
      <NodeChrome nodeId={id} kindLabel="Transform" selected={Boolean(selected)}>
        <div className="flex items-start gap-2">
          <Code2 className="h-4 w-4 mt-0.5 text-purple-400" />
          <div className="min-w-0">
            <div className="text-xs font-medium">JS transform</div>
            <div className="text-[10px] text-muted-foreground mt-0.5">
              {lineCount > 0 ? `${lineCount} line${lineCount === 1 ? '' : 's'}` : 'empty'}
            </div>
          </div>
        </div>
      </NodeChrome>
      <Handle type="source" position={Position.Bottom} />
    </>
  );
}

export const TransformNode = memo(TransformNodeImpl);
TransformNode.displayName = 'TransformNode';
