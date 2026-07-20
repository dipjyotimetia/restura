import Ajv from 'ajv';
import { describe, expect, it, vi } from 'vitest';
import { registerWorkflowEditorSchemas, workflowEditorModelPath } from '../workflowEditorMonaco';
import { RESTURA_BINDINGS_SCHEMA, RESTURA_OWS_SCHEMA } from '../workflowEditorSchemas';

const safeWorkflow = {
  document: {
    dsl: '1.0.3',
    namespace: 'restura',
    name: 'schema-safe',
    version: '1.0.0',
  },
  do: [
    {
      fetch: {
        call: 'http',
        with: { method: 'GET', endpoint: { uri: 'restura://saved-request' } },
      },
    },
  ],
};

describe('Restura workflow editor schemas', () => {
  it('accepts the Restura-safe OWS profile and rejects unsupported executable controls', () => {
    const validate = new Ajv({ strict: false }).compile(RESTURA_OWS_SCHEMA);

    expect(validate(safeWorkflow)).toBe(true);
    expect(
      validate({
        ...safeWorkflow,
        timeout: { after: { seconds: 1 } },
        output: { as: { result: '${.result}' } },
        do: [
          { guarded: { if: '${.enabled}', do: [{ setValue: { set: { value: true } } }] } },
          {
            eachValue: {
              for: { each: 'value', at: 'index', in: '${.values}' },
              do: [{ pause: { wait: { milliseconds: 1 } } }],
            },
          },
          {
            recover: {
              try: [{ attempt: { wait: { milliseconds: 1 } } }],
              catch: { as: 'error', do: [{ recovered: { set: { ok: true } } }] },
            },
          },
        ],
      })
    ).toBe(true);
    expect(
      validate({
        ...safeWorkflow,
        do: [{ unsafe: { fork: { branches: [] } } }],
      })
    ).toBe(false);
    expect(
      validate({ ...safeWorkflow, document: { ...safeWorkflow.document, version: 'version' } })
    ).toBe(false);
    expect(
      validate(
        JSON.parse(
          '{"document":{"dsl":"1.0.3","namespace":"restura","name":"schema-safe","version":"1.0.0"},"do":[{"unsafe":{"set":{"__proto__":"unsafe"}}}]}'
        )
      )
    ).toBe(false);
    expect(
      validate({ ...safeWorkflow, do: [{ 'fetch/request': safeWorkflow.do[0]!.fetch }] })
    ).toBe(false);
  });

  it('accepts typed saved-request bindings and rejects inline transport material', () => {
    const validate = new Ajv({ strict: false }).compile(RESTURA_BINDINGS_SCHEMA);

    expect(
      validate({
        version: 1,
        tasks: {
          '/do/0/fetch': { kind: 'saved-request', call: 'http', resourceId: 'Users/Get%20user' },
        },
      })
    ).toBe(true);
    expect(
      validate({
        version: 1,
        tasks: {
          '/do/0/fetch': {
            kind: 'saved-request',
            call: 'http',
            protocol: 'graphql',
            resourceId: 'Users/Find%20user',
          },
        },
      })
    ).toBe(true);
    expect(
      validate({
        version: 1,
        tasks: {
          '/do/0/fetch': {
            kind: 'saved-request',
            call: 'http',
            resourceId: 'Users/Get%20user',
            headers: { authorization: 'Bearer secret' },
          },
        },
      })
    ).toBe(false);
    expect(
      validate({
        version: 1,
        tasks: {
          '/do/0/fetch': { kind: 'saved-request', call: 'http', resourceId: ' ../secret ' },
        },
      })
    ).toBe(false);
  });

  it('registers both schemas only for stable internal workflow model URIs', () => {
    const setDiagnosticsOptions = vi.fn();
    const jsonDefaults = {
      diagnosticsOptions: { validate: true, schemas: [] },
      setDiagnosticsOptions,
    };

    registerWorkflowEditorSchemas(jsonDefaults);

    expect(workflowEditorModelPath('workflow id', 'workflow')).toBe(
      'inmemory://restura-workflows/workflow%20id/workflow.ows.json'
    );
    expect(workflowEditorModelPath('workflow id', 'bindings')).toBe(
      'inmemory://restura-workflows/workflow%20id/bindings.restura.json'
    );
    expect(setDiagnosticsOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        schemas: expect.arrayContaining([expect.any(Object), expect.any(Object)]),
      })
    );
    const options = setDiagnosticsOptions.mock.calls[0]?.[0];
    const schemas = options?.schemas ?? [];
    expect(schemas).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fileMatch: ['inmemory://restura-workflows/**/workflow.ows.json'],
          schema: RESTURA_OWS_SCHEMA,
        }),
        expect.objectContaining({
          fileMatch: ['inmemory://restura-workflows/**/bindings.restura.json'],
          schema: RESTURA_BINDINGS_SCHEMA,
        }),
      ])
    );
  });
});
