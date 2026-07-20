import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OwsBindings, OwsLayout } from '@shared/ows/bindings';
import { saveOwsWorkflowArtifact } from '@shared/ows/node/workspace';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LoadedCollection, LoadedRequest } from '../collectionLoader';
import { runOwsWorkspaceWorkflow } from '../owsWorkspaceRunner';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const request: LoadedRequest = {
  relativePath: 'get-billing.yaml',
  folderPath: [],
  type: 'http',
  request: {
    id: 'request-1',
    name: 'Get billing',
    type: 'http',
    method: 'GET',
    url: 'https://example.test/billing',
    headers: [],
    params: [],
    body: { type: 'none' },
    auth: { type: 'none' },
  },
};

const loadedCollection: LoadedCollection = {
  meta: { name: 'OWS CLI' },
  requests: [request],
  format: 'opencollection-dir',
};

async function createWorkspace(resourceId = 'get-billing.yaml'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'restura-ows-cli-run-'));
  roots.push(root);
  await writeFile(
    join(root, 'opencollection.yml'),
    'opencollection: "1.0.0"\ninfo:\n  name: OWS CLI\n  version: "1.0.0"\n'
  );
  const bindings: OwsBindings = {
    version: 1,
    tasks: {
      '/do/0/getBilling': {
        kind: 'saved-request',
        call: 'http',
        resourceId,
      },
    },
  };
  const layout: OwsLayout = { version: 1, nodes: { '/do/0/getBilling': { x: 0, y: 0 } } };
  await saveOwsWorkflowArtifact(
    root,
    'billing',
    {
      document: { dsl: '1.0.3', namespace: 'restura', name: 'billing', version: '1.0.0' },
      do: [
        {
          getBilling: {
            call: 'http',
            with: { method: 'GET', endpoint: { uri: 'restura://saved-request' } },
            timeout: { after: { milliseconds: 25 } },
          },
        },
      ],
    },
    bindings,
    layout
  );
  return root;
}

describe('runOwsWorkspaceWorkflow', () => {
  it('resolves only the bound saved HTTP request and dispatches it through the CLI HTTP executor', async () => {
    const root = await createWorkspace();
    const executeHttp = vi.fn().mockResolvedValue({
      status: 200,
      passed: true,
      durationMs: 1,
      bodyBytes: 2,
    });

    const result = await runOwsWorkspaceWorkflow(
      root,
      'billing',
      { variables: { tenant: 'acme' }, timeoutMs: 1_000, allowLocalhost: false },
      { loadCollection: vi.fn().mockResolvedValue(loadedCollection), executeHttp }
    );

    expect(executeHttp).toHaveBeenCalledWith(
      request,
      expect.objectContaining({
        vars: { tenant: 'acme' },
        timeoutMs: 25,
        allowLocalhost: false,
        signal: expect.any(AbortSignal),
      })
    );
    expect(result).toMatchObject({
      status: 'success',
      variables: { getBilling: { status: 200, passed: true } },
    });
  });

  it('fails closed before dispatch when a binding no longer resolves to a saved request', async () => {
    const root = await createWorkspace();
    const executeHttp = vi.fn();

    await expect(
      runOwsWorkspaceWorkflow(
        root,
        'billing',
        { variables: {}, timeoutMs: 1_000, allowLocalhost: false },
        {
          loadCollection: vi.fn().mockResolvedValue({ ...loadedCollection, requests: [] }),
          executeHttp,
        }
      )
    ).resolves.toMatchObject({
      status: 'failed',
      steps: [
        expect.objectContaining({
          error: 'OWS binding get-billing.yaml does not resolve to a saved request.',
        }),
      ],
    });
    expect(executeHttp).not.toHaveBeenCalled();
  });

  it('fails closed before dispatch when a binding resolves to a non-HTTP request', async () => {
    const root = await createWorkspace();
    const executeHttp = vi.fn();
    const grpcRequest = { ...request, type: 'grpc' as const };

    await expect(
      runOwsWorkspaceWorkflow(
        root,
        'billing',
        { variables: {}, timeoutMs: 1_000, allowLocalhost: false },
        {
          loadCollection: vi
            .fn()
            .mockResolvedValue({ ...loadedCollection, requests: [grpcRequest] }),
          executeHttp,
        }
      )
    ).resolves.toMatchObject({
      status: 'failed',
      steps: [
        expect.objectContaining({ error: 'OWS binding get-billing.yaml is not an HTTP request.' }),
      ],
    });
    expect(executeHttp).not.toHaveBeenCalled();
  });

  it('fails the OWS run when the saved HTTP request reports an unsuccessful outcome', async () => {
    const root = await createWorkspace();

    const result = await runOwsWorkspaceWorkflow(
      root,
      'billing',
      { variables: {}, timeoutMs: 1_000, allowLocalhost: false },
      {
        loadCollection: vi.fn().mockResolvedValue(loadedCollection),
        executeHttp: vi.fn().mockResolvedValue({
          status: 500,
          passed: false,
          durationMs: 1,
          bodyBytes: 0,
        }),
      }
    );

    expect(result).toMatchObject({
      status: 'failed',
      steps: [
        {
          taskPath: '/do/0/getBilling',
          status: 'failed',
          error: 'Saved HTTP request get-billing.yaml returned unsuccessful status 500.',
        },
      ],
    });
  });

  it('resolves percent-encoded logical OpenCollection request paths', async () => {
    const root = await createWorkspace('Users/Saved%20request');
    const nestedRequest: LoadedRequest = {
      ...request,
      relativePath: 'Users/Saved request',
    };
    const executeHttp = vi.fn().mockResolvedValue({
      status: 200,
      passed: true,
      durationMs: 1,
      bodyBytes: 0,
    });

    await expect(
      runOwsWorkspaceWorkflow(
        root,
        'billing',
        { variables: {}, timeoutMs: 1_000, allowLocalhost: false },
        {
          loadCollection: vi
            .fn()
            .mockResolvedValue({ ...loadedCollection, requests: [nestedRequest] }),
          executeHttp,
        }
      )
    ).resolves.toMatchObject({ status: 'success' });
    expect(executeHttp).toHaveBeenCalledWith(nestedRequest, expect.any(Object));
  });

  it('caps an OWS task timeout at the CLI workflow timeout', async () => {
    const root = await createWorkspace();
    const executeHttp = vi.fn().mockResolvedValue({
      status: 200,
      passed: true,
      durationMs: 1,
      bodyBytes: 0,
    });

    await runOwsWorkspaceWorkflow(
      root,
      'billing',
      { variables: {}, timeoutMs: 10, allowLocalhost: false },
      { loadCollection: vi.fn().mockResolvedValue(loadedCollection), executeHttp }
    );

    expect(executeHttp).toHaveBeenCalledWith(request, expect.objectContaining({ timeoutMs: 10 }));
  });

  it('enforces the CLI workflow cap for non-HTTP controls', async () => {
    const root = await createWorkspace();
    await saveOwsWorkflowArtifact(
      root,
      'waiter',
      {
        document: { dsl: '1.0.3', namespace: 'restura', name: 'waiter', version: '1.0.0' },
        do: [{ wait: { wait: { milliseconds: 25 } } }],
      },
      { version: 1, tasks: {} },
      { version: 1, nodes: { '/do/0/wait': { x: 0, y: 0 } } }
    );

    await expect(
      runOwsWorkspaceWorkflow(
        root,
        'waiter',
        { variables: {}, timeoutMs: 1, allowLocalhost: false },
        { loadCollection: vi.fn().mockResolvedValue(loadedCollection), executeHttp: vi.fn() }
      )
    ).resolves.toMatchObject({
      status: 'failed',
      steps: [{ taskPath: '/do/0/wait', error: 'OWS workflow timed out.' }],
    });
  });

  it('fails closed before dispatch when the OWS method does not match the saved request', async () => {
    const root = await createWorkspace();
    const executeHttp = vi.fn();
    const postRequest = { ...request, request: { ...request.request, method: 'POST' as const } };

    await expect(
      runOwsWorkspaceWorkflow(
        root,
        'billing',
        { variables: {}, timeoutMs: 1_000, allowLocalhost: false },
        {
          loadCollection: vi
            .fn()
            .mockResolvedValue({ ...loadedCollection, requests: [postRequest] }),
          executeHttp,
        }
      )
    ).resolves.toMatchObject({
      status: 'failed',
      steps: [expect.objectContaining({ error: expect.stringContaining('does not match') })],
    });
    expect(executeHttp).not.toHaveBeenCalled();
  });

  it('requires explicit CLI authorization before dispatching a saved GraphQL mutation', async () => {
    const root = await createWorkspace();
    await saveOwsWorkflowArtifact(
      root,
      'mutation',
      {
        document: { dsl: '1.0.3', namespace: 'restura', name: 'mutation', version: '1.0.0' },
        do: [
          {
            update: {
              call: 'http',
              with: { method: 'POST', endpoint: { uri: 'restura://saved-request' } },
            },
          },
        ],
      },
      {
        version: 1,
        tasks: {
          '/do/0/update': {
            kind: 'saved-request',
            call: 'http',
            protocol: 'graphql',
            resourceId: 'get-billing.yaml',
          },
        },
      },
      { version: 1, nodes: { '/do/0/update': { x: 0, y: 0 } } }
    );
    const graphqlRequest: LoadedRequest = {
      ...request,
      request: {
        ...request.request,
        method: 'POST',
        body: {
          type: 'graphql',
          raw: JSON.stringify({
            query: 'mutation Update { update { id } }',
            operationName: 'Update',
          }),
        },
      },
    };
    const executeHttp = vi.fn();

    await expect(
      runOwsWorkspaceWorkflow(
        root,
        'mutation',
        { variables: {}, timeoutMs: 1_000, allowLocalhost: false, allowMutations: false },
        {
          loadCollection: vi
            .fn()
            .mockResolvedValue({ ...loadedCollection, requests: [graphqlRequest] }),
          executeHttp,
        }
      )
    ).rejects.toThrow('--allow-mutations');
    expect(executeHttp).not.toHaveBeenCalled();
  });
});
