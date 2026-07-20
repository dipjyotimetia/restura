import { describe, expect, it } from 'vitest';
import {
  type OwsWorkflow,
  parseOwsWorkflowJson,
  serializeOwsWorkflowJson,
  validateOwsProfile,
} from '../workflow-profile';
import {
  buildOwsGraphWithSdk,
  normalizeOwsWorkflowWithSdk,
  parseOwsWorkflowImportWithSdk,
  parseOwsWorkflowJsonWithSdk,
  serializeOwsWorkflowJsonWithSdk,
} from '../workflow-sdk';

const supportedWorkflow = {
  document: {
    dsl: '1.0.3',
    namespace: 'restura',
    name: 'seed-and-fetch',
    version: '1.0.0',
  },
  do: [
    {
      seed: {
        set: { requestId: '${ .input.requestId }' },
      },
    },
    {
      pause: {
        wait: { milliseconds: 0 },
        timeout: { after: { seconds: 10 } },
      },
    },
  ],
};

describe('OWS workflow profile', () => {
  it.each([
    ['an unsupported DSL version', { document: { ...supportedWorkflow.document, dsl: 'bogus' } }],
    ['an empty workflow name', { document: { ...supportedWorkflow.document, name: '' } }],
    ['unknown document metadata', { document: { ...supportedWorkflow.document, unsafe: true } }],
    ['an empty task list', { do: [] }],
    ['an empty set assignment', { do: [{ seed: { set: {} } }] }],
    ['an empty wait duration', { do: [{ pause: { wait: {} } }] }],
  ])('rejects %s in the CSP-safe renderer profile before persistence or execution', (_name, change) => {
    expect(() => parseOwsWorkflowJson(JSON.stringify({ ...supportedWorkflow, ...change }))).toThrow(
      /OWS|Restura/
    );
  });

  it('serializes renderer-approved OWS JSON deterministically regardless of object insertion order', () => {
    const reordered = {
      do: supportedWorkflow.do,
      document: {
        version: '1.0.0',
        name: 'seed-and-fetch',
        namespace: 'restura',
        dsl: '1.0.3',
      },
    };

    expect(serializeOwsWorkflowJson(supportedWorkflow as unknown as OwsWorkflow)).toBe(
      serializeOwsWorkflowJson(reordered as unknown as OwsWorkflow)
    );
  });

  it('parses, normalizes, validates, serializes, and graphs a supported OWS JSON document', () => {
    const parsed = parseOwsWorkflowJsonWithSdk(JSON.stringify(supportedWorkflow));
    const normalized = normalizeOwsWorkflowWithSdk(parsed);

    expect(validateOwsProfile(normalized)).toEqual({ ok: true, issues: [] });
    expect(JSON.parse(serializeOwsWorkflowJsonWithSdk(normalized))).toEqual(normalized);

    const graph = buildOwsGraphWithSdk(normalized);
    expect(graph.entryNode).toBeDefined();
    expect(graph.nodes.map((node) => node.id)).toContain('/do/0/seed');
    expect(graph.nodes.map((node) => node.id)).toContain('/do/1/pause');
  });

  it('accepts only the binding-only HTTP sentinel form', () => {
    const workflow = {
      ...supportedWorkflow,
      do: [
        {
          request: {
            call: 'http',
            with: { method: 'GET', endpoint: { uri: 'restura://saved-request' } },
          },
        },
      ],
    };

    expect(validateOwsProfile(parseOwsWorkflowJsonWithSdk(JSON.stringify(workflow)))).toEqual({
      ok: true,
      issues: [],
    });
  });

  it.each([
    ['schedules', { ...supportedWorkflow, schedule: { cron: '0 * * * *' } }],
    [
      'inline secrets',
      {
        ...supportedWorkflow,
        use: { secrets: ['production-token'] },
      },
    ],
    [
      'unmanaged shell execution',
      {
        ...supportedWorkflow,
        do: [{ unsafe: { run: { shell: { command: 'curl https://example.test' } } } }],
      },
    ],
    [
      'inline HTTP endpoints',
      {
        ...supportedWorkflow,
        do: [
          {
            unsafe: {
              call: 'http',
              with: {
                method: 'GET',
                endpoint: { uri: 'https://example.test/users' },
              },
            },
          },
        ],
      },
    ],
    [
      'unimplemented controls',
      {
        ...supportedWorkflow,
        do: [{ branch: { fork: { branches: [{ child: { set: { value: 'safe' } } }] } } }],
      },
    ],
  ])('rejects %s even when the SDK can parse the document', (_name, workflow) => {
    const parsed = parseOwsWorkflowJsonWithSdk(JSON.stringify(workflow));

    expect(validateOwsProfile(parsed)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ severity: 'error' })]),
    });
  });

  it('rejects headers, query, body, and authentication even with the saved-request sentinel', () => {
    const workflow = {
      ...supportedWorkflow,
      do: [
        {
          unsafe: {
            call: 'http',
            with: {
              method: 'GET',
              endpoint: { uri: 'restura://saved-request' },
              headers: { authorization: 'Bearer plaintext-token' },
              query: { tenant: 'production' },
              body: { mode: 'json' },
              authentication: { scheme: 'bearer' },
            },
          },
        },
      ],
    };

    expect(() => parseOwsWorkflowJsonWithSdk(JSON.stringify(workflow))).toThrow(
      'Invalid OWS workflow'
    );
  });

  it('rejects documents that the SDK schema cannot validate during JSON parsing', () => {
    expect(() =>
      parseOwsWorkflowJsonWithSdk(
        JSON.stringify({
          ...supportedWorkflow,
          do: [{ incomplete: { call: 'http' } }],
        })
      )
    ).toThrow('Invalid OWS workflow');
  });

  it('rejects YAML and legacy Restura graph envelopes at the OWS-only import boundary', () => {
    expect(() => parseOwsWorkflowJsonWithSdk('document:\n  dsl: 1.0.3')).toThrow('JSON');
    expect(() =>
      parseOwsWorkflowJsonWithSdk(
        JSON.stringify({ format: 'restura-workflow', version: 1, workflow: supportedWorkflow })
      )
    ).toThrow('OWS workflow document');
  });

  it('accepts native OWS YAML only at the import boundary and normalizes it to the SDK model', () => {
    const imported = parseOwsWorkflowImportWithSdk(`
document:
  dsl: 1.0.3
  namespace: restura
  name: yaml-import
  version: 1.0.0
do:
  - seed:
      set:
        greeting: hello
`);

    expect(imported.document.name).toBe('yaml-import');
    expect(validateOwsProfile(imported)).toEqual({ ok: true, issues: [] });
  });

  it('rejects durations that platform timers would clamp or overflow', () => {
    const workflow = {
      ...supportedWorkflow,
      do: [{ delayed: { wait: { days: Number.MAX_VALUE } } }],
    };

    expect(validateOwsProfile(parseOwsWorkflowJsonWithSdk(JSON.stringify(workflow)))).toMatchObject(
      {
        ok: false,
        issues: expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining('maximum safe platform timer'),
          }),
        ]),
      }
    );
  });
});
