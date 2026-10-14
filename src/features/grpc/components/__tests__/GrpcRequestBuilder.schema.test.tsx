/**
 * #871 / #921 — the builder persists the gRPC schema snapshot (reflection
 * descriptors or uploaded .proto) and the timeout on the request itself, so
 * they survive tab switches/reload and travel with Save-to-Collection.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UseGrpcReflectionOptions } from '@/features/grpc/hooks/useGrpcReflection';
import type { GrpcRequest, ReflectionServiceInfo } from '@/types';

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  reflectionOptions: null as UseGrpcReflectionOptions | null,
}));

const reflectedService: ReflectionServiceInfo = {
  name: 'TestService',
  fullName: 'test.v1.TestService',
  methods: [],
  descriptors: ['REFLECTED='],
};

vi.mock('@/features/registry/useRequestRunner', () => ({
  useRequestRunner: () => ({ run: mocks.run, abort: vi.fn() }),
}));

vi.mock('@/features/grpc/hooks/useGrpcReflection', () => ({
  useGrpcReflection: (opts: UseGrpcReflectionOptions) => {
    mocks.reflectionOptions = opts;
    return {
      result: { success: true, services: [reflectedService], serverUrl: 'x', timestamp: 1 },
      selectedService: reflectedService,
      selectedMethod: null,
      loading: false,
      showSchema: false,
      setShowSchema: vi.fn(),
      selectService: vi.fn(),
      selectMethod: vi.fn(),
      discover: vi.fn(),
    };
  },
}));

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

function makeRequest(extra: Partial<GrpcRequest> = {}): GrpcRequest {
  return {
    id: 'req-1',
    name: 'Ping',
    type: 'grpc',
    methodType: 'unary',
    url: 'https://grpc.example.com',
    service: 'test.v1.TestService',
    method: 'Ping',
    metadata: [],
    message: '{}',
    auth: { type: 'none' },
    ...extra,
  };
}

const activeRequest = () =>
  useRequestStore.getState().tabs.find((t) => t.id === 'tab-1')?.request as GrpcRequest;

function seed(extra: Partial<GrpcRequest> = {}) {
  useRequestStore.setState({
    tabs: [{ id: 'tab-1', request: makeRequest(extra), isDirty: false }],
    activeTabId: 'tab-1',
    isLoading: false,
  });
}

beforeEach(() => {
  mocks.run.mockReset().mockResolvedValue({
    response: {
      id: 'r',
      requestId: 'req-1',
      status: 200,
      statusText: 'OK',
      headers: {},
      body: '{}',
      size: 2,
      time: 1,
      timestamp: 1,
      grpcStatus: 0,
    },
    durationMs: 1,
  });
  mocks.reflectionOptions = null;
});

describe('GrpcRequestBuilder — persisted schema snapshot + timeout', () => {
  it('records the reflected descriptor set on the request when a service is selected', () => {
    seed();
    render(<GrpcRequestBuilder />);
    act(() => mocks.reflectionOptions?.onServiceSelected?.(reflectedService));
    expect(activeRequest().schema).toEqual({ kind: 'descriptors', descriptors: ['REFLECTED='] });
  });

  it('does not let reflection overwrite an uploaded .proto snapshot', () => {
    const proto = { kind: 'proto' as const, fileName: 'a.proto', text: 'syntax = "proto3";' };
    seed({ schema: proto });
    render(<GrpcRequestBuilder />);
    act(() => mocks.reflectionOptions?.onServiceSelected?.(reflectedService));
    expect(activeRequest().schema).toEqual(proto);
  });

  it('persists an uploaded .proto on the request and sends it (precedence over reflection)', async () => {
    seed();
    render(<GrpcRequestBuilder />);
    const text =
      'syntax = "proto3";\npackage test.v1;\nmessage A {}\nmessage B {}\nservice TestService { rpc Ping (A) returns (B); }';
    const file = new File([text], 'test.proto', { type: 'text/plain' });
    fireEvent.change(screen.getByLabelText('Upload .proto file'), { target: { files: [file] } });
    await waitFor(() =>
      expect(activeRequest().schema).toEqual({ kind: 'proto', fileName: 'test.proto', text })
    );
    // Survives a remount (tab switch) — the uploader shows the saved name.
    expect(screen.getByRole('button', { name: /test\.proto/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Invoke gRPC method' }));
    await waitFor(() => expect(mocks.run).toHaveBeenCalled());
    const opts = mocks.run.mock.calls[0]![2].protocolOptions;
    expect(opts.protoContent).toBe(text);
    expect(opts.protoFileName).toBe('test.proto');
    expect(opts.descriptors).toBeUndefined();
  });

  it('compiles a multi-file upload into an uploaded descriptor snapshot and sends it (#891)', async () => {
    seed();
    render(<GrpcRequestBuilder />);
    const svc = new File(
      [
        'syntax = "proto3";\npackage test.v1;\nimport "types.proto";\nimport "google/protobuf/empty.proto";\n' +
          'service TestService { rpc Ping (google.protobuf.Empty) returns (test.v1.Pong); }',
      ],
      'svc.proto'
    );
    const types = new File(
      ['syntax = "proto3";\npackage test.v1;\nmessage Pong { string msg = 1; }'],
      'types.proto'
    );
    fireEvent.change(screen.getByLabelText('Upload .proto file'), {
      target: { files: [svc, types] },
    });
    const { toast } = await import('sonner');
    await waitFor(() => {
      expect(vi.mocked(toast.error).mock.calls).toEqual([]);
      expect(activeRequest().schema).toMatchObject({
        kind: 'descriptors',
        fileName: 'svc.proto +1',
      });
    });
    const schema = activeRequest().schema as { descriptors: string[]; fileName?: string };
    expect(screen.getByRole('button', { name: /svc\.proto \+1/ })).toBeTruthy();

    // Reflection must not overwrite the user's upload.
    act(() => mocks.reflectionOptions?.onServiceSelected?.(reflectedService));
    expect(activeRequest().schema).toEqual(schema);

    fireEvent.click(screen.getByRole('button', { name: 'Invoke gRPC method' }));
    await waitFor(() => expect(mocks.run).toHaveBeenCalled());
    const opts = mocks.run.mock.calls[0]![2].protocolOptions;
    expect(opts.descriptors).toEqual(schema.descriptors);
  });

  it('persists the timeout on the request and sends it as timeoutMs', async () => {
    seed();
    render(<GrpcRequestBuilder />);
    fireEvent.click(screen.getByRole('tab', { name: /Settings/ }));
    const timeoutInput = screen.getByLabelText('gRPC request timeout in milliseconds');
    fireEvent.change(timeoutInput, { target: { value: '5000' } });
    // The deadline field commits on blur/Enter, not per keystroke.
    fireEvent.blur(timeoutInput);
    expect(activeRequest().timeout).toBe(5000);
    fireEvent.click(screen.getByRole('button', { name: 'Invoke gRPC method' }));
    await waitFor(() => expect(mocks.run).toHaveBeenCalled());
    expect(mocks.run.mock.calls[0]![2].protocolOptions.timeoutMs).toBe(5000);
  });
});
