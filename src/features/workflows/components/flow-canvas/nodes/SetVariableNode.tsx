import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { SetVariableFlowNode } from '@/types';
import { NodeChrome } from './NodeChrome';
import { Variable } from 'lucide-react';

type Data = SetVariableFlowNode['data'];

function SetVariableNodeImpl({ id, data, selected }: NodeProps) {
  const d = data as Data;
  const count = d.assignments?.length ?? 0;
  const preview = (d.assignments ?? [])
    .slice(0, 3)
    .map((a) => a.key)
    .join(', ');
  return (
    <>
      <Handle type="target" position={Position.Top} />
      <NodeChrome nodeId={id} kindLabel="Set Variable" selected={Boolean(selected)}>
        <div className="flex items-start gap-2">
          <Variable className="h-4 w-4 mt-0.5 text-blue-400" />
          <div className="min-w-0">
            <div className="text-xs font-medium">
              {count === 0 ? 'No assignments' : `${count} variable${count === 1 ? '' : 's'}`}
            </div>
            {preview && (
              <div className="text-[10px] font-mono text-muted-foreground truncate mt-0.5">
                {preview}
                {count > 3 ? '…' : ''}
              </div>
            )}
          </div>
        </div>
      </NodeChrome>
      <Handle type="source" position={Position.Bottom} />
    </>
  );
}

export const SetVariableNode = memo(SetVariableNodeImpl);
SetVariableNode.displayName = 'SetVariableNode';
