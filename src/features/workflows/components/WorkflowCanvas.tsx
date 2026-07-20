'use client';

import {
  Background,
  Controls,
  type Edge,
  MiniMap,
  type Node,
  type NodeChange,
  ReactFlow,
  ReactFlowProvider,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Braces, Clock3, FolderTree, Send, Variable } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useCollectionStore } from '@/store/useCollectionStore';
import { flattenRequests } from '../lib/collectionHelpers';
import type { WorkflowBlock, WorkflowBlockKind, WorkflowFlowModel } from '../lib/owsFlowMapper';
import './WorkflowCanvas.css';

interface WorkflowCanvasProps {
  collectionId: string;
  model: WorkflowFlowModel;
  onChange: (model: WorkflowFlowModel) => void;
}

const labels: Record<WorkflowBlockKind, string> = {
  do: 'Sequence',
  set: 'Set value',
  wait: 'Wait',
  call: 'Saved HTTP request',
};

function draftId(): string {
  return `draft-${crypto.randomUUID()}`;
}

function appendBlock(model: WorkflowFlowModel, kind: WorkflowBlockKind): WorkflowFlowModel {
  const count = model.blocks.filter((block) => block.kind === kind).length + 1;
  const name = `${kind === 'do' ? 'sequence' : kind === 'set' ? 'set' : kind === 'wait' ? 'wait' : 'request'}-${count}`;
  const block: WorkflowBlock = {
    id: draftId(),
    name,
    kind,
    position: { x: 260, y: model.blocks.length * 140 + 100 },
  };

  if (kind === 'do') {
    block.children = [
      {
        id: draftId(),
        name: 'wait-1',
        kind: 'wait',
        position: { x: 0, y: 0 },
        wait: { milliseconds: 0 },
      },
    ];
  }
  if (kind === 'set') block.set = { value: null };
  if (kind === 'wait') block.wait = { milliseconds: 0 };

  return { ...model, blocks: [...model.blocks, block] };
}

function updateBlock(
  model: WorkflowFlowModel,
  id: string,
  update: (block: WorkflowBlock) => WorkflowBlock
): WorkflowFlowModel {
  return {
    ...model,
    blocks: model.blocks.map((block) => (block.id === id ? update(block) : block)),
  };
}

function CanvasInner({ collectionId, model, onChange }: WorkflowCanvasProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const collection = useCollectionStore((state) =>
    state.collections.find((candidate) => candidate.id === collectionId)
  );
  const requests = useMemo(
    () =>
      collection
        ? flattenRequests(collection.items).filter((request) => request.kind === 'http')
        : [],
    [collection]
  );
  const selected = model.blocks.find((block) => block.id === selectedId);

  const nodes = useMemo<Node[]>(() => {
    const blocks = model.blocks.map((block) => ({
      id: block.id,
      position: block.position,
      data: {
        label:
          block.kind === 'call'
            ? `${block.method ?? 'HTTP'} · ${block.binding?.resourceId ?? 'Choose request'}`
            : block.kind === 'do'
              ? `${labels[block.kind]} · ${block.children?.length ?? 0} blocks`
              : `${labels[block.kind]} · ${block.name}`,
      },
      selected: block.id === selectedId,
      className: `workflow-canvas__node workflow-canvas__node--${block.kind}`,
      style: { width: 220 },
    }));
    return [
      {
        id: '__start',
        position: { x: 280, y: 0 },
        data: { label: 'START' },
        draggable: false,
        selectable: false,
        className: 'workflow-canvas__node workflow-canvas__node--terminal',
        style: { width: 150 },
      },
      ...blocks,
      {
        id: '__end',
        position: { x: 280, y: Math.max(150, model.blocks.length * 140 + 120) },
        data: { label: 'END' },
        draggable: false,
        selectable: false,
        className: 'workflow-canvas__node workflow-canvas__node--terminal',
        style: { width: 150 },
      },
    ];
  }, [model.blocks, selectedId]);

  const edges = useMemo<Edge[]>(() => {
    const ids = ['__start', ...model.blocks.map((block) => block.id), '__end'];
    return ids.slice(1).map((target, index) => ({
      id: `${ids[index]}-${target}`,
      source: ids[index]!,
      target,
      type: 'smoothstep',
    }));
  }, [model.blocks]);

  const onNodesChange = (changes: NodeChange[]) => {
    const moved = new Map<string, { x: number; y: number }>();
    for (const change of changes) {
      if (change.type === 'position' && change.position) {
        moved.set(change.id, change.position);
      }
    }
    if (moved.size === 0) return;
    onChange({
      ...model,
      blocks: model.blocks.map((block) =>
        moved.has(block.id) ? { ...block, position: moved.get(block.id)! } : block
      ),
    });
  };

  const addRequest = (request: (typeof requests)[number]) => {
    const resourceId = request.path.split(' / ').map(encodeURIComponent).join('/');
    const next = appendBlock(model, 'call');
    const block = next.blocks.at(-1);
    if (!block) return;
    block.method = request.method;
    block.binding = { kind: 'saved-request', call: 'http', resourceId };
    onChange(next);
    setSelectedId(block.id);
  };

  return (
    <div className="workflow-canvas grid h-[560px] min-h-0 grid-cols-[210px_1fr_250px] overflow-hidden rounded-md border">
      <aside className="border-r p-3">
        <p className="mb-2 text-xs font-medium">Add block</p>
        <div className="space-y-1">
          {(
            [
              ['do', FolderTree],
              ['set', Variable],
              ['wait', Clock3],
            ] as const
          ).map(([kind, Icon]) => (
            <Button
              key={kind}
              variant="ghost"
              className="w-full justify-start"
              onClick={() => {
                const next = appendBlock(model, kind);
                onChange(next);
                setSelectedId(next.blocks.at(-1)?.id ?? null);
              }}
            >
              <Icon className="mr-2 h-4 w-4" />
              {labels[kind]}
            </Button>
          ))}
        </div>
        <p className="mb-2 mt-5 text-xs font-medium">Saved requests</p>
        <ScrollArea className="h-[345px]">
          {requests.map((request) => (
            <Button
              key={request.id}
              variant="ghost"
              className="h-auto w-full justify-start py-2 text-left text-xs"
              onClick={() => addRequest(request)}
            >
              <Send className="mr-2 h-4 w-4 shrink-0" />
              <span className="min-w-0 truncate">
                {request.method} {request.path}
              </span>
            </Button>
          ))}
          {requests.length === 0 && (
            <p className="px-2 py-3 text-xs text-muted-foreground">No saved HTTP requests.</p>
          )}
        </ScrollArea>
      </aside>
      <main className="workflow-canvas__surface min-w-0">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onNodeClick={(_, node) => setSelectedId(node.id)}
          nodesDraggable
          fitView
          fitViewOptions={{ padding: 0.3 }}
        >
          <Background color="#314457" gap={22} size={1} />
          <Controls />
          <MiniMap />
        </ReactFlow>
      </main>
      <aside className="border-l p-3">
        <p className="text-xs font-medium">Inspector</p>
        {selected ? (
          <div className="mt-4 space-y-4">
            <div>
              <Label htmlFor="workflow-block-name" className="text-xs">
                Block name
              </Label>
              <Input
                id="workflow-block-name"
                className="mt-1"
                value={selected.name}
                onChange={(event) =>
                  onChange(
                    updateBlock(model, selected.id, (block) => ({
                      ...block,
                      name: event.target.value,
                    }))
                  )
                }
              />
            </div>
            {selected.kind === 'wait' && (
              <div>
                <Label htmlFor="workflow-wait-ms" className="text-xs">
                  Wait (milliseconds)
                </Label>
                <Input
                  id="workflow-wait-ms"
                  type="number"
                  min="0"
                  className="mt-1"
                  value={selected.wait?.milliseconds ?? 0}
                  onChange={(event) =>
                    onChange(
                      updateBlock(model, selected.id, (block) => ({
                        ...block,
                        wait: { milliseconds: Math.max(0, Number(event.target.value) || 0) },
                      }))
                    )
                  }
                />
              </div>
            )}
            {selected.kind === 'set' && (
              <p className="text-xs text-muted-foreground">
                Configure values in Advanced workflow definition to preserve JSON types.
              </p>
            )}
            {selected.kind === 'do' && (
              <p className="text-xs text-muted-foreground">
                This sequence contains {selected.children?.length ?? 0} nested blocks. Edit nested
                blocks in Advanced workflow definition.
              </p>
            )}
            {selected.kind === 'call' && (
              <p className="text-xs text-muted-foreground">
                {selected.method} request bound to{' '}
                {selected.binding?.resourceId ?? 'no saved request'}.
              </p>
            )}
          </div>
        ) : (
          <p className="mt-4 text-xs text-muted-foreground">
            Select a block to edit its properties. The canvas is a linear workflow path; positions
            do not change execution order.
          </p>
        )}
        <div className="mt-5 flex items-center gap-2 text-xs text-muted-foreground">
          <Braces className="h-4 w-4" />
          Advanced definition is available as JSON.
        </div>
      </aside>
    </div>
  );
}

export function WorkflowCanvas(props: WorkflowCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
