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

  it('discovers OpenRouter models with rich metadata (label, context, modality, pricing)', async () => {
    const fetcher = jsonFetcher({
      'https://openrouter.ai/api/v1/models': {
        json: {
          data: [
            {
              id: 'anthropic/claude-3.5-sonnet',
              name: 'Claude 3.5 Sonnet',
              description: 'Smart, efficient model for everyday tasks.',
              context_length: 200000,
              modality: 'text+image->text',
              input_modalities: ['text', 'image'],
              output_modalities: ['text'],
              pricing: { prompt: '0.000003', completion: '0.000015' },
              created: '2024-10-22T00:00:00.000Z',
            },
            {
              id: 'openai/gpt-4o-mini',
              name: 'GPT-4o mini',
              context_length: 128000,
              modality: 'text+image->text',
              pricing: { prompt: '0.00000015', completion: '0.0000006' },
            },
          ],
        },
      },
    });
    const models = await listModels({
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api',
      // Deliberately no apiKey — the public catalog works anonymously.
      fetcher,
    });
    expect(models).toHaveLength(2);
    const sonnet = models.find((m) => m.id === 'anthropic/claude-3.5-sonnet')!;
    expect(sonnet.label).toBe('Claude 3.5 Sonnet');
    expect(sonnet.contextLength).toBe(200000);
    expect(sonnet.modality).toBe('text+image->text');
    // Pricing is converted from per-token to per-million-token USD.
    expect(sonnet.pricing?.promptPerMTokUSD).toBeCloseTo(3);
    expect(sonnet.pricing?.completionPerMTokUSD).toBeCloseTo(15);
    expect(sonnet.createdAt).toBe('2024-10-22T00:00:00.000Z');
    const gpt = models.find((m) => m.id === 'openai/gpt-4o-mini')!;
    expect(gpt.label).toBe('GPT-4o mini');
    expect(gpt.contextLength).toBe(128000);
    expect(gpt.pricing?.promptPerMTokUSD).toBeCloseTo(0.15);
    expect(gpt.pricing?.completionPerMTokUSD).toBeCloseTo(0.6);
    // Sorted by human label, not id: "Claude 3.5 Sonnet" < "GPT-4o mini".
    expect(models.map((m) => m.label)).toEqual(['Claude 3.5 Sonnet', 'GPT-4o mini']);
    // No Authorization header — public catalog.
    const req = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as FetcherRequest;
    expect((req.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('OpenRouter discovery omits pricing when the per-token strings are absent', async () => {
    const fetcher = jsonFetcher({
      'https://openrouter.ai/api/v1/models': {
        json: {
          data: [{ id: 'free/model', name: 'Free Model', context_length: 8000 }],
        },
      },
    });
    const models = await listModels({
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api',
      fetcher,
    });
    expect(models[0]?.pricing).toBeUndefined();
    expect(models[0]?.label).toBe('Free Model');
    expect(models[0]?.contextLength).toBe(8000);
  });

  it('OpenRouter discovery tolerates malformed pricing strings (drops them, keeps the model)', async () => {
    const fetcher = jsonFetcher({
      'https://openrouter.ai/api/v1/models': {
        json: {
          data: [
            { id: 'a/model', name: 'A Model', pricing: { prompt: 'not-a-number' } },
            { id: 'b/model', name: 'B Model', pricing: { prompt: '-5' } },
          ],
        },
      },
    });
    const models = await listModels({
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api',
      fetcher,
    });
    // Both models survive; the bogus pricing values are dropped.
    expect(models.map((m) => m.id).sort()).toEqual(['a/model', 'b/model']);
    expect(models.every((m) => m.pricing === undefined)).toBe(true);
  });

  it('throws on a non-2xx discovery response', async () => {
    const fetcher = jsonFetcher({
      'http://localhost:11434/api/tags': { status: 500, json: { error: 'down' } },
    });
    await expect(
      listModels({ provider: 'ollama', baseUrl: 'http://localhost:11434', fetcher })
    ).rejects.toThrow(/discovery failed/i);
  });

  it('discovers OpenAI models and captures `created` (epoch s) + `owned_by` (vendor)', async () => {
    const fetcher = jsonFetcher({
      'https://api.openai.com/v1/models': {
        json: {
          data: [
            { id: 'gpt-4o', created: 1715000000, owned_by: 'openai' },
            { id: 'o1', created: 1734000000, owned_by: 'openai' },
            { id: 'ft:gpt-4o:org:custom:abc', created: 1715000123, owned_by: 'org-foo' },
          ],
        },
      },
    });
    const models = await listModels({
      provider: 'openai',
      baseUrl: 'https://api.openai.com',
      apiKey: 'sk-test',
      fetcher,
    });
    // Sorted by id (no label): ft: < gpt-4o < o1
    expect(models.map((m) => m.id)).toEqual(['ft:gpt-4o:org:custom:abc', 'gpt-4o', 'o1']);
    // `created` is an epoch second; verify it normalises to an ISO timestamp.
    const gpt4o = models.find((m) => m.id === 'gpt-4o')!;
    expect(gpt4o.vendor).toBe('openai');
    expect(gpt4o.createdAt).toBe(new Date(1715000000 * 1000).toISOString());
    // The fine-tuned model surfaces the org owner.
    const ft = models.find((m) => m.id === 'ft:gpt-4o:org:custom:abc')!;
    expect(ft.vendor).toBe('org-foo');
    // Sent as Bearer.
    const req = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as FetcherRequest;
    expect((req.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
  });

  it('discovers Anthropic models and uses `display_name` as label, `created_at` as ISO', async () => {
    const fetcher = jsonFetcher({
      'https://api.anthropic.com/v1/models': {
        json: {
          data: [
            {
              id: 'claude-3-5-sonnet-20241022',
              display_name: 'Claude 3.5 Sonnet (20241022)',
              created_at: '2024-10-22T00:00:00Z',
            },
            {
              id: 'claude-3-haiku-20240307',
              display_name: 'Claude 3 Haiku',
              created_at: '2024-03-07T00:00:00Z',
            },
          ],
          has_more: false,
        },
      },
    });
    const models = await listModels({
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-ant-test',
      fetcher,
    });
    // Sorted by display name: "Claude 3 Haiku" < "Claude 3.5 Sonnet (20241022)".
    expect(models.map((m) => m.label)).toEqual(['Claude 3 Haiku', 'Claude 3.5 Sonnet (20241022)']);
    const sonnet = models.find((m) => m.id === 'claude-3-5-sonnet-20241022')!;
    expect(sonnet.vendor).toBe('anthropic');
    expect(sonnet.createdAt).toBe('2024-10-22T00:00:00Z');
    // Anthropic uses `x-api-key`, not `Authorization`. The header set is
    // the only way callers can tell an Anthropic request from OpenAI's.
    const req = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as FetcherRequest;
    const headers = req.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers.Authorization).toBeUndefined();
  });

  it('discovers Ollama models with rich `details` block (family, parameterSize, quantization)', async () => {
    const fetcher = jsonFetcher({
      'http://localhost:11434/api/tags': {
        json: {
          models: [
            {
              name: 'llama3.2:3b',
              modified_at: '2024-12-01T10:30:00.000Z',
              size: 2_019_000_000,
              digest: 'sha256:abcd',
              details: {
                format: 'gguf',
                family: 'llama',
                families: ['llama'],
                parameter_size: '3.2B',
                quantization_level: 'Q4_K_M',
              },
            },
            {
              name: 'qwen2.5-coder:7b',
              modified_at: '2024-11-15T00:00:00.000Z',
              size: 4_400_000_000,
              details: {
                family: 'qwen2',
                parameter_size: '7B',
                quantization_level: 'Q4_0',
              },
            },
          ],
        },
      },
    });
    const models = await listModels({
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
      fetcher,
    });
    expect(models).toHaveLength(2);
    const llama = models.find((m) => m.id === 'llama3.2:3b')!;
    expect(llama.family).toBe('llama');
    expect(llama.parameterSize).toBe('3.2B');
    expect(llama.quantizationLevel).toBe('Q4_K_M');
    // Family is the vendor fallback when no upstream name exists.
    expect(llama.vendor).toBe('llama');
    expect(llama.sizeBytes).toBe(2_019_000_000);
    expect(llama.modifiedAt).toBe('2024-12-01T10:30:00.000Z');
    const qwen = models.find((m) => m.id === 'qwen2.5-coder:7b')!;
    expect(qwen.parameterSize).toBe('7B');
    expect(qwen.quantizationLevel).toBe('Q4_0');
    expect(qwen.vendor).toBe('qwen2');
  });

  it('OpenAI-compatible discovery accepts `display_name` as label but ignores everything else', async () => {
    const fetcher = jsonFetcher({
      'http://localhost:1234/v1/models': {
        json: {
          data: [
            { id: 'gpt-4o-mini', display_name: 'GPT-4o mini' },
            { id: 'custom-model' }, // no display_name — keeps id as label fallback
          ],
        },
      },
    });
    const models = await listModels({
      provider: 'openai-compatible',
      baseUrl: 'http://localhost:1234',
      fetcher,
    });
    // Sorted by label: "custom-model" < "GPT-4o mini"
    expect(models.map((m) => m.label ?? m.id)).toEqual(['custom-model', 'GPT-4o mini']);
    // No vendor / no context / no pricing — the gateway didn't provide them.
    for (const m of models) {
      expect(m.vendor).toBeUndefined();
      expect(m.contextLength).toBeUndefined();
      expect(m.pricing).toBeUndefined();
    }
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
