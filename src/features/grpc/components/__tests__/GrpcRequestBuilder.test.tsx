import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  GrpcRequest,
  GrpcResponse,
  ReflectionMethodInfo,
  ReflectionServiceInfo,
} from '@/types';

const runnerMocks = vi.hoisted(() => ({
  run: vi.fn(),
}));

const reflectionMethod: ReflectionMethodInfo = {
  name: 'Ping',
  fullName: 'test.v1.TestService.Ping',
  inputType: '.test.v1.PingRequest',
  outputType: '.test.v1.PingResponse',
  clientStreaming: false,
  serverStreaming: false,
  inputMessageSchema: { name: 'PingRequest', fullName: 'test.v1.PingRequest', fields: [] },
  outputMessageSchema: { name: 'PingResponse', fullName: 'test.v1.PingResponse', fields: [] },
};

const reflectionService: ReflectionServiceInfo = {
  name: 'TestService',
  fullName: 'test.v1.TestService',
  methods: [reflectionMethod],
};

vi.mock('@/features/registry/useRequestRunner', () => ({
  useRequestRunner: () => ({ run: runnerMocks.run, abort: vi.fn() }),
}));

vi.mock('@/features/grpc/hooks/useGrpcReflection', () => ({
  useGrpcReflection: () => ({
    result: {
      success: true,
      services: [reflectionService],
      serverUrl: 'https://grpc.example.com',
      timestamp: 1,
    },
    selectedService: reflectionService,
    selectedMethod: reflectionMethod,
    loading: false,
    showSchema: false,
    setShowSchema: vi.fn(),
    selectService: vi.fn(),
    selectMethod: vi.fn(),
    discover: vi.fn(),
  }),
}));

// Monaco can't load in jsdom; the editor surface is irrelevant here.
vi.mock('@/components/shared/CodeEditor', () => ({ default: () => null }));

vi.mock('sonner', () => ({
  toast: {
    dismiss: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

import { useRequestStore } from '@/store/useRequestStore';
import GrpcRequestBuilder from '../GrpcRequestBuilder';

function makeRequest(id: string, name: string): GrpcRequest {
  return {
    id,
    name,
    type: 'grpc',
    methodType: 'unary',
    url: 'https://grpc.example.com',
    service: 'test.v1.TestService',
    method: 'Ping',
    metadata: [],
    message: '{}',
    auth: { type: 'none' },
  };
}

function makeResponse(requestId: string): GrpcResponse {
  return {
    id: `response-${requestId}`,
    requestId,
    status: 200,
    statusText: 'OK',
    headers: {},
    body: '{"message":"pong"}',
    size: 18,
    time: 15,
    timestamp: Date.now(),
    grpcStatus: 0,
    grpcStatusText: 'OK',
  };
}

describe('GrpcRequestBuilder request completion routing', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    runnerMocks.run.mockReset();
    useRequestStore.setState({
      tabs: [
        { id: 'tab-origin', request: makeRequest('request-origin', 'Origin'), isDirty: false },
        { id: 'tab-other', request: makeRequest('request-other', 'Other'), isDirty: false },
      ],
      activeTabId: 'tab-origin',
      isLoading: false,
    });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('writes a delayed unary response to the tab that started the request', async () => {
    const response = makeResponse('request-origin');
    let resolveRun: ((result: { response: GrpcResponse; durationMs: number }) => void) | undefined;
    runnerMocks.run.mockReturnValue(
      new Promise((resolve) => {
        resolveRun = resolve;
      })
    );
    render(<GrpcRequestBuilder />);

    fireEvent.click(screen.getByRole('button', { name: 'Invoke gRPC method' }));
    act(() => {
      useRequestStore.getState().switchTab('tab-other');
    });
    await act(async () => {
      resolveRun?.({ response, durationMs: 15 });
    });

    await waitFor(() => {
      const state = useRequestStore.getState();
      expect(state.tabs.find((tab) => tab.id === 'tab-origin')?.response).toEqual(response);
      expect(state.tabs.find((tab) => tab.id === 'tab-other')?.response).toBeUndefined();
    });
  });

  it('writes a delayed unary error response to the tab that started the request', async () => {
    let rejectRun: ((reason: Error) => void) | undefined;
    runnerMocks.run.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectRun = reject;
      })
    );
    render(<GrpcRequestBuilder />);

    fireEvent.click(screen.getByRole('button', { name: 'Invoke gRPC method' }));
    act(() => {
      useRequestStore.getState().switchTab('tab-other');
    });
    await act(async () => {
      rejectRun?.(new Error('delayed gRPC failure'));
    });

    await waitFor(() => {
      const state = useRequestStore.getState();
      expect(state.tabs.find((tab) => tab.id === 'tab-origin')?.response).toMatchObject({
        requestId: 'request-origin',
        status: 2,
        body: expect.stringContaining('delayed gRPC failure'),
      });
      expect(state.tabs.find((tab) => tab.id === 'tab-other')?.response).toBeUndefined();
    });
  });

  it('runs a server stream through the registry runner with live hooks (#917)', async () => {
    useRequestStore.setState({
      tabs: [
        {
          id: 'tab-origin',
          request: { ...makeRequest('request-origin', 'Origin'), methodType: 'server-streaming' },
          isDirty: false,
        },
      ],
      activeTabId: 'tab-origin',
    });
    const streamed: GrpcResponse = {
      ...makeResponse('request-origin'),
      body: '[{"n":1},{"n":2}]',
      messages: ['{"n":1}', '{"n":2}'],
      isStreaming: true,
    };
    runnerMocks.run.mockImplementation(
      async (
        _req: GrpcRequest,
        _protocol: string,
        options: {
          stream?: {
            onOpen?: (c: unknown) => void;
            onMessage?: (m: unknown) => void;
          };
        }
      ) => {
        options.stream?.onOpen?.({ send: vi.fn(), closeSend: vi.fn(), cancel: vi.fn() });
        options.stream?.onMessage?.({ n: 1 });
        options.stream?.onMessage?.({ n: 2 });
        return { response: streamed, durationMs: 3 };
      }
    );
    render(<GrpcRequestBuilder />);

    fireEvent.click(screen.getByRole('button', { name: 'Invoke gRPC method' }));

    await waitFor(() => {
      const tab = useRequestStore.getState().tabs.find((t) => t.id === 'tab-origin');
      expect(tab?.response).toEqual(streamed);
    });
    expect(runnerMocks.run).toHaveBeenCalledTimes(1);
    expect(runnerMocks.run.mock.calls[0]?.[1]).toBe('grpc');
    expect(runnerMocks.run.mock.calls[0]?.[2]).toMatchObject({
      stream: { onOpen: expect.any(Function), onMessage: expect.any(Function) },
    });
    expect(await screen.findByText('Stream')).toBeInTheDocument();
    expect(useRequestStore.getState().isLoading).toBe(false);
  });
  it('ignores a cancelled stream that settles after a newer send started', async () => {
    useRequestStore.setState({
      tabs: [
        {
          id: 'tab-origin',
          request: { ...makeRequest('request-origin', 'Origin'), methodType: 'server-streaming' },
          isDirty: false,
        },
      ],
      activeTabId: 'tab-origin',
    });
    type StreamOpts = { stream?: { onOpen?: (c: unknown) => void } };
    const settles: Array<(r: { response: GrpcResponse; durationMs: number }) => void> = [];
    const cancels: Array<ReturnType<typeof vi.fn>> = [];
    runnerMocks.run.mockImplementation(
      (_req: GrpcRequest, _protocol: string, options: StreamOpts) =>
        new Promise((resolve) => {
          const cancel = vi.fn();
          cancels.push(cancel);
          options.stream?.onOpen?.({ send: vi.fn(), closeSend: vi.fn(), cancel });
          settles.push(resolve);
        })
    );
    render(<GrpcRequestBuilder />);
    const cancelButton = () => screen.getAllByRole('button', { name: /Cancel/ }).at(-1) as Element;

    fireEvent.click(screen.getByRole('button', { name: 'Invoke gRPC method' }));
    await waitFor(() => expect(cancels).toHaveLength(1));
    fireEvent.click(cancelButton());
    expect(cancels[0]).toHaveBeenCalled();
    expect(useRequestStore.getState().isLoading).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Invoke gRPC method' }));
    await waitFor(() => expect(cancels).toHaveLength(2));
    const stale = { ...makeResponse('request-origin'), id: 'stale', grpcStatus: 1 };
    await act(async () => {
      settles[0]?.({ response: stale, durationMs: 1 });
    });

    // The first run's late completion leaves the live second stream intact.
    expect(useRequestStore.getState().tabs[0]?.response).toBeUndefined();
    expect(useRequestStore.getState().isLoading).toBe(true);
    fireEvent.click(cancelButton());
    expect(cancels[1]).toHaveBeenCalled();

    const fresh = { ...makeResponse('request-origin'), id: 'fresh' };
    await act(async () => {
      settles[1]?.({ response: fresh, durationMs: 1 });
    });
    await waitFor(() => expect(useRequestStore.getState().tabs[0]?.response).toEqual(fresh));
  });
});
