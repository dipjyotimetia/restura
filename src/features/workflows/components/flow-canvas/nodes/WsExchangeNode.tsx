import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Plug } from 'lucide-react';
import { memo } from 'react';
import { NodeChrome } from './NodeChrome';
import type { WsExchangeFlowNode } from '@/types';

type Data = WsExchangeFlowNode['data'];

function WsExchangeNodeImpl({ id, data, selected }: NodeProps) {
  const d = data as Data;
  return (
    <>
      <Handle type="target" position={Position.Top} />
      <NodeChrome nodeId={id} kindLabel="WebSocket Exchange" selected={Boolean(selected)}>
        <div className="flex items-start gap-2">
          <Plug className="h-4 w-4 mt-0.5 text-teal-400" />
          <div className="min-w-0">
            <div className="text-xs font-mono truncate" title={d.url || 'wss://…'}>
              {d.url || '— set URL —'}
            </div>
            <div className="text-[10px] text-muted-foreground mt-0.5">send → match</div>
          </div>
        </div>
      </NodeChrome>
      <Handle type="source" position={Position.Bottom} />
    </>
  );
}

export const WsExchangeNode = memo(WsExchangeNodeImpl);
WsExchangeNode.displayName = 'WsExchangeNode';
