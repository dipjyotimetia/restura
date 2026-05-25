import { useEffect, useMemo, useRef, useState } from 'react';
import { useAiChatStore } from '@/features/ai/store';
import { captureActive } from '@/features/ai/lib/contextSnapshot';
import { buildMessages } from '@/features/ai/lib/promptBuilder';
import { consumeStream } from '@/features/ai/lib/streamConsumer';
import { getElectronAPI } from '@/lib/shared/platform';
import { ContextPill } from './ContextPill';
import { MessageList } from './MessageList';
import { Composer } from './Composer';
import { Button } from '@/components/ui/button';
import { Plus, X } from 'lucide-react';
import type { Usage } from '@shared/protocol/ai/types';

function uuid(): string {
  // streamId must satisfy z.string().uuid() at the IPC boundary. Electron's
  // renderer is a secure context, so crypto.randomUUID is always available.
  return globalThis.crypto.randomUUID();
}

interface Props {
  onClose: () => void;
}

export function ChatPanel({ onClose }: Props) {
  const store = useAiChatStore();
  const activeId = store.activeConversationId;
  const activeConv = activeId ? store.conversations[activeId] : undefined;

  const activeProvider = store.activeProvider;
  const providerConfig = store.providerConfigs[activeProvider];
  const apiKeyConfigured = !!providerConfig?.apiKeyRef.id;

  const [streamingId, setStreamingId] = useState<string | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);
  const flushBufferRef = useRef<{ msgId: string; buffer: string } | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!activeId) store.newConversation();
  }, [activeId, store]);

  const scheduleFlush = () => {
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const b = flushBufferRef.current;
      if (b && b.buffer.length > 0) {
        useAiChatStore.getState().appendAssistantDelta(b.msgId, b.buffer);
        b.buffer = '';
      }
    });
  };

  const handleSend = async (text: string, rawMode: boolean) => {
    if (!providerConfig) return;
    const snapshot = captureActive();

    // Read prior turns from the live store at call time — NOT the render-time
    // `activeConv` closure — so rapid successive sends don't build context from
    // a stale snapshot that omits the previous turn.
    const stateBefore = useAiChatStore.getState();
    const convIdBefore = stateBefore.activeConversationId;
    const priorTurns = (convIdBefore ? (stateBefore.conversations[convIdBefore]?.messages ?? []) : [])
      .slice(-20)
      .map((m) => ({ role: m.role, content: m.text }));

    useAiChatStore.getState().appendUserMessage(text, snapshot.contextRef, rawMode);
    const assistantMsgId = useAiChatStore.getState().appendAssistantPlaceholder();

    const messages = buildMessages({ snapshot, priorTurns, userText: text, rawMode });

    const streamId = uuid();
    const spec = {
      streamId,
      provider: activeProvider,
      model: providerConfig.defaultModel,
      messages,
      apiKeyHandleId: providerConfig.apiKeyRef.id,
      ...(providerConfig.baseUrlOverride ? { baseUrlOverride: providerConfig.baseUrlOverride } : {}),
      rawMode,
    };

    const ai = getElectronAPI()?.ai;
    if (!ai) {
      useAiChatStore.getState().setMessageError(assistantMsgId, 'AI not available (non-Electron build).');
      return;
    }

    const result = await ai.chat(spec);
    if (!result.ok) {
      useAiChatStore.getState().setMessageError(assistantMsgId, 'error' in result ? result.error : 'Unknown error');
      return;
    }

    setStreamingId(assistantMsgId);
    flushBufferRef.current = { msgId: assistantMsgId, buffer: '' };
    cancelRef.current = () => void ai.cancel({ streamId });

    let lastUsage: Usage | undefined;
    let errored = false;
    try {
      for await (const ev of consumeStream(streamId)) {
        if (ev.type === 'delta') {
          if (flushBufferRef.current) flushBufferRef.current.buffer += ev.text;
          scheduleFlush();
        } else if (ev.type === 'usage') {
          lastUsage = ev.usage;
        } else if (ev.type === 'error') {
          errored = true;
          useAiChatStore.getState().setMessageError(assistantMsgId, ev.message);
        } else if (ev.type === 'done') {
          const b = flushBufferRef.current;
          if (b && b.buffer.length > 0) {
            useAiChatStore.getState().appendAssistantDelta(b.msgId, b.buffer);
            b.buffer = '';
          }
          // Providers emit `done` after an `error`; don't let finalize flip the
          // message's status back to 'done' and mask the failure.
          if (!errored) {
            useAiChatStore.getState().finalizeAssistantMessage(assistantMsgId, lastUsage);
          }
        }
      }
    } finally {
      setStreamingId(null);
      cancelRef.current = null;
      flushBufferRef.current = null;
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    }
  };

  const messages = useMemo(() => activeConv?.messages ?? [], [activeConv?.messages]);

  return (
    <aside className="glass-2 border-border/40 flex h-full flex-col border-l" style={{ width: store.panelWidth }}>
      <header className="flex items-center justify-between border-b border-border/40 px-3 py-2">
        <div className="flex flex-col">
          <span className="text-xs font-medium">AI chat</span>
          {activeConv && activeConv.messages.length > 0 && (() => {
            const total = activeConv.messages.reduce((sum, m) => sum + (m.usage?.estimatedCostUSD ?? 0), 0);
            return total > 0 ? (
              <span className="text-[10px] text-muted-foreground">Conversation cost: ${total.toFixed(4)}</span>
            ) : null;
          })()}
        </div>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => store.newConversation()} aria-label="New chat">
            <Plus className="h-4 w-4" />
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close AI panel">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </header>
      <ContextPill />
      <MessageList messages={messages} />
      <Composer
        disabled={!apiKeyConfigured}
        streaming={!!streamingId}
        onSend={(t, r) => void handleSend(t, r)}
        onStop={() => cancelRef.current?.()}
      />
    </aside>
  );
}

export default ChatPanel;
