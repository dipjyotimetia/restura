'use client';

import { buildOwsGraph } from '@shared/ows/workflow-profile';
import { Play, Square } from 'lucide-react';
import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { OwsStoredWorkflow } from '@/store/useWorkflowStore';
import { useOwsWorkflowExecution } from '../hooks/useOwsWorkflowExecution';

interface WorkflowExecutorProps {
  workflow: OwsStoredWorkflow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function WorkflowExecutor({ workflow, open, onOpenChange }: WorkflowExecutorProps) {
  const { isRunning, result, steps, error, run, stop } = useOwsWorkflowExecution();
  const graphPaths = useMemo(() => {
    try {
      return buildOwsGraph(workflow.document).nodes.map((node) => node.id);
    } catch {
      return [];
    }
  }, [workflow.document]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {workflow.document.document.name}
            {result && (
              <Badge variant={result.status === 'success' ? 'default' : 'destructive'}>
                {result.status}
              </Badge>
            )}
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Bound calls resolve only to saved HTTP resources and run through the normal
          policy-enforced protocol adapter.
        </p>
        <ScrollArea className="h-[390px] rounded border p-3">
          <ol className="space-y-2 text-sm">
            <li className="rounded bg-muted px-3 py-2 font-medium">Start (visual only)</li>
            {graphPaths.map((taskPath) => {
              const step = steps.find((candidate) => candidate.taskPath === taskPath);
              return (
                <li
                  key={taskPath}
                  className="flex items-center justify-between rounded border px-3 py-2"
                >
                  <code className="text-xs">{taskPath}</code>
                  <span
                    className={
                      step?.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'
                    }
                  >
                    {step?.status ?? 'pending'}
                  </span>
                </li>
              );
            })}
            <li className="rounded bg-muted px-3 py-2 font-medium">End (visual only)</li>
          </ol>
        </ScrollArea>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {isRunning ? (
            <Button variant="destructive" onClick={stop}>
              <Square className="mr-2 h-4 w-4" />
              Stop
            </Button>
          ) : (
            <Button onClick={() => void run(workflow)}>
              <Play className="mr-2 h-4 w-4" />
              Run OWS workflow
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
