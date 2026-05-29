import { describe, it, expect } from 'vitest';
import type { Workflow, WorkflowGraph } from '@/types';
import { exportWorkflow, parseWorkflowImport } from '../workflowIO';

const graph: WorkflowGraph = {
  version: 1,
  nodes: [
    { id: 'start', kind: 'start', position: { x: 0, y: 0 } },
    { id: 'end', kind: 'end', position: { x: 0, y: 0 } },
  ],
  edges: [{ id: 'e1', source: 'start', target: 'end' }],
};

const workflow: Workflow = {
  id: 'orig-id',
  name: 'My Flow',
  description: 'desc',
  collectionId: 'col-a',
  requests: [],
  variables: [{ id: 'v1', key: 'k', value: 'v', enabled: true }],
  graph,
  createdAt: 1,
  updatedAt: 2,
};

describe('workflowIO', () => {
  it('round-trips a workflow, re-ids it, and rebinds the collection', () => {
    const json = exportWorkflow(workflow);
    const result = parseWorkflowImport(json, 'col-b');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workflow.id).not.toBe('orig-id');
    expect(result.workflow.collectionId).toBe('col-b');
    expect(result.workflow.name).toBe('My Flow');
    expect(result.workflow.description).toBe('desc');
    expect(result.workflow.graph).toEqual(graph);
    expect(result.workflow.variables).toEqual([{ id: 'v1', key: 'k', value: 'v', enabled: true }]);
  });

  it('accepts a bare workflow object (no envelope)', () => {
    const result = parseWorkflowImport(JSON.stringify(workflow), 'col-c');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.workflow.collectionId).toBe('col-c');
  });

  it('rejects non-JSON', () => {
    const result = parseWorkflowImport('{not json', 'c');
    expect(result.ok).toBe(false);
  });

  it('rejects a workflow with no name', () => {
    const result = parseWorkflowImport(JSON.stringify({ collectionId: 'x' }), 'c');
    expect(result.ok).toBe(false);
  });

  it('rejects an invalid embedded graph', () => {
    const bad = {
      ...workflow,
      graph: { version: 1, nodes: [], edges: [] }, // no start node
    };
    const result = parseWorkflowImport(JSON.stringify(bad), 'c');
    expect(result.ok).toBe(false);
  });
});
