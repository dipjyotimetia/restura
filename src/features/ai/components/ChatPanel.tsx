import { useEffect, useRef, useState } from 'react';
import { useAiChatStore, type ChatMessage } from '@/features/ai/store';
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

// Stable empty reference so the messages selector doesn't return a fresh array
// (which would re-render every store change under Object.is equality).
const EMPTY_MESSAGES: ChatMessage[] = [];

function uuid(): string {
  // streamId must satisfy z.string().uuid() at the IPC boundary. Electron's
  // renderer is a secure context, so crypto.randomUUID is always available.
  return globalThis.crypto.randomUUID();
}

interface Props {
  onClose: () => void;
}

export function ChatPanel({ onClose }: Props) {
  // Granular selectors: re-render only for the slices this panel renders, not
  // on every unrelated store change (panel toggle, other conversations, etc.).
  const activeId = useAiChatStore((s) => s.activeConversationId);
  const messages = useAiChatStore((s) =>
    s.activeConversationId
      ? (s.conversations[s.activeConversationId]?.messages ?? EMPTY_MESSAGES)
      : EMPTY_MESSAGES,
  );
  const activeProvider = useAiChatStore((s) => s.activeProvider);
  const providerConfig = useAiChatStore((s) => s.providerConfigs[s.activeProvider]);
  const panelWidth = useAiChatStore((s) => s.panelWidth);
  const newConversation = useAiChatStore((s) => s.newConversation);
  const apiKeyConfigured = !!providerConfig?.apiKeyRef.id;

  const [streamingId, setStreamingId] = useState<string | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);
  const flushBufferRef = useRef<{ msgId: string; buffer: string } | null>(null);
  const rafRef = useRef<number | null>(null);
  // Synchronous re-entry guard. `streamingId` is React state, so it isn't set
  // until a re-render — a second ⌘+Enter fired during the ai.chat() round-trip
  // would otherwise start a competing stream that clobbers the shared refs.
  const sendingRef = useRef(false);

  useEffect(() => {
    if (!activeId) newConversation();
  }, [activeId, newConversation]);

  // Flush the RAF-batched delta buffer to the store immediately and cancel any
  // pending frame. Used on every stream-termination path so the rendered text
  // is complete before we finalize (the old code dropped the un-flushed tail on
  // error/cancel).
  const flushNow = () => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const b = flushBufferRef.current;
    if (b && b.buffer.length > 0) {
      useAiChatStore.getState().appendAssistantDelta(b.msgId, b.buffer);
      b.buffer = '';
    }
  };

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
    if (!providerConfig || sendingRef.current) return;
    sendingRef.current = true;
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
      sendingRef.current = false;
      return;
    }

    // Subscribe to the stream BEFORE invoking ai.chat. The main process fires
    // the stream off the instant `ai:chat` runs and returns before it finishes,
    // so its earliest events — including the synchronous guard / "API key not
    // found" error AND its terminating `end` — are emitted before ai.chat()
    // even resolves. emitTo does not buffer, so a late subscription would drop
    // them and leave the message stuck "streaming" forever with no `end` to
    // close the iterator. Subscribe first, then invoke.
    const iterator = consumeStream(streamId)[Symbol.asyncIterator]();
    setStreamingId(assistantMsgId);
    flushBufferRef.current = { msgId: assistantMsgId, buffer: '' };
    cancelRef.current = () => void ai.cancel({ streamId });

    const result = await ai.chat(spec);
    if (!result.ok) {
      await iterator.return?.(); // tear down the subscription we opened above
      useAiChatStore.getState().setMessageError(assistantMsgId, 'error' in result ? result.error : 'Unknown error');
      setStreamingId(null);
      cancelRef.current = null;
      flushBufferRef.current = null;
      sendingRef.current = false;
      return;
    }

    let lastUsage: Usage | undefined;
    let errored = false;
    try {
      for (;;) {
        const { value: ev, done } = await iterator.next();
        if (done) break;
        if (ev.type === 'delta') {
          if (flushBufferRef.current) flushBufferRef.current.buffer += ev.text;
          scheduleFlush();
        } else if (ev.type === 'usage') {
          lastUsage = ev.usage;
        } else if (ev.type === 'error') {
          errored = true;
          useAiChatStore.getState().setMessageError(assistantMsgId, ev.message);
        }
        // `done` events need no handling here: the stream terminates via the
        // iterator's `done` (driven by the IPC `end` channel), and we finalize
        // in `finally` below.
      }
    } finally {
      // Flush the RAF-batched tail BEFORE finalizing so the rendered text is
      // complete on every path (success, provider error, user cancel).
      flushNow();
      // Finalize on ANY clean termination, not only on a `done` event. A cancel
      // ends the stream via the `end` channel with no `done` event, and some
      // providers close without a trailing `[DONE]`; gating finalize on a
      // `done` event left those messages stuck "streaming".
      if (!errored) {
        useAiChatStore.getState().finalizeAssistantMessage(assistantMsgId, lastUsage);
      }
      setStreamingId(null);
      cancelRef.current = null;
      flushBufferRef.current = null;
      sendingRef.current = false;
    }
  };

  return (
    <aside className="glass-2 border-border/40 flex h-full flex-col border-l" style={{ width: panelWidth }}>
      <header className="flex items-center justify-between border-b border-border/40 px-3 py-2">
        <div className="flex flex-col">
          <span className="text-xs font-medium">AI chat</span>
          {messages.length > 0 && (() => {
            const total = messages.reduce((sum, m) => sum + (m.usage?.estimatedCostUSD ?? 0), 0);
            return total > 0 ? (
              <span className="text-[10px] text-muted-foreground">Conversation cost: ${total.toFixed(4)}</span>
            ) : null;
          })()}
        </div>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => newConversation()} aria-label="New chat">
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
