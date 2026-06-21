import { describe, it, expect } from 'vitest';
import { validateWorkflowGraph } from '../flowValidators';
import type { WorkflowGraph, FlowEdge } from '@/types';

/** Top-level graph: start → switch(2 cases) → ...edges..., plus end nodes. */
function graphWithSwitch(edges: FlowEdge[]): WorkflowGraph {
  return {
    version: 1,
    nodes: [
      { id: 'start', kind: 'start', position: { x: 0, y: 0 } },
      {
        id: 'sw',
        kind: 'switch',
        position: { x: 0, y: 100 },
        data: {
          cases: [
            { id: 'c1', label: 'one', expression: 'return false;' },
            { id: 'c2', label: 'two', expression: 'return false;' },
          ],
        },
      },
      { id: 'e1', kind: 'end', position: { x: 0, y: 200 } },
      { id: 'e2', kind: 'end', position: { x: 100, y: 200 } },
      { id: 'e3', kind: 'end', position: { x: 200, y: 200 } },
    ],
    edges: [{ id: 'edge-in', source: 'start', target: 'sw' }, ...edges],
  };
}

const ok = (g: WorkflowGraph) => validateWorkflowGraph(g).ok;

describe('switch node validation', () => {
  it('passes when every case + default has a matching outgoing edge', () => {
    expect(
      ok(
        graphWithSwitch([
          { id: 'oc1', source: 'sw', target: 'e1', sourceHandle: 'c1' },
          { id: 'oc2', source: 'sw', target: 'e2', sourceHandle: 'c2' },
          { id: 'ocd', source: 'sw', target: 'e3', sourceHandle: 'default' },
        ])
      )
    ).toBe(true);
  });

  it('fails when an outgoing edge references an unknown case handle (case edited after wiring)', () => {
    expect(
      ok(
        graphWithSwitch([
          { id: 'oc1', source: 'sw', target: 'e1', sourceHandle: 'c1' },
          { id: 'ocX', source: 'sw', target: 'e2', sourceHandle: 'stale-id' },
          { id: 'ocd', source: 'sw', target: 'e3', sourceHandle: 'default' },
        ])
      )
    ).toBe(false);
  });

  it('allows an unwired case as long as a default edge exists (executor falls through to default)', () => {
    expect(
      ok(
        graphWithSwitch([
          { id: 'oc1', source: 'sw', target: 'e1', sourceHandle: 'c1' },
          // c2 deliberately left unwired — it routes to default at runtime
          { id: 'ocd', source: 'sw', target: 'e3', sourceHandle: 'default' },
        ])
      )
    ).toBe(true);
  });

  it('fails when there is no default edge (a no-match would silently stop)', () => {
    expect(
      ok(
        graphWithSwitch([
          { id: 'oc1', source: 'sw', target: 'e1', sourceHandle: 'c1' },
          { id: 'oc2', source: 'sw', target: 'e2', sourceHandle: 'c2' },
        ])
      )
    ).toBe(false);
  });
});
