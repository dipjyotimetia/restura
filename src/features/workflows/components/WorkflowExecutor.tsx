'use client';

import { useState } from 'react';
import { Workflow, HttpRequest, CollectionItem } from '@/types';
import { useWorkflowExecution } from '../hooks/useWorkflowExecution';
import { useCollectionStore } from '@/store/useCollectionStore';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { WorkflowStep } from './WorkflowStep';
import {
  Play,
  Square,
  CheckCircle2,
  XCircle,
  Clock,
  Variable,
  FileText,
} from 'lucide-react';
import { cn } from '@/lib/shared/utils';

interface WorkflowExecutorProps {
  workflow: Workflow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function WorkflowExecutor({
  workflow,
  open,
  onOpenChange,
}: WorkflowExecutorProps) {
  const collections = useCollectionStore((s) => s.collections);
  const collection = collections.find((c) => c.id === workflow.collectionId);

  const { isRunning, execution, logs, run, stop } =
    useWorkflowExecution();

  const [activeTab, setActiveTab] = useState<'steps' | 'variables' | 'logs'>('steps');

  // Get request by ID
  const getRequestById = (id: string): HttpRequest | undefined => {
    if (!collection) return undefined;

    const find = (items: CollectionItem[]): HttpRequest | undefined => {
      for (const item of items) {
        if (item.type === 'request' && item.request?.id === id && item.request.type === 'http') {
          return item.request as HttpRequest;
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

  const handleRun = async () => {
    setActiveTab('steps');
    await run(workflow);
  };

  const completedSteps = execution?.steps.filter((s) => s.status === 'success').length || 0;
  const totalSteps = workflow.requests.length;
  const progress = totalSteps > 0 ? (completedSteps / totalSteps) * 100 : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <DialogTitle className="flex items-center gap-2">
              {workflow.name}
              {execution && (
                <Badge
                  variant={
                    execution.status === 'success'
                      ? 'default'
                      : execution.status === 'failed'
                        ? 'destructive'
                        : 'secondary'
                  }
                >
                  {execution.status}
                </Badge>
              )}
            </DialogTitle>
          </div>
          {isRunning && (
            <div className="space-y-1 mt-2">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>
                  Step {completedSteps + 1} of {totalSteps}
                </span>
                <span>{Math.round(progress)}%</span>
              </div>
              <Progress value={progress} className="h-2" />
            </div>
          )}
        </DialogHeader>

        <Tabs
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as typeof activeTab)}
          className="flex-1 flex flex-col"
        >
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="steps" className="flex items-center gap-1">
              <FileText className="h-3.5 w-3.5" />
              Steps
            </TabsTrigger>
            <TabsTrigger value="variables" className="flex items-center gap-1">
              <Variable className="h-3.5 w-3.5" />
              Variables
            </TabsTrigger>
            <TabsTrigger value="logs" className="flex items-center gap-1">
              <Clock className="h-3.5 w-3.5" />
              Logs
            </TabsTrigger>
          </TabsList>

          <TabsContent value="steps" className="flex-1 mt-4">
            <ScrollArea className="h-[400px]">
              <div className="space-y-2 pr-4">
                {workflow.requests.map((req, index) => {
                  const execStep = execution?.steps.find(
                    (s) => s.workflowRequestId === req.id
                  );
                  const requestDetails = getRequestById(req.requestId);
                  return (
                    <WorkflowStep
                      key={req.id}
                      workflowRequest={req}
                      method={requestDetails?.method}
                      executionStep={execStep}
                      index={index}
                    />
                  );
                })}
              </div>
            </ScrollArea>
          </TabsContent>

          <TabsContent value="variables" className="flex-1 mt-4">
            <ScrollArea className="h-[400px]">
              {execution && Object.keys(execution.finalVariables).length > 0 ? (
                <div className="space-y-1 pr-4">
                  {Object.entries(execution.finalVariables).map(([key, value]) => (
                    <div
                      key={key}
                      className="flex items-start gap-2 p-2 rounded bg-muted/50"
                    >
                      <code className="text-sm font-medium text-primary min-w-[100px]">
                        {key}
                      </code>
                      <code className="text-sm text-muted-foreground break-all">
                        {value.length > 100 ? `${value.substring(0, 100)}...` : value}
                      </code>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-12 text-muted-foreground">
                  {execution
                    ? 'No variables extracted during execution'
                    : 'Run the workflow to see extracted variables'}
                </div>
              )}
            </ScrollArea>
          </TabsContent>

          <TabsContent value="logs" className="flex-1 mt-4">
            <ScrollArea className="h-[400px]">
              {logs.length > 0 ? (
                <div className="space-y-1 pr-4 font-mono text-xs">
                  {logs.map((log, index) => (
                    <div
                      key={index}
                      className={cn(
                        'p-1.5 rounded',
                        log.level === 'error' && 'bg-red-50 dark:bg-red-950 text-red-700 dark:text-red-300',
                        log.level === 'warn' && 'bg-yellow-50 dark:bg-yellow-950 text-yellow-700 dark:text-yellow-300',
                        log.level === 'info' && 'bg-muted'
                      )}
                    >
                      <span className="text-muted-foreground">
                        {new Date(log.timestamp).toLocaleTimeString()}
                      </span>{' '}
                      {log.message}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-12 text-muted-foreground">
                  Run the workflow to see execution logs
                </div>
              )}
            </ScrollArea>
          </TabsContent>
        </Tabs>

        <DialogFooter className="border-t pt-4">
          {execution && !isRunning && (
            <div className="flex items-center gap-2 mr-auto text-sm">
              {execution.status === 'success' ? (
                <>
                  <CheckCircle2 className="h-4 w-4 text-green-500" />
                  <span className="text-green-600">
                    Completed in {execution.completedAt ? execution.completedAt - execution.startedAt : 0}ms
                  </span>
                </>
              ) : execution.status === 'failed' ? (
                <>
                  <XCircle className="h-4 w-4 text-red-500" />
                  <span className="text-red-600">
                    Failed at step {execution.steps.findIndex((s) => s.status === 'failed') + 1}
                  </span>
                </>
              ) : null}
            </div>
          )}

          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>

          {isRunning ? (
            <Button variant="destructive" onClick={stop}>
              <Square className="h-4 w-4 mr-2" />
              Stop
            </Button>
          ) : (
            <Button onClick={handleRun}>
              <Play className="h-4 w-4 mr-2" />
              {execution ? 'Run Again' : 'Run'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
