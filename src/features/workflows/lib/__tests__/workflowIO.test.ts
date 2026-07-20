import { describe, expect, it } from 'vitest';
import type { OwsStoredWorkflow } from '@/store/useWorkflowStore';
import { exportWorkflow, parseWorkflowImport } from '../workflowIO';

const workflow: OwsStoredWorkflow = {
  id: 'orig-id',
  collectionId: 'col-a',
  document: {
    document: {
      dsl: '1.0.3',
      namespace: 'restura',
      name: 'my-flow',
      version: '1.0.0',
    },
    do: [{ seed: { set: { greeting: 'hello' } } }],
  },
  bindings: { version: 1, tasks: {} },
  layout: { version: 1, nodes: { '/do/0/seed': { x: 12, y: 34 } } },
  createdAt: 1,
  updatedAt: 2,
};

describe('workflowIO', () => {
  it('round-trips canonical OWS JSON, re-ids it, and rebinds the collection', () => {
    const json = exportWorkflow(workflow);
    const result = parseWorkflowImport(json, 'col-b');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workflow.id).not.toBe('orig-id');
    expect(result.workflow.collectionId).toBe('col-b');
    expect(result.workflow.document.document.name).toBe('my-flow');
    expect(result.workflow.bindings).toEqual({ version: 1, tasks: {} });
    expect(result.workflow.layout).toEqual({ version: 1, nodes: {} });
    expect(JSON.parse(json)).toEqual(workflow.document);
  });

  it('rejects legacy workflow envelopes and YAML at the JSON-only parser boundary', () => {
    expect(
      parseWorkflowImport(JSON.stringify({ format: 'restura-workflow', workflow: {} }), 'col-c')
    ).toEqual(expect.objectContaining({ ok: false }));
    expect(parseWorkflowImport('document:\n  dsl: 1.0.3', 'col-c')).toEqual(
      expect.objectContaining({ ok: false })
    );
  });

  it('imports native OWS YAML but persists the normalized JSON model', () => {
    const result = parseWorkflowImport(
      `
document:
  dsl: 1.0.3
  namespace: restura
  name: yaml-flow
  version: 1.0.0
do:
  - seed:
      set:
        source: yaml
`,
      'col-c'
    );

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        workflow: expect.objectContaining({
          document: expect.objectContaining({
            document: expect.objectContaining({ name: 'yaml-flow' }),
          }),
        }),
      })
    );
  });

  it('rejects a call without a strict task-path binding', () => {
    const result = parseWorkflowImport(
      JSON.stringify({
        ...workflow.document,
        do: [
          {
            request: {
              call: 'http',
              with: { method: 'GET', endpoint: { uri: 'restura://saved-request' } },
            },
          },
        ],
      }),
      'col-c'
    );

    expect(result).toEqual(expect.objectContaining({ ok: false }));
  });
});
