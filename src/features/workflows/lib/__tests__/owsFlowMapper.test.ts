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

  it('round-trips guarded, loop, catch, GraphQL, and output workflow constructs', () => {
    const advanced = {
      document: { dsl: '1.0.3', namespace: 'restura', name: 'advanced', version: '1.0.0' },
      output: { as: { last: '${.last}' } },
      do: [
        { guarded: { if: '${.enabled}', do: [{ value: { set: { value: true } } }] } },
        {
          each: {
            for: { each: 'item', in: '${.items}', at: 'index' },
            do: [{ save: { set: { last: '${.item}' } } }],
          },
        },
        {
          recover: {
            try: [{ wait: { wait: { milliseconds: 0 } } }],
            catch: { as: 'error', do: [{ fallback: { set: { recovered: true } } }] },
          },
        },
        {
          graphql: {
            call: 'http',
            with: { method: 'POST', endpoint: { uri: 'restura://saved-request' } },
          },
        },
      ],
    } as OwsWorkflow;
    const bindings = {
      version: 1 as const,
      tasks: {
        '/do/3/graphql': {
          kind: 'saved-request' as const,
          call: 'http' as const,
          protocol: 'graphql' as const,
          resourceId: 'GraphQL%20request',
        },
      },
    };

    const model = deriveOwsFlowModel(advanced, bindings, { version: 1, nodes: {} });
    expect(model.blocks.map((block) => block.kind)).toEqual(['do', 'for', 'try', 'call']);
    expect(model.blocks[0]?.condition).toBe('${.enabled}');
    expect(model.blocks[2]?.catchAs).toBe('error');
    expect(model.output).toEqual({ as: { last: '${.last}' } });

    expect(serializeOwsFlowModel(model, advanced.document)).toMatchObject({
      document: advanced,
      bindings,
    });
  });

  it('uses safe visual defaults for unpositioned blocks and preserves viewport metadata', () => {
    const model = deriveOwsFlowModel(
      {
        document: { dsl: '1.0.3', namespace: 'restura', name: 'defaults', version: '1.0.0' },
        do: [
          { malformed: 'ignored' },
          { group: { do: 'not-a-list' } },
          { pause: { wait: { seconds: 1 } } },
        ],
      } as OwsWorkflow,
      { version: 1, tasks: {} },
      { version: 1, nodes: {}, viewport: { x: 10, y: 20, zoom: 1.5 } }
    );

    expect(model.blocks).toEqual([
      expect.objectContaining({ id: '/do/1/group', kind: 'do', position: { x: 260, y: 240 } }),
      expect.objectContaining({ id: '/do/2/pause', kind: 'wait', position: { x: 260, y: 380 } }),
    ]);
    expect(model.viewport).toEqual({ x: 10, y: 20, zoom: 1.5 });
  });

  it('requires a bound saved request when serializing a call block', () => {
    expect(() =>
      serializeOwsFlowModel(
        {
          blocks: [
            { id: 'draft', name: 'request', kind: 'call', position: { x: 0, y: 0 }, method: 'GET' },
          ],
        },
        document.document
      )
    ).toThrow("Saved HTTP block 'request' needs a bound request.");
  });
});
