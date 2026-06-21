import { describe, it, expect } from 'vitest';
import { emptyStubGraph } from '../flowTypes';
import { validateWorkflowGraph } from '../flowValidators';
import type { WorkflowGraph } from '@/types';

/** A minimal valid top-level graph containing a single forEach node whose body
 *  is `subgraph`. Mirrors what the canvas produces when a forEach is dropped. */
function graphWithForEach(subgraph: WorkflowGraph): WorkflowGraph {
  return {
    version: 1,
    nodes: [
      { id: 'start', kind: 'start', position: { x: 0, y: 0 } },
      {
        id: 'fe',
        kind: 'forEach',
        position: { x: 0, y: 100 },
        data: { collectionExpression: 'return [];', iteratorVar: 'item', subgraph },
      },
      { id: 'end', kind: 'end', position: { x: 0, y: 200 } },
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'fe' },
      { id: 'e2', source: 'fe', target: 'end' },
    ],
  };
}

describe('emptyStubGraph', () => {
  it('produces a subgraph that passes validateWorkflowGraph on its own', () => {
    const result = validateWorkflowGraph(emptyStubGraph());
    expect(result.ok).toBe(true);
  });

  it('lets a forEach node validate when run before drill-in (regression)', () => {
    // The bug: defaultNodeData seeded `{ nodes: [], edges: [] }`, so a forEach
    // dropped and run before opening its body failed the whole-graph validation.
    const empty: WorkflowGraph = { version: 1, nodes: [], edges: [] };
    expect(validateWorkflowGraph(graphWithForEach(empty)).ok).toBe(false);
    expect(validateWorkflowGraph(graphWithForEach(emptyStubGraph())).ok).toBe(true);
  });
});
