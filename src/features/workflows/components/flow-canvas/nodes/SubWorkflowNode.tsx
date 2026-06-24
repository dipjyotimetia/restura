import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Workflow as WorkflowIcon } from 'lucide-react';
import { memo } from 'react';
import { NodeChrome } from './NodeChrome';
import { useWorkflowStore } from '@/store/useWorkflowStore';
import type { SubWorkflowFlowNode } from '@/types';

type Data = SubWorkflowFlowNode['data'];

function SubWorkflowNodeImpl({ id, data, selected }: NodeProps) {
  const d = data as Data;
  // Narrow selector — returns a string (or undefined). Primitives compare
  // by value, so a workflow drag elsewhere doesn't re-render this node.
  const subName = useWorkflowStore((s) =>
    d.workflowId ? s.workflows.find((w) => w.id === d.workflowId)?.name : undefined
  );
  const inCount = d.inputVarMap ? Object.keys(d.inputVarMap).length : 0;
  const outCount = d.outputVarMap ? Object.keys(d.outputVarMap).length : 0;
  return (
    <>
      <Handle type="target" position={Position.Top} />
      <NodeChrome nodeId={id} kindLabel="Sub-workflow" selected={Boolean(selected)}>
        <div className="flex items-start gap-2">
          <WorkflowIcon className="h-4 w-4 mt-0.5 text-fuchsia-400" />
          <div className="min-w-0">
            <div className="text-xs font-medium truncate" title={subName ?? d.workflowId}>
              {subName ?? '⚠ Missing workflow'}
            </div>
            <div className="text-[10px] text-muted-foreground mt-0.5">
              in: {inCount} · out: {outCount}
            </div>
          </div>
        </div>
      </NodeChrome>
      <Handle type="source" position={Position.Bottom} />
    </>
  );
}

export const SubWorkflowNode = memo(SubWorkflowNodeImpl);
SubWorkflowNode.displayName = 'SubWorkflowNode';
