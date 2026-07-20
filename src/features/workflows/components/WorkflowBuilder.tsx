'use client';

import type { OwsBindings } from '@shared/ows/bindings';
import { buildOwsGraph, parseOwsWorkflowJson } from '@shared/ows/workflow-profile';
import { Check, Play, Workflow } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { type OwsStoredWorkflow, useWorkflowStore } from '@/store/useWorkflowStore';

interface WorkflowBuilderProps {
  workflow: OwsStoredWorkflow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRun: () => void;
}

function stringify(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/**
 * OWS-native authoring surface. The graph is a CSP-safe read-only projection:
 * visual start/end rows are synthetic UI, never workflow semantics.
 */
export function WorkflowBuilder({
  workflow: initialWorkflow,
  open,
  onOpenChange,
  onRun,
}: WorkflowBuilderProps) {
  const liveWorkflow = useWorkflowStore((state) =>
    state.workflows.find((candidate) => candidate.id === initialWorkflow.id)
  );
  const workflow = liveWorkflow ?? initialWorkflow;
  const updateWorkflowArtifacts = useWorkflowStore((state) => state.updateWorkflowArtifacts);
  const [documentSource, setDocumentSource] = useState(() => stringify(workflow.document));
  const [bindingsSource, setBindingsSource] = useState(() => stringify(workflow.bindings));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setDocumentSource(stringify(workflow.document));
    setBindingsSource(stringify(workflow.bindings));
    setError(null);
    setDirty(false);
  }, [workflow.id, workflow.updatedAt]);

  useEffect(() => {
    setSaved(false);
  }, [workflow.id]);

  const graphPaths = useMemo(() => {
    try {
      return buildOwsGraph(workflow.document).nodes.map((node) => node.id);
    } catch {
      return [];
    }
  }, [workflow.document]);

  const save = () => {
    try {
      const document = parseOwsWorkflowJson(documentSource);
      const bindings = JSON.parse(bindingsSource) as OwsBindings;
      updateWorkflowArtifacts(workflow.id, document, bindings, workflow.layout);
      setError(null);
      setSaved(true);
      setDirty(false);
    } catch (cause) {
      setSaved(false);
      setError(cause instanceof Error ? cause.message : 'Invalid OWS workflow artifact.');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[88vh] flex flex-col">
        <DialogHeader icon={Workflow}>
          <DialogTitle>OWS workflow: {workflow.document.document.name}</DialogTitle>
        </DialogHeader>
        <Tabs defaultValue="document" className="min-h-0 flex-1 flex flex-col">
          <TabsList className="grid grid-cols-3 w-full">
            <TabsTrigger value="document">OWS JSON</TabsTrigger>
            <TabsTrigger value="bindings">Bindings</TabsTrigger>
            <TabsTrigger value="graph">Task graph</TabsTrigger>
          </TabsList>
          <TabsContent value="document" className="min-h-0 flex-1 space-y-2">
            <Label htmlFor="ows-document">Executable workflow. JSON only.</Label>
            <Textarea
              id="ows-document"
              aria-label="OWS workflow JSON"
              className="font-mono text-xs min-h-[420px]"
              value={documentSource}
              onChange={(event) => {
                setDocumentSource(event.target.value);
                setSaved(false);
                setDirty(true);
              }}
              spellCheck={false}
            />
          </TabsContent>
          <TabsContent value="bindings" className="min-h-0 flex-1 space-y-2">
            <p className="text-sm text-muted-foreground">
              Typed task-path references only. Credentials and executable behavior are rejected.
            </p>
            <Textarea
              aria-label="OWS bindings JSON"
              className="font-mono text-xs min-h-[400px]"
              value={bindingsSource}
              onChange={(event) => {
                setBindingsSource(event.target.value);
                setSaved(false);
                setDirty(true);
              }}
              spellCheck={false}
            />
          </TabsContent>
          <TabsContent value="graph" className="min-h-0 flex-1">
            <p className="mb-3 text-sm text-muted-foreground">
              CSP-safe graph projection. Start and end are visual-only and are not stored in OWS.
            </p>
            <ScrollArea className="h-[380px] rounded border p-3">
              <ol className="space-y-2 text-sm">
                <li className="rounded bg-muted px-3 py-2 font-medium">Start (visual only)</li>
                {graphPaths.map((path) => (
                  <li key={path} className="rounded border px-3 py-2 font-mono text-xs">
                    {path}
                  </li>
                ))}
                <li className="rounded bg-muted px-3 py-2 font-medium">End (visual only)</li>
              </ol>
            </ScrollArea>
          </TabsContent>
        </Tabs>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {saved && (
          <p className="flex items-center gap-1 text-sm text-green-600">
            <Check className="h-4 w-4" /> Saved as validated OWS artifacts.
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button variant="outline" onClick={save}>
            Validate & save
          </Button>
          <Button
            disabled={dirty}
            onClick={onRun}
            title={dirty ? 'Save changes before running' : undefined}
          >
            <Play className="mr-2 h-4 w-4" />
            {dirty ? 'Save before running' : 'Run'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
