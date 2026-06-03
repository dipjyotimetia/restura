import { describe, it, expect, vi } from 'vitest';
import { listModels, testConnection } from '@shared/protocol/ai/model-discovery';
import type { Fetcher, FetcherRequest, FetcherResponse } from '@shared/protocol/types';

function jsonFetcher(byUrl: Record<string, { status?: number; json: unknown }>): Fetcher {
  return vi.fn(async (req: FetcherRequest): Promise<FetcherResponse> => {
    const match = byUrl[req.url];
    const status = match?.status ?? (match ? 200 : 404);
    return {
      status,
      statusText: String(status),
      headers: new Headers(),
      contentLengthHeader: null,
      text: async () => JSON.stringify(match?.json ?? { error: 'not found' }),
    };
  });
}

describe('listModels', () => {
  it('discovers Ollama models via GET /api/tags', async () => {
    const fetcher = jsonFetcher({
      'http://localhost:11434/api/tags': {
        json: { models: [{ name: 'llama3.2:latest' }, { name: 'qwen2.5-coder' }] },
      },
    });
    const models = await listModels({
      provider: 'ollama',
      baseUrl: 'http://localhost:11434/',
      fetcher,
    });
    expect(models.map((m) => m.id)).toEqual(['llama3.2:latest', 'qwen2.5-coder']);
    // GET, not POST.
    const req = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as FetcherRequest;
    expect(req.method).toBe('GET');
  });

  it('discovers OpenAI-compatible models via GET /v1/models and sorts them', async () => {
    const fetcher = jsonFetcher({
      'http://localhost:1234/v1/models': {
        json: { data: [{ id: 'mistral' }, { id: 'gemma' }] },
      },
    });
    const models = await listModels({
      provider: 'openai-compatible',
      baseUrl: 'http://localhost:1234',
      apiKey: 'sk-x',
      fetcher,
    });
    expect(models.map((m) => m.id)).toEqual(['gemma', 'mistral']);
    const req = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as FetcherRequest;
    expect((req.headers as Record<string, string>).Authorization).toBe('Bearer sk-x');
  });

  it('throws on a non-2xx discovery response', async () => {
    const fetcher = jsonFetcher({
      'http://localhost:11434/api/tags': { status: 500, json: { error: 'down' } },
    });
    await expect(
      listModels({ provider: 'ollama', baseUrl: 'http://localhost:11434', fetcher })
    ).rejects.toThrow(/discovery failed/i);
  });
});

describe('testConnection', () => {
  it('returns ok with a model count on success', async () => {
    const fetcher = jsonFetcher({
      'http://localhost:11434/api/tags': { json: { models: [{ name: 'llama3.2' }] } },
    });
    const result = await testConnection({
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
      fetcher,
    });
    expect(result).toEqual({ ok: true, modelCount: 1 });
  });

  it('returns ok:false with an error message on failure', async () => {
    const fetcher = jsonFetcher({});
    const result = await testConnection({
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
      fetcher,
    });
    expect(result.ok).toBe(false);
  });
});
