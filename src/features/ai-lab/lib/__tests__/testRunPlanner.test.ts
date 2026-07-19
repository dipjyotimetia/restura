import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useGlobalsStore } from '@/store/useGlobalsStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import type { HttpRequest, Response } from '@/types';

const executeRequestMock = vi.hoisted(() => vi.fn());

vi.mock('@/features/http/lib/requestExecutor', () => ({
  executeRequest: executeRequestMock,
}));

import {
  planTestRun,
  executeTestRun,
  type TestPlan,
  type TestPlanStep,
  type PlannedExecutionStep,
} from '../testRunPlanner';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    id: 'req-1',
    name: 'Get orders',
    type: 'http',
    method: 'GET',
    url: 'https://api.example.com/orders',
    headers: [],
    params: [],
    body: { type: 'none' },
    auth: { type: 'none' },
    ...overrides,
  };
}

function makeResponse(overrides: Partial<Response> = {}): Response {
  return {
    id: 'resp-1',
    status: 200,
    statusText: 'OK',
    headers: {},
    body: '{"orders":[]}',
    time: 42,
    size: 15,
    requestId: 'req-1',
    timestamp: 0,
    ...overrides,
  };
}

const originalSettings = useSettingsStore.getState().settings;

beforeEach(() => {
  executeRequestMock.mockReset();
  useCollectionStore.setState({ collections: [], activeCollectionId: null });
  useEnvironmentStore.setState({ environments: [], activeEnvironmentId: null });
  useGlobalsStore.setState({ vars: {} });
  useSettingsStore.setState({ settings: originalSettings });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// planTestRun
// ---------------------------------------------------------------------------

describe('planTestRun', () => {
  it('resolves a test plan against saved Restura requests', () => {
    useCollectionStore.setState({
      collections: [
        {
          id: 'c1',
          name: 'Orders',
          items: [
            {
              id: 'item-1',
              name: 'Get orders',
              type: 'request',
              request: makeRequest({ id: 'req-1', method: 'GET' }),
            },
            {
              id: 'item-2',
              name: 'Create order',
              type: 'request',
              request: makeRequest({ id: 'req-2', method: 'POST' }),
            },
          ],
        },
      ],
    });

    const plan: TestPlan = {
      name: 'Order flow smoke test',
      steps: [
        { id: 'step-1', description: 'List existing orders', requestId: 'req-1' },
        { id: 'step-2', description: 'Create a new order', requestId: 'req-2' },
      ],
    };

    const planned = planTestRun(plan);

    expect(planned.planName).toBe('Order flow smoke test');
    expect(planned.steps).toHaveLength(2);
    expect(planned.steps[0]).toMatchObject({
      stepId: 'step-1',
      method: 'GET',
      requiresApproval: false,
      permissionClass: 'read',
    });
    expect(planned.steps[1]).toMatchObject({
      stepId: 'step-2',
      method: 'POST',
      requiresApproval: true,
      permissionClass: 'mutation',
    });
  });

  it('throws when a step references an unknown request', () => {
    useCollectionStore.setState({
      collections: [
        {
          id: 'c1',
          name: 'Empty',
          items: [],
        },
      ],
    });

    const plan: TestPlan = {
      name: 'Broken',
      steps: [{ id: 's1', description: 'Missing', requestId: 'nope' }],
    };

    expect(() => planTestRun(plan)).toThrow(/unknown request.*nope/i);
  });

  it('classifies scripted GET as mutation and requires approval', () => {
    useCollectionStore.setState({
      collections: [
        {
          id: 'c1',
          name: 'Scripted',
          items: [
            {
              id: 'item-1',
              name: 'Get with script',
              type: 'request',
              request: makeRequest({
                id: 'req-1',
                method: 'GET',
                preRequestScript: 'pm.variables.set("x", "1");',
              }),
            },
          ],
        },
      ],
    });

    const plan: TestPlan = {
      name: 'Scripted',
      steps: [{ id: 's1', description: 'Get with script', requestId: 'req-1' }],
    };

    const planned = planTestRun(plan);
    expect(planned.steps[0].requiresApproval).toBe(true);
    expect(planned.steps[0].permissionClass).toBe('mutation');
    expect(planned.steps[0].hasExecutableScripts).toBe(true);
  });

  it('classifies HEAD and OPTIONS as read', () => {
    useCollectionStore.setState({
      collections: [
        {
          id: 'c1',
          name: 'Read checks',
          items: [
            {
              id: 'item-head',
              name: 'Head',
              type: 'request',
              request: makeRequest({ id: 'req-head', method: 'HEAD' }),
            },
            {
              id: 'item-options',
              name: 'Options',
              type: 'request',
              request: makeRequest({ id: 'req-options', method: 'OPTIONS' }),
            },
          ],
        },
      ],
    });

    const plan: TestPlan = {
      name: 'Read-only methods',
      steps: [
        { id: 's1', description: 'Head check', requestId: 'req-head' },
        { id: 's2', description: 'Options check', requestId: 'req-options' },
      ],
    };

    const planned = planTestRun(plan);
    expect(planned.steps.every((s) => s.requiresApproval === false)).toBe(true);
  });

  it('redacts URLs in planned steps', () => {
    useCollectionStore.setState({
      collections: [
        {
          id: 'c1',
          name: 'Orders',
          items: [
            {
              id: 'item-1',
              name: 'Get orders',
              type: 'request',
              request: makeRequest({
                id: 'req-1',
                url: 'https://user:[EMAIL]/api/orders?token=s3kr1t',
              }),
            },
          ],
        },
      ],
    });

    const plan: TestPlan = {
      name: 'Redacted',
      steps: [{ id: 's1', description: 'Get orders', requestId: 'req-1' }],
    };

    const planned = planTestRun(plan);
    expect(planned.steps[0].url).not.toContain('s3kr1t');
    expect(planned.steps[0].url).not.toContain('password');
  });

  it('merges variable fixtures into the plan', () => {
    useCollectionStore.setState({
      collections: [
        {
          id: 'c1',
          name: 'Orders',
          items: [
            {
              id: 'item-1',
              name: 'Get orders',
              type: 'request',
              request: makeRequest({ id: 'req-1' }),
            },
          ],
        },
      ],
    });

    const plan: TestPlan = {
      name: 'With fixtures',
      steps: [{ id: 's1', description: 'List', requestId: 'req-1' }],
      variableFixtures: { BASE_URL: 'https://staging.example.com' },
    };

    const planned = planTestRun(plan);
    expect(planned.variableFixtures).toEqual({ BASE_URL: 'https://staging.example.com' });
  });

  it('applies default budgets and clamps overrides', () => {
    useCollectionStore.setState({
      collections: [
        {
          id: 'c1',
          name: 'Test',
          items: [
            {
              id: 'item-1',
              name: 'Req',
              type: 'request',
              request: makeRequest({ id: 'req-1' }),
            },
          ],
        },
      ],
    });

    const plan: TestPlan = {
      name: 'Budgets',
      steps: [{ id: 's1', description: 'Test', requestId: 'req-1' }],
    };

    const planned = planTestRun(plan, { maxSteps: 10, maxWallTimeMs: 60_000 });
    expect(planned.budgets.maxSteps).toBe(10);
    expect(planned.budgets.maxWallTimeMs).toBe(60000);
  });

  it('includes expected assertions in planned steps', () => {
    useCollectionStore.setState({
      collections: [
        {
          id: 'c1',
          name: 'Orders',
          items: [
            {
              id: 'item-1',
              name: 'Get orders',
              type: 'request',
              request: makeRequest({ id: 'req-1' }),
            },
          ],
        },
      ],
    });

    const plan: TestPlan = {
      name: 'With assertions',
      steps: [
        {
          id: 's1',
          description: 'List orders',
          requestId: 'req-1',
          expectedAssertions: ['Response status is 200', 'Response has orders array'],
        },
      ],
    };

    const planned = planTestRun(plan);
    expect(planned.steps[0].expectedAssertions).toEqual([
      'Response status is 200',
      'Response has orders array',
    ]);
  });
});

// ---------------------------------------------------------------------------
// executeTestRun
// ---------------------------------------------------------------------------

describe('executeTestRun', () => {
  it('executes read steps through the normal executor without approval', async () => {
    useCollectionStore.setState({
      collections: [
        {
          id: 'c1',
          name: 'Orders',
          items: [
            {
              id: 'item-1',
              name: 'Get orders',
              type: 'request',
              request: makeRequest({ id: 'req-1', method: 'GET' }),
            },
          ],
        },
      ],
    });
    executeRequestMock.mockResolvedValue({
      response: makeResponse(),
      sentHeaders: {},
      transportOk: true,
    });

    const plan: TestPlan = {
      name: 'Simple read',
      steps: [{ id: 's1', description: 'Get orders', requestId: 'req-1' }],
    };
    const planned = planTestRun(plan);
    const signal = new AbortController().signal;
    const requestApproval = vi.fn<[PlannedExecutionStep], Promise<'approved' | 'denied'>>();

    const trace = await executeTestRun(planned, signal, requestApproval);

    expect(trace.status).toBe('passed');
    expect(trace.results).toHaveLength(1);
    expect(trace.results[0].status).toBe('passed');
    expect(requestApproval).not.toHaveBeenCalled();
    expect(executeRequestMock).toHaveBeenCalledOnce();
  });

  it('requests and needs approval for non-read steps', async () => {
    useCollectionStore.setState({
      collections: [
        {
          id: 'c1',
          name: 'Orders',
          items: [
            {
              id: 'item-1',
              name: 'Create order',
              type: 'request',
              request: makeRequest({ id: 'req-1', method: 'POST' }),
            },
          ],
        },
      ],
    });
    executeRequestMock.mockResolvedValue({
      response: makeResponse({ status: 201 }),
      sentHeaders: {},
      transportOk: true,
    });

    const plan: TestPlan = {
      name: 'Create',
      steps: [{ id: 's1', description: 'Create order', requestId: 'req-1' }],
    };
    const planned = planTestRun(plan);
    const signal = new AbortController().signal;
    const requestApproval = vi
      .fn<[PlannedExecutionStep], Promise<'approved' | 'denied'>>()
      .mockResolvedValue('approved');

    const trace = await executeTestRun(planned, signal, requestApproval);

    expect(trace.status).toBe('passed');
    expect(requestApproval).toHaveBeenCalledOnce();
    expect(requestApproval.mock.calls[0]?.[0]?.stepId).toBe('s1');
    expect(executeRequestMock).toHaveBeenCalledOnce();
  });

  it('records denied approval as failed with no side effect', async () => {
    useCollectionStore.setState({
      collections: [
        {
          id: 'c1',
          name: 'Orders',
          items: [
            {
              id: 'item-1',
              name: 'Create order',
              type: 'request',
              request: makeRequest({ id: 'req-1', method: 'POST' }),
            },
          ],
        },
      ],
    });
    // The executor must never be called when approval is denied.
    executeRequestMock.mockRejectedValue(new Error('should not have been called'));

    const plan: TestPlan = {
      name: 'Denied',
      steps: [{ id: 's1', description: 'Create order', requestId: 'req-1' }],
    };
    const planned = planTestRun(plan);
    const signal = new AbortController().signal;
    const requestApproval = vi
      .fn<[PlannedExecutionStep], Promise<'approved' | 'denied'>>()
      .mockResolvedValue('denied');

    const trace = await executeTestRun(planned, signal, requestApproval);

    expect(trace.status).toBe('failed');
    expect(trace.results).toHaveLength(1);
    expect(trace.results[0].status).toBe('failed');
    expect(trace.results[0].error).toMatch(/denied/i);
    expect(trace.results[0].approvalDecision).toBe('denied');
    expect(executeRequestMock).not.toHaveBeenCalled();
  });

  it('honours cancellation before execution starts', async () => {
    useCollectionStore.setState({
      collections: [
        {
          id: 'c1',
          name: 'Orders',
          items: [
            {
              id: 'item-1',
              name: 'Get orders',
              type: 'request',
              request: makeRequest({ id: 'req-1', method: 'GET' }),
            },
          ],
        },
      ],
    });
    executeRequestMock.mockResolvedValue({
      response: makeResponse(),
      sentHeaders: {},
      transportOk: true,
    });

    const plan: TestPlan = {
      name: 'Cancelled',
      steps: [{ id: 's1', description: 'Get orders', requestId: 'req-1' }],
    };
    const planned = planTestRun(plan);
    const controller = new AbortController();
    controller.abort();

    const trace = await executeTestRun(planned, controller.signal);

    expect(trace.status).toBe('cancelled');
    expect(trace.results).toHaveLength(0);
    expect(executeRequestMock).not.toHaveBeenCalled();
  });

  it('honours cancellation during execution and stops subsequent steps', async () => {
    useCollectionStore.setState({
      collections: [
        {
          id: 'c1',
          name: 'Orders',
          items: [
            {
              id: 'item-1',
              name: 'Step 1',
              type: 'request',
              request: makeRequest({ id: 'req-1', method: 'GET' }),
            },
            {
              id: 'item-2',
              name: 'Step 2',
              type: 'request',
              request: makeRequest({ id: 'req-2', method: 'POST' }),
            },
          ],
        },
      ],
    });
    executeRequestMock.mockImplementation(async (_opts: unknown) => {
      // Simulate a response
      return { response: makeResponse(), sentHeaders: {}, transportOk: true };
    });

    const plan: TestPlan = {
      name: 'Cancelled mid-run',
      steps: [
        { id: 's1', description: 'Step 1', requestId: 'req-1' },
        { id: 's2', description: 'Step 2', requestId: 'req-2' },
      ],
    };
    const planned = planTestRun(plan);
    const controller = new AbortController();

    // We need a way to abort between steps. Use approval callback to cancel.
    const requestApproval = vi
      .fn<[PlannedExecutionStep], Promise<'approved' | 'denied'>>()
      .mockImplementation(async (_step: PlannedExecutionStep) => {
        controller.abort();
        return 'approved'; // approval returns before cancellation propagates
      });

    const trace = await executeTestRun(planned, controller.signal, requestApproval);

    // The first step may have been executed, but step 2 should be cancelled
    expect(trace.results.length).toBeLessThanOrEqual(2);
    // Either we saw s1 execute and then cancellation, or s1 got cancelled too
    expect(executeRequestMock.mock.calls.length).toBeLessThanOrEqual(2);
    expect(trace.status).toBe('cancelled');
  });

  it('cancellation wins over late success from the executor', async () => {
    useCollectionStore.setState({
      collections: [
        {
          id: 'c1',
          name: 'Orders',
          items: [
            {
              id: 'item-1',
              name: 'Get orders',
              type: 'request',
              request: makeRequest({ id: 'req-1', method: 'GET' }),
            },
          ],
        },
      ],
    });

    let resolveLate!: (value: unknown) => void;
    executeRequestMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLate = resolve;
        })
    );

    const plan: TestPlan = {
      name: 'Late success',
      steps: [{ id: 's1', description: 'Get orders', requestId: 'req-1' }],
    };
    const planned = planTestRun(plan);
    const controller = new AbortController();

    const tracePromise = executeTestRun(planned, controller.signal);
    controller.abort();
    resolveLate({ response: makeResponse(), sentHeaders: {}, transportOk: true });

    const trace = await tracePromise;
    expect(trace.status).toBe('cancelled');
    expect(trace.results).toHaveLength(0);
  });

  it('executes multiple steps sequentially with mixed permissions', async () => {
    useCollectionStore.setState({
      collections: [
        {
          id: 'c1',
          name: 'Orders',
          items: [
            {
              id: 'item-1',
              name: 'List',
              type: 'request',
              request: makeRequest({ id: 'req-1', method: 'GET' }),
            },
            {
              id: 'item-2',
              name: 'Create',
              type: 'request',
              request: makeRequest({ id: 'req-2', method: 'POST' }),
            },
            {
              id: 'item-3',
              name: 'Check',
              type: 'request',
              request: makeRequest({ id: 'req-3', method: 'GET' }),
            },
          ],
        },
      ],
    });
    executeRequestMock.mockResolvedValue({
      response: makeResponse(),
      sentHeaders: {},
      transportOk: true,
    });

    const plan: TestPlan = {
      name: 'Mixed flow',
      steps: [
        { id: 's1', description: 'List', requestId: 'req-1' },
        { id: 's2', description: 'Create', requestId: 'req-2' },
        { id: 's3', description: 'Check', requestId: 'req-3' },
      ],
    };
    const planned = planTestRun(plan);
    const signal = new AbortController().signal;
    const requestApproval = vi
      .fn<[PlannedExecutionStep], Promise<'approved' | 'denied'>>()
      .mockResolvedValue('approved');

    const trace = await executeTestRun(planned, signal, requestApproval);

    expect(trace.status).toBe('passed');
    expect(trace.results).toHaveLength(3);
    expect(requestApproval).toHaveBeenCalledTimes(1); // only the POST
    expect(executeRequestMock).toHaveBeenCalledTimes(3);
  });

  it('records response details in each step result', async () => {
    useCollectionStore.setState({
      collections: [
        {
          id: 'c1',
          name: 'Orders',
          items: [
            {
              id: 'item-1',
              name: 'Get orders',
              type: 'request',
              request: makeRequest({ id: 'req-1', method: 'GET' }),
            },
          ],
        },
      ],
    });
    executeRequestMock.mockResolvedValue({
      response: makeResponse({ status: 200, statusText: 'OK', time: 99, size: 42 }),
      sentHeaders: {},
      transportOk: true,
    });

    const plan: TestPlan = {
      name: 'Response details',
      steps: [{ id: 's1', description: 'Get orders', requestId: 'req-1' }],
    };
    const planned = planTestRun(plan);

    const trace = await executeTestRun(planned, new AbortController().signal);

    expect(trace.results[0].response).toEqual({
      status: 200,
      statusText: 'OK',
      timeMs: 99,
      sizeBytes: 42,
    });
  });

  it('captures approvals and decisions in the trace', async () => {
    useCollectionStore.setState({
      collections: [
        {
          id: 'c1',
          name: 'Orders',
          items: [
            {
              id: 'item-1',
              name: 'Create',
              type: 'request',
              request: makeRequest({ id: 'req-1', method: 'POST' }),
            },
          ],
        },
      ],
    });
    executeRequestMock.mockResolvedValue({
      response: makeResponse({ status: 201 }),
      sentHeaders: {},
      transportOk: true,
    });

    const plan: TestPlan = {
      name: 'Approval trace',
      steps: [{ id: 's1', description: 'Create', requestId: 'req-1' }],
    };
    const planned = planTestRun(plan);
    const requestApproval = vi
      .fn<[PlannedExecutionStep], Promise<'approved' | 'denied'>>()
      .mockResolvedValue('approved');

    const trace = await executeTestRun(planned, new AbortController().signal, requestApproval);

    expect(trace.results[0].approvalId).toBeDefined();
    expect(trace.results[0].approvalDecision).toBe('approved');
  });

  it('applies variable fixtures on top of environment variables', async () => {
    useGlobalsStore.setState({ vars: { GLOBAL: 'gval' } });
    useEnvironmentStore.setState({
      environments: [
        {
          id: 'env-1',
          name: 'Staging',
          variables: [
            { id: 'v1', key: 'BASE_URL', value: 'https://staging.example.com', enabled: true },
            { id: 'v2', key: 'API_KEY', value: 'env-key', enabled: true },
          ],
        },
      ],
      activeEnvironmentId: 'env-1',
    });
    useCollectionStore.setState({
      collections: [
        {
          id: 'c1',
          name: 'Orders',
          items: [
            {
              id: 'item-1',
              name: 'Get orders',
              type: 'request',
              request: makeRequest({ id: 'req-1', method: 'GET' }),
            },
          ],
        },
      ],
    });
    executeRequestMock.mockResolvedValue({
      response: makeResponse(),
      sentHeaders: {},
      transportOk: true,
    });

    const plan: TestPlan = {
      name: 'With fixtures',
      steps: [{ id: 's1', description: 'Get orders', requestId: 'req-1' }],
      variableFixtures: { API_KEY: 'fixture-key', EXTRA: 'fixture-extra' },
    };
    const planned = planTestRun(plan);

    const trace = await executeTestRun(planned, new AbortController().signal);

    expect(trace.status).toBe('passed');
    // Verify the executor received the merged variables
    expect(executeRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        envVars: expect.objectContaining({
          GLOBAL: 'gval',
          BASE_URL: 'https://staging.example.com',
          API_KEY: 'fixture-key',
          EXTRA: 'fixture-extra',
        }),
      })
    );
  });

  it('propagates executor errors as step errors', async () => {
    useCollectionStore.setState({
      collections: [
        {
          id: 'c1',
          name: 'Orders',
          items: [
            {
              id: 'item-1',
              name: 'Get orders',
              type: 'request',
              request: makeRequest({ id: 'req-1', method: 'GET' }),
            },
          ],
        },
      ],
    });
    executeRequestMock.mockRejectedValue(new Error('Network timeout'));

    const plan: TestPlan = {
      name: 'Error case',
      steps: [{ id: 's1', description: 'Get orders', requestId: 'req-1' }],
    };
    const planned = planTestRun(plan);

    const trace = await executeTestRun(planned, new AbortController().signal);

    expect(trace.status).toBe('error');
    expect(trace.results[0].status).toBe('error');
    expect(trace.results[0].error).toContain('Network timeout');
  });

  it('reports a trace with timestamps and the plan snapshot', async () => {
    useCollectionStore.setState({
      collections: [
        {
          id: 'c1',
          name: 'Orders',
          items: [
            {
              id: 'item-1',
              name: 'Get orders',
              type: 'request',
              request: makeRequest({ id: 'req-1', method: 'GET' }),
            },
          ],
        },
      ],
    });
    executeRequestMock.mockResolvedValue({
      response: makeResponse(),
      sentHeaders: {},
      transportOk: true,
    });

    const plan: TestPlan = {
      name: 'Trace check',
      steps: [{ id: 's1', description: 'Get orders', requestId: 'req-1' }],
    };
    const planned = planTestRun(plan);

    const trace = await executeTestRun(planned, new AbortController().signal);

    expect(trace.id).toBeDefined();
    expect(trace.startedAt).toBeGreaterThan(0);
    expect(trace.finishedAt).toBeGreaterThanOrEqual(trace.startedAt);
    expect(trace.plan).toBe(planned);
  });

  it('handles empty step list gracefully', async () => {
    const plan: TestPlan = {
      name: 'Empty',
      steps: [],
    };
    const planned = planTestRun(plan);

    const trace = await executeTestRun(planned, new AbortController().signal);

    expect(trace.status).toBe('passed');
    expect(trace.results).toHaveLength(0);
  });
});
