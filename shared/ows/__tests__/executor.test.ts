import { describe, expect, it, vi } from 'vitest';
import type { OwsBindings } from '../bindings';
import { executeOwsWorkflow } from '../executor';
import type { OwsWorkflow } from '../workflow-profile';

const workflow: OwsWorkflow = {
  document: {
    dsl: '1.0.3',
    namespace: 'restura',
    name: 'native-flow',
    version: '1.0.0',
  },
  do: [{ seed: { set: { greeting: 'hello' } } }, { pause: { wait: { milliseconds: 0 } } }],
};

const bindings: OwsBindings = {
  version: 1,
  tasks: {},
};

const boundHttpWorkflow: OwsWorkflow = {
  ...workflow,
  do: [
    {
      request: {
        call: 'http',
        with: { method: 'GET', endpoint: { uri: 'restura://saved-request' } },
      },
    },
  ],
};

describe('OWS executor', () => {
  it('runs only safe set and wait tasks in OWS task-path order', async () => {
    const dispatcher = { dispatch: vi.fn() };

    const result = await executeOwsWorkflow({
      workflow,
      bindings,
      variables: { input: 'value' },
      dispatcher,
    });

    expect(dispatcher.dispatch).not.toHaveBeenCalled();
    expect(result.status).toBe('success');
    expect(result.variables).toMatchObject({ greeting: 'hello' });
    expect(result.steps.map((step) => step.taskPath)).toEqual(['/do/0/seed', '/do/1/pause']);
  });

  it('fails closed before dispatching an OWS call with inline transport configuration', async () => {
    const dispatcher = { dispatch: vi.fn() };
    const unsafeWorkflow = {
      ...workflow,
      do: [
        {
          request: {
            call: 'http',
            with: { method: 'GET', endpoint: { uri: 'https://example.test' } },
          },
        },
      ],
    } as OwsWorkflow;

    await expect(
      executeOwsWorkflow({ workflow: unsafeWorkflow, bindings, variables: {}, dispatcher })
    ).rejects.toThrow("outside Restura's executable profile");
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('dispatches a binding-only HTTP call without exposing endpoint or headers', async () => {
    const dispatcher = { dispatch: vi.fn().mockResolvedValue({ status: 200 }) };
    const result = await executeOwsWorkflow({
      workflow: boundHttpWorkflow,
      bindings: {
        version: 1,
        tasks: {
          '/do/0/request': { kind: 'saved-request', call: 'http', resourceId: 'request-1' },
        },
      },
      variables: {},
      dispatcher,
    });

    expect(dispatcher.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        taskPath: '/do/0/request',
        call: 'http',
        method: 'GET',
        binding: { kind: 'saved-request', call: 'http', resourceId: 'request-1' },
      })
    );
    expect(dispatcher.dispatch.mock.calls[0]?.[0]).not.toHaveProperty('endpoint');
    expect(dispatcher.dispatch.mock.calls[0]?.[0]).not.toHaveProperty('headers');
    expect(result).toMatchObject({ status: 'success', variables: { request: { status: 200 } } });
  });

  it('passes values created by earlier blocks as an immutable dispatch snapshot', async () => {
    const dispatcher = { dispatch: vi.fn().mockResolvedValue({ status: 200 }) };
    await executeOwsWorkflow({
      workflow: {
        ...boundHttpWorkflow,
        do: [
          { prepare: { set: { tenant: 'acme', attempt: 2 } } },
          {
            request: {
              call: 'http',
              with: { method: 'GET', endpoint: { uri: 'restura://saved-request' } },
            },
          },
        ],
      },
      bindings: {
        version: 1,
        tasks: {
          '/do/1/request': { kind: 'saved-request', call: 'http', resourceId: 'request-1' },
        },
      },
      variables: { input: 'initial' },
      dispatcher,
    });

    expect(dispatcher.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        variables: { input: 'initial', tenant: 'acme', attempt: 2 },
      })
    );
  });

  it('enforces task timeouts and reports them as failures', async () => {
    const result = await executeOwsWorkflow({
      workflow: {
        ...workflow,
        do: [{ slow: { wait: { milliseconds: 25 }, timeout: { after: { milliseconds: 1 } } } }],
      },
      bindings,
      variables: {},
      dispatcher: { dispatch: vi.fn() },
    });

    expect(result.status).toBe('failed');
    expect(result.steps).toMatchObject([
      { taskPath: '/do/0/slow', status: 'failed', error: 'OWS task timed out.' },
    ]);
  });

  it('enforces workflow timeouts and composes caller cancellation', async () => {
    const controller = new AbortController();
    const execution = executeOwsWorkflow({
      workflow: {
        ...workflow,
        timeout: { after: { milliseconds: 1 } },
        do: [{ slow: { wait: { milliseconds: 25 } } }],
      },
      bindings,
      variables: {},
      dispatcher: { dispatch: vi.fn() },
      signal: controller.signal,
    });

    const result = await execution;
    expect(result.status).toBe('failed');
    expect(result.steps).toMatchObject([
      { taskPath: '/do/0/slow', status: 'failed', error: 'OWS workflow timed out.' },
    ]);
  });

  it('reports caller cancellation as stopped rather than a timeout failure', async () => {
    const controller = new AbortController();
    const execution = executeOwsWorkflow({
      workflow: { ...workflow, do: [{ slow: { wait: { milliseconds: 25 } } }] },
      bindings,
      variables: {},
      dispatcher: { dispatch: vi.fn() },
      signal: controller.signal,
    });
    controller.abort();

    const result = await execution;
    expect(result.status).toBe('stopped');
    expect(result.steps).toMatchObject([
      { taskPath: '/do/0/slow', status: 'stopped', error: 'OWS workflow stopped.' },
    ]);
  });

  it('returns at a task deadline even if a dispatcher ignores AbortSignal', async () => {
    const result = await executeOwsWorkflow({
      workflow: {
        ...boundHttpWorkflow,
        do: [
          {
            request: {
              call: 'http',
              with: { method: 'GET', endpoint: { uri: 'restura://saved-request' } },
              timeout: { after: { milliseconds: 1 } },
            },
          },
        ],
      },
      bindings: {
        version: 1,
        tasks: {
          '/do/0/request': { kind: 'saved-request', call: 'http', resourceId: 'request-1' },
        },
      },
      variables: {},
      dispatcher: { dispatch: vi.fn(() => new Promise(() => undefined)) },
    });

    expect(result).toMatchObject({
      status: 'failed',
      steps: [{ taskPath: '/do/0/request', status: 'failed', error: 'OWS task timed out.' }],
    });
  });

  it('rejects stale bindings before executing any task', async () => {
    const dispatcher = { dispatch: vi.fn() };

    await expect(
      executeOwsWorkflow({
        workflow,
        bindings: {
          version: 1,
          tasks: {
            '/do/99/removed': { kind: 'saved-request', call: 'http', resourceId: 'request-1' },
          },
        },
        variables: {},
        dispatcher,
      })
    ).rejects.toThrow('OWS binding task path does not exist: /do/99/removed');
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('applies an explicit execution cap to set and wait controls', async () => {
    const result = await executeOwsWorkflow({
      workflow: { ...workflow, do: [{ slow: { wait: { milliseconds: 25 } } }] },
      bindings,
      variables: {},
      timeoutMs: 1,
      dispatcher: { dispatch: vi.fn() },
    });

    expect(result).toMatchObject({
      status: 'failed',
      steps: [{ taskPath: '/do/0/slow', error: 'OWS workflow timed out.' }],
    });
  });

  it('executes guarded sequences, bounded array loops, catch paths, and workflow output', async () => {
    const result = await executeOwsWorkflow({
      workflow: {
        ...workflow,
        output: { as: { last: '${.last}', recovered: '${.recovered}' } },
        do: [
          { skipped: { if: '${.enabled}', set: { shouldNotAppear: true } } },
          {
            each: {
              for: { each: 'item', at: 'index', in: '${.items}' },
              do: [{ save: { set: { last: '${.item}' } } }],
            },
          },
          {
            recover: {
              try: [
                {
                  call: {
                    call: 'http',
                    with: { method: 'GET', endpoint: { uri: 'restura://saved-request' } },
                  },
                },
              ],
              catch: { as: 'error', do: [{ fallback: { set: { recovered: true } } }] },
            },
          },
        ],
      },
      bindings: {
        version: 1,
        tasks: {
          '/do/2/recover/try/0/call': {
            kind: 'saved-request',
            call: 'http',
            resourceId: 'request-1',
          },
        },
      },
      variables: { enabled: false, items: ['first', 'last'] },
      dispatcher: { dispatch: vi.fn().mockRejectedValue(new Error('upstream failed')) },
    });

    expect(result.status).toBe('success');
    expect(result.variables).toMatchObject({ last: 'last', recovered: true });
    expect(result.variables).not.toHaveProperty('shouldNotAppear');
    expect(result.output).toEqual({ last: 'last', recovered: true });
    expect(result.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskPath: '/do/0/skipped', status: 'skipped' }),
        expect.objectContaining({ taskPath: '/do/2/recover', status: 'success' }),
      ])
    );
  });

  it('fails closed when a loop source is not an array or exceeds the iteration limit', async () => {
    const base = {
      ...workflow,
      do: [
        {
          each: {
            for: { each: 'item', in: '${.items}' },
            do: [{ save: { set: { last: '${.item}' } } }],
          },
        },
      ],
    } as OwsWorkflow;

    const nonArray = await executeOwsWorkflow({
      workflow: base,
      bindings,
      variables: { items: 'nope' },
      dispatcher: { dispatch: vi.fn() },
    });
    expect(nonArray).toMatchObject({ status: 'failed' });

    const oversized = await executeOwsWorkflow({
      workflow: base,
      bindings,
      variables: { items: Array.from({ length: 1001 }, (_, index) => index) },
      dispatcher: { dispatch: vi.fn() },
    });
    expect(oversized).toMatchObject({ status: 'failed' });
  });

  it('preserves pre-existing loop variables and runs nested do tasks', async () => {
    const result = await executeOwsWorkflow({
      workflow: {
        ...workflow,
        do: [
          {
            group: {
              do: [
                {
                  each: {
                    for: { each: 'item', in: '${.items}' },
                    do: [{ write: { set: { last: '${.item}' } } }],
                  },
                },
              ],
            },
          },
        ],
      },
      bindings,
      variables: { item: 'original', items: ['first', 'second'] },
      dispatcher: { dispatch: vi.fn() },
    });

    expect(result).toMatchObject({
      status: 'success',
      variables: { item: 'original', last: 'second' },
    });
  });

  it('reports unhandled dispatcher failures and validates a caller timeout cap', async () => {
    const failed = await executeOwsWorkflow({
      workflow: boundHttpWorkflow,
      bindings: {
        version: 1,
        tasks: {
          '/do/0/request': { kind: 'saved-request', call: 'http', resourceId: 'request-1' },
        },
      },
      variables: {},
      dispatcher: { dispatch: vi.fn().mockRejectedValue(new Error('upstream failed')) },
    });

    expect(failed.steps).toMatchObject([{ status: 'failed', error: 'upstream failed' }]);
    await expect(
      executeOwsWorkflow({
        workflow,
        bindings,
        variables: {},
        timeoutMs: 0,
        dispatcher: { dispatch: vi.fn() },
      })
    ).rejects.toThrow('timeout cap');
  });
});
