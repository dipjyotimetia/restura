import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GrpcRequest } from '@/types';

const mocks = vi.hoisted(() => ({ run: vi.fn(), abort: vi.fn() }));

vi.mock('@/features/registry/useRequestRunner', () => ({
  useRequestRunner: () => ({ run: mocks.run, abort: mocks.abort }),
}));
vi.mock('@/features/grpc/hooks/useGrpcReflection', () => ({
  useGrpcReflection: () => ({
    result: { success: false, services: [], error: 'connect ECONNREFUSED', timestamp: 1 },
    selectedService: null,
    selectedMethod: null,
    loading: false,
    showSchema: false,
    setShowSchema: vi.fn(),
    selectService: vi.fn(),
    selectMethod: vi.fn(),
    discover: vi.fn(),
  }),
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
import { GrpcInvocationBar } from '../GrpcInvocationBar';
import { GrpcMethodSelector } from '../GrpcMethodSelector';
import GrpcRequestBuilder from '../GrpcRequestBuilder';

const PROTO = `syntax = "proto3";
package demo.v1;
message HelloRequest { string name = 1; }
service Greeter {
  rpc SayHello (HelloRequest) returns (HelloRequest);
  rpc Chat (stream HelloRequest) returns (stream HelloRequest);
}`;

function makeRequest(extra: Partial<GrpcRequest> = {}): GrpcRequest {
  return {
    id: 'req-1',
    name: 'Hello',
    type: 'grpc',
    methodType: 'unary',
    url: 'grpc://localhost:50051',
    service: '',
    method: '',
    metadata: [{ id: 'm', key: 'x-tenant', value: 'acme', enabled: true }],
    message: '{}',
    auth: { type: 'none' },
    ...extra,
  };
}

const active = () =>
  useRequestStore.getState().tabs.find((t) => t.id === 'tab-1')?.request as GrpcRequest;

function seed(extra: Partial<GrpcRequest> = {}, isLoading = false) {
  useRequestStore.setState({
    tabs: [{ id: 'tab-1', request: makeRequest(extra), isDirty: false }],
    activeTabId: 'tab-1',
    isLoading,
  });
}

beforeEach(() => {
  vi.mocked(toast.info).mockClear();
  mocks.abort.mockClear();
});

describe('GrpcRequestBuilder — uploaded .proto drives the method picker', () => {
  it('uploading picks the first method and generates its request template', async () => {
    seed();
    render(<GrpcRequestBuilder />);
    const file = new File([PROTO], 'demo.proto', { type: 'text/plain' });
    fireEvent.change(screen.getByLabelText('Upload .proto file'), { target: { files: [file] } });
    await waitFor(() => expect(active().schema?.kind).toBe('proto'));
    expect(active().service).toBe('demo.v1.Greeter');
    expect(active().method).toBe('SayHello');
    expect(JSON.parse(active().message)).toEqual({ name: '<name>' });
  });

  it('offers uploaded services in dropdowns even when reflection failed', () => {
    seed({
      schema: { kind: 'proto', fileName: 'demo.proto', text: PROTO },
      service: 'demo.v1.Greeter',
      method: 'SayHello',
    });
    render(<GrpcRequestBuilder />);
    expect(screen.queryByPlaceholderText(/Service \(e\.g\./)).toBeNull();
    expect(screen.getAllByRole('combobox').length).toBeGreaterThanOrEqual(2);
  });
});

describe('GrpcRequestBuilder — web limits, shortcuts, codegen', () => {
  it('web: client/bidi are marked desktop-only and not selectable', () => {
    seed();
    render(<GrpcRequestBuilder />);
    fireEvent.click(screen.getByRole('radio', { name: /Bidi/ }));
    expect(active().methodType).toBe('unary');
    expect(toast.info).toHaveBeenCalledWith('Desktop only', expect.anything());
  });

  it('web: the reflection-failure banner says native gRPC needs the desktop app', () => {
    seed();
    render(<GrpcRequestBuilder />);
    expect(
      screen.getByText(/native gRPC \(HTTP\/2-only\) server needs the Restura desktop app/)
    ).toBeTruthy();
  });

  it('Cmd/Ctrl+Enter while a call is in flight cancels it', () => {
    seed({ service: 'demo.v1.Greeter', method: 'SayHello' }, true);
    render(<GrpcRequestBuilder />);
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });
    expect(mocks.abort).toHaveBeenCalled();
  });

  it('Code opens grpcurl / buf curl for the request', () => {
    seed({ service: 'demo.v1.Greeter', method: 'SayHello', message: '{"name":"x"}' });
    render(<GrpcRequestBuilder />);
    fireEvent.click(screen.getByRole('button', { name: 'Generate code' }));
    const code = within(screen.getByRole('dialog')).getByLabelText(/Generated grpcurl code/);
    expect(code.textContent).toContain('grpcurl -plaintext');
    expect(code.textContent).toContain("-H 'x-tenant: acme'");
    expect(code.textContent).toContain("'demo.v1.Greeter/SayHello'");
  });
});

describe('GrpcMethodSelector a11y', () => {
  it('labels the free-text fields and announces validation errors', () => {
    render(
      <GrpcMethodSelector
        services={[]}
        selectedService={null}
        selectedMethod={null}
        serviceValue=""
        methodValue=""
        serviceValidation={{ valid: false, error: 'Service is required' }}
        methodValidation={{ valid: true }}
        onSelectService={vi.fn()}
        onSelectMethod={vi.fn()}
        onServiceTextChange={vi.fn()}
        onMethodTextChange={vi.fn()}
      />
    );
    expect(screen.getByRole('textbox', { name: 'gRPC service' })).toHaveAttribute(
      'aria-invalid',
      'true'
    );
    expect(screen.getByRole('textbox', { name: 'gRPC method' })).toBeTruthy();
    expect(screen.getByRole('alert')).toHaveTextContent('Service is required');
  });
});

describe('GrpcInvocationBar', () => {
  it('renders a single Cancel while a stream is active', () => {
    render(
      <GrpcInvocationBar
        methodType="server-streaming"
        url="grpc://x:1"
        isLoading
        isFormValid
        streamControl={{ sendMessage: vi.fn(), endStream: vi.fn(), cancelStream: vi.fn() }}
        isUrlValid
        onMethodTypeChange={vi.fn()}
        onUrlChange={vi.fn()}
        onSend={vi.fn()}
        onCancelStream={vi.fn()}
      />
    );
    expect(screen.getAllByRole('button', { name: /cancel/i })).toHaveLength(1);
  });
});
