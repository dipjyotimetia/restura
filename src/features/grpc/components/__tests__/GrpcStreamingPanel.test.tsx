import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { GrpcStreamingPanel } from '../GrpcStreamingPanel';
import * as streamingModule from '../../lib/grpcStreamingClient';
import type { GrpcRequest } from '@/types';

vi.mock('../../lib/grpcStreamingClient');
vi.mock('@/store/useEnvironmentStore', () => ({
  useEnvironmentStore: (selector: (s: unknown) => unknown) =>
    selector({ resolveVariables: (s: string) => s }),
}));

const mockRequest: GrpcRequest = {
  id: 'r1',
  name: 'Watch',
  type: 'grpc',
  methodType: 'server-streaming',
  url: 'https://example.com',
  service: 'svc.v1.Foo',
  method: 'Watch',
  metadata: [],
  message: '{}',
  auth: { type: 'none' },
};

describe('GrpcStreamingPanel', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('starts streaming and renders messages as they arrive', async () => {
    async function* messageGen() {
      yield { i: 1 };
      yield { i: 2 };
    }
    const handle = {
      messages: messageGen(),
      send: vi.fn().mockRejectedValue(new Error('not supported')),
      closeSend: vi.fn(),
      cancel: vi.fn(),
      done: Promise.resolve({ headers: {}, trailers: {}, status: 0 }),
    };
    vi.mocked(streamingModule.startGrpcStream).mockResolvedValue(handle as never);

    render(<GrpcStreamingPanel request={mockRequest} />);
    fireEvent.click(screen.getByRole('button', { name: /start stream/i }));

    await waitFor(() => {
      expect(screen.getByText(/"i": 1/)).toBeInTheDocument();
      expect(screen.getByText(/"i": 2/)).toBeInTheDocument();
    });
  });

  it('renders error when stream fails to start', async () => {
    vi.mocked(streamingModule.startGrpcStream).mockRejectedValue(new Error('connect refused'));
    render(<GrpcStreamingPanel request={mockRequest} />);
    fireEvent.click(screen.getByRole('button', { name: /start stream/i }));
    await waitFor(() => {
      expect(screen.getByText(/connect refused/i)).toBeInTheDocument();
    });
  });

  it('cancel button calls handle.cancel()', async () => {
    async function* hangingGen() {
      yield { i: 1 };
      // Hang forever — represents an open server stream.
      await new Promise(() => {
        /* never resolves */
      });
    }
    const cancel = vi.fn();
    const handle = {
      messages: hangingGen(),
      send: vi.fn(),
      closeSend: vi.fn(),
      cancel,
      done: new Promise<never>(() => {
        /* never resolves */
      }),
    };
    vi.mocked(streamingModule.startGrpcStream).mockResolvedValue(handle as never);

    render(<GrpcStreamingPanel request={mockRequest} />);
    fireEvent.click(screen.getByRole('button', { name: /start stream/i }));
    // Wait for the streaming state to be visible (cancel button appears)
    const cancelButton = await screen.findByRole('button', { name: /cancel stream/i });
    fireEvent.click(cancelButton);
    expect(cancel).toHaveBeenCalled();
  });
});
