import { beforeEach, describe, expect, it } from 'vitest';
import { type Conversation, useAiChatStore } from '@/features/ai/store';

const good = (id: string, streaming = false): Conversation => ({
  id,
  title: id,
  createdAt: 1,
  updatedAt: 2,
  messages: [
    {
      id: `${id}-m0`,
      role: 'user',
      text: 'hi',
      status: streaming ? 'streaming' : 'done',
      createdAt: 1,
    },
  ],
});

function rehydrate(): void {
  const hook = useAiChatStore.persist.getOptions().onRehydrateStorage;
  if (!hook) throw new Error('expected onRehydrateStorage');
  hook(useAiChatStore.getState())?.(useAiChatStore.getState(), undefined);
}

describe('useAiChatStore — rehydrate validation', () => {
  beforeEach(() => {
    useAiChatStore.setState(useAiChatStore.getInitialState(), true);
  });

  it('drops only the invalid conversation, keeping the valid ones', () => {
    useAiChatStore.setState({
      conversations: {
        a: good('a'),
        bad: { id: 'bad', title: 42, messages: 'nope' } as unknown as Conversation,
        b: good('b', true),
      },
      activeConversationId: 'bad',
      panelWidth: 500,
      redactionMode: 'raw',
    });
    rehydrate();
    const s = useAiChatStore.getState();
    expect(Object.keys(s.conversations).sort()).toEqual(['a', 'b']);
    // The mid-stream recovery still runs on the survivors.
    expect(s.conversations.b?.messages[0]?.status).toBe('error');
    // The active pointer no longer names a dropped conversation.
    expect(s.activeConversationId).toBeNull();
    // Valid unrelated fields are untouched.
    expect(s.panelWidth).toBe(500);
    expect(s.redactionMode).toBe('raw');
    expect(typeof s.newConversation).toBe('function');
  });

  it('resets only the invalid top-level field, keeping conversations', () => {
    useAiChatStore.setState({
      conversations: { a: good('a') },
      activeConversationId: 'a',
      panelWidth: 99_999,
    });
    rehydrate();
    const s = useAiChatStore.getState();
    expect(Object.keys(s.conversations)).toEqual(['a']);
    expect(s.activeConversationId).toBe('a');
    expect(s.panelWidth).toBe(380);
  });
});
