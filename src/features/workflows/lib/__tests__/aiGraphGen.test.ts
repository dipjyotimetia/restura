import { describe, expect, it } from 'vitest';
import { buildGraphSystemPrompt, extractGraphFromAiText } from '../aiGraphGen';

const validGraph = {
  version: 1,
  nodes: [
    { id: 'start', kind: 'start', position: { x: 0, y: 0 } },
    {
      id: 'sv',
      kind: 'setVariable',
      position: { x: 0, y: 80 },
      data: { assignments: [{ key: 'x', valueExpression: '"1"' }] },
    },
    { id: 'end', kind: 'end', position: { x: 0, y: 160 } },
  ],
  edges: [
    { id: 'e1', source: 'start', target: 'sv' },
    { id: 'e2', source: 'sv', target: 'end' },
  ],
};

describe('aiGraphGen', () => {
  it('system prompt documents the new node kinds', () => {
    const p = buildGraphSystemPrompt();
    for (const kind of ['switch', 'loop', 'template', 'display', 'forEach']) {
      expect(p).toContain(kind);
    }
  });

  it('extracts a bare JSON graph', () => {
    const res = extractGraphFromAiText(JSON.stringify(validGraph));
    expect(res.ok).toBe(true);
  });

  it('extracts a fenced JSON graph wrapped in prose', () => {
    const text = `Sure! Here is your workflow:\n\n\`\`\`json\n${JSON.stringify(
      validGraph
    )}\n\`\`\`\nLet me know if you need changes.`;
    const res = extractGraphFromAiText(text);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.graph.nodes).toHaveLength(3);
  });

  it('extracts an object even when surrounded by leading text and no fence', () => {
    const text = `Here you go: ${JSON.stringify(validGraph)} (done)`;
    const res = extractGraphFromAiText(text);
    expect(res.ok).toBe(true);
  });

  it('handles braces inside string values', () => {
    const withBraces = {
      ...validGraph,
      nodes: validGraph.nodes.map((n) =>
        n.id === 'sv'
          ? {
              ...n,
              data: { assignments: [{ key: 'tpl', valueExpression: '"{a:{b}}"' }] },
            }
          : n
      ),
    };
    const res = extractGraphFromAiText(JSON.stringify(withBraces));
    expect(res.ok).toBe(true);
  });

  it('rejects when there is no JSON object', () => {
    const res = extractGraphFromAiText('I cannot help with that.');
    expect(res.ok).toBe(false);
  });

  it('rejects malformed JSON', () => {
    const res = extractGraphFromAiText('```json\n{ "version": 1, nodes: [] \n```');
    expect(res.ok).toBe(false);
  });

  it('rejects a structurally invalid graph (no start)', () => {
    const res = extractGraphFromAiText(
      JSON.stringify({
        version: 1,
        nodes: [{ id: 'end', kind: 'end', position: { x: 0, y: 0 } }],
        edges: [],
      })
    );
    expect(res.ok).toBe(false);
  });

  it('remaps the model’s own short/predictable ids to fresh uuids', () => {
    const res = extractGraphFromAiText(JSON.stringify(validGraph));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // None of the model's literal ids ("start"/"sv"/"end"/"e1"/"e2") survive —
    // merging a second AI-generated graph (or a human-authored one using the
    // same short ids) must not collide.
    for (const n of res.graph.nodes) expect(['start', 'sv', 'end']).not.toContain(n.id);
    for (const e of res.graph.edges) expect(['e1', 'e2']).not.toContain(e.id);
    // Edges still resolve to the (remapped) node ids at this graph level.
    const nodeIds = new Set(res.graph.nodes.map((n) => n.id));
    for (const e of res.graph.edges) {
      expect(nodeIds.has(e.source)).toBe(true);
      expect(nodeIds.has(e.target)).toBe(true);
    }
    // Every id is unique.
    expect(new Set(res.graph.nodes.map((n) => n.id)).size).toBe(res.graph.nodes.length);
  });

  it('remaps ids recursively inside nested forEach/loop/tryCatch subgraphs', () => {
    const nested = {
      version: 1,
      nodes: [
        { id: 'start', kind: 'start', position: { x: 0, y: 0 } },
        {
          id: 'fe',
          kind: 'forEach',
          position: { x: 0, y: 80 },
          data: {
            collectionExpression: 'return [];',
            iteratorVar: 'item',
            subgraph: {
              version: 1,
              nodes: [
                { id: 'start', kind: 'start', position: { x: 0, y: 0 } },
                { id: 'end', kind: 'end', position: { x: 0, y: 80 } },
              ],
              edges: [{ id: 'e1', source: 'start', target: 'end' }],
            },
          },
        },
        { id: 'end', kind: 'end', position: { x: 0, y: 160 } },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'fe' },
        { id: 'e2', source: 'fe', target: 'end' },
      ],
    };
    const res = extractGraphFromAiText(JSON.stringify(nested));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const forEachNode = res.graph.nodes.find((n) => n.kind === 'forEach');
    expect(forEachNode?.kind).toBe('forEach');
    if (forEachNode?.kind !== 'forEach') return;
    const sub = forEachNode.data.subgraph;
    // The nested subgraph reused the SAME literal ids ("start"/"end"/"e1")
    // as the top level — both must be remapped independently, and the
    // subgraph's remapped ids must not collide with the top level's.
    for (const n of sub.nodes) expect(['start', 'end']).not.toContain(n.id);
    const topIds = new Set(res.graph.nodes.map((n) => n.id));
    for (const n of sub.nodes) expect(topIds.has(n.id)).toBe(false);
    const subNodeIds = new Set(sub.nodes.map((n) => n.id));
    for (const e of sub.edges) {
      expect(subNodeIds.has(e.source)).toBe(true);
      expect(subNodeIds.has(e.target)).toBe(true);
    }
  });
});
