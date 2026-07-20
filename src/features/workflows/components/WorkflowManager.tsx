'use client';

import { Download, MoreVertical, Pencil, Play, Plus, Trash2, Upload, Workflow } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useShallow } from 'zustand/react/shallow';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { isNameTaken, uniqueName } from '@/features/collections/lib/names';
import { type OwsStoredWorkflow, useWorkflowStore } from '@/store/useWorkflowStore';
import { exportWorkflow, parseWorkflowImport } from '../lib/workflowIO';

interface WorkflowManagerProps {
  collectionId: string;
  onSelectWorkflow: (workflow: OwsStoredWorkflow) => void;
  onRunWorkflow: (workflow: OwsStoredWorkflow) => void;
}

export function WorkflowManager({
  collectionId,
  onSelectWorkflow,
  onRunWorkflow,
}: WorkflowManagerProps) {
  const workflows = useWorkflowStore(
    useShallow((state) =>
      state.workflows.filter((workflow) => workflow.collectionId === collectionId)
    )
  );
  const createNewWorkflow = useWorkflowStore((state) => state.createNewWorkflow);
  const addWorkflow = useWorkflowStore((state) => state.addWorkflow);
  const renameWorkflow = useWorkflowStore((state) => state.renameWorkflow);
  const removeWorkflow = useWorkflowStore((state) => state.removeWorkflow);
  const [showNewDialog, setShowNewDialog] = useState(false);
  const [editingWorkflow, setEditingWorkflow] = useState<OwsStoredWorkflow | null>(null);
  const [workflowName, setWorkflowName] = useState('');
  const importInputRef = useRef<HTMLInputElement>(null);
  const workflowNames = useMemo(
    () => workflows.map((workflow) => workflow.document.document.name),
    [workflows]
  );

  const create = () => {
    if (!workflowName.trim()) return;
    const workflow = createNewWorkflow(
      uniqueName(workflowName.trim(), workflowNames),
      collectionId
    );
    addWorkflow(workflow);
    setWorkflowName('');
    setShowNewDialog(false);
    onSelectWorkflow(workflow);
  };
  const rename = () => {
    if (!editingWorkflow || !workflowName.trim()) return;
    const otherNames = workflowNames.filter(
      (name) => name !== editingWorkflow.document.document.name
    );
    if (isNameTaken(workflowName.trim(), otherNames)) {
      toast.error(`A workflow named "${workflowName.trim()}" already exists`);
      return;
    }
    renameWorkflow(editingWorkflow.id, workflowName.trim());
    setEditingWorkflow(null);
    setWorkflowName('');
  };
  const exportArtifact = (workflow: OwsStoredWorkflow) => {
    const url = URL.createObjectURL(
      new Blob([exportWorkflow(workflow)], { type: 'application/json' })
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `${workflow.document.document.name}.ows.json`;
    link.click();
    URL.revokeObjectURL(url);
  };
  const importArtifact = async (file: File) => {
    const result = parseWorkflowImport(await file.text(), collectionId);
    if (!result.ok) {
      toast.error(`Import failed — ${result.error}`);
      return;
    }
    addWorkflow(result.workflow);
    toast.success(`Imported "${result.workflow.document.document.name}"`);
    onSelectWorkflow(result.workflow);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between px-2">
        <h3 className="text-sm font-medium text-muted-foreground">Workflows</h3>
        <div className="flex gap-0.5">
          <input
            ref={importInputRef}
            type="file"
            accept="application/json,application/yaml,text/yaml,.json,.yaml,.yml"
            className="hidden"
            aria-label="Import workflow"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importArtifact(file);
              event.target.value = '';
            }}
          />
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            title="Import workflow JSON or YAML"
            onClick={() => importInputRef.current?.click()}
          >
            <Upload className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            title="New workflow"
            onClick={() => setShowNewDialog(true)}
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      </div>
      {workflows.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted-foreground">No workflows yet</div>
      ) : (
        <div className="space-y-1">
          {workflows.map((workflow) => (
            <div
              key={workflow.id}
              className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50"
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                aria-label={`Edit workflow ${workflow.document.document.name}`}
                onClick={() => onSelectWorkflow(workflow)}
              >
                <Workflow className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {workflow.document.document.name}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {Object.keys(workflow.bindings.tasks).length} bound call
                    {Object.keys(workflow.bindings.tasks).length === 1 ? '' : 's'}
                  </div>
                </div>
              </button>
              <div className="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  title="Run workflow"
                  aria-label={`Run workflow ${workflow.document.document.name}`}
                  onClick={() => {
                    onRunWorkflow(workflow);
                  }}
                >
                  <Play className="h-3.5 w-3.5" />
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      aria-label={`Workflow actions for ${workflow.document.document.name}`}
                    >
                      <MoreVertical className="h-3.5 w-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onClick={() => {
                        setEditingWorkflow(workflow);
                        setWorkflowName(workflow.document.document.name);
                      }}
                    >
                      <Pencil className="mr-2 h-4 w-4" />
                      Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => exportArtifact(workflow)}>
                      <Download className="mr-2 h-4 w-4" />
                      Export workflow JSON
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="text-destructive"
                      onClick={() => removeWorkflow(workflow.id)}
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          ))}
        </div>
      )}
      <Dialog open={showNewDialog} onOpenChange={setShowNewDialog}>
        <DialogContent>
          <DialogHeader icon={Workflow}>
            <DialogTitle>Create workflow</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            placeholder="Workflow name"
            value={workflowName}
            onChange={(event) => setWorkflowName(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && create()}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowNewDialog(false)}>
              Cancel
            </Button>
            <Button disabled={!workflowName.trim()} onClick={create}>
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={!!editingWorkflow} onOpenChange={(open) => !open && setEditingWorkflow(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename workflow</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={workflowName}
            onChange={(event) => setWorkflowName(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && rename()}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingWorkflow(null)}>
              Cancel
            </Button>
            <Button disabled={!workflowName.trim()} onClick={rename}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
