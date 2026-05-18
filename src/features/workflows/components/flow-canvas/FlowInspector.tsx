/**
 * One inspector per node kind. Each writes through
 * `setWorkflowSubgraph` so edits inside a forEach/tryCatch land at
 * the right nesting depth. Scripts use plain `<Textarea>` so the
 * lazy `flow-canvas` chunk stays free of Monaco.
 */
'use client';

import { useMemo, useState } from 'react';
import type {
  Workflow,
  FlowNode,
  RequestFlowNode,
  ConditionFlowNode,
  SetVariableFlowNode,
  DelayFlowNode,
  TransformFlowNode,
  ParallelFlowNode,
  ForEachFlowNode,
  TryCatchFlowNode,
  SubWorkflowFlowNode,
  SseSubscribeFlowNode,
  WsExchangeFlowNode,
  McpCallFlowNode,
  RequestFailureMode,
  ParallelWaitMode,
  ParallelMergeStrategy,
  CompletionPolicy,
  WorkflowRequest,
  VariableExtraction,
  SubgraphPath,
} from '@/types';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useWorkflowStore } from '@/store/useWorkflowStore';
import { selectAtPath } from '../../lib/flowTypes';
import { flattenRequests } from '../../lib/collectionHelpers';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { VariableExtractorConfig } from '../VariableExtractorConfig';
import { Plus, Trash2, ArrowRight } from 'lucide-react';

interface FlowInspectorProps {
  workflow: Workflow;
  /** Current subgraph slice the canvas is rendering. Selected node id
   *  is local to this slice. */
  subgraphPath: SubgraphPath;
  selectedNodeId: string | null;
  onClose: () => void;
  /** Push a path segment to drill into a forEach/tryCatch body. */
  onDrillInto: (segment: SubgraphPath[number]) => void;
}

function useUpdateNode(workflowId: string, path: SubgraphPath) {
  const setWorkflowSubgraph = useWorkflowStore((s) => s.setWorkflowSubgraph);
  const workflows = useWorkflowStore((s) => s.workflows);
  return (nodeId: string, mutator: (node: FlowNode) => FlowNode) => {
    const wf = workflows.find((w) => w.id === workflowId);
    if (!wf?.graph) return;
    const slice = path.length === 0 ? wf.graph : selectAtPath(wf.graph, path);
    if (!slice) return;
    setWorkflowSubgraph(workflowId, path, {
      ...slice,
      nodes: slice.nodes.map((n) => (n.id === nodeId ? mutator(n) : n)),
    });
  };
}

function useUpdateWorkflowRequest(workflowId: string) {
  const updateWorkflowRequest = useWorkflowStore((s) => s.updateWorkflowRequest);
  return (workflowRequestId: string, updates: Partial<WorkflowRequest>) => {
    updateWorkflowRequest(workflowId, workflowRequestId, updates);
  };
}

export function FlowInspector({
  workflow,
  subgraphPath,
  selectedNodeId,
  onClose,
  onDrillInto,
}: FlowInspectorProps) {
  const node = useMemo(() => {
    if (!selectedNodeId || !workflow.graph) return null;
    const slice =
      subgraphPath.length === 0
        ? workflow.graph
        : selectAtPath(workflow.graph, subgraphPath);
    return slice?.nodes.find((n) => n.id === selectedNodeId) ?? null;
  }, [selectedNodeId, workflow.graph, subgraphPath]);

  if (!node) {
    return (
      <div className="flex flex-col h-full w-72 border-l border-[hsl(var(--foreground)/var(--border-default))] bg-[hsl(var(--surface-1))]">
        <div className="px-3 py-2 border-b border-[hsl(var(--foreground)/var(--border-subtle))]">
          <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
            Inspector
          </div>
        </div>
        <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground p-4 text-center">
          Select a node on the canvas to edit its properties.
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full w-72 border-l border-[hsl(var(--foreground)/var(--border-default))] bg-[hsl(var(--surface-1))]">
      <div className="px-3 py-2 border-b border-[hsl(var(--foreground)/var(--border-subtle))] flex items-center justify-between">
        <div>
          <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
            Inspector
          </div>
          <div className="text-xs font-medium capitalize">{node.kind}</div>
        </div>
        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onClose}>
          Close
        </Button>
      </div>
      <ScrollArea className="flex-1">
        <div className="p-3 space-y-3">
          <InspectorBody
            workflow={workflow}
            subgraphPath={subgraphPath}
            node={node}
            onDrillInto={onDrillInto}
          />
        </div>
      </ScrollArea>
    </div>
  );
}

interface BodyProps {
  workflow: Workflow;
  subgraphPath: SubgraphPath;
  node: FlowNode;
  onDrillInto: (segment: SubgraphPath[number]) => void;
}

function InspectorBody({ workflow, subgraphPath, node, onDrillInto }: BodyProps) {
  switch (node.kind) {
    case 'start':
    case 'end':
      return (
        <div className="text-xs text-muted-foreground italic">
          {node.kind === 'start'
            ? 'Workflow starts here. No properties to edit.'
            : 'Workflow ends here. No properties to edit.'}
        </div>
      );
    case 'request':
      return <RequestInspector workflow={workflow} subgraphPath={subgraphPath} node={node} />;
    case 'condition':
      return <ConditionInspector workflow={workflow} subgraphPath={subgraphPath} node={node} />;
    case 'setVariable':
      return <SetVariableInspector workflow={workflow} subgraphPath={subgraphPath} node={node} />;
    case 'delay':
      return <DelayInspector workflow={workflow} subgraphPath={subgraphPath} node={node} />;
    case 'transform':
      return <TransformInspector workflow={workflow} subgraphPath={subgraphPath} node={node} />;
    case 'parallel':
      return <ParallelInspector workflow={workflow} subgraphPath={subgraphPath} node={node} />;
    case 'forEach':
      return (
        <ForEachInspector
          workflow={workflow}
          subgraphPath={subgraphPath}
          node={node}
          onDrillInto={onDrillInto}
        />
      );
    case 'tryCatch':
      return (
        <TryCatchInspector
          workflow={workflow}
          subgraphPath={subgraphPath}
          node={node}
          onDrillInto={onDrillInto}
        />
      );
    case 'subWorkflow':
      return <SubWorkflowInspector workflow={workflow} subgraphPath={subgraphPath} node={node} />;
    case 'sseSubscribe':
      return <SseSubscribeInspector workflow={workflow} subgraphPath={subgraphPath} node={node} />;
    case 'wsExchange':
      return <WsExchangeInspector workflow={workflow} subgraphPath={subgraphPath} node={node} />;
    case 'mcpCall':
      return <McpCallInspector workflow={workflow} subgraphPath={subgraphPath} node={node} />;
  }
}

// ---------- Per-kind inspectors ----------

function RequestInspector({
  workflow,
  subgraphPath,
  node,
}: {
  workflow: Workflow;
  subgraphPath: SubgraphPath;
  node: RequestFlowNode;
}) {
  const updateNode = useUpdateNode(workflow.id, subgraphPath);
  const updateWR = useUpdateWorkflowRequest(workflow.id);
  const wr = workflow.requests.find((r) => r.id === node.data.workflowRequestId);
  const [extractorOpen, setExtractorOpen] = useState(false);

  if (!wr) {
    return (
      <div className="text-xs text-destructive">
        Linked WorkflowRequest is missing. Delete this node and re-drop the saved
        request from the sidebar.
      </div>
    );
  }

  const failureMode = node.data.failureMode ?? 'thrown-only';

  return (
    <>
      <div>
        <Label className="text-xs">Step name</Label>
        <Input
          className="mt-1 h-7 text-xs"
          value={wr.name}
          onChange={(e) => updateWR(wr.id, { name: e.target.value })}
        />
      </div>

      <div>
        <Label className="text-xs">Failure mode</Label>
        <Select
          value={failureMode}
          onValueChange={(v) =>
            updateNode(node.id, (n) => ({
              ...(n as RequestFlowNode),
              data: { ...(n as RequestFlowNode).data, failureMode: v as RequestFailureMode },
            }))
          }
        >
          <SelectTrigger className="mt-1 h-7 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="thrown-only">Thrown errors only (default)</SelectItem>
            <SelectItem value="http-status">Non-2xx HTTP status</SelectItem>
            <SelectItem value="never">Never fail (continue on error)</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-[10px] text-muted-foreground mt-1">
          Drives surrounding Try/Catch behaviour.
        </p>
      </div>

      <div>
        <Label className="text-xs">Precondition (script, optional)</Label>
        <Textarea
          className="mt-1 font-mono text-xs"
          rows={3}
          placeholder='return environment.get("token") !== undefined;'
          value={wr.precondition ?? ''}
          onChange={(e) => updateWR(wr.id, { precondition: e.target.value })}
        />
        <p className="text-[10px] text-muted-foreground mt-1">
          Must <code>return</code> a boolean. False = skip this node.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label className="text-xs">Retry attempts</Label>
          <Input
            type="number"
            min={1}
            max={10}
            className="mt-1 h-7 text-xs"
            value={wr.retryPolicy?.maxAttempts ?? 1}
            onChange={(e) => {
              const maxAttempts = Math.max(1, Math.min(10, parseInt(e.target.value) || 1));
              updateWR(wr.id, {
                retryPolicy: {
                  maxAttempts,
                  delayMs: wr.retryPolicy?.delayMs ?? 1000,
                  ...(wr.retryPolicy?.backoffMultiplier
                    ? { backoffMultiplier: wr.retryPolicy.backoffMultiplier }
                    : {}),
                },
              });
            }}
          />
        </div>
        <div>
          <Label className="text-xs">Retry delay (ms)</Label>
          <Input
            type="number"
            min={0}
            className="mt-1 h-7 text-xs"
            value={wr.retryPolicy?.delayMs ?? 1000}
            onChange={(e) => {
              const delayMs = Math.max(0, parseInt(e.target.value) || 0);
              updateWR(wr.id, {
                retryPolicy: {
                  maxAttempts: wr.retryPolicy?.maxAttempts ?? 1,
                  delayMs,
                  ...(wr.retryPolicy?.backoffMultiplier
                    ? { backoffMultiplier: wr.retryPolicy.backoffMultiplier }
                    : {}),
                },
              });
            }}
          />
        </div>
      </div>

      <div>
        <Label className="text-xs">Variable extractions</Label>
        <div className="mt-1 flex items-center justify-between gap-2">
          <div className="text-[10px] text-muted-foreground">
            {wr.extractVariables?.length ?? 0} configured
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-xs"
            onClick={() => setExtractorOpen(true)}
          >
            Configure…
          </Button>
        </div>
      </div>

      {extractorOpen && (
        <VariableExtractorConfig
          open={extractorOpen}
          onOpenChange={(o) => setExtractorOpen(o)}
          extractions={wr.extractVariables ?? []}
          onSave={(next: VariableExtraction[]) => {
            updateWR(wr.id, { extractVariables: next });
            setExtractorOpen(false);
          }}
        />
      )}
    </>
  );
}

function ConditionInspector({
  workflow,
  subgraphPath,
  node,
}: {
  workflow: Workflow;
  subgraphPath: SubgraphPath;
  node: ConditionFlowNode;
}) {
  const updateNode = useUpdateNode(workflow.id, subgraphPath);
  return (
    <>
      <div>
        <Label className="text-xs">Description (optional)</Label>
        <Input
          className="mt-1 h-7 text-xs"
          placeholder="What does this branch decide?"
          value={node.data.description ?? ''}
          onChange={(e) =>
            updateNode(node.id, (n) => ({
              ...(n as ConditionFlowNode),
              data: { ...(n as ConditionFlowNode).data, description: e.target.value },
            }))
          }
        />
      </div>
      <div>
        <Label className="text-xs">Expression (JS, must return boolean)</Label>
        <Textarea
          className="mt-1 font-mono text-xs"
          rows={5}
          placeholder="return response.status === 200;"
          value={node.data.expression}
          onChange={(e) =>
            updateNode(node.id, (n) => ({
              ...(n as ConditionFlowNode),
              data: { ...(n as ConditionFlowNode).data, expression: e.target.value },
            }))
          }
        />
        <p className="text-[10px] text-muted-foreground mt-1">
          True/false handles route to different downstream nodes.
        </p>
      </div>
    </>
  );
}

function SetVariableInspector({
  workflow,
  subgraphPath,
  node,
}: {
  workflow: Workflow;
  subgraphPath: SubgraphPath;
  node: SetVariableFlowNode;
}) {
  const updateNode = useUpdateNode(workflow.id, subgraphPath);
  const update = (mutate: (data: SetVariableFlowNode['data']) => SetVariableFlowNode['data']) =>
    updateNode(node.id, (n) => ({
      ...(n as SetVariableFlowNode),
      data: mutate((n as SetVariableFlowNode).data),
    }));

  return (
    <>
      <div className="flex items-center justify-between">
        <Label className="text-xs">Assignments</Label>
        <Button
          size="sm"
          variant="outline"
          className="h-6 px-2 text-xs"
          onClick={() =>
            update((d) => ({
              ...d,
              assignments: [...d.assignments, { key: '', valueExpression: '""' }],
            }))
          }
        >
          <Plus className="h-3 w-3 mr-1" /> Add
        </Button>
      </div>
      <div className="space-y-2">
        {node.data.assignments.map((a, i) => (
          <div key={i} className="space-y-1 p-2 rounded-md border border-[hsl(var(--foreground)/var(--border-subtle))]">
            <div className="flex items-center gap-1">
              <Input
                className="h-6 text-xs"
                placeholder="key"
                value={a.key}
                onChange={(e) =>
                  update((d) => ({
                    ...d,
                    assignments: d.assignments.map((x, idx) =>
                      idx === i ? { ...x, key: e.target.value } : x
                    ),
                  }))
                }
              />
              <Button
                size="sm"
                variant="ghost"
                className="h-6 w-6 p-0"
                onClick={() =>
                  update((d) => ({
                    ...d,
                    assignments: d.assignments.filter((_, idx) => idx !== i),
                  }))
                }
                title="Remove"
              >
                <Trash2 className="h-3 w-3 text-destructive" />
              </Button>
            </div>
            <Input
              className="h-6 text-xs font-mono"
              placeholder='value expression — e.g. "world" or response.body.id'
              value={a.valueExpression}
              onChange={(e) =>
                update((d) => ({
                  ...d,
                  assignments: d.assignments.map((x, idx) =>
                    idx === i ? { ...x, valueExpression: e.target.value } : x
                  ),
                }))
              }
            />
          </div>
        ))}
        {node.data.assignments.length === 0 && (
          <div className="text-[11px] text-muted-foreground italic">No assignments yet.</div>
        )}
      </div>
    </>
  );
}

function DelayInspector({
  workflow,
  subgraphPath,
  node,
}: {
  workflow: Workflow;
  subgraphPath: SubgraphPath;
  node: DelayFlowNode;
}) {
  const updateNode = useUpdateNode(workflow.id, subgraphPath);
  return (
    <div>
      <Label className="text-xs">Duration (ms)</Label>
      <Input
        type="number"
        min={0}
        max={3_600_000}
        className="mt-1 h-7 text-xs"
        value={node.data.ms}
        onChange={(e) => {
          const ms = Math.max(0, parseInt(e.target.value) || 0);
          updateNode(node.id, (n) => ({
            ...(n as DelayFlowNode),
            data: { ...(n as DelayFlowNode).data, ms },
          }));
        }}
      />
    </div>
  );
}

function TransformInspector({
  workflow,
  subgraphPath,
  node,
}: {
  workflow: Workflow;
  subgraphPath: SubgraphPath;
  node: TransformFlowNode;
}) {
  const updateNode = useUpdateNode(workflow.id, subgraphPath);
  return (
    <div>
      <Label className="text-xs">Script (JS)</Label>
      <Textarea
        className="mt-1 font-mono text-xs"
        rows={10}
        placeholder='pm.variables.set("foo", "bar");'
        value={node.data.script}
        onChange={(e) =>
          updateNode(node.id, (n) => ({
            ...(n as TransformFlowNode),
            data: { ...(n as TransformFlowNode).data, script: e.target.value },
          }))
        }
      />
      <p className="text-[10px] text-muted-foreground mt-1">
        Variables set via <code>pm.variables.set</code> propagate downstream.
      </p>
    </div>
  );
}

function ParallelInspector({
  workflow,
  subgraphPath,
  node,
}: {
  workflow: Workflow;
  subgraphPath: SubgraphPath;
  node: ParallelFlowNode;
}) {
  const updateNode = useUpdateNode(workflow.id, subgraphPath);
  return (
    <>
      <div>
        <Label className="text-xs">Wait mode</Label>
        <Select
          value={node.data.waitMode}
          onValueChange={(v) =>
            updateNode(node.id, (n) => ({
              ...(n as ParallelFlowNode),
              data: { ...(n as ParallelFlowNode).data, waitMode: v as ParallelWaitMode },
            }))
          }
        >
          <SelectTrigger className="mt-1 h-7 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">all — wait for every branch</SelectItem>
            <SelectItem value="any">any — first to succeed</SelectItem>
            <SelectItem value="race">race — first settled (success or fail)</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label className="text-xs">Merge strategy</Label>
        <Select
          value={node.data.mergeStrategy ?? 'fail-on-conflict'}
          onValueChange={(v) =>
            updateNode(node.id, (n) => ({
              ...(n as ParallelFlowNode),
              data: {
                ...(n as ParallelFlowNode).data,
                mergeStrategy: v as ParallelMergeStrategy,
              },
            }))
          }
        >
          <SelectTrigger className="mt-1 h-7 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="fail-on-conflict">fail-on-conflict (safe default)</SelectItem>
            <SelectItem value="pick-first">pick-first</SelectItem>
            <SelectItem value="pick-last">pick-last</SelectItem>
            <SelectItem value="merge-list">merge-list (JSON array)</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-[10px] text-muted-foreground mt-1">
          What to do when branches set the same variable to different values.
        </p>
      </div>
    </>
  );
}

function ForEachInspector({
  workflow,
  subgraphPath,
  node,
  onDrillInto,
}: {
  workflow: Workflow;
  subgraphPath: SubgraphPath;
  node: ForEachFlowNode;
  onDrillInto: (segment: SubgraphPath[number]) => void;
}) {
  const updateNode = useUpdateNode(workflow.id, subgraphPath);
  const update = (mutate: (d: ForEachFlowNode['data']) => ForEachFlowNode['data']) =>
    updateNode(node.id, (n) => ({
      ...(n as ForEachFlowNode),
      data: mutate((n as ForEachFlowNode).data),
    }));
  const bodyCount = node.data.subgraph?.nodes?.length ?? 0;

  return (
    <>
      <div>
        <Label className="text-xs">Collection expression (JS, must return array)</Label>
        <Textarea
          className="mt-1 font-mono text-xs"
          rows={3}
          placeholder="return JSON.parse(pm.variables.get('items'));"
          value={node.data.collectionExpression}
          onChange={(e) => update((d) => ({ ...d, collectionExpression: e.target.value }))}
        />
      </div>
      <div>
        <Label className="text-xs">Iterator variable name</Label>
        <Input
          className="mt-1 h-7 text-xs font-mono"
          placeholder="item"
          value={node.data.iteratorVar}
          onChange={(e) => update((d) => ({ ...d, iteratorVar: e.target.value }))}
        />
      </div>
      <div>
        <Label className="text-xs">Concurrency (1–64)</Label>
        <Input
          type="number"
          min={1}
          max={64}
          className="mt-1 h-7 text-xs"
          value={node.data.concurrency ?? 8}
          onChange={(e) => {
            const concurrency = Math.max(1, Math.min(64, parseInt(e.target.value) || 8));
            update((d) => ({ ...d, concurrency }));
          }}
        />
      </div>
      <div>
        <Label className="text-xs">Loop body</Label>
        <div className="mt-1 flex items-center justify-between gap-2">
          <span className="text-[10px] text-muted-foreground">
            {bodyCount === 0
              ? 'empty — click to start'
              : `${bodyCount} node${bodyCount === 1 ? '' : 's'}`}
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-xs"
            onClick={() => onDrillInto({ parentNodeId: node.id, key: 'subgraph' })}
          >
            Edit body
            <ArrowRight className="h-3 w-3 ml-1" />
          </Button>
        </div>
      </div>
    </>
  );
}

function TryCatchInspector({
  node,
  onDrillInto,
}: {
  workflow: Workflow;
  subgraphPath: SubgraphPath;
  node: TryCatchFlowNode;
  onDrillInto: (segment: SubgraphPath[number]) => void;
}) {
  const tryCount = node.data.trySubgraph?.nodes.length ?? 0;
  const catchCount = node.data.catchSubgraph?.nodes.length ?? 0;
  return (
    <>
      <div>
        <Label className="text-xs">Try branch</Label>
        <div className="mt-1 flex items-center justify-between gap-2">
          <span className="text-[10px] text-muted-foreground">
            {tryCount === 0 ? 'empty — click to start' : `${tryCount} node${tryCount === 1 ? '' : 's'}`}
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-xs"
            onClick={() => onDrillInto({ parentNodeId: node.id, key: 'trySubgraph' })}
          >
            Edit try
            <ArrowRight className="h-3 w-3 ml-1" />
          </Button>
        </div>
      </div>
      <div>
        <Label className="text-xs">Catch branch</Label>
        <div className="mt-1 flex items-center justify-between gap-2">
          <span className="text-[10px] text-muted-foreground">
            {catchCount === 0
              ? 'empty — click to start'
              : `${catchCount} node${catchCount === 1 ? '' : 's'}`}
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-xs"
            onClick={() => onDrillInto({ parentNodeId: node.id, key: 'catchSubgraph' })}
          >
            Edit catch
            <ArrowRight className="h-3 w-3 ml-1" />
          </Button>
        </div>
      </div>
      <div className="text-[10px] text-muted-foreground italic">
        Inside catch, variables <code>error</code> and <code>errorNode</code> hold the
        failure context.
      </div>
    </>
  );
}

// ---------- Streaming protocol inspectors ----------

function CompletionPolicyEditor({
  policy,
  onChange,
}: {
  policy: CompletionPolicy;
  onChange: (next: CompletionPolicy) => void;
}) {
  return (
    <div className="space-y-2">
      <div>
        <Label className="text-xs">Completion policy</Label>
        <Select
          value={policy.kind}
          onValueChange={(v) => {
            if (v === 'eventCount') onChange({ kind: 'eventCount', n: 1 });
            else if (v === 'timeoutMs') onChange({ kind: 'timeoutMs', ms: 30_000 });
            else if (v === 'eventMatch')
              onChange({ kind: 'eventMatch', expression: 'return false;' });
            else onChange({ kind: 'connectionClose' });
          }}
        >
          <SelectTrigger className="mt-1 h-7 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="eventCount">After N events</SelectItem>
            <SelectItem value="timeoutMs">After a timeout</SelectItem>
            <SelectItem value="eventMatch">When predicate matches</SelectItem>
            <SelectItem value="connectionClose">When server closes</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {policy.kind === 'eventCount' && (
        <div>
          <Label className="text-xs">N events</Label>
          <Input
            type="number"
            min={1}
            max={1_000_000}
            className="mt-1 h-7 text-xs"
            value={policy.n}
            onChange={(e) => {
              const n = Math.max(1, parseInt(e.target.value) || 1);
              onChange({ kind: 'eventCount', n });
            }}
          />
        </div>
      )}
      {policy.kind === 'timeoutMs' && (
        <div>
          <Label className="text-xs">Timeout (ms)</Label>
          <Input
            type="number"
            min={1}
            max={86_400_000}
            className="mt-1 h-7 text-xs"
            value={policy.ms}
            onChange={(e) => {
              const ms = Math.max(1, parseInt(e.target.value) || 1000);
              onChange({ kind: 'timeoutMs', ms });
            }}
          />
        </div>
      )}
      {policy.kind === 'eventMatch' && (
        <div>
          <Label className="text-xs">Predicate (JS — receives <code>event</code>)</Label>
          <Textarea
            className="mt-1 font-mono text-xs"
            rows={3}
            placeholder='return event.data && JSON.parse(event.data).type === "complete";'
            value={policy.expression}
            onChange={(e) =>
              onChange({ kind: 'eventMatch', expression: e.target.value })
            }
          />
        </div>
      )}
    </div>
  );
}

function useFlattenedRequests(collectionId: string) {
  const collections = useCollectionStore((s) => s.collections);
  return useMemo(() => {
    const collection = collections.find((c) => c.id === collectionId);
    return collection ? flattenRequests(collection.items) : [];
  }, [collections, collectionId]);
}

function SseSubscribeInspector({
  workflow,
  subgraphPath,
  node,
}: {
  workflow: Workflow;
  subgraphPath: SubgraphPath;
  node: SseSubscribeFlowNode;
}) {
  const updateNode = useUpdateNode(workflow.id, subgraphPath);
  const updateWR = useUpdateWorkflowRequest(workflow.id);
  const wr = workflow.requests.find((r) => r.id === node.data.workflowRequestId);
  const allRequests = useFlattenedRequests(workflow.collectionId);
  const sseRequests = allRequests.filter((r) => r.kind === 'sse');

  const update = (mutate: (d: SseSubscribeFlowNode['data']) => SseSubscribeFlowNode['data']) =>
    updateNode(node.id, (n) => ({
      ...(n as SseSubscribeFlowNode),
      data: mutate((n as SseSubscribeFlowNode).data),
    }));

  return (
    <>
      <div>
        <Label className="text-xs">SSE request</Label>
        <Select
          value={wr?.requestId ?? ''}
          onValueChange={(collectionRequestId) => {
            const picked = allRequests.find((r) => r.id === collectionRequestId);
            if (!picked) return;
            if (wr) {
              updateWR(wr.id, { requestId: collectionRequestId, name: picked.name });
            }
          }}
          disabled={!wr}
        >
          <SelectTrigger className="mt-1 h-7 text-xs">
            <SelectValue placeholder="Choose…" />
          </SelectTrigger>
          <SelectContent>
            {sseRequests.length === 0 ? (
              <div className="text-xs text-muted-foreground p-2">
                No SSE requests in this collection.
              </div>
            ) : (
              sseRequests.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.name}
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>
      </div>
      <CompletionPolicyEditor
        policy={node.data.completion}
        onChange={(completion) => update((d) => ({ ...d, completion }))}
      />
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id={`accum-${node.id}`}
          checked={node.data.accumulateAll ?? true}
          onChange={(e) => update((d) => ({ ...d, accumulateAll: e.target.checked }))}
        />
        <Label htmlFor={`accum-${node.id}`} className="text-xs">
          Accumulate all events (uncheck to keep only predicate-matched ones)
        </Label>
      </div>
      <div>
        <Label className="text-xs">Result variable</Label>
        <Input
          className="mt-1 h-7 text-xs font-mono"
          placeholder={`${node.id}.events`}
          value={node.data.resultVar ?? ''}
          onChange={(e) => update((d) => ({ ...d, resultVar: e.target.value || undefined }))}
        />
      </div>
    </>
  );
}

function WsExchangeInspector({
  workflow,
  subgraphPath,
  node,
}: {
  workflow: Workflow;
  subgraphPath: SubgraphPath;
  node: WsExchangeFlowNode;
}) {
  const updateNode = useUpdateNode(workflow.id, subgraphPath);
  const update = (mutate: (d: WsExchangeFlowNode['data']) => WsExchangeFlowNode['data']) =>
    updateNode(node.id, (n) => ({
      ...(n as WsExchangeFlowNode),
      data: mutate((n as WsExchangeFlowNode).data),
    }));

  return (
    <>
      <div>
        <Label className="text-xs">WebSocket URL</Label>
        <Input
          className="mt-1 h-7 text-xs font-mono"
          placeholder="wss://example.com/socket"
          value={node.data.url}
          onChange={(e) => update((d) => ({ ...d, url: e.target.value }))}
        />
      </div>
      <div>
        <Label className="text-xs">Frame to send (JS — returns string or object)</Label>
        <Textarea
          className="mt-1 font-mono text-xs"
          rows={3}
          placeholder='return JSON.stringify({ type: "subscribe", channel: "feed" });'
          value={node.data.sendExpression}
          onChange={(e) => update((d) => ({ ...d, sendExpression: e.target.value }))}
        />
      </div>
      <div>
        <Label className="text-xs">Match predicate (JS — receives <code>event</code>)</Label>
        <Textarea
          className="mt-1 font-mono text-xs"
          rows={3}
          placeholder='return event.type === "match-this";'
          value={node.data.matchExpression}
          onChange={(e) => update((d) => ({ ...d, matchExpression: e.target.value }))}
        />
      </div>
      <CompletionPolicyEditor
        policy={node.data.completion}
        onChange={(completion) => update((d) => ({ ...d, completion }))}
      />
      <div>
        <Label className="text-xs">Result variable</Label>
        <Input
          className="mt-1 h-7 text-xs font-mono"
          placeholder={`${node.id}.reply`}
          value={node.data.resultVar ?? ''}
          onChange={(e) => update((d) => ({ ...d, resultVar: e.target.value || undefined }))}
        />
      </div>
    </>
  );
}

function McpCallInspector({
  workflow,
  subgraphPath,
  node,
}: {
  workflow: Workflow;
  subgraphPath: SubgraphPath;
  node: McpCallFlowNode;
}) {
  const updateNode = useUpdateNode(workflow.id, subgraphPath);
  const updateWR = useUpdateWorkflowRequest(workflow.id);
  const wr = workflow.requests.find((r) => r.id === node.data.workflowRequestId);
  const allRequests = useFlattenedRequests(workflow.collectionId);
  const mcpRequests = allRequests.filter((r) => r.kind === 'mcp');

  const update = (mutate: (d: McpCallFlowNode['data']) => McpCallFlowNode['data']) =>
    updateNode(node.id, (n) => ({
      ...(n as McpCallFlowNode),
      data: mutate((n as McpCallFlowNode).data),
    }));

  return (
    <>
      <div>
        <Label className="text-xs">MCP request</Label>
        <Select
          value={wr?.requestId ?? ''}
          onValueChange={(collectionRequestId) => {
            const picked = allRequests.find((r) => r.id === collectionRequestId);
            if (!picked) return;
            if (wr) {
              updateWR(wr.id, { requestId: collectionRequestId, name: picked.name });
            }
          }}
          disabled={!wr}
        >
          <SelectTrigger className="mt-1 h-7 text-xs">
            <SelectValue placeholder="Choose…" />
          </SelectTrigger>
          <SelectContent>
            {mcpRequests.length === 0 ? (
              <div className="text-xs text-muted-foreground p-2">
                No MCP requests in this collection.
              </div>
            ) : (
              mcpRequests.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.name}
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label className="text-xs">JSON-RPC method</Label>
        <Input
          className="mt-1 h-7 text-xs font-mono"
          placeholder="tools/call"
          value={node.data.method}
          onChange={(e) => update((d) => ({ ...d, method: e.target.value }))}
        />
      </div>
      <div>
        <Label className="text-xs">Params (JS — returns object)</Label>
        <Textarea
          className="mt-1 font-mono text-xs"
          rows={4}
          placeholder='return { name: "myTool", arguments: { foo: "bar" } };'
          value={node.data.paramsExpression ?? ''}
          onChange={(e) =>
            update((d) => ({ ...d, paramsExpression: e.target.value || undefined }))
          }
        />
      </div>
      <div>
        <Label className="text-xs">Result variable</Label>
        <Input
          className="mt-1 h-7 text-xs font-mono"
          placeholder={`${node.id}.result`}
          value={node.data.resultVar ?? ''}
          onChange={(e) => update((d) => ({ ...d, resultVar: e.target.value || undefined }))}
        />
      </div>
    </>
  );
}

function SubWorkflowInspector({
  workflow,
  subgraphPath,
  node,
}: {
  workflow: Workflow;
  subgraphPath: SubgraphPath;
  node: SubWorkflowFlowNode;
}) {
  const updateNode = useUpdateNode(workflow.id, subgraphPath);
  const allWorkflows = useWorkflowStore((s) => s.workflows);
  const candidates = allWorkflows.filter(
    (w) => w.id !== workflow.id && w.collectionId === workflow.collectionId
  );

  const update = (mutate: (d: SubWorkflowFlowNode['data']) => SubWorkflowFlowNode['data']) =>
    updateNode(node.id, (n) => ({
      ...(n as SubWorkflowFlowNode),
      data: mutate((n as SubWorkflowFlowNode).data),
    }));

  const setMap = (
    field: 'inputVarMap' | 'outputVarMap',
    next: Record<string, string>
  ) => update((d) => ({ ...d, [field]: next }));

  const renderMap = (
    field: 'inputVarMap' | 'outputVarMap',
    map: Record<string, string> | undefined
  ) => {
    const entries = Object.entries(map ?? {});
    return (
      <div className="space-y-1">
        {entries.map(([k, v], i) => (
          <div key={i} className="flex items-center gap-1">
            <Input
              className="h-6 text-xs font-mono"
              placeholder={field === 'inputVarMap' ? 'parent var' : 'child var'}
              value={k}
              onChange={(e) => {
                const next = { ...(map ?? {}) };
                delete next[k];
                next[e.target.value] = v;
                setMap(field, next);
              }}
            />
            <span className="text-muted-foreground text-xs">→</span>
            <Input
              className="h-6 text-xs font-mono"
              placeholder={field === 'inputVarMap' ? 'child var' : 'parent var'}
              value={v}
              onChange={(e) => {
                const next = { ...(map ?? {}) };
                next[k] = e.target.value;
                setMap(field, next);
              }}
            />
            <Button
              size="sm"
              variant="ghost"
              className="h-6 w-6 p-0"
              onClick={() => {
                const next = { ...(map ?? {}) };
                delete next[k];
                setMap(field, next);
              }}
              title="Remove"
            >
              <Trash2 className="h-3 w-3 text-destructive" />
            </Button>
          </div>
        ))}
        <Button
          size="sm"
          variant="outline"
          className="h-6 px-2 text-xs"
          onClick={() => setMap(field, { ...(map ?? {}), '': '' })}
        >
          <Plus className="h-3 w-3 mr-1" /> Add mapping
        </Button>
      </div>
    );
  };

  return (
    <>
      <div>
        <Label className="text-xs">Workflow to call</Label>
        <Select
          value={node.data.workflowId}
          onValueChange={(v) => update((d) => ({ ...d, workflowId: v }))}
        >
          <SelectTrigger className="mt-1 h-7 text-xs">
            <SelectValue placeholder="Choose…" />
          </SelectTrigger>
          <SelectContent>
            {candidates.length === 0 ? (
              <div className="text-xs text-muted-foreground p-2">
                No other workflows in this collection.
              </div>
            ) : (
              candidates.map((w) => (
                <SelectItem key={w.id} value={w.id}>
                  {w.name}
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label className="text-xs">Input var map (parent → child)</Label>
        <div className="mt-1">{renderMap('inputVarMap', node.data.inputVarMap)}</div>
      </div>
      <div>
        <Label className="text-xs">Output var map (child → parent)</Label>
        <div className="mt-1">{renderMap('outputVarMap', node.data.outputVarMap)}</div>
      </div>
    </>
  );
}
