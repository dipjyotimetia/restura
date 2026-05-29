import { describe, it, expect } from 'vitest';
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
});
