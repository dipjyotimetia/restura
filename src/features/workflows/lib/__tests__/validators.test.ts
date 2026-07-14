import { describe, expect, it } from 'vitest';
import type { Workflow, WorkflowGraph } from '@/types';
import { validateWorkflow } from '../validators';

function baseWorkflow(graph?: WorkflowGraph): Workflow {
  return {
    id: 'wf1',
    name: 'test',
    collectionId: 'c1',
    requests: [],
    createdAt: 0,
    updatedAt: 0,
    ...(graph ? { graph } : {}),
  };
}

describe('validateWorkflow — structural graph checks', () => {
  it('accepts a workflow with no graph', () => {
    expect(validateWorkflow(baseWorkflow()).success).toBe(true);
  });

  it('accepts a workflow with a structurally valid graph', () => {
    const graph: WorkflowGraph = {
      version: 1,
      nodes: [
        { id: 'start', kind: 'start', position: { x: 0, y: 0 } },
        { id: 'end', kind: 'end', position: { x: 0, y: 100 } },
      ],
      edges: [{ id: 'e1', source: 'start', target: 'end' }],
    };
    expect(validateWorkflow(baseWorkflow(graph)).success).toBe(true);
  });

  it('rejects a workflow whose graph has a cycle — Zod shape alone would have missed this', () => {
    const graph: WorkflowGraph = {
      version: 1,
      nodes: [
        { id: 'start', kind: 'start', position: { x: 0, y: 0 } },
        {
          id: 'a',
          kind: 'setVariable',
          position: { x: 0, y: 80 },
          data: { assignments: [] },
        },
        {
          id: 'b',
          kind: 'setVariable',
          position: { x: 0, y: 160 },
          data: { assignments: [] },
        },
        { id: 'end', kind: 'end', position: { x: 0, y: 240 } },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'a' },
        { id: 'e2', source: 'a', target: 'b' },
        { id: 'e3', source: 'b', target: 'a' },
        { id: 'e4', source: 'b', target: 'end' },
      ],
    };
    const result = validateWorkflow(baseWorkflow(graph));
    expect(result.success).toBe(false);
    expect(result.errors?.some((e) => e.includes('cycle'))).toBe(true);
  });

  it('rejects a workflow whose graph has no start node', () => {
    const graph: WorkflowGraph = {
      version: 1,
      nodes: [{ id: 'end', kind: 'end', position: { x: 0, y: 0 } }],
      edges: [],
    };
    expect(validateWorkflow(baseWorkflow(graph)).success).toBe(false);
  });

  it('does not reject a graph that only has non-blocking warnings (dead end-node wiring)', () => {
    const graph: WorkflowGraph = {
      version: 1,
      nodes: [
        { id: 'start', kind: 'start', position: { x: 0, y: 0 } },
        { id: 'end', kind: 'end', position: { x: 0, y: 100 } },
        { id: 'orphan', kind: 'end', position: { x: 100, y: 200 } },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'end' },
        { id: 'e2', source: 'end', target: 'orphan' },
      ],
    };
    expect(validateWorkflow(baseWorkflow(graph)).success).toBe(true);
  });
});
