import type { Fetcher } from '@shared/protocol/types';
import { isLocalProvider, type Provider } from './types';

export interface DiscoveredModel {
  id: string;
  label?: string;
  // OpenRouter-specific rich metadata. Only populated for OpenRouter discovery
  // (the OpenRouter public API returns these in /v1/models); other providers
  // leave them undefined and the UI falls back to the model id.
  description?: string;
  /** Max context window in tokens (OpenRouter's `context_length`). */
  contextLength?: number;
  /** OpenRouter's `modality` string, e.g. "text+image->text". */
  modality?: string;
  inputModalities?: string[];
  outputModalities?: string[];
  /**
   * Per-million-token USD prices. OpenRouter returns per-token strings; we
   * multiply by 1_000_000 so consumers can show "$3 / 1M" without a unit
   * conversion at the call site.
   */
  pricing?: {
    promptPerMTokUSD?: number;
    completionPerMTokUSD?: number;
  };
  /** ISO 8601 timestamp the model was first listed (provider-normalised). */
  createdAt?: string;
  /**
   * Provider/owner of the model — OpenAI's `owned_by` (e.g. "openai",
   * "openai-dev"), Anthropic's vendor (always "anthropic"), OpenRouter's
   * `top_provider.name` when present, Ollama's `details.family`
   * (e.g. "llama", "qwen2"). Surfaces as a small subtitle chip in the model
   * checklist so users can tell two slugs from the same org apart.
   */
  vendor?: string;
  // Ollama-specific. Populated only when the discovery endpoint is Ollama's
  // `/api/tags` (which returns a `details` block per model). The values are
  // Ollama's native strings — no normalisation — so "3.2B" stays "3.2B".
  family?: string;
  parameterSize?: string;
  quantizationLevel?: string;
  /** Model file size in bytes (Ollama's `size`). */
  sizeBytes?: number;
  /** ISO 8601 last-modified timestamp (Ollama's `modified_at`). */
  modifiedAt?: string;
}

export interface DiscoverArgs {
  provider: Provider;
  /** Resolved base URL (no trailing slash needed; normalised here). */
  baseUrl: string;
  apiKey?: string;
  fetcher: Fetcher;
  signal?: AbortSignal;
}

/**
 * Ollama lists models at `GET /api/tags` → `{ models: [{ name, details, ... }] }`.
 * OpenAI exposes `GET /v1/models` → `{ data: [{ id, created, owned_by }] }`.
 * Anthropic exposes `GET /v1/models` → `{ data: [{ id, display_name, created_at }] }`.
 * OpenRouter's `/v1/models` returns the same envelope as OpenAI but with much
 * richer fields (name, description, context_length, modality, pricing), so we
 * special-case it to keep that metadata flowing through to the AI Lab UI.
 * Generic OpenAI-compatible gateways use the same `/v1/models` envelope as
 * OpenAI but typically only populate `id` and `display_name`.
 *
 * Returns a flat, de-duplicated, sorted list. Throws on transport / non-2xx /
 * parse failure so the caller can surface a connection error.
 */
export async function listModels(args: DiscoverArgs): Promise<DiscoveredModel[]> {
  const base = args.baseUrl.replace(/\/+$/, '');
  if (args.provider === 'ollama') {
    return fetchOllamaTags(base, args);
  }
  if (args.provider === 'openrouter') {
    return fetchOpenRouterModels(base, args);
  }
  if (args.provider === 'anthropic') {
    return fetchAnthropicModels(base, args);
  }
  if (args.provider === 'openai') {
    return fetchOpenAiModels(base, args);
  }
  if (args.provider === 'huggingface') {
    return fetchHuggingFaceModels(base, args);
  }
  return fetchOpenAiCompatibleModels(base, args);
}

/** Lightweight reachability check used by the AI Lab "Test connection" button. */
export async function testConnection(
  args: DiscoverArgs
): Promise<{ ok: true; modelCount: number } | { ok: false; error: string }> {
  try {
    const models = await listModels(args);
    return { ok: true, modelCount: models.length };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function fetchJson(url: string, args: DiscoverArgs): Promise<unknown> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  // Anthropic needs its own auth header shape; everything else uses Bearer.
  // OpenRouter's public /v1/models endpoint is also accessible without auth
  // (rate-limited); the auth header is only sent when an apiKey is present.
  if (args.apiKey) {
    if (args.provider === 'anthropic') {
      headers['x-api-key'] = args.apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers.Authorization = `Bearer ${args.apiKey}`;
    }
  }
  const res = await args.fetcher({
    url,
    method: 'GET',
    headers,
    body: undefined,
    signal: args.signal ?? new AbortController().signal,
  });
  if (res.status < 200 || res.status >= 300) {
    let detail = '';
    try {
      detail = await res.text();
    } catch {
      detail = '';
    }
    throw new Error(`Model discovery failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  const raw = await res.text();
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Model discovery returned malformed JSON.');
  }
}

async function fetchOllamaTags(base: string, args: DiscoverArgs): Promise<DiscoveredModel[]> {
  const json = (await fetchJson(`${base}/api/tags`, args)) as {
    models?: Array<OllamaModelWire>;
  };
  const out = (json.models ?? [])
    .map((m) => {
      const id = m.name ?? m.model;
      if (typeof id !== 'string' || id.length === 0) return undefined;
      const detail: DiscoveredModel = { id };
      // Ollama's `details` block carries the most useful runtime info:
      // parameter_size ("3.2B"), quantization_level ("Q4_K_M"), and family
      // ("llama"). We surface all three so the model checklist can show
      // "3.2B · Q4_K_M" without a separate probe call.
      const d = m.details;
      if (d) {
        if (typeof d.family === 'string' && d.family.length > 0) detail.family = d.family;
        if (typeof d.parameter_size === 'string' && d.parameter_size.length > 0) {
          detail.parameterSize = d.parameter_size;
        }
        if (typeof d.quantization_level === 'string' && d.quantization_level.length > 0) {
          detail.quantizationLevel = d.quantization_level;
        }
      }
      // Use family as the vendor display when nothing else is available —
      // a "llama" model has a meaningfully different origin than "qwen2".
      if (!detail.vendor && detail.family) detail.vendor = detail.family;
      if (typeof m.size === 'number' && Number.isFinite(m.size) && m.size >= 0) {
        detail.sizeBytes = m.size;
      }
      if (typeof m.modified_at === 'string' && m.modified_at.length > 0) {
        detail.modifiedAt = m.modified_at;
      }
      return detail;
    })
    .filter((m): m is DiscoveredModel => m !== undefined);
  return dedupeSort(out);
}

interface OllamaModelWire {
  name?: string;
  model?: string;
  modified_at?: string;
  size?: number;
  details?: {
    format?: string;
    family?: string;
    families?: string[];
    parameter_size?: string;
    quantization_level?: string;
  };
}

/**
 * OpenAI's `/v1/models` returns `{ data: [{ id, object, created, owned_by }] }`
 * — the most minimal cloud catalog. We capture `created` (Unix epoch seconds)
 * as an ISO `createdAt` and `owned_by` as `vendor` so the model checklist
 * can show "openai · 2024-05-13" rather than just the model id.
 */
async function fetchOpenAiModels(base: string, args: DiscoverArgs): Promise<DiscoveredModel[]> {
  const json = (await fetchJson(`${base}/v1/models`, args)) as {
    data?: Array<{ id?: string; created?: number; owned_by?: string }>;
  };
  const out = (json.data ?? [])
    .filter(
      (m): m is { id: string; created?: number; owned_by?: string } =>
        typeof m.id === 'string' && m.id.length > 0
    )
    .map((m) => {
      const detail: DiscoveredModel = { id: m.id };
      if (typeof m.owned_by === 'string' && m.owned_by.length > 0) detail.vendor = m.owned_by;
      if (typeof m.created === 'number' && Number.isFinite(m.created) && m.created > 0) {
        detail.createdAt = new Date(m.created * 1000).toISOString();
      }
      return detail;
    });
  return dedupeSort(out);
}

/**
 * Anthropic's `/v1/models` returns
 * `{ data: [{ id, type, display_name, created_at }], has_more, first_id, last_id }`.
 * `display_name` becomes `label` (so the UI shows "Claude 3.5 Sonnet" instead
 * of the dated slug), and `created_at` is kept as ISO. `vendor` is hardcoded
 * to "anthropic" — every model in their catalog is theirs.
 */
async function fetchAnthropicModels(base: string, args: DiscoverArgs): Promise<DiscoveredModel[]> {
  const json = (await fetchJson(`${base}/v1/models`, args)) as {
    data?: Array<{ id?: string; display_name?: string; created_at?: string }>;
  };
  const out = (json.data ?? [])
    .filter(
      (m): m is { id: string; display_name?: string; created_at?: string } =>
        typeof m.id === 'string' && m.id.length > 0
    )
    .map((m) => {
      const detail: DiscoveredModel = { id: m.id, vendor: 'anthropic' };
      if (typeof m.display_name === 'string' && m.display_name.length > 0) {
        detail.label = m.display_name;
      }
      if (typeof m.created_at === 'string' && m.created_at.length > 0) {
        detail.createdAt = m.created_at;
      }
      return detail;
    });
  return dedupeSort(out);
}

/**
 * HuggingFace Inference Providers router exposes `GET /v1/models` in the same
 * `{ data: [...] }` envelope as the OpenAI-compatible schema. Model ids are
 * slash-namespaced by their hosting org (e.g. `meta-llama/Llama-3.3-70B-Instruct`,
 * `Qwen/Qwen2.5-72B-Instruct`), so we derive a `vendor` chip from the first path
 * segment — the same UX role OpenRouter's `canonical_slug` plays. HF's discovery
 * payload does not include pricing/context/modality, so those stay undefined
 * and the AI Lab falls back to the bare id + vendor chip.
 *
 * Auth: the renderer passes the user's HF token (hf_…) as a Bearer header via
 * `apiKey`; the router requires it for the catalog endpoint. (A bare keyless
 * call returns 401, surfaced by the handler as a discovery failure.)
 */
async function fetchHuggingFaceModels(
  base: string,
  args: DiscoverArgs
): Promise<DiscoveredModel[]> {
  const json = (await fetchJson(`${base}/v1/models`, args)) as {
    data?: Array<HuggingFaceModelWire>;
  };
  const out = (json.data ?? [])
    .filter(
      (m): m is HuggingFaceModelWire & { id: string } => typeof m.id === 'string' && m.id.length > 0
    )
    .map((m) => {
      const detail: DiscoveredModel = { id: m.id };
      // Some HF entries carry a human-readable `name`/`label`; prefer it when present.
      if (typeof m.name === 'string' && m.name.length > 0) {
        detail.label = m.name;
      } else if (typeof m.label === 'string' && m.label.length > 0) {
        detail.label = m.label;
      }
      // Derive the vendor chip from the org segment of the slash-namespaced id —
      // `meta-llama/Llama-…` → "meta-llama". Ids without a slash (a few HF
      // provider-routed models) leave vendor undefined so the UI shows the chip
      // only when it's meaningful. `noUncheckedIndexedAccess` makes the array
      // access `string | undefined`; guard before assigning under EOPT.
      const head = m.id.split('/')[0];
      if (typeof head === 'string' && head.length > 0 && head !== m.id) detail.vendor = head;
      if (typeof m.context_length === 'number' && Number.isFinite(m.context_length)) {
        detail.contextLength = m.context_length;
      }
      if (typeof m.created === 'number' && Number.isFinite(m.created) && m.created > 0) {
        detail.createdAt = new Date(m.created * 1000).toISOString();
      } else if (typeof m.created === 'string' && m.created.length > 0) {
        detail.createdAt = m.created;
      }
      return detail;
    });
  return dedupeSort(out);
}

/** HuggingFace `/v1/models` wire shape — only `id` is guaranteed; the rest is opportunistic. */
interface HuggingFaceModelWire {
  id?: string;
  // HF sometimes populates one or the other; we accept both and prefer `name`.
  name?: string;
  label?: string;
  context_length?: number;
  // Unix epoch seconds (OpenAI-style) OR an ISO string (HF sometimes returns ISO).
  created?: number | string;
}

/**
 * Generic OpenAI-compatible gateway. Same `{ data: [{ id, display_name }] }`
 * envelope as OpenAI, but most third-party gateways don't populate `display_name`
 * or any other rich field — so we just keep what's there.
 */
async function fetchOpenAiCompatibleModels(
  base: string,
  args: DiscoverArgs
): Promise<DiscoveredModel[]> {
  const json = (await fetchJson(`${base}/v1/models`, args)) as {
    data?: Array<{ id?: string; display_name?: string }>;
  };
  const out = (json.data ?? [])
    .filter(
      (m): m is { id: string; display_name?: string } => typeof m.id === 'string' && m.id.length > 0
    )
    .map((m) => (m.display_name ? { id: m.id, label: m.display_name } : { id: m.id }));
  return dedupeSort(out);
}

/**
 * OpenRouter's `/v1/models` returns the same `{ data: [...] }` envelope as the
 * OpenAI-compatible schema, but every entry carries the full metadata
 * (name / description / context_length / modality / pricing). We extract the
 * OpenRouter-specific fields so the AI Lab can show "Claude 3.5 Sonnet ·
 * 200K ctx · text+image→text" instead of just `anthropic/claude-3.5-sonnet`.
 *
 * Pricing values are per-token strings ("0.000003" = $3/MTok); we convert to
 * per-million-token USD so the UI can display the standard unit.
 *
 * OpenRouter's `name` becomes `label` (the UI's "human-readable" field) but
 * `description` is kept separately so callers can show it as a tooltip.
 */
async function fetchOpenRouterModels(base: string, args: DiscoverArgs): Promise<DiscoveredModel[]> {
  const json = (await fetchJson(`${base}/v1/models`, args)) as {
    data?: Array<OpenRouterModelWire>;
  };
  const out = (json.data ?? [])
    .filter(
      (m): m is OpenRouterModelWire & { id: string } => typeof m.id === 'string' && m.id.length > 0
    )
    .map((m) => {
      const detail: DiscoveredModel = { id: m.id };
      if (typeof m.name === 'string' && m.name.length > 0) detail.label = m.name;
      if (typeof m.description === 'string' && m.description.length > 0) {
        detail.description = m.description;
      }
      if (typeof m.context_length === 'number' && Number.isFinite(m.context_length)) {
        detail.contextLength = m.context_length;
      }
      if (typeof m.modality === 'string' && m.modality.length > 0) detail.modality = m.modality;
      if (
        Array.isArray(m.input_modalities) &&
        m.input_modalities.every((x) => typeof x === 'string')
      )
        detail.inputModalities = m.input_modalities;
      if (
        Array.isArray(m.output_modalities) &&
        m.output_modalities.every((x) => typeof x === 'string')
      )
        detail.outputModalities = m.output_modalities;
      const pricing = parseOpenRouterPricing(m.pricing);
      if (pricing) detail.pricing = pricing;
      if (typeof m.created === 'string' && m.created.length > 0) detail.createdAt = m.created;
      if (typeof m.canonical_slug === 'string' && m.canonical_slug.length > 0) {
        // The OpenRouter `top_provider.name` is the upstream owner
        // ("Anthropic", "OpenAI"); use it as the vendor chip in the checklist.
        // Only assign when the first slash segment is non-empty — `noUncheckedIndexedAccess`
        // makes the array access `string | undefined` and the protocol tsconfig's
        // `exactOptionalPropertyTypes` rejects assigning `undefined` to a
        // property declared as `vendor?: string` (no `| undefined`).
        const head = m.canonical_slug.split('/')[0];
        if (typeof head === 'string' && head.length > 0) detail.vendor = head;
      }
      return detail;
    });
  return dedupeSort(out);
}

/** OpenRouter's wire shape — fields not present are simply absent on the model. */
interface OpenRouterModelWire {
  id?: string;
  name?: string;
  description?: string;
  context_length?: number;
  modality?: string;
  input_modalities?: string[];
  output_modalities?: string[];
  pricing?: { prompt?: string; completion?: string };
  created?: string;
  /** Slash-prefixed upstream name (e.g. "anthropic/claude-3.5-sonnet"). */
  canonical_slug?: string;
}

function parseOpenRouterPricing(
  p: OpenRouterModelWire['pricing']
): { promptPerMTokUSD?: number; completionPerMTokUSD?: number } | undefined {
  if (!p) return undefined;
  const out: { promptPerMTokUSD?: number; completionPerMTokUSD?: number } = {};
  if (typeof p.prompt === 'string') {
    const v = Number(p.prompt);
    if (Number.isFinite(v) && v >= 0) out.promptPerMTokUSD = v * 1_000_000;
  }
  if (typeof p.completion === 'string') {
    const v = Number(p.completion);
    if (Number.isFinite(v) && v >= 0) out.completionPerMTokUSD = v * 1_000_000;
  }
  return out.promptPerMTokUSD !== undefined || out.completionPerMTokUSD !== undefined
    ? out
    : undefined;
}

function dedupeSort(models: DiscoveredModel[]): DiscoveredModel[] {
  const seen = new Map<string, DiscoveredModel>();
  for (const m of models) if (!seen.has(m.id)) seen.set(m.id, m);
  return [...seen.values()].sort((a, b) => {
    // Sort by label (human name) when both are present, falling back to id.
    // The label-first ordering puts "Claude 3.5 Sonnet" before
    // "claude-3-haiku" alphabetically by the human name users see, not the
    // slash-namespaced slug.
    const ax = (a.label ?? a.id).toLowerCase();
    const bx = (b.label ?? b.id).toLowerCase();
    return ax.localeCompare(bx);
  });
}

/** Re-exported for callers deciding whether to apply the localhost carve-out. */
export { isLocalProvider };
