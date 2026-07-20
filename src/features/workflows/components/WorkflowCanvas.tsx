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
import {
  Braces,
  Clock3,
  FileText,
  FolderTree,
  GitBranch,
  List,
  ShieldCheck,
  Type,
  Variable,
} from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
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
  for: 'For each',
  set: 'Set value',
  try: 'Try / catch',
  wait: 'Wait',
  call: 'Saved HTTP request',
};

function draftId(): string {
  return `draft-${crypto.randomUUID()}`;
}

function appendBlock(model: WorkflowFlowModel, kind: WorkflowBlockKind): WorkflowFlowModel {
  const count = model.blocks.filter((block) => block.kind === kind).length + 1;
  const prefix =
    kind === 'do'
      ? 'sequence'
      : kind === 'for'
        ? 'each'
        : kind === 'set'
          ? 'set'
          : kind === 'try'
            ? 'try'
            : kind === 'wait'
              ? 'wait'
              : 'request';
  const name = `${prefix}-${count}`;
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
  if (kind === 'for') {
    block.for = { each: 'item', at: 'index', in: '${.value}' };
    block.children = [
      {
        id: draftId(),
        name: 'save-1',
        kind: 'set',
        position: { x: 0, y: 0 },
        set: { last: '${.item}' },
      },
    ];
  }
  if (kind === 'set') block.set = { value: null };
  if (kind === 'wait') block.wait = { milliseconds: 0 };
  if (kind === 'try') {
    block.children = [
      {
        id: draftId(),
        name: 'attempt-1',
        kind: 'wait',
        position: { x: 0, y: 0 },
        wait: { milliseconds: 0 },
      },
    ];
    block.catchAs = 'error';
    block.catchChildren = [
      {
        id: draftId(),
        name: 'recover-1',
        kind: 'set',
        position: { x: 0, y: 0 },
        set: { recovered: true },
      },
    ];
  }

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
  const hasReceivedInitialMove = useRef(false);
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
  const terminalPositions = useMemo(() => {
    if (model.blocks.length === 0) {
      return { start: { x: 310, y: 72 }, end: { x: 310, y: 250 } };
    }
    const first = model.blocks[0]!;
    const last = model.blocks.at(-1)!;
    const terminalX = Math.max(0, first.position.x + 35);
    return {
      start: { x: terminalX, y: Math.max(0, first.position.y - 108) },
      end: { x: Math.max(0, last.position.x + 35), y: last.position.y + 106 },
    };
  }, [model.blocks]);

  const nodes = useMemo<Node[]>(() => {
    const blocks = model.blocks.map((block) => ({
      id: block.id,
      position: block.position,
      data: {
        label:
          block.kind === 'call'
            ? `${'protocol' in (block.binding ?? {}) ? 'GQL' : (block.method ?? 'HTTP')} · ${block.binding?.resourceId ?? 'Choose request'}`
            : block.kind === 'do'
              ? `${block.condition ? 'Condition' : labels[block.kind]} · ${block.children?.length ?? 0} blocks`
              : block.kind === 'for'
                ? `${labels[block.kind]} · ${block.for?.in ?? 'Choose array'}`
                : block.kind === 'try'
                  ? `${labels[block.kind]} · ${block.children?.length ?? 0} attempt blocks`
                  : `${labels[block.kind]} · ${block.name}`,
      },
      selected: block.id === selectedId,
      className: `workflow-canvas__node workflow-canvas__node--${block.kind}`,
      style: { width: 220 },
    }));
    return [
      {
        id: '__start',
        position: terminalPositions.start,
        data: { label: 'START' },
        draggable: false,
        selectable: false,
        className: 'workflow-canvas__node workflow-canvas__node--terminal',
        style: { width: 150 },
      },
      ...blocks,
      {
        id: '__end',
        position: terminalPositions.end,
        data: { label: model.output ? 'END · OUTPUT' : 'END' },
        draggable: false,
        selectable: false,
        className: 'workflow-canvas__node workflow-canvas__node--terminal',
        style: { width: 150 },
      },
    ];
  }, [model.blocks, selectedId, terminalPositions]);

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
    block.binding = {
      kind: 'saved-request',
      call: 'http',
      ...(request.workflowProtocol === 'graphql' ? { protocol: 'graphql' as const } : {}),
      resourceId,
    };
    onChange(next);
    setSelectedId(block.id);
  };

  const addDataBlock = (value: unknown) => {
    const next = appendBlock(model, 'set');
    const block = next.blocks.at(-1);
    if (block) block.set = { value };
    onChange(next);
    setSelectedId(block?.id ?? null);
  };

  return (
    <div className="workflow-canvas grid h-[min(64vh,640px)] min-h-[520px] min-w-0 grid-cols-[250px_minmax(0,1fr)_290px] overflow-hidden rounded-lg border">
      <aside className="workflow-canvas__palette border-r p-3">
        <p className="workflow-canvas__section-label">Add block</p>
        <div className="workflow-canvas__palette-group">
          {(
            [
              ['do', FolderTree],
              ['for', List],
              ['try', ShieldCheck],
              ['set', Variable],
              ['wait', Clock3],
            ] as const
          ).map(([kind, Icon]) => (
            <Button
              key={kind}
              variant="ghost"
              className="workflow-canvas__palette-button"
              aria-label={labels[kind]}
              onClick={() => {
                const next = appendBlock(model, kind);
                onChange(next);
                setSelectedId(next.blocks.at(-1)?.id ?? null);
              }}
            >
              <span className="workflow-canvas__palette-icon">
                <Icon className="h-4 w-4" />
              </span>
              <span>
                <b>{labels[kind]}</b>
                <small>
                  {kind === 'do'
                    ? 'Group steps in order'
                    : kind === 'for'
                      ? 'Iterate a finite list'
                      : kind === 'try'
                        ? 'Recover from a failed path'
                        : kind === 'set'
                          ? 'Store a typed value'
                          : 'Pause before the next step'}
                </small>
              </span>
            </Button>
          ))}
          <Button
            variant="ghost"
            className="workflow-canvas__palette-button"
            aria-label="Condition"
            onClick={() => {
              const next = appendBlock(model, 'do');
              const block = next.blocks.at(-1);
              if (block) block.condition = '${.value}';
              onChange(next);
              setSelectedId(block?.id ?? null);
            }}
          >
            <span className="workflow-canvas__palette-icon">
              <GitBranch className="h-4 w-4" />
            </span>
            <span>
              <b>Condition</b>
              <small>Gate a sequence</small>
            </span>
          </Button>
        </div>
        <p className="workflow-canvas__section-label mt-5">Data</p>
        <div className="workflow-canvas__palette-group">
          {[
            ['String', 'text'],
            ['Boolean', true],
            ['Number', 0],
            ['Null', null],
            ['List', []],
            ['Record', {}],
          ].map(([label, value]) => (
            <Button
              key={label as string}
              variant="ghost"
              className="workflow-canvas__palette-button workflow-canvas__palette-button--compact"
              onClick={() => addDataBlock(value)}
            >
              <span className="workflow-canvas__palette-icon">
                <Variable className="h-4 w-4" />
              </span>
              <span>
                <b>{label as string}</b>
                <small>Set a workflow value</small>
              </span>
            </Button>
          ))}
          <Button
            variant="ghost"
            className="workflow-canvas__palette-button workflow-canvas__palette-button--compact"
            onClick={() => addDataBlock('${.value}')}
          >
            <span className="workflow-canvas__palette-icon">
              <Braces className="h-4 w-4" />
            </span>
            <span>
              <b>Select</b>
              <small>Read a value by path</small>
            </span>
          </Button>
          <Button
            variant="ghost"
            className="workflow-canvas__palette-button workflow-canvas__palette-button--compact"
            onClick={() => addDataBlock('Result: ${.value}')}
          >
            <span className="workflow-canvas__palette-icon">
              <Type className="h-4 w-4" />
            </span>
            <span>
              <b>Template</b>
              <small>Compose text from values</small>
            </span>
          </Button>
          <Button
            variant="ghost"
            className="workflow-canvas__palette-button workflow-canvas__palette-button--compact"
            onClick={() => onChange({ ...model, output: { as: { result: '${.last}' } } })}
          >
            <span className="workflow-canvas__palette-icon">
              <FileText className="h-4 w-4" />
            </span>
            <span>
              <b>Output</b>
              <small>Project the final result</small>
            </span>
          </Button>
        </div>
        <p className="workflow-canvas__section-label mt-5">Saved requests</p>
        <ScrollArea className="h-[min(30vh,250px)]">
          {requests.map((request) => (
            <Button
              key={request.id}
              variant="ghost"
              className="workflow-canvas__request-button"
              onClick={() => addRequest(request)}
            >
              <span className="workflow-canvas__request-method">
                {request.workflowProtocol === 'graphql' ? 'GQL' : request.method}
              </span>
              <span className="min-w-0 truncate">{request.path}</span>
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
          defaultViewport={model.viewport}
          onMoveEnd={(_, viewport) => {
            if (!hasReceivedInitialMove.current) {
              hasReceivedInitialMove.current = true;
              return;
            }
            if (
              model.viewport?.x === viewport.x &&
              model.viewport.y === viewport.y &&
              model.viewport.zoom === viewport.zoom
            ) {
              return;
            }
            onChange({ ...model, viewport });
          }}
          nodesDraggable
          fitView
          fitViewOptions={{ padding: 0.2, maxZoom: 1.15 }}
          proOptions={{ hideAttribution: true }}
          defaultEdgeOptions={{ animated: false, style: { stroke: '#4d6e89', strokeWidth: 1.5 } }}
        >
          <Background color="#23415f" gap={24} size={1} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable nodeColor="#6684a5" maskColor="rgb(8 15 23 / 78%)" />
        </ReactFlow>
      </main>
      <aside className="workflow-canvas__inspector border-l p-4">
        <p className="workflow-canvas__section-label">Inspector</p>
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
            {selected.kind !== 'call' && (
              <div>
                <Label htmlFor="workflow-condition" className="text-xs">
                  Run when (optional)
                </Label>
                <Input
                  id="workflow-condition"
                  className="mt-1 font-mono text-xs"
                  placeholder="${.enabled}"
                  value={selected.condition ?? ''}
                  onChange={(event) =>
                    onChange(
                      updateBlock(model, selected.id, (block) => ({
                        ...block,
                        ...(event.target.value
                          ? { condition: event.target.value }
                          : { condition: undefined }),
                      }))
                    )
                  }
                />
              </div>
            )}
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
              <div>
                <Label htmlFor="workflow-set-key" className="text-xs">
                  Store as
                </Label>
                <Input
                  id="workflow-set-key"
                  className="mt-1 font-mono text-xs"
                  value={Object.keys(selected.set ?? {})[0] ?? 'value'}
                  onChange={(event) => {
                    const currentSet = selected.set ?? { value: null };
                    const oldKey = Object.keys(currentSet)[0] ?? 'value';
                    const nextKey = event.target.value.trim();
                    if (!nextKey) return;
                    const { [oldKey]: currentValue, ...rest } = currentSet;
                    onChange(
                      updateBlock(model, selected.id, (block) => ({
                        ...block,
                        set: { ...rest, [nextKey]: currentValue },
                      }))
                    );
                  }}
                />
                <p className="mt-2 text-xs text-muted-foreground">
                  Values stay typed. Use advanced JSON to edit object, list, or template contents.
                </p>
              </div>
            )}
            {selected.kind === 'do' && (
              <p className="text-xs text-muted-foreground">
                This sequence contains {selected.children?.length ?? 0} nested blocks. Edit nested
                blocks in Advanced workflow definition.
              </p>
            )}
            {selected.kind === 'for' && (
              <div className="space-y-3">
                <div>
                  <Label htmlFor="workflow-for-source" className="text-xs">
                    Array path
                  </Label>
                  <Input
                    id="workflow-for-source"
                    className="mt-1 font-mono text-xs"
                    value={selected.for?.in ?? '${.value}'}
                    onChange={(event) =>
                      onChange(
                        updateBlock(model, selected.id, (block) => ({
                          ...block,
                          for: { ...(block.for ?? { each: 'item' }), in: event.target.value },
                        }))
                      )
                    }
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label htmlFor="workflow-for-item" className="text-xs">
                      Item name
                    </Label>
                    <Input
                      id="workflow-for-item"
                      className="mt-1 font-mono text-xs"
                      value={selected.for?.each ?? 'item'}
                      onChange={(event) =>
                        onChange(
                          updateBlock(model, selected.id, (block) => ({
                            ...block,
                            for: {
                              ...(block.for ?? { in: '${.value}' }),
                              each: event.target.value,
                            },
                          }))
                        )
                      }
                    />
                  </div>
                  <div>
                    <Label htmlFor="workflow-for-index" className="text-xs">
                      Index name
                    </Label>
                    <Input
                      id="workflow-for-index"
                      className="mt-1 font-mono text-xs"
                      value={selected.for?.at ?? ''}
                      onChange={(event) =>
                        onChange(
                          updateBlock(model, selected.id, (block) => {
                            const { at: _at, ...withoutIndex } = block.for ?? {
                              each: 'item',
                              in: '${.value}',
                            };
                            return {
                              ...block,
                              for: {
                                ...withoutIndex,
                                ...(event.target.value ? { at: event.target.value } : {}),
                              },
                            };
                          })
                        )
                      }
                    />
                  </div>
                </div>
              </div>
            )}
            {selected.kind === 'try' && (
              <p className="text-xs text-muted-foreground">
                Runs the attempt path, then the catch path only when an attempt fails.
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
          <p className="workflow-canvas__empty-inspector">
            Select a block to edit its properties. The visual path is linear; positions do not
            change execution order.
          </p>
        )}
        <div className="workflow-canvas__advanced-note">
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
