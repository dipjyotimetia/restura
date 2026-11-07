import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type ProviderConfig, useAiChatStore } from '@/features/ai/store';
import { useRequestStore } from '@/store/useRequestStore';
import type { HttpRequest } from '@/types';

type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: string }
  | { type: 'usage'; usage: Record<string, unknown> }
  | { type: 'error'; message: string }
  | { type: 'wait'; promise: Promise<void> };

const h = vi.hoisted(() => ({
  chat: vi.fn(async (_spec: unknown): Promise<{ ok: boolean; error?: string }> => ({ ok: true })),
  cancel: vi.fn(),
  hasAi: true,
  /** One entry per send (FIFO); a send with no queued turn streams nothing. */
  turns: [] as StreamEvent[][],
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

vi.mock('@/lib/shared/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/shared/platform')>();
  return {
    ...actual,
    isElectron: () => true,
    getElectronAPI: () => (h.hasAi ? { ai: { chat: h.chat, cancel: h.cancel } } : {}),
  };
});

vi.mock('@/features/ai/lib/streamConsumer', () => ({
  consumeStream: () => {
    const events = h.turns.shift() ?? [];
    return {
      async *[Symbol.asyncIterator]() {
        for (const ev of events) {
          if (ev.type === 'wait') await ev.promise;
          else yield ev;
        }
      },
    };
  },
}));

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), h.toast),
}));

import { ChatPanel } from '../ChatPanel';

const KEY_ID = '00000000-0000-4000-8000-000000000001';

function httpReq(id: string, url: string, extra: Partial<HttpRequest> = {}): HttpRequest {
  return {
    id,
    name: id,
    type: 'http',
    method: 'GET',
    url,
    headers: [],
    params: [],
    body: { type: 'none' },
    auth: { type: 'none' },
    ...extra,
  };
}

function openTab(req: HttpRequest): string {
  useRequestStore.getState().openTab(req, { switchTo: true });
  return useRequestStore.getState().activeTabId as string;
}

function activeRequest(): HttpRequest {
  const st = useRequestStore.getState();
  return st.tabs.find((t) => t.id === st.activeTabId)?.request as HttpRequest;
}

function configure(provider: 'anthropic' | 'openai-compatible' | null, extra = {}): void {
  const cfg: ProviderConfig | null =
    provider === 'anthropic'
      ? {
          provider: 'anthropic',
          defaultModel: 'claude-x',
          apiKeyRef: { kind: 'handle', id: KEY_ID },
          ...extra,
        }
      : provider === 'openai-compatible'
        ? {
            provider: 'openai-compatible',
            defaultModel: 'llama',
            baseUrlOverride: 'http://localhost:11434/v1',
            ...extra,
          }
        : null;
  useAiChatStore.setState({
    activeProvider: provider ?? 'anthropic',
    providerConfigs: {
      openai: null,
      anthropic: provider === 'anthropic' ? cfg : null,
      openrouter: null,
      'openai-compatible': provider === 'openai-compatible' ? cfg : null,
    },
    conversations: {},
    activeConversationId: null,
    agentSession: null,
    queuedAction: null,
    agentToolsEnabled: false,
  } as never);
}

type Spec = {
  provider: string;
  model: string;
  apiKeyHandleId?: string;
  baseUrlOverride?: string;
  rawMode: boolean;
  tools?: unknown[];
  messages: Array<{ role: string; content: string }>;
};
const specAt = (i: number): Spec => h.chat.mock.calls[i]?.[0] as Spec;

function activeMessages() {
  const st = useAiChatStore.getState();
  return st.activeConversationId ? (st.conversations[st.activeConversationId]?.messages ?? []) : [];
}

function send(text: string): void {
  fireEvent.change(screen.getByLabelText('Chat message'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const toolCall = (id: string, name: string, input: unknown): StreamEvent => ({
  type: 'tool_call',
  id,
  name,
  input: typeof input === 'string' ? input : JSON.stringify(input),
});

beforeEach(() => {
  h.chat.mockReset();
  h.chat.mockResolvedValue({ ok: true });
  h.cancel.mockReset();
  h.hasAi = true;
  h.turns = [];
  h.toast.error.mockReset();
  h.toast.success.mockReset();
  h.toast.info.mockReset();
  useRequestStore.setState({ tabs: [], activeTabId: null });
  configure('anthropic');
});

describe('ChatPanel chat flow', () => {
  it('creates a conversation on mount and streams a reply with its cost', async () => {
    openTab(httpReq('a', 'https://api.example/users'));
    h.turns.push([
      { type: 'delta', text: 'Hello ' },
      { type: 'delta', text: 'there' },
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 2, estimatedCostUSD: 0.0123 } },
    ]);
    render(<ChatPanel onClose={() => {}} />);
    expect(useAiChatStore.getState().activeConversationId).not.toBeNull();
    send('why 500?');
    await waitFor(() => expect(screen.getByText('Hello there')).toBeInTheDocument());
    expect(screen.getByText('Conversation cost: $0.0123')).toBeInTheDocument();
    const spec = specAt(0);
    expect(spec).toMatchObject({
      provider: 'anthropic',
      model: 'claude-x',
      apiKeyHandleId: KEY_ID,
      rawMode: false,
    });
    expect(spec.tools).toBeUndefined();
    expect(spec.baseUrlOverride).toBeUndefined();
    const msgs = activeMessages();
    expect(msgs.map((m) => [m.role, m.status])).toEqual([
      ['user', 'done'],
      ['assistant', 'done'],
    ]);
  });

  it('shows no cost line when no turn reported a cost', async () => {
    h.turns.push([{ type: 'delta', text: 'free' }]);
    render(<ChatPanel onClose={() => {}} />);
    send('hi');
    await waitFor(() => expect(screen.getByText('free')).toBeInTheDocument());
    expect(screen.queryByText(/Conversation cost/)).not.toBeInTheDocument();
  });

  it('sends a local provider without a key handle but with its base URL', async () => {
    configure('openai-compatible');
    render(<ChatPanel onClose={() => {}} />);
    send('hi');
    await waitFor(() => expect(h.chat).toHaveBeenCalledTimes(1));
    expect(specAt(0).apiKeyHandleId).toBeUndefined();
    expect(specAt(0).baseUrlOverride).toBe('http://localhost:11434/v1');
  });

  it('reports the IPC error when ai.chat is refused', async () => {
    h.chat.mockResolvedValue({ ok: false, error: 'API key not found' });
    render(<ChatPanel onClose={() => {}} />);
    send('hi');
    await waitFor(() => expect(screen.getByText('API key not found')).toBeInTheDocument());
    expect(activeMessages().at(-1)?.status).toBe('error');
  });

  it('falls back to "Unknown error" when the refusal has no message', async () => {
    h.chat.mockResolvedValue({ ok: false });
    render(<ChatPanel onClose={() => {}} />);
    send('hi');
    await waitFor(() => expect(screen.getByText('Unknown error')).toBeInTheDocument());
  });

  it('explains when the AI bridge is missing (non-Electron build)', async () => {
    h.hasAi = false;
    render(<ChatPanel onClose={() => {}} />);
    send('hi');
    await waitFor(() =>
      expect(screen.getByText('AI not available (non-Electron build).')).toBeInTheDocument()
    );
    expect(h.chat).not.toHaveBeenCalled();
  });

  it('keeps streamed text and marks the reply errored on a stream error', async () => {
    h.turns.push([
      { type: 'delta', text: 'partial answer' },
      { type: 'error', message: 'rate limited' },
    ]);
    render(<ChatPanel onClose={() => {}} />);
    send('hi');
    await waitFor(() => expect(screen.getByText('rate limited')).toBeInTheDocument());
    const last = activeMessages().at(-1);
    expect(last?.status).toBe('error');
    expect(last?.text).toBe('partial answer');
  });

  it('flushes deltas on an animation frame while the stream is still open', async () => {
    const gate = deferred();
    h.turns.push([
      { type: 'delta', text: 'early' },
      { type: 'wait', promise: gate.promise },
    ]);
    render(<ChatPanel onClose={() => {}} />);
    send('hi');
    await waitFor(() => expect(activeMessages().at(-1)?.text).toBe('early'));
    expect(activeMessages().at(-1)?.status).toBe('streaming');
    await act(async () => gate.resolve());
    await waitFor(() => expect(activeMessages().at(-1)?.status).toBe('done'));
  });

  it('Stop cancels the in-flight stream', async () => {
    const gate = deferred();
    h.turns.push([{ type: 'wait', promise: gate.promise }]);
    render(<ChatPanel onClose={() => {}} />);
    send('hi');
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    expect(h.cancel).toHaveBeenCalledWith({ streamId: expect.any(String) });
    await act(async () => gate.resolve());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument());
  });

  it('cancels an in-flight stream when the panel unmounts', async () => {
    const gate = deferred();
    h.turns.push([{ type: 'wait', promise: gate.promise }]);
    const { unmount } = render(<ChatPanel onClose={() => {}} />);
    send('hi');
    await screen.findByRole('button', { name: 'Stop' });
    unmount();
    expect(h.cancel).toHaveBeenCalledTimes(1);
    await act(async () => gate.resolve());
  });

  it('toggles agent actions and advertises tools only when on', async () => {
    render(<ChatPanel onClose={() => {}} />);
    const toggle = screen.getByRole('button', { name: 'Enable agent actions' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);
    expect(useAiChatStore.getState().agentToolsEnabled).toBe(true);
    const off = screen.getByRole('button', { name: 'Disable agent actions' });
    expect(off).toHaveAttribute('aria-pressed', 'true');
    send('hi');
    await waitFor(() => expect(h.chat).toHaveBeenCalledTimes(1));
    expect(specAt(0).tools?.length).toBeGreaterThan(0);
  });

  it('New chat starts an empty conversation; close calls onClose', async () => {
    const onClose = vi.fn();
    h.turns.push([{ type: 'delta', text: 'reply one' }]);
    render(<ChatPanel onClose={onClose} />);
    send('first');
    await waitFor(() => expect(screen.getByText('reply one')).toBeInTheDocument());
    const before = useAiChatStore.getState().activeConversationId;
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    expect(useAiChatStore.getState().activeConversationId).not.toBe(before);
    expect(screen.queryByText('reply one')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close AI panel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('without a provider shows the setup card and disables sending', () => {
    configure(null);
    render(<ChatPanel onClose={() => {}} />);
    expect(screen.getByTestId('ai-provider-setup')).toBeInTheDocument();
    expect(screen.getByLabelText('Chat message')).toBeDisabled();
  });

  it('drains a queued inline action once, with tools forced on', async () => {
    useAiChatStore.getState().enqueueAction({ userText: 'Fix this request' });
    render(<ChatPanel onClose={() => {}} />);
    await waitFor(() => expect(h.chat).toHaveBeenCalledTimes(1));
    expect(useAiChatStore.getState().queuedAction).toBeNull();
    expect(specAt(0).tools?.length).toBeGreaterThan(0);
    expect(activeMessages()[0]?.text).toBe('Fix this request');
  });

  it('does not drain a queued action while no provider is configured', () => {
    configure(null);
    useAiChatStore.getState().enqueueAction({ userText: 'Fix this request' });
    render(<ChatPanel onClose={() => {}} />);
    expect(h.chat).not.toHaveBeenCalled();
    expect(useAiChatStore.getState().queuedAction).not.toBeNull();
  });

  it('Retry keeps raw mode for a turn that had no tab context', async () => {
    useAiChatStore.setState({
      conversations: {
        c1: {
          id: 'c1',
          title: 't',
          createdAt: 1,
          updatedAt: 2,
          messages: [
            {
              id: 'u1',
              role: 'user',
              text: 'general question',
              status: 'done',
              contextRef: { kind: 'none', capturedAt: 1 },
              rawMode: true,
              createdAt: 1,
            },
            { id: 'r1', role: 'assistant', text: 'old', status: 'done', createdAt: 2 },
          ],
        },
      },
      activeConversationId: 'c1',
    });
    render(<ChatPanel onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(h.chat).toHaveBeenCalledTimes(1));
    expect(specAt(0).rawMode).toBe(true);
  });

  it('Retry of a legacy turn (no context, no raw flag) re-sends redacted against the active tab', async () => {
    openTab(httpReq('a', 'https://api.example/now'));
    useAiChatStore.setState({
      conversations: {
        c1: {
          id: 'c1',
          title: 't',
          createdAt: 1,
          updatedAt: 2,
          messages: [
            { id: 'u1', role: 'user', text: 'legacy', status: 'done', createdAt: 1 },
            { id: 'r1', role: 'assistant', text: 'old', status: 'error', createdAt: 2 },
          ],
        },
      },
      activeConversationId: 'c1',
    });
    render(<ChatPanel onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(h.chat).toHaveBeenCalledTimes(1));
    expect(specAt(0).rawMode).toBe(false);
    expect(activeMessages().map((m) => m.text)).toEqual(['legacy', '']);
  });

  it('cannot start an agent run while a manual reply is streaming', async () => {
    const gate = deferred();
    h.turns.push([{ type: 'wait', promise: gate.promise }]);
    render(<ChatPanel onClose={() => {}} />);
    send('hi');
    await screen.findByRole('button', { name: 'Stop' });
    fireEvent.click(screen.getByRole('button', { name: 'Agent mode' }));
    fireEvent.change(screen.getByLabelText('Agent goal'), { target: { value: 'goal' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(useAiChatStore.getState().agentSession).toBeNull();
    await act(async () => gate.resolve());
    expect(h.chat).toHaveBeenCalledTimes(1);
  });

  it('Retry re-sends a turn with its original forced-tools option', async () => {
    useAiChatStore.getState().enqueueAction({ userText: 'Generate tests' });
    render(<ChatPanel onClose={() => {}} />);
    await waitFor(() => expect(h.chat).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(h.chat).toHaveBeenCalledTimes(2));
    expect(specAt(1).tools?.length).toBeGreaterThan(0);
    expect(activeMessages().filter((m) => m.role === 'user')).toHaveLength(1);
  });
});

describe('ChatPanel proposals', () => {
  async function propose(...events: StreamEvent[]): Promise<void> {
    h.turns.push(events);
    render(<ChatPanel onClose={() => {}} />);
    send('do it');
    await screen.findAllByTestId('ai-proposal-card');
  }

  it('previews added and removed headers before applying', async () => {
    openTab(
      httpReq('a', 'https://api.example/x', {
        headers: [{ id: 'h1', key: 'X-Old', value: '1', enabled: true }],
      })
    );
    await propose(
      toolCall('t1', 'update_http_request', { headers: [{ key: 'X-New', value: '2' }] })
    );
    const card = screen.getByTestId('ai-proposal-card');
    expect(card).toHaveTextContent('Update the active request');
    expect(within(card).getByText('(removed)')).toBeInTheDocument();
    expect(within(card).getByText('(added)')).toBeInTheDocument();
    expect(screen.getByTestId('ai-proposal-details')).not.toHaveAttribute('open');
  });

  it('applies a change and offers an Undo that reverts it', async () => {
    openTab(httpReq('a', 'https://api.example/old'));
    await propose(toolCall('t1', 'update_http_request', { url: 'https://api.example/new' }));
    const card = screen.getByTestId('ai-proposal-card');
    expect(within(card).getByText('https://api.example/old')).toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: 'Apply' }));
    expect(activeRequest().url).toBe('https://api.example/new');
    expect(screen.queryByTestId('ai-proposal-card')).not.toBeInTheDocument();
    const [, opts] = h.toast.success.mock.calls[0] as [
      string,
      { action: { label: string; onClick: () => void } },
    ];
    expect(opts.action.label).toBe('Undo');
    opts.action.onClick();
    expect(activeRequest().url).toBe('https://api.example/old');
    expect(h.toast.info).toHaveBeenCalledWith('Reverted the AI change');
  });

  it('applies a tool exactly once on a double click', async () => {
    openTab(httpReq('a', 'https://api.example/old'));
    await propose(toolCall('t1', 'update_http_request', { url: 'https://api.example/new' }));
    const apply = screen.getByRole('button', { name: 'Apply' });
    fireEvent.click(apply);
    fireEvent.click(apply);
    expect(h.toast.success).toHaveBeenCalledTimes(1);
  });

  it('reports a failed tool and removes its card', async () => {
    await propose(toolCall('t1', 'mystery_tool', 'not json'));
    // Raw (unparseable) input is shown verbatim, and expanded since nothing is listed.
    const details = screen.getByTestId('ai-proposal-details');
    expect(details).toHaveAttribute('open');
    expect(details).toHaveTextContent('not json');
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(h.toast.error).toHaveBeenCalledWith('Unknown tool: mystery_tool');
    expect(screen.queryByTestId('ai-proposal-card')).not.toBeInTheDocument();
  });

  it('refuses an active-request tool after the user switched tabs', async () => {
    openTab(httpReq('a', 'https://api.example/a'));
    await propose(toolCall('t1', 'update_http_request', { url: 'https://evil/' }));
    act(() => {
      openTab(httpReq('b', 'https://api.example/b'));
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(h.toast.error).toHaveBeenCalledWith(
      'The active request changed — re-run the action on the intended request.'
    );
    expect(activeRequest().url).toBe('https://api.example/b');
    expect(screen.queryByTestId('ai-proposal-card')).not.toBeInTheDocument();
  });

  it('Dismiss drops just that proposal', async () => {
    openTab(httpReq('a', 'https://api.example/a'));
    await propose(
      toolCall('t1', 'update_http_request', { url: 'https://api.example/b' }),
      toolCall('t2', 'set_test_script', { script: 'rs.test("ok", () => {})' })
    );
    expect(screen.getAllByTestId('ai-proposal-card')).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: 'Dismiss' })[0] as HTMLElement);
    const cards = screen.getAllByTestId('ai-proposal-card');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toHaveTextContent('Replace the test script');
    expect(activeRequest().url).toBe('https://api.example/a');
  });

  it('a new send clears proposals from the previous turn', async () => {
    openTab(httpReq('a', 'https://api.example/a'));
    await propose(toolCall('t1', 'update_http_request', { url: 'https://api.example/b' }));
    h.turns.push([{ type: 'delta', text: 'second reply' }]);
    send('again');
    await waitFor(() => expect(screen.getByText('second reply')).toBeInTheDocument());
    expect(screen.queryByTestId('ai-proposal-card')).not.toBeInTheDocument();
  });
});

describe('ChatPanel agent mode', () => {
  function startAgent(goal: string): void {
    fireEvent.click(screen.getByRole('button', { name: 'Agent mode' }));
    fireEvent.change(screen.getByLabelText('Agent goal'), { target: { value: goal } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
  }
  const status = () => useAiChatStore.getState().agentSession?.status;

  it('Start is disabled for an empty goal', () => {
    render(<ChatPanel onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Agent mode' }));
    expect(screen.getByRole('button', { name: 'Agent mode' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Agent goal'), { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled();
    // Toggling closes the goal row again.
    fireEvent.click(screen.getByRole('button', { name: 'Agent mode' }));
    expect(screen.queryByLabelText('Agent goal')).not.toBeInTheDocument();
  });

  it('finishes when the model answers without proposing a step', async () => {
    h.turns.push([{ type: 'delta', text: 'Nothing to do.' }]);
    render(<ChatPanel onClose={() => {}} />);
    startAgent('  check the request  ');
    await waitFor(() => expect(status()).toBe('done'));
    expect(screen.getByText('Goal complete · step 0/8')).toBeInTheDocument();
    expect(screen.getByTitle('check the request')).toBeInTheDocument();
    const spec = specAt(0);
    expect(spec.tools?.length).toBeGreaterThan(0);
    expect(JSON.stringify(spec.messages)).toContain('check the request');
    // The run is over: the goal row is gone and the composer is usable again.
    expect(screen.queryByRole('button', { name: 'Stop agent' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Chat message')).not.toBeDisabled();
  });

  it('waits for Apply, then runs the next turn until done', async () => {
    openTab(httpReq('a', 'https://api.example/old'));
    h.turns.push(
      [toolCall('t1', 'update_http_request', { url: 'https://api.example/new' })],
      [{ type: 'delta', text: 'All set.' }]
    );
    render(<ChatPanel onClose={() => {}} />);
    startAgent('fix the url');
    await waitFor(() => expect(status()).toBe('awaiting-apply'));
    expect(screen.getByText('Proposed a step — review and Apply · step 0/8')).toBeInTheDocument();
    expect(screen.getByLabelText('Chat message')).toBeDisabled();
    // Busy agent: retry is hidden.
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(activeRequest().url).toBe('https://api.example/new');
    await waitFor(() => expect(status()).toBe('done'));
    expect(useAiChatStore.getState().agentSession?.stepCount).toBe(1);
    expect(h.chat).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(specAt(1).messages)).toContain('The previous step was applied');
  });

  it('stops at the step cap instead of running another turn', async () => {
    openTab(httpReq('a', 'https://api.example/old'));
    h.turns.push([toolCall('t1', 'update_http_request', { url: 'https://api.example/new' })]);
    render(<ChatPanel onClose={() => {}} />);
    startAgent('fix the url');
    await waitFor(() => expect(status()).toBe('awaiting-apply'));
    act(() => {
      const s = useAiChatStore.getState().agentSession;
      if (s) useAiChatStore.getState().setAgentSession({ ...s, stepCount: 7 });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(status()).toBe('max-steps');
    expect(screen.getByText('Reached the step limit · step 8/8')).toBeInTheDocument();
    expect(h.chat).toHaveBeenCalledTimes(1);
  });

  it('ends the run with an error when the applied step fails', async () => {
    h.turns.push([toolCall('t1', 'mystery_tool', {})]);
    render(<ChatPanel onClose={() => {}} />);
    startAgent('do something');
    await waitFor(() => expect(status()).toBe('awaiting-apply'));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(status()).toBe('error');
    expect(screen.getByText('Error · step 0/8')).toBeInTheDocument();
  });

  it('ends the run with an error when the tab switched before Apply', async () => {
    openTab(httpReq('a', 'https://api.example/a'));
    h.turns.push([toolCall('t1', 'update_http_request', { url: 'https://api.example/x' })]);
    render(<ChatPanel onClose={() => {}} />);
    startAgent('fix it');
    await waitFor(() => expect(status()).toBe('awaiting-apply'));
    act(() => {
      openTab(httpReq('b', 'https://api.example/b'));
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(status()).toBe('error');
    expect(h.toast.error).toHaveBeenCalledTimes(1);
  });

  it('ends the run with an error and drops proposals when the turn fails', async () => {
    h.turns.push([
      toolCall('t1', 'update_http_request', { url: 'https://api.example/x' }),
      { type: 'error', message: 'provider exploded' },
    ]);
    render(<ChatPanel onClose={() => {}} />);
    startAgent('fix it');
    await waitFor(() => expect(status()).toBe('error'));
    expect(screen.queryByTestId('ai-proposal-card')).not.toBeInTheDocument();
    expect(screen.getByText('provider exploded')).toBeInTheDocument();
  });

  it('Dismissing the proposed step stops the run', async () => {
    h.turns.push([toolCall('t1', 'mystery_tool', {})]);
    render(<ChatPanel onClose={() => {}} />);
    startAgent('do something');
    await waitFor(() => expect(status()).toBe('awaiting-apply'));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(status()).toBe('stopped');
    expect(screen.getByText('Stopped · step 0/8')).toBeInTheDocument();
  });

  it('Stop cancels the stream and clears proposals', async () => {
    h.turns.push([toolCall('t1', 'mystery_tool', {})]);
    render(<ChatPanel onClose={() => {}} />);
    startAgent('do something');
    await waitFor(() => expect(status()).toBe('awaiting-apply'));
    fireEvent.click(screen.getByRole('button', { name: 'Stop agent' }));
    expect(status()).toBe('stopped');
    expect(screen.queryByTestId('ai-proposal-card')).not.toBeInTheDocument();
  });

  it('a turn that resolves after Stop does not revive the run', async () => {
    const gate = deferred();
    h.turns.push([{ type: 'wait', promise: gate.promise }]);
    render(<ChatPanel onClose={() => {}} />);
    startAgent('slow goal');
    await waitFor(() => expect(status()).toBe('running'));
    expect(screen.getByText('Thinking… · step 0/8')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Stop agent' }));
    expect(h.cancel).toHaveBeenCalledTimes(1);
    await act(async () => gate.resolve());
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull());
    expect(status()).toBe('stopped');
    expect(h.chat).toHaveBeenCalledTimes(1);
  });

  it('marks a running agent stopped when the panel unmounts', async () => {
    const gate = deferred();
    h.turns.push([{ type: 'wait', promise: gate.promise }]);
    const { unmount } = render(<ChatPanel onClose={() => {}} />);
    startAgent('slow goal');
    await waitFor(() => expect(status()).toBe('running'));
    unmount();
    expect(status()).toBe('stopped');
    await act(async () => gate.resolve());
  });

  it('labels an unrecognised status verbatim', () => {
    useAiChatStore.setState({
      agentSession: { goal: 'g', status: 'paused' as never, stepCount: 2, maxSteps: 8 },
    });
    render(<ChatPanel onClose={() => {}} />);
    expect(screen.getByText('paused · step 2/8')).toBeInTheDocument();
  });
});
