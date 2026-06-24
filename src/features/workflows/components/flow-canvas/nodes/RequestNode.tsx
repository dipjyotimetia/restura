import { Handle, Position, type NodeProps } from '@xyflow/react';
import { memo, useMemo } from 'react';
import { findRequestInItems } from '../../../lib/collectionHelpers';
import { methodBadgeVariant } from '../../../lib/methodBadge';
import { NodeChrome } from './NodeChrome';
import { Badge } from '@/components/ui/badge';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useWorkflowStore } from '@/store/useWorkflowStore';
import type { RequestFlowNode, HttpRequest } from '@/types';

type RequestNodeData = RequestFlowNode['data'] & {
  workflowId?: string;
};

function RequestNodeImpl({ id, data, selected }: NodeProps) {
  const d = data as RequestNodeData;

  // Narrow selectors so only changes to *this* WorkflowRequest re-render.
  // A drag-commit on another node creates a new workflow object but
  // leaves WorkflowRequest references stable, so primitives selected
  // here don't change.
  const wrName = useWorkflowStore((s) =>
    d.workflowId
      ? s.workflows
          .find((w) => w.id === d.workflowId)
          ?.requests.find((r) => r.id === d.workflowRequestId)?.name
      : undefined
  );
  const wrRequestId = useWorkflowStore((s) =>
    d.workflowId
      ? s.workflows
          .find((w) => w.id === d.workflowId)
          ?.requests.find((r) => r.id === d.workflowRequestId)?.requestId
      : undefined
  );
  const extractVarNames = useWorkflowStore((s) => {
    if (!d.workflowId) return '';
    const wr = s.workflows
      .find((w) => w.id === d.workflowId)
      ?.requests.find((r) => r.id === d.workflowRequestId);
    return wr?.extractVariables?.map((e) => e.variableName).join(', ') ?? '';
  });

  // Collection tree walk is memoised on the collections array — only
  // re-runs when collections actually change, NOT on every workflow edit.
  const collections = useCollectionStore((s) => s.collections);
  const method = useMemo<string | null>(() => {
    if (!wrRequestId) return null;
    for (const c of collections) {
      const r = findRequestInItems(c.items, wrRequestId);
      if (r) return r.type === 'http' ? (r as HttpRequest).method : null;
    }
    return null;
  }, [collections, wrRequestId]);

  const displayName = wrName ?? 'Unknown request';
  const isMissing = !wrName;

  return (
    <>
      <Handle type="target" position={Position.Top} />
      <NodeChrome nodeId={id} kindLabel="Request" selected={Boolean(selected)}>
        <div className="flex items-center gap-2">
          {method && <Badge variant={methodBadgeVariant(method)}>{method}</Badge>}
          {isMissing && <Badge variant="destructive">Missing</Badge>}
          <span className="text-sm font-medium truncate" title={displayName}>
            {displayName}
          </span>
        </div>
        {extractVarNames && (
          <div className="mt-1.5 text-[10px] text-muted-foreground">
            extracts: {extractVarNames}
          </div>
        )}
      </NodeChrome>
      <Handle type="source" position={Position.Bottom} />
    </>
  );
}

export const RequestNode = memo(RequestNodeImpl);
RequestNode.displayName = 'RequestNode';
