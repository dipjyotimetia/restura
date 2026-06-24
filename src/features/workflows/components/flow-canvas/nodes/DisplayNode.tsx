import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Eye } from 'lucide-react';
import { memo } from 'react';
import { NodeChrome } from './NodeChrome';
import type { DisplayFlowNode } from '@/types';

type Data = DisplayFlowNode['data'];

function DisplayNodeImpl({ id, data, selected }: NodeProps) {
  const d = data as Data;
  return (
    <>
      <Handle type="target" position={Position.Top} />
      <NodeChrome nodeId={id} kindLabel="Display" selected={Boolean(selected)}>
        <div className="flex items-start gap-2">
          <Eye className="h-4 w-4 mt-0.5 text-emerald-400" />
          <div className="min-w-0">
            <div className="text-xs font-medium truncate" title={d.label ?? d.valueExpression}>
              {d.label || 'Display value'}
            </div>
            <div
              className="text-[10px] font-mono text-muted-foreground truncate mt-0.5"
              title={d.valueExpression}
            >
              {d.valueExpression || '— set value —'} · {d.mode ?? 'json'}
            </div>
          </div>
        </div>
      </NodeChrome>
      <Handle type="source" position={Position.Bottom} />
    </>
  );
}

export const DisplayNode = memo(DisplayNodeImpl);
DisplayNode.displayName = 'DisplayNode';
