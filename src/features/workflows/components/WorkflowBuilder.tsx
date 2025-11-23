'use client';

import { useState, useMemo } from 'react';
import { Workflow, WorkflowRequest, Request, HttpRequest, CollectionItem } from '@/types';
import { useWorkflowStore } from '@/store/useWorkflowStore';
import { useCollectionStore } from '@/store/useCollectionStore';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { WorkflowStep } from './WorkflowStep';
import { VariableExtractorConfig } from './VariableExtractorConfig';
import { Plus, Play } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';

interface WorkflowBuilderProps {
  workflow: Workflow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRun: () => void;
}

export function WorkflowBuilder({
  workflow,
  open,
  onOpenChange,
  onRun,
}: WorkflowBuilderProps) {
  const collections = useCollectionStore((s) => s.collections);
  const collection = collections.find((c) => c.id === workflow.collectionId);

  const addWorkflowRequest = useWorkflowStore((s) => s.addWorkflowRequest);
  const updateWorkflowRequest = useWorkflowStore((s) => s.updateWorkflowRequest);
  const deleteWorkflowRequest = useWorkflowStore((s) => s.deleteWorkflowRequest);

  const [showAddStep, setShowAddStep] = useState(false);
  const [selectedRequestId, setSelectedRequestId] = useState('');
  const [editingStep, setEditingStep] = useState<WorkflowRequest | null>(null);
  const [extractionStep, setExtractionStep] = useState<WorkflowRequest | null>(null);

  // Flatten collection items to get all requests
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

  // Get request details by ID
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
    deleteWorkflowRequest(workflow.id, requestId);
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

  const handleSaveExtractions = (extractions: import('@/types').VariableExtraction[]) => {
    if (!extractionStep) return;

    updateWorkflowRequest(workflow.id, extractionStep.id, {
      extractVariables: extractions,
    });
    setExtractionStep(null);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <span>{workflow.name}</span>
              <span className="text-sm font-normal text-muted-foreground">
                ({workflow.requests.length} steps)
              </span>
            </DialogTitle>
          </DialogHeader>

          <ScrollArea className="flex-1 -mx-6 px-6">
            <div className="space-y-2 py-4">
              {workflow.requests.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  <p>No steps in this workflow yet.</p>
                  <p className="text-sm mt-1">
                    Add requests from your collection to build your workflow.
                  </p>
                </div>
              ) : (
                workflow.requests.map((req, index) => {
                  const requestDetails = getRequestById(req.requestId);
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
                      onEdit={() => setEditingStep({ ...req })}
                      onDelete={() => handleDeleteStep(req.id)}
                      onConfigureExtraction={() => setExtractionStep(req)}
                    />
                  );
                })
              )}
            </div>
          </ScrollArea>

          <div className="border-t pt-4">
            <Button
              variant="outline"
              className="w-full"
              onClick={() => setShowAddStep(true)}
            >
              <Plus className="h-4 w-4 mr-2" />
              Add Step
            </Button>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            <Button
              onClick={onRun}
              disabled={workflow.requests.length === 0}
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
                  onChange={(e) =>
                    setEditingStep({ ...editingStep, name: e.target.value })
                  }
                  className="mt-1"
                />
              </div>

              <div>
                <Label>Precondition Script (optional)</Label>
                <Textarea
                  placeholder="return environment.get('token') !== undefined;"
                  value={editingStep.precondition || ''}
                  onChange={(e) =>
                    setEditingStep({ ...editingStep, precondition: e.target.value })
                  }
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
