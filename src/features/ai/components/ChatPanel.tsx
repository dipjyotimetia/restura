import { isLocalProvider, type Usage } from '@shared/protocol/ai/types';
import { Bot, Check, Plus, Square, Wand2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  isAgentActive,
  onAgentApplied,
  onAgentError,
  onAgentStopped,
  onAgentTurnComplete,
  startAgentSession,
} from '@/features/ai/agent/agentSession';
import { agentToolDefs, runAgentTool } from '@/features/ai/agent/tools';
import { captureActive } from '@/features/ai/lib/contextSnapshot';
import { buildMessages, SYSTEM_AGENT_PROMPT } from '@/features/ai/lib/promptBuilder';
import { consumeStream } from '@/features/ai/lib/streamConsumer';
import { type ChatMessage, useAiChatStore } from '@/features/ai/store';
import { getElectronAPI } from '@/lib/shared/platform';
import { useRequestStore } from '@/store/useRequestStore';
import { Composer } from './Composer';
import { ContextPill } from './ContextPill';
import { MessageList } from './MessageList';

interface PendingToolCall {
  id: string;
  name: string;
  input: string;
  /**
   * The active tab id when this proposal was made (from the context snapshot).
   * For tools that mutate the ACTIVE request, applying after the user switched
   * tabs would hit the wrong request — so apply re-checks this.
   */
  contextTabId?: string;
}

/** Tools that mutate whatever request is ACTIVE (not ones that open a new tab). */
const ACTIVE_TAB_TOOLS = new Set(['update_http_request', 'set_test_script', 'enrich_docs']);

// Stable empty reference so the messages selector doesn't return a fresh array
// (which would re-render every store change under Object.is equality).
const EMPTY_MESSAGES: ChatMessage[] = [];

function uuid(): string {
  // streamId must satisfy z.uuid() at the IPC boundary. Electron's
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
      : EMPTY_MESSAGES
  );
  const activeProvider = useAiChatStore((s) => s.activeProvider);
  const providerConfig = useAiChatStore((s) => s.providerConfigs[s.activeProvider]);
  const panelWidth = useAiChatStore((s) => s.panelWidth);
  const newConversation = useAiChatStore((s) => s.newConversation);
  const agentToolsEnabled = useAiChatStore((s) => s.agentToolsEnabled);
  const setAgentToolsEnabled = useAiChatStore((s) => s.setAgentToolsEnabled);
  const queuedAction = useAiChatStore((s) => s.queuedAction);
  const clearQueuedAction = useAiChatStore((s) => s.clearQueuedAction);
  const agentSession = useAiChatStore((s) => s.agentSession);
  const setAgentSession = useAiChatStore((s) => s.setAgentSession);
  // A cloud provider is ready once its API-key handle is set; a local
  // (openai-compatible) provider is ready once its base URL is set (no key).
  const apiKeyConfigured =
    !!providerConfig &&
    (isLocalProvider(providerConfig.provider)
      ? !!providerConfig.baseUrlOverride
      : !!providerConfig.apiKeyRef?.id);

  const [streamingId, setStreamingId] = useState<string | null>(null);
  // Tool calls proposed by the assistant, awaiting user approval ("propose &
  // apply" consent model). Nothing mutates until the user clicks Apply.
  const [toolCalls, setToolCalls] = useState<PendingToolCall[]>([]);
  // Agent Mode goal-entry row (collapsed by default).
  const [agentInputOpen, setAgentInputOpen] = useState(false);
  const [agentGoal, setAgentGoal] = useState('');
  const cancelRef = useRef<(() => void) | null>(null);
  const flushBufferRef = useRef<{ msgId: string; buffer: string } | null>(null);
  const rafRef = useRef<number | null>(null);
  // Synchronous lock so a double-click on Apply can't run the same tool twice
  // (setToolCalls is async, so the card is still on screen for the 2nd click).
  const appliedIdsRef = useRef<Set<string>>(new Set());
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

  const handleSend = async (
    text: string,
    rawMode: boolean,
    opts?: { forceTools?: boolean; agentMode?: boolean }
  ): Promise<{ ok: boolean; sawToolCall: boolean }> => {
    if (!providerConfig || sendingRef.current) return { ok: false, sawToolCall: false };
    sendingRef.current = true;
    setToolCalls([]);
    appliedIdsRef.current.clear();
    let sawToolCall = false;
    const snapshot = captureActive();

    // Read prior turns from the live store at call time — NOT the render-time
    // `activeConv` closure — so rapid successive sends don't build context from
    // a stale snapshot that omits the previous turn.
    const stateBefore = useAiChatStore.getState();
    const convIdBefore = stateBefore.activeConversationId;
    const priorTurns = (
      convIdBefore ? (stateBefore.conversations[convIdBefore]?.messages ?? []) : []
    )
      .slice(-20)
      .map((m) => ({ role: m.role, content: m.text }));

    useAiChatStore.getState().appendUserMessage(text, snapshot.contextRef, rawMode);
    const assistantMsgId = useAiChatStore.getState().appendAssistantPlaceholder();

    const messages = buildMessages({
      snapshot,
      priorTurns,
      userText: text,
      rawMode,
      ...(opts?.agentMode ? { system: SYSTEM_AGENT_PROMPT } : {}),
    });

    const streamId = uuid();
    const spec = {
      streamId,
      provider: activeProvider,
      model: providerConfig.defaultModel,
      messages,
      // Omit (don't empty-string) for a key-less local provider — the IPC schema
      // is `z.uuid().optional()`, which rejects ''.
      ...(providerConfig.apiKeyRef?.id ? { apiKeyHandleId: providerConfig.apiKeyRef.id } : {}),
      ...(providerConfig.baseUrlOverride
        ? { baseUrlOverride: providerConfig.baseUrlOverride }
        : {}),
      rawMode,
      // Advertise agent tools so the model can propose actions (create request,
      // write a test) — when the user has tools enabled, OR for a one-shot
      // inline action (forceTools) that requires them regardless of the toggle.
      // Proposals still require explicit user approval to apply.
      ...(agentToolsEnabled || opts?.forceTools ? { tools: agentToolDefs() } : {}),
    };

    const ai = getElectronAPI()?.ai;
    if (!ai) {
      useAiChatStore
        .getState()
        .setMessageError(assistantMsgId, 'AI not available (non-Electron build).');
      sendingRef.current = false;
      return { ok: false, sawToolCall: false };
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
      useAiChatStore
        .getState()
        .setMessageError(assistantMsgId, 'error' in result ? result.error : 'Unknown error');
      setStreamingId(null);
      cancelRef.current = null;
      flushBufferRef.current = null;
      sendingRef.current = false;
      return { ok: false, sawToolCall: false };
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
        } else if (ev.type === 'tool_call') {
          // Surface as a pending proposal; don't mutate state until approved.
          // Tag it with the tab the context came from so apply can detect a tab
          // switch before mutating the wrong request.
          sawToolCall = true;
          setToolCalls((prev) => [
            ...prev,
            { id: ev.id, name: ev.name, input: ev.input, contextTabId: snapshot.contextRef.tabId },
          ]);
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
    return { ok: !errored, sawToolCall };
  };

  // Keep the latest handleSend reachable from effects / agent orchestration
  // without making them depend on handleSend's per-render identity (which would
  // re-fire spuriously). handleSend reads all live state via getState().
  const handleSendRef = useRef(handleSend);
  handleSendRef.current = handleSend;

  // Run one Agent-Mode turn and advance the session state machine: a proposed
  // tool call → 'awaiting-apply' (wait for the user); a final answer with no
  // tool call → 'done'; a failed send → 'error'.
  const runAgentTurn = async (text: string) => {
    const res = await handleSendRef.current(text, false, { agentMode: true, forceTools: true });
    const current = useAiChatStore.getState().agentSession;
    if (!isAgentActive(current)) return; // stopped/closed mid-flight
    if (!res.ok) {
      setAgentSession(onAgentError(current));
      return;
    }
    setAgentSession(onAgentTurnComplete(current, res.sawToolCall));
  };

  const startAgent = (goal: string) => {
    if (!goal.trim() || sendingRef.current) return;
    setAgentSession(startAgentSession(goal.trim()));
    void runAgentTurn(goal.trim());
  };

  const stopAgent = () => {
    cancelRef.current?.(); // cancel any in-flight stream
    setToolCalls([]);
    const current = useAiChatStore.getState().agentSession;
    if (current) setAgentSession(onAgentStopped(current));
  };

  const applyToolCall = (tc: PendingToolCall) => {
    // Re-entrancy lock: a double-click would otherwise run the tool twice before
    // the card unmounts (setToolCalls is async).
    if (appliedIdsRef.current.has(tc.id)) return;
    appliedIdsRef.current.add(tc.id);

    const inAgentStep = useAiChatStore.getState().agentSession?.status === 'awaiting-apply';

    // Guard against applying an active-request mutation after the user switched
    // tabs — the proposal was built against a different request's context.
    if (
      ACTIVE_TAB_TOOLS.has(tc.name) &&
      tc.contextTabId &&
      tc.contextTabId !== useRequestStore.getState().activeTabId
    ) {
      toast.error('The active request changed — re-run the action on the intended request.');
      setToolCalls((prev) => prev.filter((t) => t.id !== tc.id));
      const cur = useAiChatStore.getState().agentSession;
      if (cur && cur.status === 'awaiting-apply') setAgentSession(onAgentError(cur));
      return;
    }

    const res = runAgentTool(tc.name, tc.input);
    if (res.ok) toast.success(res.summary);
    else toast.error(res.error);
    setToolCalls((prev) => prev.filter((t) => t.id !== tc.id));

    // Agent Mode bookkeeping: advance the loop only on success; on failure end
    // the run with an error so it can't dangle in 'awaiting-apply' forever.
    const current = useAiChatStore.getState().agentSession;
    if (inAgentStep && current && current.status === 'awaiting-apply') {
      if (!res.ok) {
        setAgentSession(onAgentError(current));
        return;
      }
      const next = onAgentApplied(current);
      setAgentSession(next);
      // The agent works one step at a time — drop any other pending proposals
      // (e.g. a turn that emitted multiple tool calls) so none can be applied
      // after the loop has advanced or hit the cap.
      setToolCalls([]);
      if (next.status === 'running') {
        void runAgentTurn('The previous step was applied. Continue toward the goal.');
      }
    }
  };

  const dismissToolCall = (id: string) => {
    setToolCalls((prev) => prev.filter((t) => t.id !== id));
    // Dismissing a proposed step ends an Agent-Mode run (the user rejected the
    // agent's next move).
    const current = useAiChatStore.getState().agentSession;
    if (current && current.status === 'awaiting-apply') setAgentSession(onAgentStopped(current));
  };

  const prettyInput = (raw: string): string => {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  };

  // Consume a queued inline action ("Fix request", "Generate tests", …). Gated
  // so it never races the manual send path: it waits until a provider is
  // configured AND no stream is in flight (streamingId null + sendingRef clear).
  // streamingId is in the deps so the effect re-fires when a stream finishes,
  // draining an action queued mid-stream. We clear BEFORE sending so a given
  // action fires exactly once.
  useEffect(() => {
    if (!queuedAction || !apiKeyConfigured || streamingId || sendingRef.current) return;
    const action = queuedAction;
    clearQueuedAction();
    void handleSendRef.current(action.userText, false, { forceTools: action.forceTools });
  }, [queuedAction, apiKeyConfigured, streamingId, clearQueuedAction]);

  // Panel unmount (user closed the AI panel): cancel any in-flight stream and
  // mark an active agent run stopped so it can't dangle "running" forever.
  useEffect(() => {
    return () => {
      cancelRef.current?.();
      const s = useAiChatStore.getState().agentSession;
      if (isAgentActive(s)) useAiChatStore.getState().setAgentSession(onAgentStopped(s));
    };
  }, []);

  const agentBusy = isAgentActive(agentSession);

  return (
    <aside
      className="sp-chrome border-sp-line flex h-full flex-col border-l"
      style={{ width: panelWidth }}
    >
      <header className="flex items-center justify-between border-b border-border/40 px-3 py-2">
        <div className="flex flex-col">
          <span className="text-xs font-medium">AI chat</span>
          {messages.length > 0 &&
            (() => {
              const total = messages.reduce((sum, m) => sum + (m.usage?.estimatedCostUSD ?? 0), 0);
              return total > 0 ? (
                <span className="text-[10px] text-muted-foreground">
                  Conversation cost: ${total.toFixed(4)}
                </span>
              ) : null;
            })()}
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setAgentToolsEnabled(!agentToolsEnabled)}
            aria-label={agentToolsEnabled ? 'Disable agent actions' : 'Enable agent actions'}
            aria-pressed={agentToolsEnabled}
            title={
              agentToolsEnabled
                ? 'Agent actions on — the assistant may propose actions to apply'
                : 'Agent actions off — chat only'
            }
            className={agentToolsEnabled ? 'text-sp-accent' : 'text-muted-foreground'}
          >
            <Wand2 className="h-4 w-4" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setAgentInputOpen((v) => !v)}
            aria-label="Agent mode"
            aria-pressed={agentInputOpen || agentBusy}
            title="Agent mode — give the assistant a goal; it works step by step, you approve each action"
            className={agentInputOpen || agentBusy ? 'text-sp-accent' : 'text-muted-foreground'}
          >
            <Bot className="h-4 w-4" />
          </Button>
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
      {toolCalls.length > 0 && (
        <div className="border-t border-border/40 p-2 space-y-2 max-h-60 overflow-auto">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground px-0.5">
            Proposed actions
          </div>
          {toolCalls.map((tc) => (
            <div key={tc.id} className="rounded-md border border-border/40 bg-muted/30 p-2">
              <div className="flex items-center gap-1.5 text-xs font-medium">
                <Wand2 className="h-3.5 w-3.5 text-sp-accent" /> {tc.name}
              </div>
              <pre className="mt-1 text-[10px] text-muted-foreground whitespace-pre-wrap break-words max-h-24 overflow-auto">
                {prettyInput(tc.input)}
              </pre>
              <div className="mt-1.5 flex gap-1.5">
                <Button size="sm" onClick={() => applyToolCall(tc)}>
                  <Check className="mr-1 h-3.5 w-3.5" /> Apply
                </Button>
                <Button size="sm" variant="ghost" onClick={() => dismissToolCall(tc.id)}>
                  Dismiss
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
      {agentSession && (
        <div className="border-t border-border/40 px-3 py-2 text-[11px]">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <Bot className="h-3.5 w-3.5 shrink-0 text-sp-accent" />
              <span className="truncate" title={agentSession.goal}>
                {agentSession.goal}
              </span>
            </div>
            {agentBusy && (
              <Button
                size="sm"
                variant="ghost"
                onClick={stopAgent}
                aria-label="Stop agent"
                className="h-6 shrink-0 px-1.5 text-muted-foreground hover:text-destructive"
              >
                <Square className="mr-1 h-3 w-3" /> Stop
              </Button>
            )}
          </div>
          <div className="mt-0.5 text-[10px] text-muted-foreground">
            {agentStatusLabel(agentSession.status)} · step {agentSession.stepCount}/
            {agentSession.maxSteps}
          </div>
        </div>
      )}
      {agentInputOpen && !agentBusy && (
        <form
          className="border-t border-border/40 p-2"
          onSubmit={(e) => {
            e.preventDefault();
            startAgent(agentGoal);
            setAgentGoal('');
            setAgentInputOpen(false);
          }}
        >
          <div className="flex items-center gap-1.5">
            <input
              value={agentGoal}
              onChange={(e) => setAgentGoal(e.target.value)}
              placeholder="Agent goal, e.g. make this request succeed and add tests"
              disabled={!apiKeyConfigured}
              aria-label="Agent goal"
              className="min-w-0 flex-1 rounded-md border border-border/40 bg-muted/30 px-2 py-1 text-xs outline-none focus:border-sp-accent"
            />
            <Button size="sm" type="submit" disabled={!apiKeyConfigured || !agentGoal.trim()}>
              <Bot className="mr-1 h-3.5 w-3.5" /> Start
            </Button>
          </div>
        </form>
      )}
      <Composer
        // Disabled during an agent run: the agent owns the conversation, and a
        // manual send would both race its next turn and pollute the context the
        // loop replays.
        disabled={!apiKeyConfigured || agentBusy}
        streaming={!!streamingId}
        onSend={(t, r) => void handleSend(t, r)}
        onStop={() => cancelRef.current?.()}
      />
    </aside>
  );
}

function agentStatusLabel(status: string): string {
  switch (status) {
    case 'running':
      return 'Thinking…';
    case 'awaiting-apply':
      return 'Proposed a step — review and Apply';
    case 'done':
      return 'Goal complete';
    case 'stopped':
      return 'Stopped';
    case 'error':
      return 'Error';
    case 'max-steps':
      return 'Reached the step limit';
    default:
      return status;
  }
}

export default ChatPanel;
