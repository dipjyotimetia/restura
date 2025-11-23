import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeWorkflow } from '../workflowExecutor';
import { Workflow, Request, HttpRequest, AppSettings, Response } from '@/types';

// Mock the executeRequest function
vi.mock('@/features/http/lib/requestExecutor', () => ({
  executeRequest: vi.fn(),
}));

// Mock the ScriptExecutor
vi.mock('@/features/scripts/lib/scriptExecutor', () => ({
  default: vi.fn().mockImplementation(() => ({
    executeScript: vi.fn().mockResolvedValue({ success: true, variables: {} }),
  })),
}));

import { executeRequest } from '@/features/http/lib/requestExecutor';

const mockExecuteRequest = executeRequest as ReturnType<typeof vi.fn>;

describe('workflowExecutor', () => {
  const mockRequest: HttpRequest = {
    id: 'req-1',
    name: 'Test Request',
    type: 'http',
    method: 'GET',
    url: 'https://api.example.com/users',
    headers: [],
    params: [],
    body: { type: 'none' },
    auth: { type: 'none' },
  };

  const mockResponse: Response = {
    id: 'resp-1',
    requestId: 'req-1',
    status: 200,
    statusText: 'OK',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: { userId: '123', token: 'abc' } }),
    size: 100,
    time: 50,
    timestamp: Date.now(),
  };

  const mockSettings: AppSettings = {
    proxy: { enabled: false, type: 'none', host: '', port: 0 },
    defaultTimeout: 30000,
    followRedirects: true,
    maxRedirects: 5,
    verifySsl: true,
    autoSaveHistory: true,
    maxHistoryItems: 100,
    theme: 'system',
    layoutOrientation: 'vertical',
    corsProxy: { enabled: false, autoDetect: false },
  };

  const getRequestById = vi.fn((id: string): Request | undefined => {
    if (id === 'req-1') return mockRequest;
    return undefined;
  });

  const resolveVariables = vi.fn((text: string) => text);

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteRequest.mockResolvedValue({
      response: mockResponse,
      envVars: {},
    });
  });

  it('should execute a simple workflow with one request', async () => {
    const workflow: Workflow = {
      id: 'wf-1',
      name: 'Simple Workflow',
      collectionId: 'col-1',
      requests: [
        {
          id: 'wr-1',
          requestId: 'req-1',
          name: 'First Request',
        },
      ],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const result = await executeWorkflow({
      workflow,
      getRequestById,
      envVars: {},
      globalSettings: mockSettings,
      resolveVariables,
    });

    expect(result.status).toBe('success');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.status).toBe('success');
    expect(mockExecuteRequest).toHaveBeenCalledTimes(1);
  });

  it('should extract variables from response', async () => {
    const workflow: Workflow = {
      id: 'wf-1',
      name: 'Extract Workflow',
      collectionId: 'col-1',
      requests: [
        {
          id: 'wr-1',
          requestId: 'req-1',
          name: 'First Request',
          extractVariables: [
            {
              id: 'ext-1',
              variableName: 'userId',
              extractionMethod: 'jsonpath',
              path: 'data.userId',
            },
            {
              id: 'ext-2',
              variableName: 'token',
              extractionMethod: 'jsonpath',
              path: 'data.token',
            },
          ],
        },
      ],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const result = await executeWorkflow({
      workflow,
      getRequestById,
      envVars: {},
      globalSettings: mockSettings,
      resolveVariables,
    });

    expect(result.status).toBe('success');
    expect(result.finalVariables).toEqual({
      userId: '123',
      token: 'abc',
    });
    expect(result.steps[0]?.extractedVariables).toEqual({
      userId: '123',
      token: 'abc',
    });
  });

  it('should handle request not found', async () => {
    const workflow: Workflow = {
      id: 'wf-1',
      name: 'Missing Request',
      collectionId: 'col-1',
      requests: [
        {
          id: 'wr-1',
          requestId: 'nonexistent',
          name: 'Missing',
        },
      ],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const result = await executeWorkflow({
      workflow,
      getRequestById,
      envVars: {},
      globalSettings: mockSettings,
      resolveVariables,
    });

    expect(result.status).toBe('failed');
    expect(result.steps[0]?.status).toBe('failed');
    expect(result.steps[0]?.error).toContain('Request not found');
  });

  it('should handle failed request', async () => {
    mockExecuteRequest.mockResolvedValueOnce({
      response: { ...mockResponse, status: 500, statusText: 'Internal Server Error' },
      envVars: {},
    });

    const workflow: Workflow = {
      id: 'wf-1',
      name: 'Failing Workflow',
      collectionId: 'col-1',
      requests: [
        {
          id: 'wr-1',
          requestId: 'req-1',
          name: 'Failing Request',
        },
      ],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const result = await executeWorkflow({
      workflow,
      getRequestById,
      envVars: {},
      globalSettings: mockSettings,
      resolveVariables,
    });

    expect(result.status).toBe('failed');
    expect(result.steps[0]?.status).toBe('failed');
    expect(result.steps[0]?.error).toContain('500');
  });

  it('should execute multiple requests in sequence', async () => {
    const secondRequest: HttpRequest = {
      ...mockRequest,
      id: 'req-2',
      name: 'Second Request',
    };

    getRequestById.mockImplementation((id: string): Request | undefined => {
      if (id === 'req-1') return mockRequest;
      if (id === 'req-2') return secondRequest;
      return undefined;
    });

    const workflow: Workflow = {
      id: 'wf-1',
      name: 'Multi-step Workflow',
      collectionId: 'col-1',
      requests: [
        { id: 'wr-1', requestId: 'req-1', name: 'First' },
        { id: 'wr-2', requestId: 'req-2', name: 'Second' },
      ],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const result = await executeWorkflow({
      workflow,
      getRequestById,
      envVars: {},
      globalSettings: mockSettings,
      resolveVariables,
    });

    expect(result.status).toBe('success');
    expect(result.steps).toHaveLength(2);
    expect(result.steps.every((s) => s.status === 'success')).toBe(true);
    expect(mockExecuteRequest).toHaveBeenCalledTimes(2);
  });

  it('should stop execution on first failure', async () => {
    mockExecuteRequest
      .mockResolvedValueOnce({
        response: { ...mockResponse, status: 500 },
        envVars: {},
      })
      .mockResolvedValueOnce({
        response: mockResponse,
        envVars: {},
      });

    const secondRequest: HttpRequest = {
      ...mockRequest,
      id: 'req-2',
    };

    getRequestById.mockImplementation((id: string) => {
      if (id === 'req-1') return mockRequest;
      if (id === 'req-2') return secondRequest;
      return undefined;
    });

    const workflow: Workflow = {
      id: 'wf-1',
      name: 'Stop on Failure',
      collectionId: 'col-1',
      requests: [
        { id: 'wr-1', requestId: 'req-1', name: 'First' },
        { id: 'wr-2', requestId: 'req-2', name: 'Second' },
      ],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const result = await executeWorkflow({
      workflow,
      getRequestById,
      envVars: {},
      globalSettings: mockSettings,
      resolveVariables,
    });

    expect(result.status).toBe('failed');
    // Only the first step was added since execution stopped on failure
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.status).toBe('failed');
    expect(mockExecuteRequest).toHaveBeenCalledTimes(1);
  });

  it('should call onStepStart and onStepComplete callbacks', async () => {
    const onStepStart = vi.fn();
    const onStepComplete = vi.fn();

    const workflow: Workflow = {
      id: 'wf-1',
      name: 'Callback Test',
      collectionId: 'col-1',
      requests: [
        { id: 'wr-1', requestId: 'req-1', name: 'First' },
      ],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await executeWorkflow({
      workflow,
      getRequestById,
      envVars: {},
      globalSettings: mockSettings,
      resolveVariables,
      onStepStart,
      onStepComplete,
    });

    expect(onStepStart).toHaveBeenCalledTimes(1);
    expect(onStepComplete).toHaveBeenCalledTimes(1);
  });

  it('should log execution progress', async () => {
    const onLog = vi.fn();

    const workflow: Workflow = {
      id: 'wf-1',
      name: 'Log Test',
      collectionId: 'col-1',
      requests: [
        { id: 'wr-1', requestId: 'req-1', name: 'First' },
      ],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const result = await executeWorkflow({
      workflow,
      getRequestById,
      envVars: {},
      globalSettings: mockSettings,
      resolveVariables,
      onLog,
    });

    expect(onLog).toHaveBeenCalled();
    expect(result.executionLog.length).toBeGreaterThan(0);
  });

  it('should merge workflow-level variables', async () => {
    const workflow: Workflow = {
      id: 'wf-1',
      name: 'Variables Test',
      collectionId: 'col-1',
      requests: [
        { id: 'wr-1', requestId: 'req-1', name: 'First' },
      ],
      variables: [
        { id: 'v1', key: 'baseUrl', value: 'https://api.example.com', enabled: true },
        { id: 'v2', key: 'disabled', value: 'should not appear', enabled: false },
      ],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const result = await executeWorkflow({
      workflow,
      getRequestById,
      envVars: { existingVar: 'value' },
      globalSettings: mockSettings,
      resolveVariables,
    });

    expect(result.finalVariables).toEqual({
      existingVar: 'value',
      baseUrl: 'https://api.example.com',
    });
  });

  it('should handle abort signal', async () => {
    const abortController = new AbortController();
    abortController.abort();

    const workflow: Workflow = {
      id: 'wf-1',
      name: 'Abort Test',
      collectionId: 'col-1',
      requests: [
        { id: 'wr-1', requestId: 'req-1', name: 'First' },
      ],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const result = await executeWorkflow({
      workflow,
      getRequestById,
      envVars: {},
      globalSettings: mockSettings,
      resolveVariables,
      abortSignal: abortController.signal,
    });

    expect(result.status).toBe('stopped');
    expect(mockExecuteRequest).not.toHaveBeenCalled();
  });
});
