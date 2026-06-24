import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Clock } from 'lucide-react';
import { memo } from 'react';
import { NodeChrome } from './NodeChrome';
import type { DelayFlowNode } from '@/types';

type Data = DelayFlowNode['data'];

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms % 1000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function DelayNodeImpl({ id, data, selected }: NodeProps) {
  const d = data as Data;
  return (
    <>
      <Handle type="target" position={Position.Top} />
      <NodeChrome nodeId={id} kindLabel="Delay" selected={Boolean(selected)}>
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-amber-400" />
          <span className="text-sm font-medium">Wait {formatDuration(d.ms ?? 0)}</span>
        </div>
      </NodeChrome>
      <Handle type="source" position={Position.Bottom} />
    </>
  );
}

export const DelayNode = memo(DelayNodeImpl);
DelayNode.displayName = 'DelayNode';
