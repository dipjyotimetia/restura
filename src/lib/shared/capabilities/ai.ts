// Capability rows: AI assistant.
// Order is significant: it is the row order of docs/CAPABILITY_MATRIX.md.
import type { CapabilityRow } from './types';

export const AI_CAPABILITIES = {
  'ai.basic': {
    label: 'AI assistant (streaming chat)',
    web: false,
    desktop: true,
    notes: 'Electron-only; tokens stream over IPC (ai:chat:chunk/end). No Worker /api/ai route',
  },
  'ai.toolCalls': {
    label: 'AI assistant tool calls',
    web: false,
    desktop: true,
    notes: 'Provider tool-call decoding (OpenAI / Anthropic / OpenRouter) in the chat path',
  },
  'ai.inlineActions': {
    label: 'Inline AI actions (Fix request / Generate tests / Enrich docs)',
    web: false,
    desktop: true,
    notes:
      'One-click request/response actions that seed a chat send through the propose-&-apply harness; reuse the ai.basic IPC path',
  },
  'ai.agentMode': {
    label: 'AI Agent Mode (multi-step, strict propose-&-apply)',
    web: false,
    desktop: true,
    notes:
      'Goal-driven loop over the existing ai:chat channel; one tool proposal per turn, every mutation user-approved, hard step cap. No new IPC/provider surface',
  },
} as const satisfies Record<string, CapabilityRow>;
