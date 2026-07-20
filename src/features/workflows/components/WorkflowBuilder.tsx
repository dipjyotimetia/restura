'use client';

import { isOwsBindings, type OwsBindings } from '@shared/ows/bindings';
import { parseOwsWorkflowJson } from '@shared/ows/workflow-profile';
import { Check, Play, Workflow } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { type OwsStoredWorkflow, useWorkflowStore } from '@/store/useWorkflowStore';
import { deriveOwsFlowModel, serializeOwsFlowModel } from '../lib/owsFlowMapper';
import { WorkflowCanvas } from './WorkflowCanvas';

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
 * Native workflow authoring surface. The graph is a CSP-safe projection:
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
  const [activeTab, setActiveTab] = useState('graph');
  const [flowModel, setFlowModel] = useState(() =>
    deriveOwsFlowModel(workflow.document, workflow.bindings, workflow.layout)
  );

  useEffect(() => {
    setDocumentSource(stringify(workflow.document));
    setBindingsSource(stringify(workflow.bindings));
    setError(null);
    setDirty(false);
    setFlowModel(deriveOwsFlowModel(workflow.document, workflow.bindings, workflow.layout));
  }, [workflow.id, workflow.updatedAt]);

  useEffect(() => {
    setSaved(false);
  }, [workflow.id]);

  const changeTab = (nextTab: string) => {
    if (nextTab === activeTab) return;
    try {
      if (activeTab === 'graph') {
        const artifact = serializeOwsFlowModel(flowModel, workflow.document.document);
        setDocumentSource(stringify(artifact.document));
        setBindingsSource(stringify(artifact.bindings));
      } else {
        const document = parseOwsWorkflowJson(documentSource);
        const bindings = JSON.parse(bindingsSource) as unknown;
        if (!isOwsBindings(bindings)) {
          throw new Error('Workflow bindings must be a version 1 typed bindings document.');
        }
        setFlowModel(deriveOwsFlowModel(document, bindings, workflow.layout));
      }
      setError(null);
      setActiveTab(nextTab);
    } catch (cause) {
      setSaved(false);
      setError(
        cause instanceof Error
          ? cause.message
          : 'Fix the current workflow draft before changing tabs.'
      );
    }
  };

  const save = () => {
    try {
      const artifact =
        activeTab === 'graph'
          ? serializeOwsFlowModel(flowModel, workflow.document.document)
          : {
              document: parseOwsWorkflowJson(documentSource),
              bindings: JSON.parse(bindingsSource) as OwsBindings,
              layout: workflow.layout,
            };
      const document = artifact.document;
      const bindings = artifact.bindings;
      updateWorkflowArtifacts(workflow.id, document, bindings, artifact.layout);
      if (activeTab === 'graph') {
        setDocumentSource(stringify(document));
        setBindingsSource(stringify(bindings));
      }
      setError(null);
      setSaved(true);
      setDirty(false);
    } catch (cause) {
      setSaved(false);
      setError(cause instanceof Error ? cause.message : 'Invalid workflow artifact.');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[88vh] flex flex-col">
        <DialogHeader icon={Workflow}>
          <DialogTitle>Workflow: {workflow.document.document.name}</DialogTitle>
        </DialogHeader>
        <Tabs value={activeTab} onValueChange={changeTab} className="min-h-0 flex-1 flex flex-col">
          <TabsList className="grid grid-cols-3 w-full">
            <TabsTrigger value="graph">Graph</TabsTrigger>
            <TabsTrigger value="document">Workflow JSON</TabsTrigger>
            <TabsTrigger value="bindings">Bindings</TabsTrigger>
          </TabsList>
          <TabsContent value="document" className="min-h-0 flex-1 space-y-2">
            <Label htmlFor="ows-document">Advanced workflow definition. JSON only.</Label>
            <Textarea
              id="ows-document"
              aria-label="Workflow JSON"
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
              aria-label="Workflow bindings JSON"
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
            <WorkflowCanvas
              collectionId={workflow.collectionId}
              model={flowModel}
              onChange={(next) => {
                setFlowModel(next);
                setDirty(true);
                setSaved(false);
              }}
            />
          </TabsContent>
        </Tabs>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {saved && (
          <p className="flex items-center gap-1 text-sm text-green-600">
            <Check className="h-4 w-4" /> Saved as a validated workflow.
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
