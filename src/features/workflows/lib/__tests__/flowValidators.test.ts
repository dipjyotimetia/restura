import { describe, it, expect } from 'vitest';
import { validateWorkflowGraph } from '../flowValidators';
import type { WorkflowGraph } from '@/types';

describe('end-node dangling edges', () => {
  function graphWithEndEdge(): WorkflowGraph {
    return {
      version: 1,
      nodes: [
        { id: 'start', kind: 'start', position: { x: 0, y: 0 } },
        { id: 'end', kind: 'end', position: { x: 0, y: 100 } },
        { id: 'orphan', kind: 'end', position: { x: 100, y: 200 } },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'end' },
        // Dead wiring — dagExecutor's walkFrom returns immediately for
        // `kind === 'end'` and never follows this edge.
        { id: 'e2', source: 'end', target: 'orphan' },
      ],
    };
  }

  it('does not block Run (warning, not error)', () => {
    const result = validateWorkflowGraph(graphWithEndEdge());
    expect(result.ok).toBe(true);
  });

  it('still surfaces the dangling edge as a warning issue for the editor UI', () => {
    const result = validateWorkflowGraph(graphWithEndEdge());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.severity).toBe('warning');
    expect(result.issues[0]!.message).toContain('end');
  });

  it('a graph with no such dead wiring reports zero issues', () => {
    const clean: WorkflowGraph = {
      version: 1,
      nodes: [
        { id: 'start', kind: 'start', position: { x: 0, y: 0 } },
        { id: 'end', kind: 'end', position: { x: 0, y: 100 } },
      ],
      edges: [{ id: 'e1', source: 'start', target: 'end' }],
    };
    const result = validateWorkflowGraph(clean);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.issues).toHaveLength(0);
  });

  it('pre-existing checks default to severity "error" and still block Run', () => {
    const noStart: WorkflowGraph = {
      version: 1,
      nodes: [{ id: 'end', kind: 'end', position: { x: 0, y: 0 } }],
      edges: [],
    };
    const result = validateWorkflowGraph(noStart);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]!.severity ?? 'error').toBe('error');
  });
});

describe('cycle detection in nested subgraphs', () => {
  it('detects a cycle fully contained inside a forEach body', () => {
    const graph: WorkflowGraph = {
      version: 1,
      nodes: [
        { id: 'start', kind: 'start', position: { x: 0, y: 0 } },
        {
          id: 'fe',
          kind: 'forEach',
          position: { x: 0, y: 100 },
          data: {
            collectionExpression: 'return [];',
            iteratorVar: 'item',
            subgraph: {
              version: 1,
              nodes: [
                { id: 'sub-start', kind: 'start', position: { x: 0, y: 0 } },
                {
                  id: 'sub-sv',
                  kind: 'setVariable',
                  position: { x: 0, y: 80 },
                  data: { assignments: [] },
                },
                { id: 'sub-end', kind: 'end', position: { x: 0, y: 160 } },
              ],
              edges: [
                { id: 'se1', source: 'sub-start', target: 'sub-sv' },
                { id: 'se2', source: 'sub-sv', target: 'sub-end' },
                // Cycle: sv -> sv via a second edge back to itself's predecessor path.
                { id: 'se3', source: 'sub-sv', target: 'sub-start' },
              ],
            },
          },
        },
        { id: 'end', kind: 'end', position: { x: 0, y: 200 } },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'fe' },
        { id: 'e2', source: 'fe', target: 'end' },
      ],
    };
    const result = validateWorkflowGraph(graph);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.message.includes('cycle'))).toBe(true);
  });

  it('detects a self-loop on a condition node', () => {
    const graph: WorkflowGraph = {
      version: 1,
      nodes: [
        { id: 'start', kind: 'start', position: { x: 0, y: 0 } },
        {
          id: 'cond',
          kind: 'condition',
          position: { x: 0, y: 100 },
          data: { expression: 'return true;' },
        },
        { id: 'end', kind: 'end', position: { x: 0, y: 200 } },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'cond' },
        // Self-loop: condition's own "true" edge targets itself.
        { id: 'e2', source: 'cond', target: 'cond', sourceHandle: 'true' },
        { id: 'e3', source: 'cond', target: 'end', sourceHandle: 'false' },
      ],
    };
    const result = validateWorkflowGraph(graph);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.message.includes('cycle'))).toBe(true);
  });

  it('a cycle spanning try and catch subgraphs independently does not false-positive', () => {
    const emptyStub = (yId: number): WorkflowGraph => ({
      version: 1,
      nodes: [
        { id: `s${yId}`, kind: 'start', position: { x: 0, y: 0 } },
        { id: `e${yId}`, kind: 'end', position: { x: 0, y: 80 } },
      ],
      edges: [{ id: `se${yId}`, source: `s${yId}`, target: `e${yId}` }],
    });
    const graph: WorkflowGraph = {
      version: 1,
      nodes: [
        { id: 'start', kind: 'start', position: { x: 0, y: 0 } },
        {
          id: 'tc',
          kind: 'tryCatch',
          position: { x: 0, y: 100 },
          data: { trySubgraph: emptyStub(1), catchSubgraph: emptyStub(2) },
        },
        { id: 'end', kind: 'end', position: { x: 0, y: 200 } },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'tc' },
        { id: 'e2', source: 'tc', target: 'end' },
      ],
    };
    expect(validateWorkflowGraph(graph).ok).toBe(true);
  });
});
