import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Workflow, WorkflowGraph, HttpRequest, Response as ApiResponse } from '@/types';
import { escapeRegExp } from '@/lib/shared/escapeRegExp';
import { executeWorkflow } from '../workflowExecutor';

// Mock the protocol registry. dagExecutor and the refactored workflowExecutor
// both reach for protocolRegistry.get(...) — we intercept here so tests stay
// in-process with deterministic responses.
const httpRunRequest = vi.fn();
const httpInjectVariables = vi.fn((req: HttpRequest, vars: Record<string, string>) => {
  let url = req.url;
  for (const [k, v] of Object.entries(vars)) {
    url = url.replace(new RegExp(`{{${escapeRegExp(k)}}}`, 'g'), () => v);
  }
  return { ...req, url };
});
vi.mock('@/features/registry/registry', () => ({
  protocolRegistry: {
    get: (id: string) => {
      if (id === 'http') {
        return {
          id: 'http',
          label: 'HTTP',
          tabType: 'http',
          defaultRequest: () => ({}),
          injectVariables: httpInjectVariables,
          runRequest: httpRunRequest,
        };
      }
      return undefined;
    },
  },
}));

// Mock executeRequest so the legacy executor's HTTP path is deterministic.
vi.mock('@/features/http/lib/requestExecutor', () => ({
  executeRequest: vi.fn(),
}));

// Import after mocks so the dagExecutor / workflowExecutor see them.
const { executeDag } = await import('../dagExecutor');

const baseHttpRequest: HttpRequest = {
  id: 'r1',
  name: 'r1',
  type: 'http',
  method: 'GET',
  url: 'https://example.com',
  headers: [],
  params: [],
  body: { type: 'none' },
  auth: { type: 'none' },
};

function okResponse(overrides: Partial<ApiResponse> = {}): ApiResponse {
  return {
    id: 'resp',
    requestId: 'r1',
    status: 200,
    statusText: 'OK',
    headers: {},
    body: '{}',
    size: 0,
    time: 1,
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeGraphWorkflow(graph: WorkflowGraph, extras: Partial<Workflow> = {}): Workflow {
  return {
    id: 'wf-1',
    name: 'test workflow',
    collectionId: 'col-1',
    requests: [],
    graph,
    createdAt: 0,
    updatedAt: 0,
    ...extras,
  };
}

beforeEach(() => {
  httpRunRequest.mockReset();
  httpInjectVariables.mockClear();
});

describe('dagExecutor — happy path', () => {
  it('runs start → request → end and reports success', async () => {
    httpRunRequest.mockResolvedValue(okResponse());
    const workflow = makeGraphWorkflow(
      {
        version: 1,
        nodes: [
          { id: 'start', kind: 'start', position: { x: 0, y: 0 } },
          {
            id: 'req',
            kind: 'request',
            position: { x: 0, y: 0 },
            data: { workflowRequestId: 'wr1' },
          },
          { id: 'end', kind: 'end', position: { x: 0, y: 0 } },
        ],
        edges: [
          { id: 'e1', source: 'start', target: 'req' },
          { id: 'e2', source: 'req', target: 'end' },
        ],
      },
      {
        requests: [{ id: 'wr1', requestId: 'r1', name: 'r1' }],
      }
    );
    const result = await executeDag({
      workflow,
      getRequestById: () => baseHttpRequest,
      envVars: {},
    });
    expect(result.status).toBe('success');
    expect(result.steps.find((s) => s.nodeId === 'req')?.status).toBe('success');
    expect(httpRunRequest).toHaveBeenCalledTimes(1);
  });

  it('chains two requests: a variable extracted from response #1 is injected into request #2', async () => {
    // Closes the previously-untested "two-request chain" path: response
    // extraction (extractVariables) feeding a downstream request's {{var}}.
    httpRunRequest
      .mockResolvedValueOnce(okResponse({ body: JSON.stringify({ token: 'tok-123' }) }))
      .mockResolvedValueOnce(okResponse());

    const workflow = makeGraphWorkflow(
      {
        version: 1,
        nodes: [
          { id: 'start', kind: 'start', position: { x: 0, y: 0 } },
          {
            id: 'req1',
            kind: 'request',
            position: { x: 0, y: 0 },
            data: { workflowRequestId: 'wr1' },
          },
          {
            id: 'req2',
            kind: 'request',
            position: { x: 0, y: 0 },
            data: { workflowRequestId: 'wr2' },
          },
          { id: 'end', kind: 'end', position: { x: 0, y: 0 } },
        ],
        edges: [
          { id: 'e1', source: 'start', target: 'req1' },
          { id: 'e2', source: 'req1', target: 'req2' },
          { id: 'e3', source: 'req2', target: 'end' },
        ],
      },
      {
        requests: [
          {
            id: 'wr1',
            requestId: 'r1',
            name: 'login',
            extractVariables: [
              { id: 'x1', variableName: 'authToken', extractionMethod: 'jsonpath', path: 'token' },
            ],
          },
          { id: 'wr2', requestId: 'r2', name: 'use-token' },
        ],
      }
    );

    const result = await executeDag({
      workflow,
      // req2's URL references the extracted variable.
      getRequestById: (id) =>
        id === 'r2'
          ? { ...baseHttpRequest, id: 'r2', url: 'https://api.example.com/{{authToken}}' }
          : baseHttpRequest,
      envVars: {},
    });

    expect(result.status).toBe('success');
    expect(result.finalVariables.authToken).toBe('tok-123');
    // The second request was injected with the extracted variable in scope.
    const secondInjectCall = httpInjectVariables.mock.calls[1];
    expect(secondInjectCall?.[1]).toMatchObject({ authToken: 'tok-123' });
    const injectedReq2 = httpInjectVariables.mock.results[1]?.value as HttpRequest;
    expect(injectedReq2.url).toBe('https://api.example.com/tok-123');
  });
});

describe('dagExecutor — inherited auth on request nodes', () => {
  const graphWithOneRequest = (): Workflow =>
    makeGraphWorkflow(
      {
        version: 1,
        nodes: [
          { id: 'start', kind: 'start', position: { x: 0, y: 0 } },
          {
            id: 'req',
            kind: 'request',
            position: { x: 0, y: 0 },
            data: { workflowRequestId: 'wr1' },
          },
          { id: 'end', kind: 'end', position: { x: 0, y: 0 } },
        ],
        edges: [
          { id: 'e1', source: 'start', target: 'req' },
          { id: 'e2', source: 'req', target: 'end' },
        ],
      },
      { requests: [{ id: 'wr1', requestId: 'r1', name: 'r1' }] }
    );

  it('applies getInheritedAuth when the request has no auth of its own', async () => {
    // Regression: the production call site originally never passed
    // getInheritedAuth, so graph runs silently skipped folder/collection auth.
    httpRunRequest.mockResolvedValue(okResponse());
    const bearerAuth = { type: 'bearer' as const, bearer: { token: 'folder-token' } };

    const result = await executeDag({
      workflow: graphWithOneRequest(),
      getRequestById: () => ({ ...baseHttpRequest, auth: { type: 'none' as const } }),
      getInheritedAuth: () => bearerAuth,
      envVars: {},
    });

    expect(result.status).toBe('success');
    const ranRequest = httpRunRequest.mock.calls[0]?.[0] as HttpRequest;
    expect(ranRequest.auth).toEqual(bearerAuth);
  });

  it("never overrides the request's own configured auth", async () => {
    httpRunRequest.mockResolvedValue(okResponse());
    const ownAuth = { type: 'basic' as const, basic: { username: 'u', password: 'p' } };

    await executeDag({
      workflow: graphWithOneRequest(),
      getRequestById: () => ({ ...baseHttpRequest, auth: ownAuth }),
      getInheritedAuth: () => ({ type: 'bearer' as const, bearer: { token: 'folder-token' } }),
      envVars: {},
    });

    const ranRequest = httpRunRequest.mock.calls[0]?.[0] as HttpRequest;
    expect(ranRequest.auth).toEqual(ownAuth);
  });
});

describe('dagExecutor — graph validation', () => {
  it('fails when there is no start node', async () => {
    const workflow = makeGraphWorkflow({
      version: 1,
      nodes: [{ id: 'end', kind: 'end', position: { x: 0, y: 0 } }],
      edges: [],
    });
    const result = await executeDag({
      workflow,
      getRequestById: () => undefined,
      envVars: {},
    });
    expect(result.status).toBe('failed');
  });

  it('fails when the graph has a cycle', async () => {
    const workflow = makeGraphWorkflow({
      version: 1,
      nodes: [
        { id: 'start', kind: 'start', position: { x: 0, y: 0 } },
        { id: 'a', kind: 'delay', position: { x: 0, y: 0 }, data: { ms: 0 } },
        { id: 'b', kind: 'delay', position: { x: 0, y: 0 }, data: { ms: 0 } },
        { id: 'end', kind: 'end', position: { x: 0, y: 0 } },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'a' },
        { id: 'e2', source: 'a', target: 'b' },
        { id: 'e3', source: 'b', target: 'a' }, // cycle
        { id: 'e4', source: 'a', target: 'end' },
      ],
    });
    const result = await executeDag({
      workflow,
      getRequestById: () => undefined,
      envVars: {},
    });
    expect(result.status).toBe('failed');
    expect(result.executionLog.some((l) => l.message.includes('cycle'))).toBe(true);
  });

  it('fails when a condition node lacks true/false handles', async () => {
    const workflow = makeGraphWorkflow({
      version: 1,
      nodes: [
        { id: 'start', kind: 'start', position: { x: 0, y: 0 } },
        {
          id: 'c',
          kind: 'condition',
          position: { x: 0, y: 0 },
          data: { expression: 'return true;' },
        },
        { id: 'end', kind: 'end', position: { x: 0, y: 0 } },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'c' },
        // Missing sourceHandle and only one outgoing edge.
        { id: 'e2', source: 'c', target: 'end' },
      ],
    });
    const result = await executeDag({
      workflow,
      getRequestById: () => undefined,
      envVars: {},
    });
    expect(result.status).toBe('failed');
  });
});

describe('dagExecutor — condition routing', () => {
  it('takes the true branch when the expression returns true', async () => {
    httpRunRequest.mockResolvedValue(okResponse());
    const workflow = makeGraphWorkflow(
      {
        version: 1,
        nodes: [
          { id: 'start', kind: 'start', position: { x: 0, y: 0 } },
          {
            id: 'c',
            kind: 'condition',
            position: { x: 0, y: 0 },
            data: { expression: 'return true;' },
          },
          {
            id: 't',
            kind: 'request',
            position: { x: 0, y: 0 },
            data: { workflowRequestId: 'wr1' },
          },
          {
            id: 'f',
            kind: 'request',
            position: { x: 0, y: 0 },
            data: { workflowRequestId: 'wr1' },
          },
          { id: 'end', kind: 'end', position: { x: 0, y: 0 } },
        ],
        edges: [
          { id: 'e1', source: 'start', target: 'c' },
          { id: 'e2', source: 'c', target: 't', sourceHandle: 'true' },
          { id: 'e3', source: 'c', target: 'f', sourceHandle: 'false' },
          { id: 'e4', source: 't', target: 'end' },
          { id: 'e5', source: 'f', target: 'end' },
        ],
      },
      { requests: [{ id: 'wr1', requestId: 'r1', name: 'r1' }] }
    );
    const result = await executeDag({
      workflow,
      getRequestById: () => baseHttpRequest,
      envVars: {},
    });
    expect(result.status).toBe('success');
    expect(result.steps.find((s) => s.nodeId === 't')?.status).toBe('success');
    expect(result.steps.find((s) => s.nodeId === 'f')).toBeUndefined();
  });

  it('takes the false branch when the expression returns false (regression of legacy bug)', async () => {
    // The legacy evaluatePrecondition returned true for `return false;`.
    // This test guards the fix end-to-end through the executor.
    httpRunRequest.mockResolvedValue(okResponse());
    const workflow = makeGraphWorkflow(
      {
        version: 1,
        nodes: [
          { id: 'start', kind: 'start', position: { x: 0, y: 0 } },
          {
            id: 'c',
            kind: 'condition',
            position: { x: 0, y: 0 },
            data: { expression: 'return false;' },
          },
          {
            id: 't',
            kind: 'request',
            position: { x: 0, y: 0 },
            data: { workflowRequestId: 'wr1' },
          },
          {
            id: 'f',
            kind: 'request',
            position: { x: 0, y: 0 },
            data: { workflowRequestId: 'wr1' },
          },
          { id: 'end', kind: 'end', position: { x: 0, y: 0 } },
        ],
        edges: [
          { id: 'e1', source: 'start', target: 'c' },
          { id: 'e2', source: 'c', target: 't', sourceHandle: 'true' },
          { id: 'e3', source: 'c', target: 'f', sourceHandle: 'false' },
          { id: 'e4', source: 't', target: 'end' },
          { id: 'e5', source: 'f', target: 'end' },
        ],
      },
      { requests: [{ id: 'wr1', requestId: 'r1', name: 'r1' }] }
    );
    const result = await executeDag({
      workflow,
      getRequestById: () => baseHttpRequest,
      envVars: {},
    });
    expect(result.status).toBe('success');
    expect(result.steps.find((s) => s.nodeId === 'f')?.status).toBe('success');
    expect(result.steps.find((s) => s.nodeId === 't')).toBeUndefined();
  });
}, 30000);

describe('dagExecutor — setVariable / delay / transform', () => {
  it('setVariable assigns variables that downstream nodes can read', async () => {
    httpRunRequest.mockImplementation(async (req: HttpRequest) =>
      okResponse({
        headers: { 'x-saw-url': req.url } as Record<string, string>,
      })
    );

    const workflow = makeGraphWorkflow(
      {
        version: 1,
        nodes: [
          { id: 'start', kind: 'start', position: { x: 0, y: 0 } },
          {
            id: 'sv',
            kind: 'setVariable',
            position: { x: 0, y: 0 },
            data: {
              assignments: [{ key: 'who', valueExpression: '"world"' }],
            },
          },
          {
            id: 'req',
            kind: 'request',
            position: { x: 0, y: 0 },
            data: { workflowRequestId: 'wr1' },
          },
          { id: 'end', kind: 'end', position: { x: 0, y: 0 } },
        ],
        edges: [
          { id: 'e1', source: 'start', target: 'sv' },
          { id: 'e2', source: 'sv', target: 'req' },
          { id: 'e3', source: 'req', target: 'end' },
        ],
      },
      { requests: [{ id: 'wr1', requestId: 'r1', name: 'r1' }] }
    );
    const result = await executeDag({
      workflow,
      getRequestById: () => ({ ...baseHttpRequest, url: 'https://example.com/{{who}}' }),
      envVars: {},
    });
    expect(result.status).toBe('success');
    expect(httpInjectVariables).toHaveBeenCalled();
    // After substitution, the URL should contain "world".
    const calls = httpRunRequest.mock.calls;
    expect((calls[0]?.[0] as HttpRequest).url).toContain('world');
  });

  it('delay node waits for ms (smoke test)', async () => {
    const workflow = makeGraphWorkflow({
      version: 1,
      nodes: [
        { id: 'start', kind: 'start', position: { x: 0, y: 0 } },
        { id: 'd', kind: 'delay', position: { x: 0, y: 0 }, data: { ms: 10 } },
        { id: 'end', kind: 'end', position: { x: 0, y: 0 } },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'd' },
        { id: 'e2', source: 'd', target: 'end' },
      ],
    });
    const t0 = Date.now();
    const result = await executeDag({
      workflow,
      getRequestById: () => undefined,
      envVars: {},
    });
    expect(result.status).toBe('success');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(8);
  });

  it('transform merges pm.variables.set into downstream scope', async () => {
    const workflow = makeGraphWorkflow({
      version: 1,
      nodes: [
        { id: 'start', kind: 'start', position: { x: 0, y: 0 } },
        {
          id: 'tr',
          kind: 'transform',
          position: { x: 0, y: 0 },
          data: { script: 'pm.variables.set("greeting", "hi");' },
        },
        { id: 'end', kind: 'end', position: { x: 0, y: 0 } },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'tr' },
        { id: 'e2', source: 'tr', target: 'end' },
      ],
    });
    const result = await executeDag({
      workflow,
      getRequestById: () => undefined,
      envVars: {},
    });
    expect(result.status).toBe('success');
    expect(result.finalVariables.greeting).toBe('hi');
  });
}, 30000);

describe('dagExecutor — parallel', () => {
  function parallelGraph(
    waitMode: 'all' | 'any' | 'race',
    mergeStrategy?: 'fail-on-conflict' | 'pick-first' | 'pick-last' | 'merge-list'
  ): WorkflowGraph {
    return {
      version: 1,
      nodes: [
        { id: 'start', kind: 'start', position: { x: 0, y: 0 } },
        {
          id: 'p',
          kind: 'parallel',
          position: { x: 0, y: 0 },
          data: { waitMode, ...(mergeStrategy ? { mergeStrategy } : {}) },
        },
        {
          id: 'a',
          kind: 'setVariable',
          position: { x: 0, y: 0 },
          data: { assignments: [{ key: 'x', valueExpression: '"A"' }] },
        },
        {
          id: 'b',
          kind: 'setVariable',
          position: { x: 0, y: 0 },
          data: { assignments: [{ key: 'x', valueExpression: '"B"' }] },
        },
        { id: 'end', kind: 'end', position: { x: 0, y: 0 } },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'p' },
        { id: 'e2', source: 'p', target: 'a' },
        { id: 'e3', source: 'p', target: 'b' },
        { id: 'e4', source: 'a', target: 'end' },
        { id: 'e5', source: 'b', target: 'end' },
      ],
    };
  }

  it('detects write-write conflict by default (fail-on-conflict)', async () => {
    const result = await executeDag({
      workflow: makeGraphWorkflow(parallelGraph('all')),
      getRequestById: () => undefined,
      envVars: {},
    });
    expect(result.status).toBe('failed');
    expect(result.executionLog.some((l) => l.message.toLowerCase().includes('conflict'))).toBe(
      true
    );
  });

  it('pick-first resolves to the first branch value', async () => {
    const result = await executeDag({
      workflow: makeGraphWorkflow(parallelGraph('all', 'pick-first')),
      getRequestById: () => undefined,
      envVars: {},
    });
    expect(result.status).toBe('success');
    expect(['A', 'B']).toContain(result.finalVariables.x);
  });

  it('merge-list collects values into a JSON array', async () => {
    const result = await executeDag({
      workflow: makeGraphWorkflow(parallelGraph('all', 'merge-list')),
      getRequestById: () => undefined,
      envVars: {},
    });
    expect(result.status).toBe('success');
    expect(result.finalVariables.x).toBeDefined();
    const parsed = JSON.parse(result.finalVariables.x ?? '[]');
    expect(parsed).toEqual(expect.arrayContaining(['A', 'B']));
  });

  it('any returns when the first branch resolves', async () => {
    const result = await executeDag({
      workflow: makeGraphWorkflow(parallelGraph('any', 'pick-first')),
      getRequestById: () => undefined,
      envVars: {},
    });
    expect(result.status).toBe('success');
    expect(['A', 'B']).toContain(result.finalVariables.x);
  });

  it('parallel branches do NOT see each other mid-flight (isolated vars)', async () => {
    // Branch A reads `x`, expects undefined; sets `aSawX` accordingly.
    // Branch B sets `x` to "B" immediately.
    const result = await executeDag({
      workflow: makeGraphWorkflow({
        version: 1,
        nodes: [
          { id: 'start', kind: 'start', position: { x: 0, y: 0 } },
          {
            id: 'p',
            kind: 'parallel',
            position: { x: 0, y: 0 },
            data: { waitMode: 'all', mergeStrategy: 'merge-list' },
          },
          {
            id: 'a',
            kind: 'transform',
            position: { x: 0, y: 0 },
            data: {
              script: 'pm.variables.set("seenByA", pm.variables.get("x") || "none");',
            },
          },
          {
            id: 'b',
            kind: 'setVariable',
            position: { x: 0, y: 0 },
            data: { assignments: [{ key: 'x', valueExpression: '"B"' }] },
          },
          { id: 'end', kind: 'end', position: { x: 0, y: 0 } },
        ],
        edges: [
          { id: 'e1', source: 'start', target: 'p' },
          { id: 'e2', source: 'p', target: 'a' },
          { id: 'e3', source: 'p', target: 'b' },
          { id: 'e4', source: 'a', target: 'end' },
          { id: 'e5', source: 'b', target: 'end' },
        ],
      }),
      getRequestById: () => undefined,
      envVars: {},
    });
    expect(result.status).toBe('success');
    expect(result.finalVariables.seenByA).toBe('none');
  });
}, 30000);

describe('dagExecutor — forEach', () => {
  it('iterates the array and stores collected results', async () => {
    const workflow = makeGraphWorkflow({
      version: 1,
      nodes: [
        { id: 'start', kind: 'start', position: { x: 0, y: 0 } },
        {
          id: 'fe',
          kind: 'forEach',
          position: { x: 0, y: 0 },
          data: {
            collectionExpression: '[1,2,3]',
            iteratorVar: 'item',
            subgraph: {
              version: 1,
              nodes: [
                { id: 's', kind: 'start', position: { x: 0, y: 0 } },
                {
                  id: 'sv',
                  kind: 'setVariable',
                  position: { x: 0, y: 0 },
                  data: {
                    assignments: [{ key: 'last', valueExpression: 'pm.variables.get("item")' }],
                  },
                },
                { id: 'e', kind: 'end', position: { x: 0, y: 0 } },
              ],
              edges: [
                { id: 'a', source: 's', target: 'sv' },
                { id: 'b', source: 'sv', target: 'e' },
              ],
            },
          },
        },
        { id: 'end', kind: 'end', position: { x: 0, y: 0 } },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'fe' },
        { id: 'e2', source: 'fe', target: 'end' },
      ],
    });
    const result = await executeDag({
      workflow,
      getRequestById: () => undefined,
      envVars: {},
    });
    expect(result.status).toBe('success');
    const raw = result.finalVariables['fe.results'];
    expect(raw).toBeDefined();
    const collected = JSON.parse(raw ?? '[]');
    expect(collected).toHaveLength(3);
  });

  it('fails fast if the collectionExpression does not produce an array', async () => {
    const workflow = makeGraphWorkflow({
      version: 1,
      nodes: [
        { id: 'start', kind: 'start', position: { x: 0, y: 0 } },
        {
          id: 'fe',
          kind: 'forEach',
          position: { x: 0, y: 0 },
          data: {
            collectionExpression: '"not an array"',
            iteratorVar: 'item',
            subgraph: {
              version: 1,
              nodes: [
                { id: 's', kind: 'start', position: { x: 0, y: 0 } },
                { id: 'e', kind: 'end', position: { x: 0, y: 0 } },
              ],
              edges: [{ id: 'a', source: 's', target: 'e' }],
            },
          },
        },
        { id: 'end', kind: 'end', position: { x: 0, y: 0 } },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'fe' },
        { id: 'e2', source: 'fe', target: 'end' },
      ],
    });
    const result = await executeDag({
      workflow,
      getRequestById: () => undefined,
      envVars: {},
    });
    expect(result.status).toBe('failed');
  });
}, 30000);

describe('dagExecutor — tryCatch + failureMode', () => {
  it('default failureMode "thrown-only": non-2xx does NOT trigger catch', async () => {
    httpRunRequest.mockResolvedValue(okResponse({ status: 500 }));
    const workflow = makeGraphWorkflow(
      {
        version: 1,
        nodes: [
          { id: 'start', kind: 'start', position: { x: 0, y: 0 } },
          {
            id: 'tc',
            kind: 'tryCatch',
            position: { x: 0, y: 0 },
            data: {
              trySubgraph: {
                version: 1,
                nodes: [
                  { id: 's', kind: 'start', position: { x: 0, y: 0 } },
                  {
                    id: 'r',
                    kind: 'request',
                    position: { x: 0, y: 0 },
                    data: { workflowRequestId: 'wr1' },
                  },
                  { id: 'e', kind: 'end', position: { x: 0, y: 0 } },
                ],
                edges: [
                  { id: 'a', source: 's', target: 'r' },
                  { id: 'b', source: 'r', target: 'e' },
                ],
              },
              catchSubgraph: {
                version: 1,
                nodes: [
                  { id: 's', kind: 'start', position: { x: 0, y: 0 } },
                  {
                    id: 'mark',
                    kind: 'setVariable',
                    position: { x: 0, y: 0 },
                    data: { assignments: [{ key: 'caught', valueExpression: '"yes"' }] },
                  },
                  { id: 'e', kind: 'end', position: { x: 0, y: 0 } },
                ],
                edges: [
                  { id: 'a', source: 's', target: 'mark' },
                  { id: 'b', source: 'mark', target: 'e' },
                ],
              },
            },
          },
          { id: 'end', kind: 'end', position: { x: 0, y: 0 } },
        ],
        edges: [
          { id: 'e1', source: 'start', target: 'tc' },
          { id: 'e2', source: 'tc', target: 'end' },
        ],
      },
      { requests: [{ id: 'wr1', requestId: 'r1', name: 'r1' }] }
    );
    const result = await executeDag({
      workflow,
      getRequestById: () => baseHttpRequest,
      envVars: {},
    });
    expect(result.status).toBe('success');
    expect(result.finalVariables.caught).toBeUndefined();
  });

  it('failureMode "http-status" routes non-2xx through catch', async () => {
    httpRunRequest.mockResolvedValue(okResponse({ status: 500 }));
    const workflow = makeGraphWorkflow(
      {
        version: 1,
        nodes: [
          { id: 'start', kind: 'start', position: { x: 0, y: 0 } },
          {
            id: 'tc',
            kind: 'tryCatch',
            position: { x: 0, y: 0 },
            data: {
              trySubgraph: {
                version: 1,
                nodes: [
                  { id: 's', kind: 'start', position: { x: 0, y: 0 } },
                  {
                    id: 'r',
                    kind: 'request',
                    position: { x: 0, y: 0 },
                    data: { workflowRequestId: 'wr1', failureMode: 'http-status' },
                  },
                  { id: 'e', kind: 'end', position: { x: 0, y: 0 } },
                ],
                edges: [
                  { id: 'a', source: 's', target: 'r' },
                  { id: 'b', source: 'r', target: 'e' },
                ],
              },
              catchSubgraph: {
                version: 1,
                nodes: [
                  { id: 's', kind: 'start', position: { x: 0, y: 0 } },
                  {
                    id: 'mark',
                    kind: 'setVariable',
                    position: { x: 0, y: 0 },
                    data: { assignments: [{ key: 'caught', valueExpression: '"yes"' }] },
                  },
                  { id: 'e', kind: 'end', position: { x: 0, y: 0 } },
                ],
                edges: [
                  { id: 'a', source: 's', target: 'mark' },
                  { id: 'b', source: 'mark', target: 'e' },
                ],
              },
            },
          },
          { id: 'end', kind: 'end', position: { x: 0, y: 0 } },
        ],
        edges: [
          { id: 'e1', source: 'start', target: 'tc' },
          { id: 'e2', source: 'tc', target: 'end' },
        ],
      },
      { requests: [{ id: 'wr1', requestId: 'r1', name: 'r1' }] }
    );
    const result = await executeDag({
      workflow,
      getRequestById: () => baseHttpRequest,
      envVars: {},
    });
    expect(result.status).toBe('success');
    expect(result.finalVariables.caught).toBe('yes');
  });
}, 30000);

describe('dagExecutor — subWorkflow', () => {
  function trivialChildGraph(): WorkflowGraph {
    return {
      version: 1,
      nodes: [
        { id: 'start', kind: 'start', position: { x: 0, y: 0 } },
        {
          id: 'sv',
          kind: 'setVariable',
          position: { x: 0, y: 0 },
          data: { assignments: [{ key: 'childOut', valueExpression: '"made-in-child"' }] },
        },
        { id: 'end', kind: 'end', position: { x: 0, y: 0 } },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'sv' },
        { id: 'e2', source: 'sv', target: 'end' },
      ],
    };
  }

  it('projects vars in via inputVarMap and out via outputVarMap', async () => {
    const child: Workflow = {
      id: 'child',
      name: 'child',
      collectionId: 'col-1',
      requests: [],
      graph: trivialChildGraph(),
      createdAt: 0,
      updatedAt: 0,
    };
    const parent = makeGraphWorkflow({
      version: 1,
      nodes: [
        { id: 'start', kind: 'start', position: { x: 0, y: 0 } },
        {
          id: 'sw',
          kind: 'subWorkflow',
          position: { x: 0, y: 0 },
          data: {
            workflowId: 'child',
            inputVarMap: { fromParent: 'fromParent' },
            outputVarMap: { childOut: 'projected' },
          },
        },
        { id: 'end', kind: 'end', position: { x: 0, y: 0 } },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'sw' },
        { id: 'e2', source: 'sw', target: 'end' },
      ],
    });
    const result = await executeDag({
      workflow: parent,
      getRequestById: () => undefined,
      getWorkflowById: (id) => (id === 'child' ? child : undefined),
      envVars: { fromParent: 'P' },
    });
    expect(result.status).toBe('success');
    expect(result.finalVariables.projected).toBe('made-in-child');
  });

  it('rejects direct self-recursion via the call-stack cycle guard', async () => {
    const recursive: Workflow = {
      id: 'wf-cycle',
      name: 'cyclic',
      collectionId: 'col-1',
      requests: [],
      graph: {
        version: 1,
        nodes: [
          { id: 'start', kind: 'start', position: { x: 0, y: 0 } },
          {
            id: 'sw',
            kind: 'subWorkflow',
            position: { x: 0, y: 0 },
            data: { workflowId: 'wf-cycle' },
          },
          { id: 'end', kind: 'end', position: { x: 0, y: 0 } },
        ],
        edges: [
          { id: 'e1', source: 'start', target: 'sw' },
          { id: 'e2', source: 'sw', target: 'end' },
        ],
      },
      createdAt: 0,
      updatedAt: 0,
    };
    const result = await executeDag({
      workflow: recursive,
      getRequestById: () => undefined,
      getWorkflowById: (id) => (id === 'wf-cycle' ? recursive : undefined),
      envVars: {},
    });
    expect(result.status).toBe('failed');
  });
}, 30000);

describe('dagExecutor — abort propagation', () => {
  it('returns "stopped" when the abort signal is triggered mid-run', async () => {
    // Protocol implementations honour ctx.signal — the mock simulates that
    // so the abort flows through executeWithRetry and into the executor's
    // top-level catch.
    httpRunRequest.mockImplementation(
      (_req: HttpRequest, ctx: { signal: AbortSignal }) =>
        new Promise<ApiResponse>((_resolve, reject) => {
          if (ctx.signal.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
            return;
          }
          ctx.signal.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError'))
          );
        })
    );
    const controller = new AbortController();
    const workflow = makeGraphWorkflow(
      {
        version: 1,
        nodes: [
          { id: 'start', kind: 'start', position: { x: 0, y: 0 } },
          {
            id: 'r',
            kind: 'request',
            position: { x: 0, y: 0 },
            data: { workflowRequestId: 'wr1' },
          },
          { id: 'end', kind: 'end', position: { x: 0, y: 0 } },
        ],
        edges: [
          { id: 'e1', source: 'start', target: 'r' },
          { id: 'e2', source: 'r', target: 'end' },
        ],
      },
      { requests: [{ id: 'wr1', requestId: 'r1', name: 'r1' }] }
    );
    const promise = executeDag({
      workflow,
      getRequestById: () => baseHttpRequest,
      envVars: {},
      abortSignal: controller.signal,
    });
    setTimeout(() => controller.abort(), 30);
    const result = await promise;
    expect(['stopped', 'failed']).toContain(result.status);
  });
}, 30000);

describe('legacy workflowExecutor — refuses graph workflows', () => {
  it('throws when called with a workflow that has a non-null graph', async () => {
    const workflow = makeGraphWorkflow({
      version: 1,
      nodes: [
        { id: 'start', kind: 'start', position: { x: 0, y: 0 } },
        { id: 'end', kind: 'end', position: { x: 0, y: 0 } },
      ],
      edges: [{ id: 'e1', source: 'start', target: 'end' }],
    });
    await expect(
      executeWorkflow({
        workflow,
        getRequestById: () => undefined,
        envVars: {},
        globalSettings: {} as never,
        resolveVariables: (t) => t,
      })
    ).rejects.toThrow(/graph-authored/);
  });
});

describe('dagExecutor — switch / loop / template / display', () => {
  it('switch routes to the first matching case', async () => {
    const workflow = makeGraphWorkflow({
      version: 1,
      nodes: [
        { id: 'start', kind: 'start', position: { x: 0, y: 0 } },
        {
          id: 'sw',
          kind: 'switch',
          position: { x: 0, y: 0 },
          data: {
            cases: [
              { id: 'a', expression: 'return false;' },
              { id: 'b', expression: 'return true;' },
            ],
          },
        },
        {
          id: 'setA',
          kind: 'setVariable',
          position: { x: 0, y: 0 },
          data: { assignments: [{ key: 'hit', valueExpression: '"a"' }] },
        },
        {
          id: 'setB',
          kind: 'setVariable',
          position: { x: 0, y: 0 },
          data: { assignments: [{ key: 'hit', valueExpression: '"b"' }] },
        },
        {
          id: 'setD',
          kind: 'setVariable',
          position: { x: 0, y: 0 },
          data: { assignments: [{ key: 'hit', valueExpression: '"d"' }] },
        },
        { id: 'end', kind: 'end', position: { x: 0, y: 0 } },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'sw' },
        { id: 'e2', source: 'sw', target: 'setA', sourceHandle: 'a' },
        { id: 'e3', source: 'sw', target: 'setB', sourceHandle: 'b' },
        { id: 'e4', source: 'sw', target: 'setD', sourceHandle: 'default' },
        { id: 'e5', source: 'setA', target: 'end' },
        { id: 'e6', source: 'setB', target: 'end' },
        { id: 'e7', source: 'setD', target: 'end' },
      ],
    });
    const result = await executeDag({
      workflow,
      getRequestById: () => undefined,
      envVars: {},
    });
    expect(result.status).toBe('success');
    expect(result.finalVariables.hit).toBe('b');
  });

  it('switch falls back to the default handle when no case matches', async () => {
    const workflow = makeGraphWorkflow({
      version: 1,
      nodes: [
        { id: 'start', kind: 'start', position: { x: 0, y: 0 } },
        {
          id: 'sw',
          kind: 'switch',
          position: { x: 0, y: 0 },
          data: { cases: [{ id: 'a', expression: 'return false;' }] },
        },
        {
          id: 'setD',
          kind: 'setVariable',
          position: { x: 0, y: 0 },
          data: { assignments: [{ key: 'hit', valueExpression: '"d"' }] },
        },
        { id: 'end', kind: 'end', position: { x: 0, y: 0 } },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'sw' },
        { id: 'e2', source: 'sw', target: 'setD', sourceHandle: 'default' },
        { id: 'e3', source: 'setD', target: 'end' },
      ],
    });
    const result = await executeDag({
      workflow,
      getRequestById: () => undefined,
      envVars: {},
    });
    expect(result.status).toBe('success');
    expect(result.finalVariables.hit).toBe('d');
  });

  it('loop runs until the while-condition becomes false', async () => {
    const bodyGraph: WorkflowGraph = {
      version: 1,
      nodes: [
        { id: 'bs', kind: 'start', position: { x: 0, y: 0 } },
        {
          id: 'inc',
          kind: 'setVariable',
          position: { x: 0, y: 0 },
          data: {
            assignments: [
              {
                key: 'i',
                valueExpression: "String(Number(pm.variables.get('i') || '0') + 1)",
              },
            ],
          },
        },
        { id: 'be', kind: 'end', position: { x: 0, y: 0 } },
      ],
      edges: [
        { id: 'be1', source: 'bs', target: 'inc' },
        { id: 'be2', source: 'inc', target: 'be' },
      ],
    };
    const workflow = makeGraphWorkflow({
      version: 1,
      nodes: [
        { id: 'start', kind: 'start', position: { x: 0, y: 0 } },
        {
          id: 'lp',
          kind: 'loop',
          position: { x: 0, y: 0 },
          data: {
            conditionExpression: "return Number(pm.variables.get('i') || '0') < 3;",
            mode: 'while',
            maxIterations: 100,
            subgraph: bodyGraph,
          },
        },
        { id: 'end', kind: 'end', position: { x: 0, y: 0 } },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'lp' },
        { id: 'e2', source: 'lp', target: 'end' },
      ],
    });
    const result = await executeDag({
      workflow,
      getRequestById: () => undefined,
      envVars: {},
    });
    expect(result.status).toBe('success');
    expect(result.finalVariables.i).toBe('3');
    expect(result.finalVariables['lp.iterations']).toBe('3');
  }, 30000);

  it('loop honours the maxIterations cap', async () => {
    const bodyGraph: WorkflowGraph = {
      version: 1,
      nodes: [
        { id: 'bs', kind: 'start', position: { x: 0, y: 0 } },
        { id: 'be', kind: 'end', position: { x: 0, y: 0 } },
      ],
      edges: [{ id: 'be1', source: 'bs', target: 'be' }],
    };
    const workflow = makeGraphWorkflow({
      version: 1,
      nodes: [
        { id: 'start', kind: 'start', position: { x: 0, y: 0 } },
        {
          id: 'lp',
          kind: 'loop',
          position: { x: 0, y: 0 },
          data: {
            conditionExpression: 'return true;',
            mode: 'while',
            maxIterations: 5,
            subgraph: bodyGraph,
          },
        },
        { id: 'end', kind: 'end', position: { x: 0, y: 0 } },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'lp' },
        { id: 'e2', source: 'lp', target: 'end' },
      ],
    });
    const result = await executeDag({
      workflow,
      getRequestById: () => undefined,
      envVars: {},
    });
    expect(result.status).toBe('success');
    expect(result.finalVariables['lp.iterations']).toBe('5');
  });

  it('template renders {{vars}} into the result variable', async () => {
    const workflow = makeGraphWorkflow({
      version: 1,
      nodes: [
        { id: 'start', kind: 'start', position: { x: 0, y: 0 } },
        {
          id: 'sv',
          kind: 'setVariable',
          position: { x: 0, y: 0 },
          data: { assignments: [{ key: 'name', valueExpression: '"world"' }] },
        },
        {
          id: 'tpl',
          kind: 'template',
          position: { x: 0, y: 0 },
          data: { template: 'Hello {{name}}!', resultVar: 'greeting' },
        },
        { id: 'end', kind: 'end', position: { x: 0, y: 0 } },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'sv' },
        { id: 'e2', source: 'sv', target: 'tpl' },
        { id: 'e3', source: 'tpl', target: 'end' },
      ],
    });
    const result = await executeDag({
      workflow,
      getRequestById: () => undefined,
      envVars: {},
    });
    expect(result.status).toBe('success');
    expect(result.finalVariables.greeting).toBe('Hello world!');
  });

  it('display captures a value into the run step', async () => {
    const workflow = makeGraphWorkflow({
      version: 1,
      nodes: [
        { id: 'start', kind: 'start', position: { x: 0, y: 0 } },
        {
          id: 'disp',
          kind: 'display',
          position: { x: 0, y: 0 },
          data: { valueExpression: '({ a: 1 })', mode: 'json', label: 'out' },
        },
        { id: 'end', kind: 'end', position: { x: 0, y: 0 } },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'disp' },
        { id: 'e2', source: 'disp', target: 'end' },
      ],
    });
    const result = await executeDag({
      workflow,
      getRequestById: () => undefined,
      envVars: {},
    });
    expect(result.status).toBe('success');
    const step = result.steps.find((s) => s.nodeId === 'disp');
    expect(step?.extractedVariables?.out).toBe('{"a":1}');
  });
});
