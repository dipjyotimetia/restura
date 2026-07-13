import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useGlobalsStore } from '@/store/useGlobalsStore';
import { useRequestStore } from '@/store/useRequestStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import type { HttpRequest, Response } from '@/types';

const executeRequestMock = vi.hoisted(() => vi.fn());

vi.mock('@/features/http/lib/requestExecutor', () => ({
  executeRequest: executeRequestMock,
}));

import { createResturaRequestTool, redactToolUrl, resolveResturaAgentTools } from '../agentTools';

function request(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    id: 'request-1',
    name: 'Get order',
    type: 'http',
    method: 'GET',
    url: 'https://example.com',
    headers: [],
    params: [],
    body: { type: 'none' },
    auth: { type: 'none' },
    ...overrides,
  };
}

function response(overrides: Partial<Response> = {}): Response {
  return {
    id: 'response',
    status: 200,
    statusText: 'OK',
    headers: {},
    body: '{"paid":true}',
    time: 5,
    size: 13,
    requestId: 'request-1',
    timestamp: 0,
    ...overrides,
  };
}

describe('Restura request agent tools', () => {
  const originalSettings = useSettingsStore.getState().settings;
  const originalRequestState = useRequestStore.getState();

  beforeEach(() => {
    executeRequestMock.mockReset();
    useCollectionStore.setState({ collections: [], activeCollectionId: null });
    useEnvironmentStore.setState({ environments: [], activeEnvironmentId: null });
    useGlobalsStore.setState({ vars: {} });
    useRequestStore.setState({ tabs: [], activeTabId: null });
    useSettingsStore.setState({ settings: originalSettings });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useCollectionStore.setState({ collections: [], activeCollectionId: null });
    useEnvironmentStore.setState({ environments: [], activeEnvironmentId: null });
    useGlobalsStore.setState({ vars: {} });
    useRequestStore.setState({
      tabs: originalRequestState.tabs,
      activeTabId: originalRequestState.activeTabId,
    });
    useSettingsStore.setState({ settings: originalSettings });
  });

  it('classifies reads and returns a structured response', async () => {
    const tool = createResturaRequestTool(request(), async () => response());
    expect(tool.permissionClass).toBe('read');
    expect(await tool.execute({}, { signal: new AbortController().signal })).toEqual([
      { type: 'json', value: expect.objectContaining({ status: 200, body: '{"paid":true}' }) },
    ]);
  });

  it('redacts credentials, fragments, and query values from tool descriptions', () => {
    const tool = createResturaRequestTool(
      request({
        url: 'https://alice:secret@example.com/orders?token=signed&view=full#frag',
      }),
      vi.fn()
    );

    expect(tool.definition.description).toContain('token=REDACTED');
    expect(tool.definition.description).toContain('view=REDACTED');
    expect(tool.definition.description).not.toMatch(/alice|secret|signed|full|frag/);
  });

  it('redacts invalid templated URLs without exposing fallback secrets', () => {
    const redacted = redactToolUrl(
      '{{BASE_URL}}//alice:secret@example.com/orders?token=signed&view=full#frag'
    );

    expect(redacted).toBe('[REDACTED INVALID URL]');
    expect(redacted).not.toMatch(/alice|secret|signed|full|frag/);
  });

  it.each([
    '{{BASE_URL}}//alice:authority-secret@example.com/orders?token=query-secret&view=full#fragment-secret',
    'not a url //bob:password-secret@example.com/path?one=alpha&two=beta#hidden-fragment',
    '{{BASE_URL}}/path?token=secret value with spaces&next=other secret#private-fragment',
  ])('fully redacts adversarial invalid URL fallback: %s', (raw) => {
    const redacted = redactToolUrl(raw);

    expect(redacted).toBe('[REDACTED INVALID URL]');
    expect(redacted).not.toMatch(
      /alice|authority-secret|bob|password-secret|query-secret|full|alpha|beta|secret value|other secret|fragment/i
    );
  });

  it('passes the runner signal into request execution', async () => {
    const controller = new AbortController();
    const execute = vi.fn().mockResolvedValue(response());
    const tool = createResturaRequestTool(request({ url: '{{BASE_URL}}/orders' }), execute);

    await tool.execute({}, { signal: controller.signal });

    expect(execute).toHaveBeenCalledWith(expect.anything(), controller.signal);
  });

  it('uses normal active scopes and persists successful collection mutations', async () => {
    useGlobalsStore.setState({ vars: { GLOBAL_TOKEN: 'global' } });
    useEnvironmentStore.setState({
      environments: [
        {
          id: 'env-1',
          name: 'Active',
          variables: [
            { id: 'base', key: 'BASE_URL', value: 'https://api.example.com', enabled: true },
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
          auth: { type: 'bearer', bearer: { token: { kind: 'handle', id: 'secret-1' } } },
          variables: [{ id: 'order', key: 'ORDER_ID', value: '42', enabled: true }],
          items: [
            {
              id: 'item-1',
              name: 'Get order',
              type: 'request',
              request: request({ url: '{{BASE_URL}}/orders/{{ORDER_ID}}' }),
            },
          ],
        },
      ],
      activeCollectionId: 'c1',
    });
    const settings = { ...originalSettings, defaultTimeout: 12_345 };
    useSettingsStore.setState({ settings });
    executeRequestMock.mockResolvedValue({
      response: response(),
      sentHeaders: {},
      transportOk: true,
      collectionVarsMutations: { ORDER_ID: '43' },
    });
    const applyCollectionVarMutations = vi.spyOn(
      useCollectionStore.getState(),
      'applyCollectionVarMutations'
    );
    applyCollectionVarMutations.mockClear();
    const signal = new AbortController().signal;

    const [tool] = await resolveResturaAgentTools([
      { kind: 'restura-request', requestId: 'request-1' },
    ]);
    await tool!.execute({}, { signal });

    expect(executeRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          auth: { type: 'bearer', bearer: { token: { kind: 'handle', id: 'secret-1' } } },
        }),
        envVars: expect.objectContaining({
          BASE_URL: 'https://api.example.com',
          GLOBAL_TOKEN: 'global',
          ORDER_ID: '42',
        }),
        collectionVars: { ORDER_ID: '42' },
        globalSettings: settings,
        signal,
      })
    );
    expect(applyCollectionVarMutations).toHaveBeenCalledWith('c1', { ORDER_ID: '43' });
    expect(useCollectionStore.getState().collections[0]?.variables?.[0]?.value).toBe('43');
  });

  it('uses globals, active environment, and only the owning collection scope', async () => {
    useGlobalsStore.setState({ vars: { SHARED: 'global', GLOBAL_ONLY: 'global-only' } });
    useEnvironmentStore.setState({
      environments: [
        {
          id: 'env-1',
          name: 'Active',
          variables: [
            { id: 'env-shared', key: 'SHARED', value: 'environment', enabled: true },
            { id: 'env-only', key: 'ENV_ONLY', value: 'environment-only', enabled: true },
            { id: 'env-off', key: 'ENV_DISABLED', value: 'must-not-leak', enabled: false },
          ],
        },
      ],
      activeEnvironmentId: 'env-1',
    });
    useCollectionStore.setState({
      collections: [
        {
          id: 'active-c',
          name: 'Active tab collection',
          variables: [
            { id: 'active-shared', key: 'SHARED', value: 'active-tab', enabled: true },
            { id: 'active-only', key: 'ACTIVE_ONLY', value: 'must-not-leak', enabled: true },
          ],
          items: [
            {
              id: 'active-item',
              name: 'Active request',
              type: 'request',
              request: request({ id: 'active-request' }),
            },
          ],
        },
        {
          id: 'owner-c',
          name: 'Owner',
          variables: [
            { id: 'owner-shared', key: 'SHARED', value: 'owner', enabled: true },
            { id: 'owner-only', key: 'OWNER_ONLY', value: 'owner-only', enabled: true },
            { id: 'owner-off', key: 'OWNER_DISABLED', value: 'must-not-resolve', enabled: false },
          ],
          items: [{ id: 'owner-item', name: 'Tool request', type: 'request', request: request() }],
        },
      ],
      activeCollectionId: 'active-c',
    });
    useRequestStore.setState({
      tabs: [
        {
          id: 'tab-1',
          request: request({ id: 'active-request' }),
          isDirty: false,
          savedRequestId: 'active-item',
        },
      ],
      activeTabId: 'tab-1',
    });
    executeRequestMock.mockResolvedValue({
      response: response(),
      sentHeaders: {},
      transportOk: true,
    });

    const [tool] = await resolveResturaAgentTools([
      { kind: 'restura-request', requestId: 'owner-item' },
    ]);
    await tool!.execute({}, { signal: new AbortController().signal });

    expect(executeRequestMock.mock.calls[0]?.[0]?.envVars).toEqual({
      GLOBAL_ONLY: 'global-only',
      ENV_ONLY: 'environment-only',
      OWNER_ONLY: 'owner-only',
      SHARED: 'owner',
    });
    expect(executeRequestMock.mock.calls[0]?.[0]?.collectionVars).toEqual({
      OWNER_ONLY: 'owner-only',
      SHARED: 'owner',
    });
  });

  it('resolves folder auth only from the owning collection when request IDs collide', async () => {
    useCollectionStore.setState({
      collections: [
        {
          id: 'wrong-c',
          name: 'Wrong duplicate',
          auth: { type: 'bearer', bearer: { token: 'wrong-token' } },
          items: [{ id: 'wrong-item', name: 'Duplicate', type: 'request', request: request() }],
        },
        {
          id: 'owner-c',
          name: 'Owner',
          items: [
            {
              id: 'folder',
              name: 'Authenticated folder',
              type: 'folder',
              auth: { type: 'bearer', bearer: { token: 'folder-token' } },
              items: [
                { id: 'owner-item', name: 'Tool request', type: 'request', request: request() },
              ],
            },
          ],
        },
      ],
      activeCollectionId: null,
    });
    executeRequestMock.mockResolvedValue({
      response: response(),
      sentHeaders: {},
      transportOk: true,
    });

    const [tool] = await resolveResturaAgentTools([
      { kind: 'restura-request', requestId: 'owner-item' },
    ]);
    await tool!.execute({}, { signal: new AbortController().signal });

    expect(executeRequestMock.mock.calls[0]?.[0]?.request.auth).toEqual({
      type: 'bearer',
      bearer: { token: 'folder-token' },
    });
  });

  it('does not persist collection mutations after a transport error', async () => {
    useCollectionStore.setState({
      collections: [
        {
          id: 'c1',
          name: 'Orders',
          variables: [{ id: 'order', key: 'ORDER_ID', value: '42', enabled: true }],
          items: [{ id: 'item-1', name: 'Get order', type: 'request', request: request() }],
        },
      ],
      activeCollectionId: 'c1',
    });
    executeRequestMock.mockResolvedValue({
      response: response({ status: 0, statusText: 'Proxy Error' }),
      sentHeaders: {},
      transportOk: false,
      collectionVarsMutations: { ORDER_ID: '43' },
    });
    const applyCollectionVarMutations = vi.spyOn(
      useCollectionStore.getState(),
      'applyCollectionVarMutations'
    );
    applyCollectionVarMutations.mockClear();

    const [tool] = await resolveResturaAgentTools([
      { kind: 'restura-request', requestId: 'request-1' },
    ]);
    await tool!.execute({}, { signal: new AbortController().signal });

    expect(applyCollectionVarMutations).not.toHaveBeenCalled();
    expect(useCollectionStore.getState().collections[0]?.variables?.[0]?.value).toBe('42');
  });

  it('does not persist collection mutations when execution is cancelled', async () => {
    useCollectionStore.setState({
      collections: [
        {
          id: 'c1',
          name: 'Orders',
          variables: [{ id: 'order', key: 'ORDER_ID', value: '42', enabled: true }],
          items: [
            {
              id: 'item-1',
              name: 'Get order',
              type: 'request',
              request: request(),
            },
          ],
        },
      ],
      activeCollectionId: 'c1',
    });
    const controller = new AbortController();
    controller.abort();
    executeRequestMock.mockRejectedValue(controller.signal.reason);
    const applyCollectionVarMutations = vi.spyOn(
      useCollectionStore.getState(),
      'applyCollectionVarMutations'
    );
    applyCollectionVarMutations.mockClear();

    const [tool] = await resolveResturaAgentTools([
      { kind: 'restura-request', requestId: 'request-1' },
    ]);
    await expect(tool!.execute({}, { signal: controller.signal })).rejects.toThrow(/abort/i);

    expect(applyCollectionVarMutations).not.toHaveBeenCalled();
    expect(useCollectionStore.getState().collections[0]?.variables?.[0]?.value).toBe('42');
  });
});
