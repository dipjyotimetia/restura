'use client';

import { AlertTriangle, GitBranch, Play, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { lazyComponent } from '@/lib/shared/lazyComponent';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useWorkflowStore } from '@/store/useWorkflowStore';
import type {
  CollectionItem,
  HttpRequest,
  Request,
  VariableExtraction,
  Workflow,
  WorkflowRequest,
} from '@/types';
import { useGraphValidation } from '../hooks/useGraphValidation';
import { VariableExtractorConfig } from './VariableExtractorConfig';
import { WorkflowStep } from './WorkflowStep';

// Lazy-load the entire flow-canvas tree — including @xyflow/react and
// @dagrejs/dagre — so users who never open the Graph tab don't pay the
// bundle cost. The ESLint no-restricted-imports rule for
// `src/features/workflows/lib/**` keeps any future eager regression at
// CI time; here in components/ we own the deliberate import boundary.
const FlowEditor = lazyComponent(
  () => import('./flow-canvas/FlowEditor'),
  <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
    Loading graph editor…
  </div>
);

interface WorkflowBuilderProps {
  workflow: Workflow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRun: () => void;
}

type BuilderTab = 'form' | 'graph';

export function WorkflowBuilder({
  workflow: initialWorkflow,
  open,
  onOpenChange,
  onRun,
}: WorkflowBuilderProps) {
  // The caller (Sidebar) holds `selectedWorkflow` in local useState, so the
  // `workflow` prop is a snapshot from click time — it never updates when
  // we mutate the store. Subscribe to the live workflow by id and fall
  // back to the snapshot if the store entry has been removed mid-edit.
  const liveWorkflow = useWorkflowStore((s) =>
    s.workflows.find((w) => w.id === initialWorkflow.id)
  );
  const workflow = liveWorkflow ?? initialWorkflow;

  const collections = useCollectionStore((s) => s.collections);
  const collection = collections.find((c) => c.id === workflow.collectionId);

  const addWorkflowRequest = useWorkflowStore((s) => s.addWorkflowRequest);
  const updateWorkflowRequest = useWorkflowStore((s) => s.updateWorkflowRequest);
  const removeWorkflowRequest = useWorkflowStore((s) => s.removeWorkflowRequest);
  const clearWorkflowGraph = useWorkflowStore((s) => s.clearWorkflowGraph);

  const [activeTab, setActiveTab] = useState<BuilderTab>('form');
  const [showAddStep, setShowAddStep] = useState(false);
  const [selectedRequestId, setSelectedRequestId] = useState('');
  const [editingStep, setEditingStep] = useState<WorkflowRequest | null>(null);
  const [extractionStep, setExtractionStep] = useState<WorkflowRequest | null>(null);

  const hasGraph = Boolean(workflow.graph);
  const formReadOnly = hasGraph;

  // Merely opening the Graph tab must NOT persist anything — `FlowEditor`
  // renders a synthesised, in-memory view derived from `requests[]` when
  // `workflow.graph` is absent (see its `renderedGraph`), and only an
  // actual structural edit in the canvas (FlowCanvas's `commit` calls)
  // materialises a real, persisted graph. Previously this effect stamped
  // a `{nodes:[],edges:[]}` stub the instant the tab was clicked, which
  // permanently flipped the workflow into graph mode — disabling the Form
  // tab and routing Run through the DAG executor against a graph with no
  // start node — even if the user never touched the canvas.

  // Same structural-validity gate as FlowToolbar's in-canvas Run button —
  // this footer button is a second entry point into the same run, so it
  // needs the same guard or a user could bypass the canvas warning here.
  // Computed once here and threaded down to FlowEditor/FlowToolbar as a
  // prop (rather than each independently re-validating the same graph) —
  // both are mounted in the same tree whenever the Graph tab is open. Only
  // blocking ('error') issues gate Run — non-blocking warnings (e.g. dead
  // wiring off an `end` node) are visible in FlowToolbar's popover, not
  // worth a scary "won't run" message on this simpler footer button.
  const graphValidation = useGraphValidation(workflow.graph);
  const graphIssues = graphValidation.blockingIssues;

  const availableRequests = useMemo(() => {
    if (!collection) return [];
    const requests: Array<{ id: string; name: string; method?: string; path: string }> = [];
    const traverse = (items: CollectionItem[], path: string = '') => {
      for (const item of items) {
        if (item.type === 'request' && item.request) {
          const fullPath = path ? `${path} / ${item.name}` : item.name;
          requests.push({
            id: item.request.id,
            name: item.name,
            method: item.request.type === 'http' ? item.request.method : 'gRPC',
            path: fullPath,
          });
        }
        if (item.items) {
          traverse(item.items, path ? `${path} / ${item.name}` : item.name);
        }
      }
    };
    traverse(collection.items);
    return requests;
  }, [collection]);

  const getRequestById = (id: string): Request | undefined => {
    if (!collection) return undefined;
    const find = (items: CollectionItem[]): Request | undefined => {
      for (const item of items) {
        if (item.type === 'request' && item.request?.id === id) {
          return item.request;
        }
        if (item.items) {
          const found = find(item.items);
          if (found) return found;
        }
      }
      return undefined;
    };
    return find(collection.items);
  };

  const handleAddStep = () => {
    if (!selectedRequestId) return;
    const request = availableRequests.find((r) => r.id === selectedRequestId);
    if (!request) return;
    const workflowRequest: WorkflowRequest = {
      id: uuidv4(),
      requestId: selectedRequestId,
      name: request.name,
    };
    addWorkflowRequest(workflow.id, workflowRequest);
    setSelectedRequestId('');
    setShowAddStep(false);
  };

  const handleDeleteStep = (requestId: string) => {
    removeWorkflowRequest(workflow.id, requestId);
  };

  const handleSaveStepEdit = () => {
    if (!editingStep) return;
    updateWorkflowRequest(workflow.id, editingStep.id, {
      name: editingStep.name,
      precondition: editingStep.precondition,
      retryPolicy: editingStep.retryPolicy,
      timeout: editingStep.timeout,
    });
    setEditingStep(null);
  };

  const handleSaveExtractions = (extractions: VariableExtraction[]) => {
    if (!extractionStep) return;
    updateWorkflowRequest(workflow.id, extractionStep.id, {
      extractVariables: extractions,
    });
    setExtractionStep(null);
  };

  const handleDiscardGraph = () => {
    if (
      window.confirm(
        'Discard the graph and return to linear (form) editing? Your graph layout will be lost; the steps in this workflow are kept.'
      )
    ) {
      clearWorkflowGraph(workflow.id);
      setActiveTab('form');
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="w-[95vw] max-w-[1600px] h-[92vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <span>{workflow.name}</span>
              <span className="text-sm font-normal text-muted-foreground">
                ({workflow.requests.length} steps)
              </span>
            </DialogTitle>
          </DialogHeader>

          <Tabs
            value={activeTab}
            onValueChange={(v) => setActiveTab(v as BuilderTab)}
            className="flex-1 flex flex-col min-h-0"
          >
            <TabsList>
              <TabsTrigger value="form">Form</TabsTrigger>
              <TabsTrigger value="graph">
                <GitBranch className="h-3 w-3 mr-1.5" />
                Graph
              </TabsTrigger>
            </TabsList>

            <TabsContent value="form" className="flex-1 flex flex-col min-h-0 mt-3">
              {formReadOnly && (
                <div className="flex items-start gap-2 px-3 py-2 mb-3 rounded-md bg-amber-500/10 border border-amber-500/30">
                  <AlertTriangle className="h-4 w-4 mt-0.5 text-amber-500 flex-shrink-0" />
                  <div className="text-sm flex-1">
                    <div className="font-medium text-amber-700 dark:text-amber-300">
                      This workflow has a graph.
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      Edit it in the Graph tab. Linear (form) editing is disabled while a graph is
                      present.
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleDiscardGraph}
                    className="text-xs"
                  >
                    Discard graph
                  </Button>
                </div>
              )}

              <ScrollArea className="flex-1 -mx-6 px-6">
                <div className="space-y-2 py-2">
                  {workflow.requests.length === 0 ? (
                    <div className="text-center py-12 text-muted-foreground">
                      <p>No steps in this workflow yet.</p>
                      {!formReadOnly && (
                        <p className="text-sm mt-1">
                          Add requests from your collection to build your workflow.
                        </p>
                      )}
                    </div>
                  ) : (
                    workflow.requests.map((req, index) => {
                      const requestDetails = getRequestById(req.requestId);
                      const stepProps: {
                        onEdit?: () => void;
                        onDelete?: () => void;
                        onConfigureExtraction?: () => void;
                      } = formReadOnly
                        ? {}
                        : {
                            onEdit: () => setEditingStep({ ...req }),
                            onDelete: () => handleDeleteStep(req.id),
                            onConfigureExtraction: () => setExtractionStep(req),
                          };
                      return (
                        <WorkflowStep
                          key={req.id}
                          workflowRequest={req}
                          method={
                            requestDetails?.type === 'http'
                              ? (requestDetails as HttpRequest).method
                              : undefined
                          }
                          index={index}
                          {...stepProps}
                        />
                      );
                    })
                  )}
                </div>
              </ScrollArea>

              {!formReadOnly && (
                <div className="border-t pt-4">
                  <Button variant="outline" className="w-full" onClick={() => setShowAddStep(true)}>
                    <Plus className="h-4 w-4 mr-2" />
                    Add Step
                  </Button>
                </div>
              )}
            </TabsContent>

            <TabsContent value="graph" className="flex-1 min-h-0 mt-3">
              <div className="h-full w-full rounded-lg overflow-hidden border border-sp-line">
                <FlowEditor workflow={workflow} onRun={onRun} validation={graphValidation} />
              </div>
            </TabsContent>
          </Tabs>

          <DialogFooter>
            {graphIssues.length > 0 && (
              <div className="text-xs text-amber-600 dark:text-amber-400 mr-auto self-center">
                {graphIssues.length} validation issue{graphIssues.length === 1 ? '' : 's'} — fix in
                the Graph tab before running.
              </div>
            )}
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            <Button
              onClick={onRun}
              disabled={workflow.requests.length === 0 || graphIssues.length > 0}
              title={graphIssues.length > 0 ? 'Fix validation issues before running' : undefined}
            >
              <Play className="h-4 w-4 mr-2" />
              Run Workflow
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Step Dialog */}
      <Dialog open={showAddStep} onOpenChange={setShowAddStep}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Step</DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <Label>Select Request</Label>
            <Select value={selectedRequestId} onValueChange={setSelectedRequestId}>
              <SelectTrigger className="mt-1">
                <SelectValue placeholder="Choose a request..." />
              </SelectTrigger>
              <SelectContent>
                {availableRequests.map((req) => (
                  <SelectItem key={req.id} value={req.id}>
                    <span className="font-mono text-xs mr-2">{req.method}</span>
                    {req.path}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAddStep(false)}>
              Cancel
            </Button>
            <Button onClick={handleAddStep} disabled={!selectedRequestId}>
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Step Dialog */}
      <Dialog open={!!editingStep} onOpenChange={() => setEditingStep(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Step</DialogTitle>
          </DialogHeader>
          {editingStep && (
            <div className="space-y-4 py-4">
              <div>
                <Label>Step Name</Label>
                <Input
                  value={editingStep.name}
                  onChange={(e) => setEditingStep({ ...editingStep, name: e.target.value })}
                  className="mt-1"
                />
              </div>

              <div>
                <Label>Precondition Script (optional)</Label>
                <Textarea
                  placeholder="return environment.get('token') !== undefined;"
                  value={editingStep.precondition || ''}
                  onChange={(e) => setEditingStep({ ...editingStep, precondition: e.target.value })}
                  className="mt-1 font-mono text-sm"
                  rows={3}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Script must return true to execute this step
                </p>
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div>
                  <Label>Retry Attempts</Label>
                  <Input
                    type="number"
                    min={1}
                    max={10}
                    value={editingStep.retryPolicy?.maxAttempts || 1}
                    onChange={(e) =>
                      setEditingStep({
                        ...editingStep,
                        retryPolicy: {
                          maxAttempts: parseInt(e.target.value) || 1,
                          delayMs: editingStep.retryPolicy?.delayMs || 1000,
                        },
                      })
                    }
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label>Retry Delay (ms)</Label>
                  <Input
                    type="number"
                    min={0}
                    value={editingStep.retryPolicy?.delayMs || 1000}
                    onChange={(e) =>
                      setEditingStep({
                        ...editingStep,
                        retryPolicy: {
                          maxAttempts: editingStep.retryPolicy?.maxAttempts || 1,
                          delayMs: parseInt(e.target.value) || 1000,
                        },
                      })
                    }
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label>Timeout (ms)</Label>
                  <Input
                    type="number"
                    min={1000}
                    value={editingStep.timeout || ''}
                    onChange={(e) =>
                      setEditingStep({
                        ...editingStep,
                        timeout: e.target.value ? parseInt(e.target.value) : undefined,
                      })
                    }
                    className="mt-1"
                    placeholder="Default"
                  />
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingStep(null)}>
              Cancel
            </Button>
            <Button onClick={handleSaveStepEdit}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Variable Extraction Config */}
      {extractionStep && (
        <VariableExtractorConfig
          open={!!extractionStep}
          onOpenChange={() => setExtractionStep(null)}
          extractions={extractionStep.extractVariables || []}
          onSave={handleSaveExtractions}
        />
      )}
    </>
  );
}
