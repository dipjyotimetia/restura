import { Handle, type NodeProps, Position } from '@xyflow/react';
import { Sparkles } from 'lucide-react';
import { memo } from 'react';
import { useWorkflowStore } from '@/store/useWorkflowStore';
import type { McpCallFlowNode } from '@/types';
import { NodeChrome } from './NodeChrome';

type Data = McpCallFlowNode['data'] & { workflowId?: string };

function McpCallNodeImpl({ id, data, selected }: NodeProps) {
  const d = data as Data;
  const wrName = useWorkflowStore((s) =>
    d.workflowId
      ? s.workflows
          .find((w) => w.id === d.workflowId)
          ?.requests.find((r) => r.id === d.workflowRequestId)?.name
      : undefined
  );

  return (
    <>
      <Handle type="target" position={Position.Top} />
      <NodeChrome nodeId={id} kindLabel="MCP Call" selected={Boolean(selected)}>
        <div className="flex items-start gap-2">
          <Sparkles className="h-4 w-4 mt-0.5 text-rose-400" />
          <div className="min-w-0">
            <div className="text-xs font-medium truncate" title={wrName ?? d.workflowRequestId}>
              {wrName ?? 'Pick an MCP request…'}
            </div>
            <div
              className="text-[10px] font-mono text-muted-foreground mt-0.5 truncate"
              title={d.method}
            >
              {d.method || '— set method —'}
            </div>
          </div>
        </div>
      </NodeChrome>
      <Handle type="source" position={Position.Bottom} />
    </>
  );
}

export const McpCallNode = memo(McpCallNodeImpl);
McpCallNode.displayName = 'McpCallNode';
