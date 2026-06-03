import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { v4 as uuidv4 } from 'uuid';
import { dexieStorageAdapters } from '@/lib/shared/dexie-storage';
import { debouncedStorage } from '@/lib/shared/debouncedStorage';
import { AiChatStateSchema, type PersistedAiChatState } from '@/lib/shared/store-validators';
import type { CloudProvider, Provider } from '@shared/protocol/ai/types';

type SecretRefHandle = { kind: 'handle'; id: string; label?: string };

export interface ProviderConfig {
  provider: Provider;
  defaultModel: string;
  apiKeyRef: SecretRefHandle;
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
  usage?: { promptTokens: number; completionTokens: number; estimatedCostUSD: number };
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

export interface AiChatState extends PersistedAiChatState {
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
  setProviderConfig: (p: CloudProvider, cfg: ProviderConfig | null) => void;
  setActiveProvider: (p: CloudProvider) => void;
  setRedactionMode: (m: 'default' | 'raw') => void;
  setAgentToolsEnabled: (enabled: boolean) => void;
}

const DEFAULT_STATE: PersistedAiChatState = {
  conversations: {},
  activeConversationId: null,
  panelOpen: false,
  panelWidth: 380,
  providerConfigs: { openai: null, anthropic: null, openrouter: null },
  activeProvider: 'anthropic',
  redactionMode: 'default',
  agentToolsEnabled: true,
};

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
        conversations: state.conversations,
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
        const parsed = AiChatStateSchema.safeParse(state);
        if (!parsed.success) {
          // Merge (NOT replace) — DEFAULT_STATE carries every persisted data
          // field, so this overwrites all of them with defaults while keeping
          // the store's action methods intact. replace:true would wipe them.
          useAiChatStore.setState({ ...DEFAULT_STATE });
          return;
        }
        // Recover from a reload mid-stream: any streaming message becomes errored.
        const conversations = { ...state.conversations };
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
        useAiChatStore.setState({ conversations });
      },
    }
  )
);
