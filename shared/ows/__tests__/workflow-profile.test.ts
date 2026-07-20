import { describe, expect, it } from 'vitest';
import {
  buildOwsGraph,
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
    ['a prototype task name', { do: [JSON.parse('{"__proto__":{"wait":{"milliseconds":0}}}')] }],
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

  it('accepts guarded sequences, finite for loops, catch paths, and an output projection', () => {
    const workflow = {
      ...supportedWorkflow,
      output: { as: { ids: '${.result.ids}' } },
      do: [
        {
          guarded: {
            if: '${.input.active} && ${.input.count} > 0',
            do: [{ seed: { set: { greeting: 'hello' } } }],
          },
        },
        {
          eachItem: {
            for: { each: 'item', at: 'index', in: '${.input.items}' },
            do: [{ capture: { set: { last: '${.item}' } } }],
          },
        },
        {
          recover: {
            try: [{ attempted: { wait: { milliseconds: 0 } } }],
            catch: { as: 'error', do: [{ fallback: { set: { recovered: true } } }] },
          },
        },
      ],
    } as OwsWorkflow;

    expect(validateOwsProfile(workflow)).toEqual({ ok: true, issues: [] });
  });

  it.each([
    ['script-like condition', { if: 'process.exit(1)', do: [{ task: { set: { value: true } } }] }],
    ['unbounded loop', { for: { each: 'item', in: '${.items}' }, while: 'true', do: [] }],
    [
      'retry policy',
      { try: [{ task: { set: { value: true } } }], catch: { retry: { limit: { attempt: 2 } } } },
    ],
    [
      'missing loop item name',
      { for: { in: '${.items}' }, do: [{ task: { set: { value: true } } }] },
    ],
    [
      'prototype loop item name',
      { for: { each: '__proto__', in: '${.items}' }, do: [{ task: { set: { value: true } } }] },
    ],
    [
      'prototype catch variable',
      {
        try: [{ task: { set: { value: true } } }],
        catch: { as: 'constructor', do: [{ fallback: { set: { value: false } } }] },
      },
    ],
  ])('rejects %s from the safe profile', (_name, task) => {
    expect(
      validateOwsProfile({ ...supportedWorkflow, do: [{ control: task }] } as OwsWorkflow)
    ).toMatchObject({ ok: false });
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

  it.each([
    ['a non-object document', { document: null }],
    [
      'non-string optional document text',
      { document: { ...supportedWorkflow.document, title: 1 } },
    ],
    ['non-object document tags', { document: { ...supportedWorkflow.document, tags: [] } }],
    ['an invalid timeout shape', { timeout: { before: { seconds: 1 } } }],
    ['a negative duration', { do: [{ pause: { wait: { milliseconds: -1 } } }] }],
    ['an unknown duration field', { do: [{ pause: { wait: { weeks: 1 } } }] }],
    ['an invalid output projection', { output: { value: '${.input}' } }],
    ['a prototype-mutating set key', { do: [{ seed: { set: { constructor: 'unsafe' } } }] }],
    [
      'a binding call with an unsupported method',
      {
        do: [
          {
            request: {
              call: 'http',
              with: { method: 'TRACE', endpoint: { uri: 'restura://saved-request' } },
            },
          },
        ],
      },
    ],
    [
      'a binding call with an incomplete endpoint',
      { do: [{ request: { call: 'http', with: { method: 'GET', endpoint: {} } } }] },
    ],
    [
      'a loop with an unsupported iterator field',
      {
        do: [
          {
            each: {
              for: { each: 'item', in: '${.items}', parallel: 'yes' },
              do: [{ save: { set: { item: '${.item}' } } }],
            },
          },
        ],
      },
    ],
    [
      'a catch block that is not an object',
      { do: [{ guarded: { try: [{ seed: { set: { ok: true } } }], catch: 'nope' } }] },
    ],
  ])('rejects %s without accepting it as executable workflow data', (_name, change) => {
    expect(validateOwsProfile({ ...supportedWorkflow, ...change } as OwsWorkflow)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ severity: 'error' })]),
    });
  });

  it('projects nested do, try, and catch tasks without adding visual nodes to workflow data', () => {
    const workflow = {
      ...supportedWorkflow,
      do: [
        {
          sequence: {
            do: [
              {
                recover: {
                  try: [{ attempt: { wait: { milliseconds: 0 } } }],
                  catch: { do: [{ fallback: { set: { recovered: true } } }] },
                },
              },
            ],
          },
        },
      ],
    } as OwsWorkflow;

    expect(buildOwsGraph(workflow).nodes.map((node) => node.id)).toEqual([
      '/do/0/sequence',
      '/do/0/sequence/do/0/recover',
      '/do/0/sequence/do/0/recover/try/0/attempt',
      '/do/0/sequence/do/0/recover/catch/do/0/fallback',
    ]);
  });
});
