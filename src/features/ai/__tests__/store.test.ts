import { beforeEach, describe, expect, it } from 'vitest';
import { useAiChatStore } from '@/features/ai/store';

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
