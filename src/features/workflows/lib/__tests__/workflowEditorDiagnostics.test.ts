import { describe, expect, it } from 'vitest';
import {
  getJsonPointerRange,
  getWorkflowBindingsDiagnostics,
  getWorkflowProfileDiagnostics,
} from '../workflowEditorDiagnostics';

const safeDocument = {
  document: {
    dsl: '1.0.3',
    namespace: 'restura',
    name: 'diagnostics',
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

describe('workflow editor diagnostics', () => {
  it('maps profile diagnostics to the exact JSON AST range', () => {
    const source = JSON.stringify({ ...safeDocument, schedule: { cron: '* * * * *' } }, null, 2);

    const range = getJsonPointerRange(source, '/schedule');
    const diagnostics = getWorkflowProfileDiagnostics(source);

    expect(range).not.toBeNull();
    expect(source.slice(range?.start ?? 0, range?.end)).toContain('cron');
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/schedule',
          message: expect.stringContaining('Schedules and event triggers'),
          range,
        }),
      ])
    );
  });

  it('reports malformed JSON without attempting profile validation', () => {
    expect(getWorkflowProfileDiagnostics('{"document":')).toEqual(
      expect.arrayContaining([expect.objectContaining({ category: 'syntax' })])
    );
  });

  it('maps task fields containing JSON-pointer characters to their exact AST range', () => {
    const source = JSON.stringify(
      {
        ...safeDocument,
        do: [{ pause: { wait: { milliseconds: 0 }, 'bad/name': true } }],
      },
      null,
      2
    );

    const range = getJsonPointerRange(source, '/do/0/pause/bad~1name');
    expect(getWorkflowProfileDiagnostics(source)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/do/0/pause/bad~1name',
          range,
          message: expect.stringContaining('task-level'),
        }),
      ])
    );
    expect(source.slice(range?.start ?? 0, range?.end)).toBe('true');
  });

  it('maps root properties containing JSON-pointer characters to their exact AST range', () => {
    const source = JSON.stringify({ ...safeDocument, 'bad/name': true }, null, 2);
    const range = getJsonPointerRange(source, '/bad~1name');

    expect(getWorkflowProfileDiagnostics(source)).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: '/bad~1name', range })])
    );
    expect(source.slice(range?.start ?? 0, range?.end)).toBe('true');
  });

  it('reports a valid JSON value that is not an OWS object without throwing', () => {
    expect(getWorkflowProfileDiagnostics('null')).toEqual([
      expect.objectContaining({ path: '/', message: expect.stringContaining('object') }),
    ]);
  });

  it('reports invalid, missing, and stale saved-request bindings at their binding paths', () => {
    const documentSource = JSON.stringify(safeDocument, null, 2);
    const bindingsSource = JSON.stringify(
      {
        version: 1,
        tasks: {
          '/do/0/fetch': { kind: 'saved-request', call: 'http', resourceId: ' bad ' },
        },
      },
      null,
      2
    );

    expect(getWorkflowBindingsDiagnostics(bindingsSource, documentSource)).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: '/tasks/~1do~10~1fetch' })])
    );

    expect(
      getWorkflowBindingsDiagnostics(
        JSON.stringify({
          version: 1,
          tasks: {
            '/do/0/fetch': { kind: 'saved-request', call: 'http', resourceId: 'request-1' },
            '/do/9/gone': { kind: 'saved-request', call: 'http', resourceId: 'request-1' },
          },
        }),
        documentSource
      )
    ).toEqual(expect.arrayContaining([expect.objectContaining({ path: '/tasks/~1do~19~1gone' })]));

    expect(
      getWorkflowBindingsDiagnostics(JSON.stringify({ version: 1, tasks: {} }), documentSource)
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining('missing an approved binding'),
          path: '/tasks',
        }),
      ])
    );
  });
});
