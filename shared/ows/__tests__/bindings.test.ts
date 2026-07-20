import { describe, expect, it } from 'vitest';
import { isOwsBindings, isOwsTaskBinding, validateOwsArtifactBindings } from '../bindings';
import type { OwsWorkflow } from '../workflow-profile';

describe('OWS bindings', () => {
  it('accepts an exact resource reference binding', () => {
    expect(isOwsTaskBinding({ kind: 'saved-request', call: 'http', resourceId: 'request-1' })).toBe(
      true
    );
    expect(
      isOwsBindings({
        version: 1,
        tasks: {
          '/do/0/request': { kind: 'saved-request', call: 'http', resourceId: 'request-1' },
        },
      })
    ).toBe(true);
  });

  it('accepts a GraphQL saved-request binding without transport configuration', () => {
    expect(
      isOwsTaskBinding({
        kind: 'saved-request',
        call: 'http',
        protocol: 'graphql',
        resourceId: 'Users/Find%20user',
      })
    ).toBe(true);
  });

  it.each([
    [
      'environment variables',
      { version: 1, tasks: {}, environment: { TOKEN: 'plaintext-secret' } },
    ],
    [
      'inline credentials on a task binding',
      {
        version: 1,
        tasks: {
          '/do/0/request': {
            kind: 'saved-request',
            call: 'http',
            resourceId: 'request-1',
            headers: { authorization: 'Bearer plaintext-secret' },
          },
        },
      },
    ],
    ['extra root fields', { version: 1, tasks: {}, credentials: 'plaintext-secret' }],
    [
      'non-reference resource identifiers',
      { kind: 'saved-request', call: 'http', resourceId: 'Bearer plaintext-secret' },
    ],
    [
      'a binding whose declared call does not match its resource kind',
      { kind: 'saved-request', call: 'mcp', resourceId: 'request-1' },
    ],
    [
      'an unsupported bound protocol',
      { kind: 'saved-request', call: 'http', protocol: 'grpc', resourceId: 'request-1' },
    ],
  ])('rejects %s', (_name, value) => {
    if ('kind' in value) {
      expect(isOwsTaskBinding(value)).toBe(false);
    } else {
      expect(isOwsBindings(value)).toBe(false);
    }
  });

  it.each([
    ['a primitive', 'saved-request'],
    ['an array', []],
    ['a prototype-bearing object', Object.create({ kind: 'saved-request' })],
    [
      'a path traversal reference',
      { kind: 'saved-request', call: 'http', resourceId: 'Users/../token' },
    ],
    [
      'a reference with surrounding whitespace',
      { kind: 'saved-request', call: 'http', resourceId: ' request-1 ' },
    ],
    [
      'a reference with an unsupported character',
      { kind: 'saved-request', call: 'http', resourceId: 'request?token' },
    ],
    [
      'a GraphQL binding with the wrong protocol discriminator',
      { kind: 'saved-request', call: 'http', protocol: 'HTTP', resourceId: 'request-1' },
    ],
  ])('fails closed for malformed task bindings such as %s', (_name, value) => {
    expect(isOwsTaskBinding(value)).toBe(false);
  });

  it.each([
    ['an invalid version', { version: 2, tasks: {} }],
    ['an array of tasks', { version: 1, tasks: [] }],
    [
      'an invalid task path',
      {
        version: 1,
        tasks: { '/do/request': { kind: 'saved-request', call: 'http', resourceId: 'request-1' } },
      },
    ],
    [
      'a task path with an extra segment',
      {
        version: 1,
        tasks: {
          '/do/0/request/extra': { kind: 'saved-request', call: 'http', resourceId: 'request-1' },
        },
      },
    ],
  ])('rejects malformed bindings documents with %s', (_name, value) => {
    expect(isOwsBindings(value)).toBe(false);
  });

  it('rejects bindings for an existing task that is not an executable saved-request call', () => {
    const workflow: OwsWorkflow = {
      document: { dsl: '1.0.3', namespace: 'restura', name: 'bindings', version: '1.0.0' },
      do: [{ pause: { wait: { milliseconds: 0 } } }],
    };

    expect(
      validateOwsArtifactBindings(workflow, {
        version: 1,
        tasks: {
          '/do/0/pause': { kind: 'saved-request', call: 'http', resourceId: 'request-1' },
        },
      })
    ).toMatchObject({ ok: false, issues: [{ path: '/tasks/~1do~10~1pause' }] });
  });

  it('requires bindings for saved-request calls nested under supported controls', () => {
    const workflow: OwsWorkflow = {
      document: { dsl: '1.0.3', namespace: 'restura', name: 'nested-bindings', version: '1.0.0' },
      do: [
        {
          sequence: {
            do: [
              {
                each: {
                  for: { each: 'item', in: '${.items}' },
                  do: [
                    {
                      request: {
                        call: 'http',
                        with: {
                          method: 'GET',
                          endpoint: { uri: 'restura://saved-request' },
                        },
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
    };
    const path = '/do/0/sequence/do/0/each/do/0/request';
    const binding = { kind: 'saved-request', call: 'http', resourceId: 'request-1' } as const;

    expect(validateOwsArtifactBindings(workflow, { version: 1, tasks: {} })).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ path: '/tasks' })],
    });
    expect(
      validateOwsArtifactBindings(workflow, { version: 1, tasks: { [path]: binding } })
    ).toEqual({ ok: true, issues: [] });
  });
});
