import { beforeEach, describe, expect, it } from 'vitest';
import {
  type Conversation,
  MAX_PERSISTED_CONVERSATIONS,
  MAX_PERSISTED_MESSAGES,
  useAiChatStore,
} from '@/features/ai/store';

describe('useAiChatStore', () => {
  beforeEach(() => {
    useAiChatStore.setState(useAiChatStore.getInitialState(), true);
  });

  it('creates a new conversation and makes it active', () => {
    const id = useAiChatStore.getState().newConversation();
    expect(useAiChatStore.getState().activeConversationId).toBe(id);
    expect(useAiChatStore.getState().conversations[id]?.messages).toEqual([]);
  });

  it('appendUserMessage adds a message and returns its id', () => {
    useAiChatStore.getState().newConversation();
    const msgId = useAiChatStore
      .getState()
      .appendUserMessage(
        'why did this fail?',
        { kind: 'response', tabId: 't1', capturedAt: 1 },
        false
      );
    const active = useAiChatStore.getState().activeConversationId!;
    const msg = useAiChatStore
      .getState()
      .conversations[active]?.messages.find((m) => m.id === msgId);
    expect(msg?.text).toBe('why did this fail?');
    expect(msg?.role).toBe('user');
    expect(msg?.rawMode).toBe(false);
  });

  it('auto-derives conversation title from the first user message (≤60 chars)', () => {
    useAiChatStore.getState().newConversation();
    useAiChatStore
      .getState()
      .appendUserMessage('a'.repeat(80), { kind: 'none', capturedAt: 0 }, false);
    const active = useAiChatStore.getState().activeConversationId!;
    expect(useAiChatStore.getState().conversations[active]?.title.length).toBeLessThanOrEqual(63);
  });

  it('appendAssistantDelta accumulates onto an existing streaming message', () => {
    useAiChatStore.getState().newConversation();
    const aId = useAiChatStore.getState().appendAssistantPlaceholder();
    useAiChatStore.getState().appendAssistantDelta(aId, 'Hello ');
    useAiChatStore.getState().appendAssistantDelta(aId, 'world');
    const active = useAiChatStore.getState().activeConversationId!;
    expect(
      useAiChatStore.getState().conversations[active]?.messages.find((m) => m.id === aId)?.text
    ).toBe('Hello world');
  });

  it('finalizeAssistantMessage sets status to done and stores usage', () => {
    useAiChatStore.getState().newConversation();
    const aId = useAiChatStore.getState().appendAssistantPlaceholder();
    useAiChatStore.getState().finalizeAssistantMessage(aId, {
      promptTokens: 5,
      completionTokens: 7,
      estimatedCostUSD: 0.0001,
    });
    const active = useAiChatStore.getState().activeConversationId!;
    const msg = useAiChatStore.getState().conversations[active]?.messages.find((m) => m.id === aId);
    expect(msg?.status).toBe('done');
    expect(msg?.usage?.completionTokens).toBe(7);
  });

  it('setMessageError marks the message errored and records message', () => {
    useAiChatStore.getState().newConversation();
    const aId = useAiChatStore.getState().appendAssistantPlaceholder();
    useAiChatStore.getState().setMessageError(aId, 'Provider 429');
    const active = useAiChatStore.getState().activeConversationId!;
    const msg = useAiChatStore.getState().conversations[active]?.messages.find((m) => m.id === aId);
    expect(msg?.status).toBe('error');
    expect(msg?.errorMessage).toBe('Provider 429');
  });

  it('panelOpen and panelWidth are mutable', () => {
    useAiChatStore.getState().setPanelOpen(true);
    useAiChatStore.getState().setPanelWidth(420);
    expect(useAiChatStore.getState().panelOpen).toBe(true);
    expect(useAiChatStore.getState().panelWidth).toBe(420);
  });

  it('routes assistant updates to the owning conversation after the active one changes mid-stream', () => {
    const convA = useAiChatStore.getState().newConversation();
    const aId = useAiChatStore.getState().appendAssistantPlaceholder();

    // User starts a new chat (switches active conversation) while A streams.
    const convB = useAiChatStore.getState().newConversation();
    expect(useAiChatStore.getState().activeConversationId).toBe(convB);

    // Late stream events for A must still land in A, not the now-active B.
    useAiChatStore.getState().appendAssistantDelta(aId, 'hello');
    useAiChatStore.getState().finalizeAssistantMessage(aId, {
      promptTokens: 1,
      completionTokens: 1,
      estimatedCostUSD: 0.0001,
    });

    const msgInA = useAiChatStore
      .getState()
      .conversations[convA]?.messages.find((m) => m.id === aId);
    expect(msgInA?.text).toBe('hello');
    expect(msgInA?.status).toBe('done');
    expect(useAiChatStore.getState().conversations[convB]?.messages).toEqual([]);
  });
});

describe('useAiChatStore persistence caps', () => {
  const conversation = (id: string, updatedAt: number, messageCount: number): Conversation => ({
    id,
    title: id,
    createdAt: updatedAt,
    updatedAt,
    messages: Array.from({ length: messageCount }, (_, i) => ({
      id: `${id}-m${i}`,
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      text: `message ${i}`,
      status: 'done' as const,
      createdAt: updatedAt + i,
    })),
  });

  it('persists only the newest conversations (always the active one) and their latest messages', () => {
    const conversations: Record<string, Conversation> = {};
    const total = MAX_PERSISTED_CONVERSATIONS + 5;
    for (let i = 0; i < total; i++) conversations[`c${i}`] = conversation(`c${i}`, 1_000 + i, 1);
    // The active conversation is the oldest and the longest.
    conversations.c0 = conversation('c0', 1, MAX_PERSISTED_MESSAGES + 10);
    useAiChatStore.setState({ conversations, activeConversationId: 'c0' });

    const partialize = useAiChatStore.persist.getOptions().partialize;
    if (!partialize) throw new Error('expected partialize');
    const persisted = partialize(useAiChatStore.getState()) as {
      conversations: Record<string, Conversation>;
    };

    const ids = Object.keys(persisted.conversations);
    expect(ids).toHaveLength(MAX_PERSISTED_CONVERSATIONS);
    expect(ids).toContain('c0');
    expect(ids).toContain(`c${total - 1}`);
    expect(ids).not.toContain('c1');
    const active = persisted.conversations.c0;
    expect(active?.messages).toHaveLength(MAX_PERSISTED_MESSAGES);
    expect(active?.messages.at(-1)?.id).toBe(`c0-m${MAX_PERSISTED_MESSAGES + 9}`);
    // In-memory state is untouched; only the persisted copy is capped.
    expect(Object.keys(useAiChatStore.getState().conversations)).toHaveLength(total);
  });
});
