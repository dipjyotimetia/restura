// Capability rows: AI Lab workbench and agents.
// Order is significant: it is the row order of docs/CAPABILITY_MATRIX.md.
import type { CapabilityRow } from './types';

export const AI_LAB_CAPABILITIES = {
  'aiLab.basic': {
    label: 'AI Lab (prompt/model workbench)',
    web: false,
    desktop: true,
    notes: 'Electron-only; model calls + SSRF localhost carve-out run in main',
  },
  'aiLab.localProviders': {
    label: 'AI Lab local runtimes (Ollama / OpenAI-compatible)',
    web: false,
    desktop: true,
    notes: 'Needs the localhost SSRF carve-out; no browser access to 127.0.0.1',
  },
  'aiLab.evals': {
    label: 'AI Lab dataset evals (deterministic + script + tool-call + pairwise scorers)',
    web: false,
    desktop: true,
    notes:
      'QuickJS scorers + bounded-concurrency runner over case × model cells; datasets from history/collections/CSV/JSONL/red-team, multi-turn cases',
  },
  'aiLab.judge': {
    label: 'AI Lab LLM-as-judge (incl. pairwise/preference)',
    web: false,
    desktop: true,
    notes:
      'Structured-output judge call via the AI Lab complete path; pairwise with position-bias swap',
  },
  'aiLab.httpExec': {
    label: 'AI Lab http-exec target (execute AI-generated request, score upstream response)',
    web: false,
    desktop: true,
    notes:
      'Model emits an HTTP/GraphQL request; executed via the real request executor (same SSRF guard), upstream response scored. See ADR 0023',
  },
  'aiLab.arena': {
    label: 'AI Lab Arena (pairwise model-vs-model Elo leaderboard)',
    web: false,
    desktop: true,
    notes: 'Round-robin pairwise judging → Elo + win-rate matrix; persisted to the arenaRuns table',
  },
  'aiLab.agentSuites': {
    label: 'AI Lab agent suites (multi-step trials, trajectory/outcome evals)',
    web: false,
    desktop: true,
    notes:
      'AI Lab UI authoring and in-app execution are Electron-only, with one cancellable lifecycle per run surface; v3 suites add explicit selected grounding with provenance traces, task-aware grading, hard run-wide budgets, repeated-trial reliability, and sanitized bounded report persistence. `restura agent eval` supports OpenAI Responses, Anthropic Messages, and Git-native fixture bundles with fail-closed baseline gates.',
  },
  'aiLab.agentProviders': {
    label: 'AI Lab agent provider transports',
    web: false,
    desktop: true,
    notes:
      'Desktop wires OpenAI Chat, Anthropic Messages, OpenRouter, Ollama, Hugging Face, and generic OpenAI-compatible through cancellable keychain-backed IPC with conservative per-model capabilities and explicit user overrides. Headless CLI wires stateless OpenAI Responses and native Anthropic Messages. Gemini, Azure OpenAI, and Bedrock are adapter profiles only, not shipped transports.',
  },
  'aiLab.agentRequestTools': {
    label: 'AI Lab agents using saved Restura HTTP requests as tools',
    web: false,
    desktop: true,
    notes:
      'Runs through the normal request executor and security boundary with run-scoped cancellation; non-read methods require explicit per-call approval',
  },
  'aiLab.agentMcpTools': {
    label: 'AI Lab agents using MCP servers as tools',
    web: false,
    desktop: true,
    notes:
      'Uses saved encrypted MCP profiles with fresh desktop-owned sessions, existing SSRF/DNS pinning and execution policy, allowlists, cancellation, and per-call approval. CLI supports manifest-listed MCP tools when CI explicitly asserts readOnly:true (operator-asserted); tools the server marks destructiveHint:true or readOnlyHint:false are still refused with exit 2 (unannotated tools pass on the operator assertion).',
  },
  'aiLab.agentA2aTools': {
    label: 'AI Lab agents calling remote A2A (Agent2Agent) agents as tools',
    web: false,
    desktop: true,
    notes:
      'One tool per `a2a` source: agent card fetch (well-known path or direct card URL; card must stay on the suite origin), JSON-RPC message/send with tasks/get polling and tasks/cancel on abort. Desktop sends through the request executor (main-process SSRF guard) and every call is network-class, so approval is required. CLI runs only manifest-listed endpoints with readOnly:true over the DNS-pinned transport, with env-sourced headers. No A2A protocol tab',
  },
  'aiLab.agentSandboxes': {
    label: 'AI Lab pluggable code sandboxes',
    web: false,
    desktop: true,
    notes:
      'QuickJS provider (`sandboxId: "quickjs"`) on desktop and in `restura agent eval`: JavaScript only, a fresh WASM runtime per call with the request-script memory/stack/time caps, no network, filesystem, timers or host bridges, bounded stdout/stderr. Docker/Podman providers are a follow-on',
  },
} as const satisfies Record<string, CapabilityRow>;
