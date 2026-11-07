import { beforeEach, describe, expect, it } from 'vitest';
import { useAiChatStore } from '@/features/ai/store';

const ref = { kind: 'none' as const, capturedAt: 1 };

beforeEach(() => {
  useAiChatStore.setState(useAiChatStore.getInitialState(), true);
});

describe('useAiChatStore guards', () => {
  it('append* is a no-op without an active conversation', () => {
    const before = useAiChatStore.getState().conversations;
    useAiChatStore.getState().appendUserMessage('hi', ref, false);
    useAiChatStore.getState().appendAssistantPlaceholder();
    expect(useAiChatStore.getState().conversations).toBe(before);
  });

  it('append* is a no-op when the active id points at a deleted conversation', () => {
    useAiChatStore.setState({ activeConversationId: 'ghost' });
    useAiChatStore.getState().appendUserMessage('hi', ref, false);
    useAiChatStore.getState().appendAssistantPlaceholder();
    expect(useAiChatStore.getState().conversations).toEqual({});
  });

  it('message-id mutations ignore unknown ids', () => {
    const id = useAiChatStore.getState().newConversation();
    const before = useAiChatStore.getState().conversations;
    const st = useAiChatStore.getState();
    st.appendAssistantDelta('nope', 'x');
    st.truncateMessagesFrom('nope');
    st.finalizeAssistantMessage('nope');
    st.setMessageError('nope', 'err');
    expect(useAiChatStore.getState().conversations).toBe(before);
    expect(useAiChatStore.getState().conversations[id]?.messages).toEqual([]);
  });

  it('keeps the title after the first message', () => {
    const id = useAiChatStore.getState().newConversation();
    useAiChatStore.getState().appendUserMessage('first question', ref, false);
    const title = useAiChatStore.getState().conversations[id]?.title;
    useAiChatStore.getState().appendUserMessage('second question', ref, false);
    expect(useAiChatStore.getState().conversations[id]?.title).toBe(title);
  });

  it('switching and deleting a non-active conversation keeps the active one', () => {
    const a = useAiChatStore.getState().newConversation();
    const b = useAiChatStore.getState().newConversation();
    useAiChatStore.getState().setActive(a);
    expect(useAiChatStore.getState().activeConversationId).toBe(a);
    useAiChatStore.getState().deleteConversation(b);
    expect(useAiChatStore.getState().activeConversationId).toBe(a);
    expect(Object.keys(useAiChatStore.getState().conversations)).toEqual([a]);
  });

  it('records the redaction mode', () => {
    useAiChatStore.getState().setRedactionMode('raw');
    expect(useAiChatStore.getState().redactionMode).toBe('raw');
  });
});
