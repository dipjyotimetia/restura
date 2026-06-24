import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Radio } from 'lucide-react';
import { memo } from 'react';
import { useFlowRunStore } from '../../../store/useFlowRunStore';
import { NodeChrome } from './NodeChrome';
import { useWorkflowStore } from '@/store/useWorkflowStore';
import type { SseSubscribeFlowNode } from '@/types';

type Data = SseSubscribeFlowNode['data'] & { workflowId?: string };

function describeCompletion(c: SseSubscribeFlowNode['data']['completion']): string {
  switch (c.kind) {
    case 'eventCount':
      return `until ${c.n} events`;
    case 'timeoutMs':
      return `until ${c.ms}ms`;
    case 'eventMatch':
      return 'until match';
    case 'connectionClose':
      return 'until close';
  }
}

function SseSubscribeNodeImpl({ id, data, selected }: NodeProps) {
  const d = data as Data;
  // Narrow selector — returns a string so primitive-equality avoids
  // re-renders on unrelated workflow mutations.
  const wrName = useWorkflowStore((s) =>
    d.workflowId
      ? s.workflows
          .find((w) => w.id === d.workflowId)
          ?.requests.find((r) => r.id === d.workflowRequestId)?.name
      : undefined
  );
  const liveCount = useFlowRunStore((s) => s.variables[`${id}.eventCount`]);

  return (
    <>
      <Handle type="target" position={Position.Top} />
      <NodeChrome nodeId={id} kindLabel="SSE Subscribe" selected={Boolean(selected)}>
        <div className="flex items-start gap-2">
          <Radio className="h-4 w-4 mt-0.5 text-pink-400" />
          <div className="min-w-0">
            <div className="text-xs font-medium truncate" title={wrName ?? d.workflowRequestId}>
              {wrName ?? 'Pick an SSE request…'}
            </div>
            <div className="text-[10px] text-muted-foreground mt-0.5">
              {describeCompletion(d.completion)}
              {liveCount && ` · ${liveCount} events`}
            </div>
          </div>
        </div>
      </NodeChrome>
      <Handle type="source" position={Position.Bottom} />
    </>
  );
}

export const SseSubscribeNode = memo(SseSubscribeNodeImpl);
SseSubscribeNode.displayName = 'SseSubscribeNode';
