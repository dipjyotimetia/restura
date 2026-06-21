import { describe, it, expect } from 'vitest';
import type { WorkflowGraph, ForEachFlowNode, TryCatchFlowNode } from '@/types';
import { selectAtPath, setAtPath, pathSegmentLabel } from '../flowTypes';

const emptySubgraph: WorkflowGraph = {
  version: 1,
  nodes: [
    { id: 's', kind: 'start', position: { x: 0, y: 0 } },
    { id: 'e', kind: 'end', position: { x: 0, y: 0 } },
  ],
  edges: [{ id: 'a', source: 's', target: 'e' }],
};

function makeForEach(id: string, sub: WorkflowGraph): ForEachFlowNode {
  return {
    id,
    kind: 'forEach',
    position: { x: 0, y: 0 },
    data: {
      collectionExpression: 'return [];',
      iteratorVar: 'item',
      subgraph: sub,
    },
  };
}

function makeTryCatch(
  id: string,
  tryGraph: WorkflowGraph,
  catchGraph: WorkflowGraph
): TryCatchFlowNode {
  return {
    id,
    kind: 'tryCatch',
    position: { x: 0, y: 0 },
    data: { trySubgraph: tryGraph, catchSubgraph: catchGraph },
  };
}

const root: WorkflowGraph = {
  version: 1,
  nodes: [
    { id: 'start', kind: 'start', position: { x: 0, y: 0 } },
    makeForEach('fe', emptySubgraph),
    makeTryCatch('tc', emptySubgraph, emptySubgraph),
    { id: 'end', kind: 'end', position: { x: 0, y: 0 } },
  ],
  edges: [],
};

describe('selectAtPath', () => {
  it('returns root for empty path', () => {
    expect(selectAtPath(root, [])).toBe(root);
  });

  it('descends into forEach.subgraph', () => {
    const got = selectAtPath(root, [{ parentNodeId: 'fe', key: 'subgraph' }]);
    expect(got).toBe(emptySubgraph);
  });

  it('descends into tryCatch.trySubgraph and catchSubgraph', () => {
    expect(selectAtPath(root, [{ parentNodeId: 'tc', key: 'trySubgraph' }])).toBe(emptySubgraph);
    expect(selectAtPath(root, [{ parentNodeId: 'tc', key: 'catchSubgraph' }])).toBe(emptySubgraph);
  });

  it('returns null when parentNodeId is unknown', () => {
    expect(selectAtPath(root, [{ parentNodeId: 'nope', key: 'subgraph' }])).toBeNull();
  });

  it('returns null when key is wrong for kind', () => {
    // 'subgraph' on a tryCatch is invalid
    expect(selectAtPath(root, [{ parentNodeId: 'tc', key: 'subgraph' }])).toBeNull();
    // 'trySubgraph' on a forEach is invalid
    expect(selectAtPath(root, [{ parentNodeId: 'fe', key: 'trySubgraph' }])).toBeNull();
  });

  it('handles two-level nesting', () => {
    const inner = emptySubgraph;
    const outer: WorkflowGraph = {
      version: 1,
      nodes: [
        { id: 's', kind: 'start', position: { x: 0, y: 0 } },
        makeForEach('inner', inner),
        { id: 'e', kind: 'end', position: { x: 0, y: 0 } },
      ],
      edges: [],
    };
    const root2: WorkflowGraph = {
      version: 1,
      nodes: [makeForEach('outer', outer)],
      edges: [],
    };
    const got = selectAtPath(root2, [
      { parentNodeId: 'outer', key: 'subgraph' },
      { parentNodeId: 'inner', key: 'subgraph' },
    ]);
    expect(got).toBe(inner);
  });
});

describe('setAtPath', () => {
  const replacement: WorkflowGraph = {
    version: 1,
    nodes: [
      { id: 's', kind: 'start', position: { x: 10, y: 10 } },
      { id: 'e', kind: 'end', position: { x: 20, y: 20 } },
    ],
    edges: [],
  };

  it('replaces top-level with empty path', () => {
    expect(setAtPath(root, [], replacement)).toBe(replacement);
  });

  it('replaces forEach subgraph at depth 1', () => {
    const next = setAtPath(root, [{ parentNodeId: 'fe', key: 'subgraph' }], replacement);
    const fe = next.nodes.find((n) => n.id === 'fe') as ForEachFlowNode;
    expect(fe.data.subgraph).toBe(replacement);
    // Other nodes untouched.
    expect(next.nodes.find((n) => n.id === 'tc')).toBe(root.nodes.find((n) => n.id === 'tc'));
  });

  it('replaces tryCatch catch branch independently of try', () => {
    const next = setAtPath(root, [{ parentNodeId: 'tc', key: 'catchSubgraph' }], replacement);
    const tc = next.nodes.find((n) => n.id === 'tc') as TryCatchFlowNode;
    expect(tc.data.catchSubgraph).toBe(replacement);
    expect(tc.data.trySubgraph).toBe(emptySubgraph);
  });

  it('returns root unchanged when path is invalid', () => {
    const got = setAtPath(root, [{ parentNodeId: 'nope', key: 'subgraph' }], replacement);
    expect(got).toBe(root);
  });

  it('returns root unchanged when key mismatches kind', () => {
    const got = setAtPath(root, [{ parentNodeId: 'tc', key: 'subgraph' }], replacement);
    expect(got).toBe(root);
  });

  it('updates a doubly-nested subgraph', () => {
    const inner = emptySubgraph;
    const outerSub: WorkflowGraph = {
      version: 1,
      nodes: [makeForEach('inner', inner)],
      edges: [],
    };
    const top: WorkflowGraph = {
      version: 1,
      nodes: [makeForEach('outer', outerSub)],
      edges: [],
    };
    const next = setAtPath(
      top,
      [
        { parentNodeId: 'outer', key: 'subgraph' },
        { parentNodeId: 'inner', key: 'subgraph' },
      ],
      replacement
    );
    const outer = next.nodes[0] as ForEachFlowNode;
    const innerNode = outer.data.subgraph.nodes[0] as ForEachFlowNode;
    expect(innerNode.data.subgraph).toBe(replacement);
  });
});

describe('pathSegmentLabel', () => {
  it('maps each key to a short human label', () => {
    expect(pathSegmentLabel('subgraph')).toBe('body');
    expect(pathSegmentLabel('trySubgraph')).toBe('try');
    expect(pathSegmentLabel('catchSubgraph')).toBe('catch');
  });
});
