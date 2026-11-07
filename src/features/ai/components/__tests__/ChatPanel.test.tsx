import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type ChatMessage, useAiChatStore } from '@/features/ai/store';
import { useRequestStore } from '@/store/useRequestStore';
import type { HttpRequest } from '@/types';

type StreamEvent = { type: 'tool_call'; id: string; name: string; input: string };

const h = vi.hoisted(() => ({
  chat: vi.fn(async (_spec: unknown) => ({ ok: true as const })),
  events: [] as StreamEvent[],
}));

vi.mock('@/lib/shared/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/shared/platform')>();
  return {
    ...actual,
    isElectron: () => true,
    getElectronAPI: () => ({ ai: { chat: h.chat, cancel: vi.fn() } }),
  };
});

vi.mock('@/features/ai/lib/streamConsumer', () => ({
  consumeStream: () => ({
    async *[Symbol.asyncIterator]() {
      for (const ev of h.events) yield ev;
    },
  }),
}));

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), info: vi.fn() }),
}));

import { ChatPanel } from '../ChatPanel';

const SECRET_A = 'Bearer tab-a-secret-token';
const SECRET_B = 'Bearer tab-b-secret-token';

function httpReq(id: string, url: string, auth: string): HttpRequest {
  return {
    id,
    name: id,
    type: 'http',
    method: 'GET',
    url,
    headers: [{ id: `${id}-h`, key: 'Authorization', value: auth, enabled: true }],
    params: [],
    body: { type: 'none' },
    auth: { type: 'none' },
  };
}

function openTabs(): { tabA: string; tabB: string } {
  useRequestStore.setState({ tabs: [], activeTabId: null });
  const st = useRequestStore.getState();
  st.openTab(httpReq('a', 'https://a.example/orig', SECRET_A), { switchTo: true });
  const tabA = useRequestStore.getState().activeTabId as string;
  st.openTab(httpReq('b', 'https://b.example/other', SECRET_B), { switchTo: true });
  const tabB = useRequestStore.getState().activeTabId as string;
  return { tabA, tabB };
}

function seedConversation(tabId: string, rawMode: boolean): void {
  const messages: ChatMessage[] = [
    {
      id: 'u1',
      role: 'user',
      text: 'why does this fail?',
      status: 'done',
      contextRef: { kind: 'request', tabId, capturedAt: 1 },
      rawMode,
      createdAt: 1,
    },
    { id: 'r1', role: 'assistant', text: 'Because.', status: 'done', createdAt: 2 },
  ];
  useAiChatStore.setState({
    activeProvider: 'anthropic',
    providerConfigs: {
      openai: null,
      anthropic: {
        provider: 'anthropic',
        defaultModel: 'm',
        apiKeyRef: { kind: 'handle', id: '00000000-0000-4000-8000-000000000001' },
      },
      openrouter: null,
      'openai-compatible': null,
    },
    conversations: {
      c1: { id: 'c1', title: 't', messages, createdAt: 1, updatedAt: 2 },
    },
    activeConversationId: 'c1',
    agentSession: null,
    queuedAction: null,
  } as never);
}

const lastSpec = (): { rawMode: boolean; messages: unknown } =>
  h.chat.mock.calls.at(-1)?.[0] as { rawMode: boolean; messages: unknown };

beforeEach(() => {
  h.chat.mockClear();
  h.events = [];
});

describe('ChatPanel Retry (A3)', () => {
  it('never sends raw after the original tab was closed and another is active', async () => {
    const { tabA } = openTabs();
    seedConversation(tabA, true);
    useRequestStore.getState().closeTab(tabA);
    render(<ChatPanel onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(h.chat).toHaveBeenCalledTimes(1));
    const spec = lastSpec();
    expect(spec.rawMode).toBe(false);
    expect(JSON.stringify(spec.messages)).not.toContain('tab-b-secret-token');
  });

  it('re-captures the original tab, not the newly active one', async () => {
    const { tabA } = openTabs(); // tab B is active now
    seedConversation(tabA, true);
    render(<ChatPanel onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(h.chat).toHaveBeenCalledTimes(1));
    const sent = JSON.stringify(lastSpec().messages);
    expect(sent).toContain('a.example/orig');
    expect(sent).not.toContain('b.example');
    expect(sent).not.toContain('tab-b-secret-token');
    // The user chose raw for THIS tab's context; re-sending it raw is consistent.
    expect(lastSpec().rawMode).toBe(true);
  });
});

describe('ChatPanel proposal card (A2)', () => {
  it('expands the raw input when the change list is empty or a value was suppressed', async () => {
    const { tabB } = openTabs();
    seedConversation(tabB, false);
    h.events = [
      {
        type: 'tool_call',
        id: 't1',
        name: 'update_http_request',
        input: JSON.stringify({ url: 'https://x/[REDACTED]' }),
      },
    ];
    render(<ChatPanel onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    const details = await screen.findByTestId('ai-proposal-details');
    expect(details).toHaveAttribute('open');
  });

  it('keeps the raw input collapsed when every change is listed', async () => {
    const { tabB } = openTabs();
    seedConversation(tabB, false);
    h.events = [
      {
        type: 'tool_call',
        id: 't2',
        name: 'set_test_script',
        input: JSON.stringify({ script: 'rs.test("x", () => {}) // [REDACTED]' }),
      },
    ];
    render(<ChatPanel onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    const details = await screen.findByTestId('ai-proposal-details');
    expect(details).not.toHaveAttribute('open');
    expect(screen.getByTestId('ai-proposal-card')).toHaveTextContent('// [REDACTED]');
  });
});
