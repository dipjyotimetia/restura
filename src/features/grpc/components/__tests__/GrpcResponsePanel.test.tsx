import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useRequestStore } from '@/store/useRequestStore';
import type { GrpcRequest, GrpcResponse } from '@/types';
import { GrpcResponsePanel } from '../GrpcResponsePanel';

vi.mock('@/components/shared/CodeEditor', () => ({
  default: ({ value }: { value: string }) => <pre data-testid="editor">{value}</pre>,
}));

const response: GrpcResponse = {
  id: 'res',
  requestId: 'req',
  status: 0,
  statusText: 'OK',
  headers: { 'content-type': 'application/grpc', 'x-request-id': 'abc' },
  body: '{"message":"hi"}',
  size: 16,
  time: 12,
  timestamp: 0,
  grpcStatus: 0,
  grpcStatusText: '',
  trailers: { 'grpc-status': '0' },
};

describe('GrpcResponsePanel', () => {
  beforeEach(() => {
    useRequestStore.setState({
      tabs: [
        {
          id: 'tab',
          request: { id: 'req', name: 'Echo', type: 'grpc' } as GrpcRequest,
          response,
        },
      ] as never,
      activeTabId: 'tab',
    });
  });

  it('shows the body with JSON tools and leading metadata in its own tab', async () => {
    render(<GrpcResponsePanel />);
    expect(await screen.findByTestId('editor')).toHaveTextContent('"message": "hi"');
    expect(screen.getByRole('button', { name: 'Copy result' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: /Headers/ }));
    expect(screen.getByText('x-request-id')).toBeInTheDocument();
    expect(screen.getByText('abc')).toBeInTheDocument();
  });

  it('has no Error details tab when the response carries none', () => {
    render(<GrpcResponsePanel />);
    expect(screen.queryByRole('tab', { name: /Error details/ })).not.toBeInTheDocument();
  });

  it('renders decoded rich error details, unknown Any as raw base64 (#883)', async () => {
    useRequestStore.setState({
      tabs: [
        {
          id: 'tab',
          request: { id: 'req', name: 'Echo', type: 'grpc' } as GrpcRequest,
          response: {
            ...response,
            grpcStatus: 3,
            grpcStatusText: 'INVALID_ARGUMENT',
            statusDetails: [
              {
                type: 'google.rpc.BadRequest',
                value: { fieldViolations: [{ field: 'user.email', description: 'invalid' }] },
              },
              { type: 'acme.v1.Custom', raw: 'AQI=', debug: { hint: 'x' } },
            ],
          },
        },
      ] as never,
      activeTabId: 'tab',
    });
    render(<GrpcResponsePanel />);
    await userEvent.click(screen.getByRole('tab', { name: /Error details/ }));
    const list = screen.getByRole('list', { name: 'Error details' });
    expect(list).toHaveTextContent('BadRequest');
    expect(list).toHaveTextContent('"field": "user.email"');
    expect(list).toHaveTextContent('acme.v1.Custom');
    expect(list).toHaveTextContent('AQI=');
    expect(list).toHaveTextContent('"hint": "x"');
  });
});
