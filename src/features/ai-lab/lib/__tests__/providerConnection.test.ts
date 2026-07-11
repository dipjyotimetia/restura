import { describe, expect, it, vi } from 'vitest';
import { connectAndAddProvider } from '../providerConnection';

describe('connectAndAddProvider', () => {
  it('stores the key first and discovers models using only its secret handle', async () => {
    const calls: string[] = [];
    const storeSecret = vi.fn(async () => {
      calls.push('secret');
      return { ok: true as const, id: '00000000-0000-4000-8000-000000000001' };
    });
    const discoverModels = vi.fn(async () => {
      calls.push('discover');
      return {
        ok: true as const,
        models: [
          { id: 'anthropic/claude-3.5-sonnet', label: 'Claude 3.5 Sonnet', contextLength: 200_000 },
        ],
      };
    });
    const addProvider = vi.fn(() => {
      calls.push('add');
      return 'provider-1';
    });

    const result = await connectAndAddProvider(
      {
        provider: 'openrouter',
        label: 'OpenRouter',
        baseUrl: 'https://openrouter.ai/api',
        apiKey: 'sk-secret',
      },
      { storeSecret, deleteSecret: vi.fn(), discoverModels, addProvider, now: () => 123 }
    );

    expect(result).toEqual({ ok: true, providerId: 'provider-1', modelCount: 1 });
    expect(calls).toEqual(['secret', 'discover', 'add']);
    expect(discoverModels).toHaveBeenCalledWith({
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api',
      apiKeyHandleId: '00000000-0000-4000-8000-000000000001',
    });
    expect(addProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKeyHandleId: '00000000-0000-4000-8000-000000000001',
        models: ['anthropic/claude-3.5-sonnet'],
        modelDetails: {
          'anthropic/claude-3.5-sonnet': {
            label: 'Claude 3.5 Sonnet',
            contextLength: 200_000,
          },
        },
        lastTest: { ok: true, at: 123, modelCount: 1 },
        lastDiscoveredAt: 123,
      })
    );
  });

  it('deletes a temporary secret and does not save the provider when discovery fails', async () => {
    const deleteSecret = vi.fn(async () => ({ ok: true as const }));
    const addProvider = vi.fn(() => 'provider-1');

    const result = await connectAndAddProvider(
      {
        provider: 'openai',
        label: 'OpenAI',
        baseUrl: 'https://api.openai.com',
        apiKey: 'sk-secret',
      },
      {
        storeSecret: vi.fn(async () => ({ ok: true as const, id: 'handle-1' })),
        deleteSecret,
        discoverModels: vi.fn(async () => ({ ok: false as const, error: '401 unauthorized' })),
        addProvider,
        now: () => 123,
      }
    );

    expect(result).toEqual({ ok: false, error: '401 unauthorized' });
    expect(deleteSecret).toHaveBeenCalledWith('handle-1');
    expect(addProvider).not.toHaveBeenCalled();
  });

  it('deletes a temporary secret when discovery rejects unexpectedly', async () => {
    const deleteSecret = vi.fn(async () => ({ ok: true as const }));
    const result = await connectAndAddProvider(
      {
        provider: 'openai',
        label: 'OpenAI',
        baseUrl: 'https://api.openai.com',
        apiKey: 'sk-secret',
      },
      {
        storeSecret: vi.fn(async () => ({ ok: true as const, id: 'handle-1' })),
        deleteSecret,
        discoverModels: vi.fn(async () => {
          throw new Error('IPC closed');
        }),
        addProvider: vi.fn(() => 'provider-1'),
      }
    );

    expect(result).toEqual({ ok: false, error: 'IPC closed' });
    expect(deleteSecret).toHaveBeenCalledWith('handle-1');
  });

  it('connects a keyless local provider without touching secret storage', async () => {
    const storeSecret = vi.fn();
    const result = await connectAndAddProvider(
      {
        provider: 'ollama',
        label: 'Local Ollama',
        baseUrl: 'http://localhost:11434',
        apiKey: '',
      },
      {
        storeSecret,
        deleteSecret: vi.fn(),
        discoverModels: vi.fn(async () => ({ ok: true as const, models: [{ id: 'llama3.2' }] })),
        addProvider: vi.fn(() => 'local-1'),
        now: () => 123,
      }
    );

    expect(result).toEqual({ ok: true, providerId: 'local-1', modelCount: 1 });
    expect(storeSecret).not.toHaveBeenCalled();
  });
});
