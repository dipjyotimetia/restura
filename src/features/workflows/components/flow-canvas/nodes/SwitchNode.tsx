import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Split } from 'lucide-react';
import { memo } from 'react';
import { NodeChrome } from './NodeChrome';
import type { SwitchFlowNode } from '@/types';

type Data = SwitchFlowNode['data'];

function SwitchNodeImpl({ id, data, selected }: NodeProps) {
  const d = data as Data;
  const cases = d.cases ?? [];
  // One source handle per case plus a trailing 'default' handle, spread
  // evenly along the bottom edge so React Flow can route by sourceHandle.
  const handleIds = [...cases.map((c) => c.id), 'default'];
  return (
    <>
      <Handle type="target" position={Position.Top} />
      <NodeChrome nodeId={id} kindLabel="Switch" selected={Boolean(selected)}>
        <div className="flex items-start gap-2">
          <Split className="h-4 w-4 mt-0.5 text-indigo-400" />
          <div className="min-w-0">
            <div
              className="text-xs font-medium truncate"
              title={d.description ?? 'Multi-branch switch'}
            >
              {d.description ?? 'Multi-branch switch'}
            </div>
            <div className="text-[10px] text-muted-foreground mt-0.5">
              {cases.length} case{cases.length === 1 ? '' : 's'} + default
            </div>
          </div>
        </div>
        <div className="mt-1.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] uppercase tracking-wider font-mono">
          {cases.map((c, i) => (
            <span key={c.id} className="text-indigo-400">
              ↳ {c.label || `case ${i + 1}`}
            </span>
          ))}
          <span className="text-muted-foreground">↳ default</span>
        </div>
      </NodeChrome>
      {handleIds.map((hid, i) => (
        <Handle
          key={hid}
          type="source"
          id={hid}
          position={Position.Bottom}
          style={{
            left: `${((i + 1) / (handleIds.length + 1)) * 100}%`,
          }}
        />
      ))}
    </>
  );
}

export const SwitchNode = memo(SwitchNodeImpl);
SwitchNode.displayName = 'SwitchNode';
