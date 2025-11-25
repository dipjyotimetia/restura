'use client';

import { useState, useMemo } from 'react';
import { Workflow } from '@/types';
import { useWorkflowStore } from '@/store/useWorkflowStore';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Plus,
  MoreVertical,
  Play,
  Pencil,
  Trash2,
  GitBranch,
} from 'lucide-react';

interface WorkflowManagerProps {
  collectionId: string;
  onSelectWorkflow: (workflow: Workflow) => void;
  onRunWorkflow: (workflow: Workflow) => void;
}

export function WorkflowManager({
  collectionId,
  onSelectWorkflow,
  onRunWorkflow,
}: WorkflowManagerProps) {
  const allWorkflows = useWorkflowStore((s) => s.workflows);
  const executions = useWorkflowStore((s) => s.executions);
  const createNewWorkflow = useWorkflowStore((s) => s.createNewWorkflow);
  const addWorkflow = useWorkflowStore((s) => s.addWorkflow);
  const updateWorkflow = useWorkflowStore((s) => s.updateWorkflow);
  const deleteWorkflow = useWorkflowStore((s) => s.deleteWorkflow);

  const workflows = useMemo(
    () => allWorkflows.filter((wf) => wf.collectionId === collectionId),
    [allWorkflows, collectionId]
  );

  const getLatestExecution = useMemo(() => {
    return (workflowId: string) =>
      executions
        .filter((ex) => ex.workflowId === workflowId)
        .sort((a, b) => b.startedAt - a.startedAt)[0];
  }, [executions]);

  const [showNewDialog, setShowNewDialog] = useState(false);
  const [editingWorkflow, setEditingWorkflow] = useState<Workflow | null>(null);
  const [deletingWorkflow, setDeletingWorkflow] = useState<Workflow | null>(null);
  const [workflowName, setWorkflowName] = useState('');

  const handleCreate = () => {
    if (!workflowName.trim()) return;

    // Generate unique name if duplicate exists
    const existingNames = workflows.map((w) => w.name.toLowerCase());
    let finalName = workflowName.trim();
    let counter = 1;
    while (existingNames.includes(finalName.toLowerCase())) {
      counter++;
      finalName = `${workflowName.trim()} ${counter}`;
    }

    const workflow = createNewWorkflow(finalName, collectionId);
    addWorkflow(workflow);
    setWorkflowName('');
    setShowNewDialog(false);
    onSelectWorkflow(workflow);
  };

  const handleUpdate = () => {
    if (!editingWorkflow || !workflowName.trim()) return;

    updateWorkflow(editingWorkflow.id, { name: workflowName.trim() });
    setEditingWorkflow(null);
    setWorkflowName('');
  };

  const handleDelete = () => {
    if (!deletingWorkflow) return;

    deleteWorkflow(deletingWorkflow.id);
    setDeletingWorkflow(null);
  };

  return (
    <div className="space-y-2">
      {/* Header */}
      <div className="flex items-center justify-between px-2">
        <h3 className="text-sm font-medium text-muted-foreground">Workflows</h3>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => setShowNewDialog(true)}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      {/* Workflow List */}
      {workflows.length === 0 ? (
        <div className="text-center py-8 text-sm text-muted-foreground">
          <GitBranch className="h-8 w-8 mx-auto mb-2 opacity-50" />
          <p>No workflows yet</p>
          <Button
            variant="link"
            size="sm"
            className="mt-1"
            onClick={() => setShowNewDialog(true)}
          >
            Create your first workflow
          </Button>
        </div>
      ) : (
        <div className="space-y-1">
          {workflows.map((workflow) => {
            const latestExecution = getLatestExecution(workflow.id);
            return (
              <div
                key={workflow.id}
                className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-muted/50 group cursor-pointer"
                onClick={() => onSelectWorkflow(workflow)}
              >
                <GitBranch className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{workflow.name}</div>
                  <div className="text-xs text-muted-foreground flex items-center gap-1">
                    <span>{workflow.requests.length} steps</span>
                    {latestExecution && (
                      <>
                        <span>·</span>
                        <span
                          className={
                            latestExecution.status === 'success'
                              ? 'text-green-600'
                              : latestExecution.status === 'failed'
                                ? 'text-red-600'
                                : ''
                          }
                        >
                          {latestExecution.status}
                        </span>
                      </>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRunWorkflow(workflow);
                    }}
                    title="Run workflow"
                  >
                    <Play className="h-3.5 w-3.5" />
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <MoreVertical className="h-3.5 w-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={(e) => {
                          e.stopPropagation();
                          setWorkflowName(workflow.name);
                          setEditingWorkflow(workflow);
                        }}
                      >
                        <Pencil className="h-4 w-4 mr-2" />
                        Rename
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeletingWorkflow(workflow);
                        }}
                      >
                        <Trash2 className="h-4 w-4 mr-2" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* New Workflow Dialog */}
      <Dialog open={showNewDialog} onOpenChange={setShowNewDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Workflow</DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <Input
              placeholder="Workflow name"
              value={workflowName}
              onChange={(e) => setWorkflowName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowNewDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={!workflowName.trim()}>
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Workflow Dialog */}
      <Dialog open={!!editingWorkflow} onOpenChange={() => setEditingWorkflow(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename Workflow</DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <Input
              placeholder="Workflow name"
              value={workflowName}
              onChange={(e) => setWorkflowName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleUpdate()}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingWorkflow(null)}>
              Cancel
            </Button>
            <Button onClick={handleUpdate} disabled={!workflowName.trim()}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deletingWorkflow} onOpenChange={() => setDeletingWorkflow(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Workflow</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{deletingWorkflow?.name}"? This action cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleDelete}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
