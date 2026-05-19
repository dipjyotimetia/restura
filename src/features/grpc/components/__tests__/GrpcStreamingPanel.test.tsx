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

const clientStreamRequest: GrpcRequest = {
  ...mockRequest,
  id: 'r2',
  name: 'Upload',
  methodType: 'client-streaming',
  method: 'Upload',
};

const bidiRequest: GrpcRequest = {
  ...mockRequest,
  id: 'r3',
  name: 'Chat',
  methodType: 'bidirectional-streaming',
  method: 'Chat',
};

/** A test handle that exposes manual control over inbound messages. */
function makeControlledHandle() {
  let pushMsg!: (m: unknown) => void;
  let endMessages!: () => void;
  const sent: unknown[] = [];

  const messages = (async function* () {
    const buffer: unknown[] = [];
    let resolver: (() => void) | null = null;
    let finished = false;
    pushMsg = (m) => {
      buffer.push(m);
      resolver?.();
      resolver = null;
    };
    endMessages = () => {
      finished = true;
      resolver?.();
      resolver = null;
    };
    while (true) {
      while (buffer.length > 0) {
        yield buffer.shift();
      }
      if (finished) return;
      await new Promise<void>((res) => {
        resolver = res;
      });
    }
  })();

  const handle = {
    messages,
    send: vi.fn(async (m: unknown) => {
      sent.push(m);
    }),
    closeSend: vi.fn(() => {
      // Caller may follow with pushMsg() to simulate the unary response.
    }),
    cancel: vi.fn(() => {
      endMessages();
    }),
    done: new Promise<{ headers: Record<string, string>; trailers: Record<string, string>; status: number }>(() => {
      /* never resolves — controlled via cancel / endMessages */
    }),
  };

  return { handle, pushMsg: (m: unknown) => pushMsg(m), endMessages: () => endMessages(), sent };
}

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

  it('bidi: sends record into outbound history and renders received frames with direction', async () => {
    const { handle, pushMsg, sent } = makeControlledHandle();
    vi.mocked(streamingModule.startGrpcStream).mockResolvedValue(handle as never);

    render(<GrpcStreamingPanel request={bidiRequest} />);
    fireEvent.click(screen.getByRole('button', { name: /start stream/i }));

    // Wait for streaming UI to mount.
    const sendBtn = await screen.findByRole('button', { name: /send message/i });

    // Send an outbound frame.
    const textarea = screen.getByLabelText(/streaming message json/i);
    fireEvent.change(textarea, { target: { value: '{"hi":"world"}' } });
    fireEvent.click(sendBtn);

    // Outbound frame rendered with direction marker.
    await waitFor(() => {
      const outFrames = screen.getAllByTestId('grpc-frame-out');
      expect(outFrames).toHaveLength(1);
      expect(outFrames[0]?.textContent).toContain('"hi": "world"');
    });
    expect(sent).toEqual([{ hi: 'world' }]);

    // Simulate server reply, verify it renders as inbound.
    pushMsg({ echo: 'hi' });
    await waitFor(() => {
      const inFrames = screen.getAllByTestId('grpc-frame-in');
      expect(inFrames).toHaveLength(1);
      expect(inFrames[0]?.textContent).toContain('"echo": "hi"');
    });
  });

  it('client-streaming: End button calls closeSend and surfaces "Awaiting response" status', async () => {
    const { handle, pushMsg } = makeControlledHandle();
    vi.mocked(streamingModule.startGrpcStream).mockResolvedValue(handle as never);

    render(<GrpcStreamingPanel request={clientStreamRequest} />);
    fireEvent.click(screen.getByRole('button', { name: /start stream/i }));

    // Send a couple of outbound frames.
    const textarea = await screen.findByLabelText(/streaming message json/i);
    fireEvent.change(textarea, { target: { value: '{"n":1}' } });
    fireEvent.click(screen.getByRole('button', { name: /send message/i }));
    fireEvent.change(textarea, { target: { value: '{"n":2}' } });
    fireEvent.click(screen.getByRole('button', { name: /send message/i }));

    await waitFor(() => {
      expect(screen.getAllByTestId('grpc-frame-out')).toHaveLength(2);
    });

    // Click "Done sending" (the End button's label changes for client-streaming).
    fireEvent.click(screen.getByRole('button', { name: /end outbound stream/i }));
    expect(handle.closeSend).toHaveBeenCalled();

    // Status switches to "Awaiting response" until the server replies.
    await waitFor(() => {
      expect(screen.getByText(/awaiting response/i)).toBeInTheDocument();
    });

    // Server sends single summary reply — status should close.
    pushMsg({ summary: { count: 2 } });
    await waitFor(() => {
      expect(screen.getByText(/closed/i)).toBeInTheDocument();
      const inFrames = screen.getAllByTestId('grpc-frame-in');
      expect(inFrames).toHaveLength(1);
    });
  });
});
