import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { ConditionFlowNode } from '@/types';
import { NodeChrome } from './NodeChrome';
import { GitBranch } from 'lucide-react';

type Data = ConditionFlowNode['data'];

function ConditionNodeImpl({ id, data, selected }: NodeProps) {
  const d = data as Data;
  return (
    <>
      <Handle type="target" position={Position.Top} />
      <NodeChrome nodeId={id} kindLabel="Condition" selected={Boolean(selected)}>
        <div className="flex items-start gap-2">
          <GitBranch className="h-4 w-4 mt-0.5 text-violet-400" />
          <div className="min-w-0">
            <div className="text-xs font-medium truncate" title={d.description ?? d.expression}>
              {d.description ?? 'Branch by expression'}
            </div>
            <div
              className="text-[10px] font-mono text-muted-foreground truncate mt-0.5"
              title={d.expression}
            >
              {d.expression || '— set expression —'}
            </div>
          </div>
        </div>
        <div className="mt-1.5 flex gap-2 text-[10px] uppercase tracking-wider font-mono">
          <span className="text-emerald-500">↳ true</span>
          <span className="text-red-400">↳ false</span>
        </div>
      </NodeChrome>
      {/* Explicit named handles so React Flow routes edges by sourceHandle. */}
      <Handle type="source" id="true" position={Position.Bottom} style={{ left: '30%' }} />
      <Handle type="source" id="false" position={Position.Bottom} style={{ left: '70%' }} />
    </>
  );
}

export const ConditionNode = memo(ConditionNodeImpl);
ConditionNode.displayName = 'ConditionNode';
