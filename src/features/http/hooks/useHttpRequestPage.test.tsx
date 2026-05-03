import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import type { HttpRequest, Response as ApiResponse } from '@/types';
import { useRequestStore } from '@/store/useRequestStore';
import { useHistoryStore } from '@/store/useHistoryStore';
import { useConsoleStore } from '@/store/useConsoleStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { executeRequest } from '@/features/http/lib/requestExecutor';
import { useHttpRequestPage } from './useHttpRequestPage';

vi.mock('sonner', () => ({
  toast: {
    loading: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/lib/shared/dexie-storage', () => {
  const createStorage = () => ({
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  });

  return {
    dexieStorageAdapters: {
      collections: createStorage,
      environments: createStorage,
      history: createStorage,
      settings: createStorage,
      cookies: createStorage,
      workflows: createStorage,
      workflowExecutions: createStorage,
      fileCollections: createStorage,
    },
  };
});

vi.mock('@/features/http/lib/requestExecutor', () => ({
  executeRequest: vi.fn(),
}));

const mockExecuteRequest = vi.mocked(executeRequest);

function makeHttpRequest(): HttpRequest {
  return {
    id: 'request-1',
    name: 'GET users',
    type: 'http',
    method: 'GET',
    url: 'https://api.example.com/users',
    params: [],
    headers: [],
    body: { type: 'none' },
    auth: { type: 'none' },
  };
}

function makeResponse(requestId: string): ApiResponse {
  return {
    id: 'response-1',
    requestId,
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json' },
    body: '{"ok":true}',
    size: 11,
    time: 42,
    timestamp: 1_700_000_000_000,
  };
}

describe('useHttpRequestPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    const request = makeHttpRequest();
    useRequestStore.setState({
      currentRequest: request,
      httpRequest: request,
      currentResponse: null,
      scriptResult: null,
      isLoading: false,
    });
    useHistoryStore.setState({ history: [] });
    useConsoleStore.setState({ entries: [], selectedEntryId: null });
    useSettingsStore.getState().resetSettings();
  });

  it('sends the active HTTP request through the shared executor', async () => {
    const request = makeHttpRequest();
    const response = makeResponse(request.id);
    mockExecuteRequest.mockResolvedValue({
      response,
      scriptResult: {},
      envVars: {},
      sentHeaders: { accept: 'application/json' },
    });

    const { result } = renderHook(() => useHttpRequestPage());

    await act(async () => {
      await result.current.handlers.sendRequest();
    });

    expect(mockExecuteRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        request,
        globalSettings: useSettingsStore.getState().settings,
        envVars: {},
      })
    );
    expect(useRequestStore.getState().currentResponse).toEqual(response);
    expect(useHistoryStore.getState().history[0]?.response).toEqual(response);
    expect(useConsoleStore.getState().entries[0]?.request.headers).toEqual({ accept: 'application/json' });
    expect(toast.success).toHaveBeenCalledWith('Request completed: 200 OK', expect.any(Object));
  });
});
