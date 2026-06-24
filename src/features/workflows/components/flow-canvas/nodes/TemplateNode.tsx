import { Handle, Position, type NodeProps } from '@xyflow/react';
import { FileText } from 'lucide-react';
import { memo } from 'react';
import { NodeChrome } from './NodeChrome';
import type { TemplateFlowNode } from '@/types';

type Data = TemplateFlowNode['data'];

function TemplateNodeImpl({ id, data, selected }: NodeProps) {
  const d = data as Data;
  return (
    <>
      <Handle type="target" position={Position.Top} />
      <NodeChrome nodeId={id} kindLabel="Template" selected={Boolean(selected)}>
        <div className="flex items-start gap-2">
          <FileText className="h-4 w-4 mt-0.5 text-sky-400" />
          <div className="min-w-0">
            <div className="text-xs font-mono truncate" title={d.template}>
              {d.template || '— set template —'}
            </div>
            <div className="text-[10px] text-muted-foreground mt-0.5">
              → <span className="font-mono">{d.resultVar || '?'}</span>
            </div>
          </div>
        </div>
      </NodeChrome>
      <Handle type="source" position={Position.Bottom} />
    </>
  );
}

export const TemplateNode = memo(TemplateNodeImpl);
TemplateNode.displayName = 'TemplateNode';
