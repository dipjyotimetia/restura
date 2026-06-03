import type { Fetcher } from '@shared/protocol/types';
import { isLocalProvider, type Provider } from './types';

export interface DiscoveredModel {
  id: string;
  label?: string;
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
 * Ollama lists models at `GET /api/tags` → `{ models: [{ name, ... }] }`.
 * Every other OpenAI-compatible endpoint (OpenAI, OpenRouter, generic gateways)
 * uses `GET /v1/models` → `{ data: [{ id }] }`. Anthropic also exposes
 * `GET /v1/models` (`{ data: [{ id, display_name }] }`).
 *
 * Returns a flat, de-duplicated, sorted list. Throws on transport / non-2xx /
 * parse failure so the caller can surface a connection error.
 */
export async function listModels(args: DiscoverArgs): Promise<DiscoveredModel[]> {
  const base = args.baseUrl.replace(/\/+$/, '');
  if (args.provider === 'ollama') {
    return fetchOllamaTags(base, args);
  }
  return fetchOpenAiModels(base, args);
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
    models?: Array<{ name?: string; model?: string }>;
  };
  const out = (json.models ?? [])
    .map((m) => m.name ?? m.model)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
    .map((id) => ({ id }));
  return dedupeSort(out);
}

async function fetchOpenAiModels(base: string, args: DiscoverArgs): Promise<DiscoveredModel[]> {
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

function dedupeSort(models: DiscoveredModel[]): DiscoveredModel[] {
  const seen = new Map<string, DiscoveredModel>();
  for (const m of models) if (!seen.has(m.id)) seen.set(m.id, m);
  return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Re-exported for callers deciding whether to apply the localhost carve-out. */
export { isLocalProvider };
