import type { ChatProvider, Provider } from '@shared/protocol/ai/types';
import { v4 as uuidv4 } from 'uuid';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AgentSession } from '@/features/ai/agent/agentSession';
import { debouncedStorage } from '@/lib/shared/debouncedStorage';
import { dexieStorageAdapters } from '@/lib/shared/dexie-storage';
import { quarantineState } from '@/lib/shared/persistence/quarantine';
import {
  AiChatStateSchema,
  ConversationSchema,
  type PersistedAiChatState,
} from '@/lib/shared/store-validators';

type SecretRefHandle = { kind: 'handle'; id: string; label?: string };

export interface ProviderConfig {
  provider: Provider;
  defaultModel: string;
  // Optional: a local openai-compatible provider needs no API key handle.
  apiKeyRef?: SecretRefHandle;
  baseUrlOverride?: string;
}

export interface ContextRef {
  kind: 'request' | 'response' | 'history-entry' | 'none';
  tabId?: string;
  historyId?: string;
  capturedAt: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  status: 'streaming' | 'done' | 'error';
  errorMessage?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    estimatedCostUSD: number;
    /** No price entry for the model: the cost is unknown, not $0. */
    costUnknown?: boolean;
  };
  contextRef?: ContextRef;
  rawMode?: boolean;
  createdAt: number;
}

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

/**
 * Persistence caps. Every debounced flush re-encrypts and rewrites the whole
 * persisted chat state, so an unbounded history grows the write (and the
 * Dexie row) forever. Only the persisted copy is capped: the newest
 * conversations by `updatedAt` (the active one always survives) and the latest
 * messages of each. The in-memory session keeps everything until reload.
 */
export const MAX_PERSISTED_CONVERSATIONS = 50;
export const MAX_PERSISTED_MESSAGES = 200;

function capPersistedConversations(
  conversations: Record<string, Conversation>,
  activeId: string | null
): Record<string, Conversation> {
  const newestFirst = Object.values(conversations).sort((a, b) => b.updatedAt - a.updatedAt);
  const active = activeId ? conversations[activeId] : undefined;
  const kept = newestFirst.slice(0, MAX_PERSISTED_CONVERSATIONS);
  if (active && !kept.includes(active)) kept.splice(MAX_PERSISTED_CONVERSATIONS - 1, 1, active);
  return Object.fromEntries(
    kept.map((conv) => [
      conv.id,
      conv.messages.length > MAX_PERSISTED_MESSAGES
        ? { ...conv, messages: conv.messages.slice(-MAX_PERSISTED_MESSAGES) }
        : conv,
    ])
  );
}

/**
 * A one-shot chat action queued from an inline UI button (e.g. "Fix request").
 * Ephemeral — never persisted. `forceTools` advertises the agent tools for this
 * send regardless of the user's `agentToolsEnabled` preference, so an inline
 * action can always propose a mutation without permanently flipping the toggle.
 */
export interface QueuedAction {
  userText: string;
  forceTools: boolean;
}

// `conversations` is re-typed with the hand-written `Conversation`/`ChatMessage`
// interfaces rather than the Zod-inferred persisted type. Zod's `.optional()`
// widens optionals to `T | undefined`, which clashes with the hand-written
// optionals under `exactOptionalPropertyTypes` (on in the http feature's
// tsconfig, which reaches this store via the inline AI actions). Same runtime
// shape; this just keeps the store EOPT-clean wherever it's imported.
export interface AiChatState extends Omit<PersistedAiChatState, 'conversations'> {
  conversations: Record<string, Conversation>;
  /** Set by enqueueAction; consumed (and cleared) by the ChatPanel effect. */
  queuedAction: QueuedAction | null;
  enqueueAction: (action: { userText: string }) => void;
  clearQueuedAction: () => void;
  /** Active Agent Mode run (ephemeral, never persisted). */
  agentSession: AgentSession | null;
  setAgentSession: (s: AgentSession | null) => void;
  newConversation: () => string;
  setActive: (id: string) => void;
  deleteConversation: (id: string) => void;
  appendUserMessage: (text: string, ref: ContextRef, rawMode: boolean) => string;
  appendAssistantPlaceholder: () => string;
  appendAssistantDelta: (id: string, delta: string) => void;
  finalizeAssistantMessage: (id: string, usage?: ChatMessage['usage']) => void;
  setMessageError: (id: string, error: string) => void;
  setPanelOpen: (open: boolean) => void;
  setPanelWidth: (px: number) => void;
  setProviderConfig: (p: ChatProvider, cfg: ProviderConfig | null) => void;
  setActiveProvider: (p: ChatProvider) => void;
  setRedactionMode: (m: 'default' | 'raw') => void;
  setAgentToolsEnabled: (enabled: boolean) => void;
}

const DEFAULT_STATE: PersistedAiChatState = {
  conversations: {},
  activeConversationId: null,
  panelOpen: false,
  panelWidth: 380,
  providerConfigs: { openai: null, anthropic: null, openrouter: null, 'openai-compatible': null },
  activeProvider: 'anthropic',
  redactionMode: 'default',
  agentToolsEnabled: true,
};

/**
 * Field-wise rehydrate validation for the AI chat store: each conversation is
 * validated on its own (an invalid one is dropped and reported, the rest are
 * kept as persisted), and each other top-level field falls back to its default
 * only when it is itself invalid. An active pointer naming a dropped / missing
 * conversation is cleared. Never throws.
 */
function sanitizePersistedAiChatState(
  raw: unknown,
  defaults: PersistedAiChatState
): {
  state: PersistedAiChatState;
  dropped: Record<string, unknown>;
} {
  const record =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const conversations: PersistedAiChatState['conversations'] = {};
  const dropped: Record<string, unknown> = {};
  const rawConversations = record.conversations;
  if (
    rawConversations &&
    typeof rawConversations === 'object' &&
    !Array.isArray(rawConversations)
  ) {
    for (const [id, conv] of Object.entries(rawConversations)) {
      if (ConversationSchema.safeParse(conv).success) {
        // Keep the persisted object (not the parsed copy) so fields the schema
        // doesn't list are not stripped on every launch.
        conversations[id] = conv as PersistedAiChatState['conversations'][string];
      } else {
        dropped[id] = conv;
      }
    }
  }
  const field = <K extends Exclude<keyof PersistedAiChatState, 'conversations'>>(
    key: K
  ): PersistedAiChatState[K] => {
    const parsed = AiChatStateSchema.shape[key].safeParse(record[key]);
    return parsed.success ? (parsed.data as PersistedAiChatState[K]) : defaults[key];
  };
  const active = field('activeConversationId');
  return {
    state: {
      conversations,
      activeConversationId: active !== null && active in conversations ? active : null,
      panelOpen: field('panelOpen'),
      panelWidth: field('panelWidth'),
      providerConfigs: field('providerConfigs'),
      activeProvider: field('activeProvider'),
      redactionMode: field('redactionMode'),
      agentToolsEnabled: field('agentToolsEnabled'),
    },
    dropped,
  };
}

function deriveTitle(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 60)}…` : oneLine;
}

/**
 * Find the conversation that owns a given message id. Stream updates
 * (delta / finalize / error) must target the conversation the assistant
 * message lives in — NOT whatever conversation is active now, because the user
 * can switch conversations (or start a new chat) while a stream is in flight.
 */
function findConversationByMessageId(
  conversations: Record<string, Conversation>,
  messageId: string
): Conversation | undefined {
  for (const conv of Object.values(conversations)) {
    if (conv.messages.some((m) => m.id === messageId)) return conv;
  }
  return undefined;
}

export const useAiChatStore = create<AiChatState>()(
  persist(
    (set) => ({
      ...DEFAULT_STATE,
      // Re-typed to the hand-written Conversation (DEFAULT_STATE carries the
      // Zod-inferred type, which EOPT rejects here). Same empty value.
      conversations: {} as Record<string, Conversation>,
      queuedAction: null,

      enqueueAction: (action) =>
        // Open the panel so the ChatPanel mounts and its effect can consume the
        // queued action; force tools on for this send.
        set({ queuedAction: { userText: action.userText, forceTools: true }, panelOpen: true }),
      clearQueuedAction: () => set({ queuedAction: null }),

      agentSession: null,
      setAgentSession: (s) => set({ agentSession: s }),

      newConversation: () => {
        const id = uuidv4();
        const now = Date.now();
        set((s) => ({
          conversations: {
            ...s.conversations,
            [id]: { id, title: 'New chat', messages: [], createdAt: now, updatedAt: now },
          },
          activeConversationId: id,
        }));
        return id;
      },

      setActive: (id) => set({ activeConversationId: id }),

      deleteConversation: (id) =>
        set((s) => {
          const conversations = { ...s.conversations };
          delete conversations[id];
          return {
            conversations,
            activeConversationId: s.activeConversationId === id ? null : s.activeConversationId,
          };
        }),

      appendUserMessage: (text, contextRef, rawMode) => {
        const id = uuidv4();
        const now = Date.now();
        set((s) => {
          const activeId = s.activeConversationId;
          if (!activeId) return s;
          const conv = s.conversations[activeId];
          if (!conv) return s;
          const isFirst = conv.messages.length === 0;
          const updated: Conversation = {
            ...conv,
            title: isFirst ? deriveTitle(text) : conv.title,
            messages: [
              ...conv.messages,
              { id, role: 'user', text, status: 'done', contextRef, rawMode, createdAt: now },
            ],
            updatedAt: now,
          };
          return { conversations: { ...s.conversations, [activeId]: updated } };
        });
        return id;
      },

      appendAssistantPlaceholder: () => {
        const id = uuidv4();
        const now = Date.now();
        set((s) => {
          const activeId = s.activeConversationId;
          if (!activeId) return s;
          const conv = s.conversations[activeId];
          if (!conv) return s;
          return {
            conversations: {
              ...s.conversations,
              [activeId]: {
                ...conv,
                messages: [
                  ...conv.messages,
                  { id, role: 'assistant', text: '', status: 'streaming', createdAt: now },
                ],
                updatedAt: now,
              },
            },
          };
        });
        return id;
      },

      appendAssistantDelta: (id, delta) =>
        set((s) => {
          const conv = findConversationByMessageId(s.conversations, id);
          if (!conv) return s;
          return {
            conversations: {
              ...s.conversations,
              [conv.id]: {
                ...conv,
                messages: conv.messages.map((m) =>
                  m.id === id ? { ...m, text: m.text + delta } : m
                ),
                updatedAt: Date.now(),
              },
            },
          };
        }),

      finalizeAssistantMessage: (id, usage) =>
        set((s) => {
          const conv = findConversationByMessageId(s.conversations, id);
          if (!conv) return s;
          return {
            conversations: {
              ...s.conversations,
              [conv.id]: {
                ...conv,
                messages: conv.messages.map((m) =>
                  m.id === id ? { ...m, status: 'done' as const, ...(usage ? { usage } : {}) } : m
                ),
                updatedAt: Date.now(),
              },
            },
          };
        }),

      setMessageError: (id, error) =>
        set((s) => {
          const conv = findConversationByMessageId(s.conversations, id);
          if (!conv) return s;
          return {
            conversations: {
              ...s.conversations,
              [conv.id]: {
                ...conv,
                messages: conv.messages.map((m) =>
                  m.id === id ? { ...m, status: 'error' as const, errorMessage: error } : m
                ),
                updatedAt: Date.now(),
              },
            },
          };
        }),

      setPanelOpen: (open) => set({ panelOpen: open }),
      setPanelWidth: (px) => set({ panelWidth: Math.max(280, Math.min(800, px)) }),
      setProviderConfig: (p, cfg) =>
        set((s) => ({ providerConfigs: { ...s.providerConfigs, [p]: cfg } })),
      setActiveProvider: (p) => set({ activeProvider: p }),
      setRedactionMode: (m) => set({ redactionMode: m }),
      setAgentToolsEnabled: (enabled) => set({ agentToolsEnabled: enabled }),
    }),
    {
      name: 'ai-chat-store',
      // Debounced so streamed deltas don't trigger a full-history re-encrypt per
      // frame (see debouncedStorage). 400ms trailing, 2s max between writes.
      storage: debouncedStorage(dexieStorageAdapters.aiChat(), 400, 2000),
      version: 1,
      partialize: (state) => ({
        conversations: capPersistedConversations(state.conversations, state.activeConversationId),
        activeConversationId: state.activeConversationId,
        panelOpen: state.panelOpen,
        panelWidth: state.panelWidth,
        providerConfigs: state.providerConfigs,
        activeProvider: state.activeProvider,
        redactionMode: state.redactionMode,
        agentToolsEnabled: state.agentToolsEnabled,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        // Field-wise: one invalid conversation (or field) must not wipe the
        // rest. Dropped conversations are quarantined for recovery.
        const { state: valid, dropped } = sanitizePersistedAiChatState(state, DEFAULT_STATE);
        const droppedIds = Object.keys(dropped);
        if (droppedIds.length > 0) {
          console.warn(`[ai-chat] dropped ${droppedIds.length} invalid persisted conversation(s)`);
          void quarantineState(
            `quarantine:aiChat:ai-chat-store:${new Date().toISOString()}`,
            dropped,
            `invalid conversation(s): ${droppedIds.join(', ')}`
          );
        }
        // Recover from a reload mid-stream: any streaming message becomes errored.
        const conversations = { ...valid.conversations };
        for (const [cid, conv] of Object.entries(conversations)) {
          let touched = false;
          const fixed = conv.messages.map((m) => {
            if (m.status === 'streaming') {
              touched = true;
              return { ...m, status: 'error' as const, errorMessage: 'Interrupted by reload' };
            }
            return m;
          });
          if (touched) conversations[cid] = { ...conv, messages: fixed };
        }
        // Cast across the persistence boundary: the Zod-parsed `state` widens
        // optionals to `| undefined`; the runtime shape matches Conversation.
        useAiChatStore.setState({
          ...valid,
          conversations: conversations as Record<string, Conversation>,
        });
      },
    }
  )
);
