/** #944 — live lint for unknown keys in the gRPC request editor. */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useRequestStore } from '@/store/useRequestStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import type { GrpcRequest, GrpcUnknownFieldsMode } from '@/types';
import { GrpcUnknownFieldsLint } from '../GrpcUnknownFieldsLint';

const PROTO = `syntax = "proto3";
package greet.v1;
message Item { string sku_id = 1; }
message HelloRequest { string name = 1; repeated Item items = 2; }
service Greeter { rpc SayHello(HelloRequest) returns (HelloRequest); }`;

const MESSAGE = '{\n  "nmae": "{{who}}",\n  "items": [{ "skuId": "a", "zzz": 1 }]\n}';

function seed(message: string, extra: Partial<GrpcRequest> = {}) {
  const request: GrpcRequest = {
    id: 'req-1',
    name: 'SayHello',
    type: 'grpc',
    methodType: 'unary',
    url: 'http://localhost:50051',
    service: 'greet.v1.Greeter',
    method: 'SayHello',
    metadata: [],
    message,
    auth: { type: 'none' },
    schema: { kind: 'proto', fileName: 'greet.proto', text: PROTO },
    ...extra,
  };
  useRequestStore.setState({
    tabs: [{ id: 'tab-1', request, isDirty: false }],
    activeTabId: 'tab-1',
    isLoading: false,
  });
}

const setMode = (grpcUnknownFields: GrpcUnknownFieldsMode | undefined) =>
  useSettingsStore.setState((s) => ({ settings: { ...s.settings, grpcUnknownFields } }));

beforeEach(() => setMode(undefined));

describe('GrpcUnknownFieldsLint', () => {
  it('flags unknown keys live (default warn) and offers a rename quick fix', () => {
    seed(MESSAGE);
    const onChange = vi.fn();
    render(<GrpcUnknownFieldsLint onMessageChange={onChange} />);
    const lint = screen.getByRole('status', { name: 'Unknown request fields' });
    expect(lint.textContent).toContain('2 unknown fields');
    expect(lint.textContent).toContain('dropped when sent');
    expect(lint.textContent).toContain('items[0].zzz');

    fireEvent.click(screen.getByRole('button', { name: 'Rename nmae to name' }));
    expect(onChange).toHaveBeenCalledWith(MESSAGE.replace('"nmae"', '"name"'));
    // No suggestion for a key with no near miss.
    expect(screen.queryByRole('button', { name: /Rename items\[0\]\.zzz/ })).toBeNull();
  });

  it('removes all unknown keys on request', () => {
    seed(MESSAGE);
    const onChange = vi.fn();
    render(<GrpcUnknownFieldsLint onMessageChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove all' }));
    const next = onChange.mock.calls[0]![0] as string;
    expect(next).not.toContain('nmae');
    expect(next).not.toContain('zzz');
    expect(next).toContain('"skuId": "a"');
  });

  it('says sending is blocked in block mode', () => {
    setMode('block');
    seed(MESSAGE);
    render(<GrpcUnknownFieldsLint onMessageChange={vi.fn()} />);
    expect(screen.getByRole('status').textContent).toContain('sending is blocked');
  });

  it('renders nothing when off, when the message is clean, or without a schema', () => {
    setMode('off');
    seed(MESSAGE);
    const { container, rerender } = render(<GrpcUnknownFieldsLint onMessageChange={vi.fn()} />);
    expect(container.firstChild).toBeNull();

    setMode('warn');
    seed('{"name": "x"}');
    rerender(<GrpcUnknownFieldsLint onMessageChange={vi.fn()} />);
    expect(container.firstChild).toBeNull();

    seed(MESSAGE, { schema: undefined });
    rerender(<GrpcUnknownFieldsLint onMessageChange={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });
});
