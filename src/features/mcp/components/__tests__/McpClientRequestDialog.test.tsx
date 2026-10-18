import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAiChatStore } from '@/features/ai/store';
import { McpClientRequestDialog } from '@/features/mcp/components/McpClientRequestDialog';
import { McpRootsPanel } from '@/features/mcp/components/McpRootsPanel';
import { useMcpClientRequestStore } from '@/features/mcp/store/useMcpClientRequestStore';

const mcp = {
  on: vi.fn(),
  removeListener: vi.fn(),
  respondClientRequest: vi.fn(),
  setRoots: vi.fn(),
};

const ELICIT_ID = '0f0e0d0c-0b0a-4908-8706-050403020100';
const SAMPLE_ID = '1f0e0d0c-0b0a-4908-8706-050403020100';

function queue(kind: 'elicitation' | 'sampling', params: unknown, requestId: string) {
  act(() => {
    useMcpClientRequestStore.getState().add({
      requestId,
      connectionId: 'conn-1',
      kind,
      params,
      receivedAt: Date.now(),
    });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mcp.respondClientRequest.mockResolvedValue({ success: true });
  useMcpClientRequestStore.setState({ requests: [] });
  useAiChatStore.setState({
    providerConfigs: { openai: null, anthropic: null, openrouter: null, 'openai-compatible': null },
  });
  (window as unknown as { electron: unknown }).electron = { isElectron: true, mcp };
});

afterEach(() => {
  delete (window as unknown as { electron?: unknown }).electron;
});

describe('McpClientRequestDialog — elicitation', () => {
  const params = {
    message: 'Deploy to prod?',
    requestedSchema: {
      type: 'object',
      properties: { confirm: { type: 'boolean', description: 'Really?' } },
      required: ['confirm'],
    },
  };

  it('renders nothing without a pending request for the connection', () => {
    const { container } = render(<McpClientRequestDialog connectionId="conn-2" />);
    queue('elicitation', params, ELICIT_ID);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText('Deploy to prod?')).toBeNull();
  });

  it('validates the form against the requested schema before accepting', async () => {
    render(<McpClientRequestDialog connectionId="conn-1" />);
    queue('elicitation', params, ELICIT_ID);
    expect(screen.getByText('Deploy to prod?')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    expect(await screen.findByText('Required.')).toBeInTheDocument();
    expect(mcp.respondClientRequest).not.toHaveBeenCalled();

    fireEvent.change(screen.getByPlaceholderText('true / false'), { target: { value: 'true' } });
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() =>
      expect(mcp.respondClientRequest).toHaveBeenCalledWith({
        kind: 'elicitation',
        connectionId: 'conn-1',
        requestId: ELICIT_ID,
        response: { action: 'accept', content: { confirm: true } },
      })
    );
    await waitFor(() => expect(screen.queryByText('Deploy to prod?')).toBeNull());
  });

  it.each(['Decline', 'Cancel'])('sends %s without content', async (label) => {
    render(<McpClientRequestDialog connectionId="conn-1" />);
    queue('elicitation', params, ELICIT_ID);
    fireEvent.click(screen.getByRole('button', { name: label }));
    await waitFor(() =>
      expect(mcp.respondClientRequest).toHaveBeenCalledWith(
        expect.objectContaining({ response: { action: label.toLowerCase() } })
      )
    );
  });

  it('shows field errors returned by main', async () => {
    mcp.respondClientRequest.mockResolvedValueOnce({
      success: false,
      error: 'Content does not match the requested schema',
      fieldErrors: { confirm: 'Must be true or false.' },
    });
    render(<McpClientRequestDialog connectionId="conn-1" />);
    queue('elicitation', params, ELICIT_ID);
    fireEvent.change(screen.getByPlaceholderText('true / false'), { target: { value: 'false' } });
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    expect(await screen.findByText('Must be true or false.')).toBeInTheDocument();
  });

  it('dismissing the dialog answers cancel', async () => {
    render(<McpClientRequestDialog connectionId="conn-1" />);
    queue('elicitation', params, ELICIT_ID);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() =>
      expect(mcp.respondClientRequest).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'elicitation', response: { action: 'cancel' } })
      )
    );
  });

  it('flags an unsupported schema', () => {
    render(<McpClientRequestDialog connectionId="conn-1" />);
    queue('elicitation', { message: 'x', requestedSchema: { properties: 1 } }, ELICIT_ID);
    expect(screen.getByText(/unsupported form schema/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept' })).toBeDisabled();
  });
});

describe('McpClientRequestDialog — sampling', () => {
  const params = {
    systemPrompt: 'You are terse',
    maxTokens: 32,
    modelPreferences: { hints: [{ name: 'claude' }], speedPriority: 0.5 },
    messages: [{ role: 'user', content: { type: 'text', text: 'Summarise the log' } }],
  };

  it('shows the full request and requires explicit approval with text', async () => {
    render(<McpClientRequestDialog connectionId="conn-1" />);
    queue('sampling', params, SAMPLE_ID);
    queue('elicitation', { message: 'later', requestedSchema: { properties: {} } }, ELICIT_ID);

    expect(screen.getByText('Summarise the log')).toBeInTheDocument();
    expect(screen.getByText('You are terse')).toBeInTheDocument();
    expect(screen.getByText('maxTokens: 32')).toBeInTheDocument();
    expect(screen.getByText('model hints: claude')).toBeInTheDocument();
    expect(screen.getByText(/1 more waiting/)).toBeInTheDocument();
    // No configured AI provider → no draft button.
    expect(screen.queryByRole('button', { name: /Draft with/ })).toBeNull();

    const approve = screen.getByRole('button', { name: 'Approve & send' });
    expect(approve).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Sampling response'), {
      target: { value: 'All good.' },
    });
    fireEvent.click(approve);
    await waitFor(() =>
      expect(mcp.respondClientRequest).toHaveBeenCalledWith({
        kind: 'sampling',
        connectionId: 'conn-1',
        requestId: SAMPLE_ID,
        response: { action: 'approve', text: 'All good.', model: 'restura-manual' },
      })
    );
    // The next queued request takes over.
    expect(await screen.findByText('later')).toBeInTheDocument();
  });

  it('rejects on Reject and surfaces errors', async () => {
    mcp.respondClientRequest.mockResolvedValueOnce({ success: false, error: 'boom' });
    render(<McpClientRequestDialog connectionId="conn-1" />);
    queue('sampling', params, SAMPLE_ID);
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(await screen.findByText('boom')).toBeInTheDocument();
    expect(mcp.respondClientRequest).toHaveBeenCalledWith(
      expect.objectContaining({ response: { action: 'reject' } })
    );
  });

  it('offers an AI-provider draft that still needs approval', async () => {
    const ai = {
      chat: vi.fn(async (spec: { streamId: string }) => {
        queueMicrotask(() => {
          chunk?.({ type: 'delta', text: 'Drafted.' });
          end?.({ reason: 'done' });
        });
        return { ok: true, streamId: spec.streamId };
      }),
      onChunk: vi.fn((_id: string, cb: (e: unknown) => void) => {
        chunk = cb;
        return () => undefined;
      }),
      onEnd: vi.fn((_id: string, cb: (e: unknown) => void) => {
        end = cb;
        return () => undefined;
      }),
    };
    let chunk: ((e: unknown) => void) | undefined;
    let end: ((e: unknown) => void) | undefined;
    (window as unknown as { electron: unknown }).electron = { isElectron: true, mcp, ai };
    useAiChatStore.setState({
      activeProvider: 'openai',
      providerConfigs: {
        openai: { provider: 'openai', defaultModel: 'gpt-test' },
        anthropic: null,
        openrouter: null,
        'openai-compatible': null,
      },
    });

    render(<McpClientRequestDialog connectionId="conn-1" />);
    queue('sampling', params, SAMPLE_ID);
    fireEvent.click(screen.getByRole('button', { name: /Draft with gpt-test/ }));
    await waitFor(() => expect(screen.getByLabelText('Sampling response')).toHaveValue('Drafted.'));
    expect(screen.getByLabelText('Response model')).toHaveValue('gpt-test');
    expect(mcp.respondClientRequest).not.toHaveBeenCalled();
  });
});

describe('McpRootsPanel', () => {
  it('drafts edits locally and saves only valid file:// roots', async () => {
    const onSave = vi.fn(async () => ({ ok: true as const }));
    render(<McpRootsPanel roots={[]} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: /Roots/ }));
    fireEvent.click(screen.getByRole('button', { name: /Add root/ }));
    fireEvent.change(screen.getByLabelText('Root 1 URI'), { target: { value: 'https://x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save roots' }));
    expect(await screen.findByText('Every root must be a file:// URI.')).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Root 1 URI'), {
      target: { value: 'file:///repo' },
    });
    fireEvent.change(screen.getByLabelText('Root 1 name'), { target: { value: 'repo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save roots' }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith([{ uri: 'file:///repo', name: 'repo' }])
    );
  });

  it('removes rows and surfaces save failures', async () => {
    const onSave = vi.fn(async () => ({ ok: false as const, error: 'Not allowed' }));
    render(
      <McpRootsPanel
        roots={[{ uri: 'file:///a' }, { uri: 'file:///b', name: 'b' }]}
        onSave={onSave}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Roots/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove root 1' }));
    fireEvent.change(screen.getByLabelText('Root 1 name'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save roots' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith([{ uri: 'file:///b' }]));
    expect(await screen.findByText('Not allowed')).toBeInTheDocument();
  });
});
