import type { OwsWorkflow } from '@shared/ows/workflow-profile';
import { describe, expect, it } from 'vitest';
import { deriveOwsFlowModel, serializeOwsFlowModel } from '../owsFlowMapper';

const document = {
  document: { dsl: '1.0.3', namespace: 'restura', name: 'canvas', version: '1.0.0' },
  timeout: { after: { seconds: 30 } },
  do: [
    { prepare: { set: { greeting: 'hello' } } },
    {
      grouped: {
        do: [
          { pause: { wait: { milliseconds: 5 } } },
          {
            fetch: {
              call: 'http',
              with: { method: 'GET', endpoint: { uri: 'restura://saved-request' } },
            },
          },
        ],
      },
    },
  ],
} as OwsWorkflow;

describe('OWS flow mapper', () => {
  it('derives safe blocks and serializes nested sequences with their bindings and layout', () => {
    const model = deriveOwsFlowModel(
      document,
      {
        version: 1,
        tasks: {
          '/do/1/grouped/do/1/fetch': {
            kind: 'saved-request',
            call: 'http',
            resourceId: 'Users/Get%20user',
          },
        },
      },
      { version: 1, nodes: { '/do/0/prepare': { x: 20, y: 40 } } }
    );

    expect(model.blocks.map((block) => block.kind)).toEqual(['set', 'do']);
    expect(model.timeout).toEqual({ after: { seconds: 30 } });
    expect(model.blocks[1]?.children?.map((block) => block.kind)).toEqual(['wait', 'call']);

    const artifact = serializeOwsFlowModel(model, document.document);
    expect(artifact.document).toEqual(document);
    expect(artifact.bindings.tasks).toEqual({
      '/do/1/grouped/do/1/fetch': {
        kind: 'saved-request',
        call: 'http',
        resourceId: 'Users/Get%20user',
      },
    });
    expect(artifact.layout.nodes['/do/0/prepare']).toEqual({ x: 20, y: 40 });
  });
});
