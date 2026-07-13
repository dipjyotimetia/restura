import { describe, expect, it, vi } from 'vitest';
import { listModels } from '@shared/protocol/ai/model-discovery';
import type { Fetcher } from '@shared/protocol/types';
import { createDesktopAgentProviders } from '../agentRuntime';
import {
  connectAndAddProvider,
  replaceSecretHandle,
  splitDiscoveredModels,
} from '../providerConnection';
import { useAiLabStore } from '../../store/useAiLabStore';

describe('connectAndAddProvider', () => {
  it('intersects tested adapter capabilities with the desktop transport through store and runtime', async () => {
    const fetcher: Fetcher = vi.fn(async () => ({
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      contentLengthHeader: null,
      text: async () =>
        JSON.stringify({
          data: [
            {
              id: 'vendor/model',
              input_modalities: ['text', 'image'],
              output_modalities: ['text'],
              supported_parameters: ['tools', 'response_format'],
            },
          ],
        }),
    }));
    const discovered = await listModels({
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api',
      fetcher,
    });
    const split = splitDiscoveredModels(discovered);
    useAiLabStore.setState({ providers: {} });
    const id = useAiLabStore.getState().addProvider({
      provider: 'openrouter',
      label: 'OpenRouter',
      models: split.models,
      modelDetails: split.modelDetails,
    });

    expect(split.modelDetails['vendor/model']).toMatchObject({
      agentCapabilities: {
        inputModalities: ['text'],
        outputModalities: ['text'],
        toolCalling: true,
        structuredOutput: false,
      },
      agentCapabilityProvenance: {
        source: 'discovered',
        adapterId: 'openrouter.models',
        adapterVersion: 1,
      },
    });
    await expect(
      createDesktopAgentProviders(useAiLabStore.getState().providers)
        .require(id)
        .getCapabilities('vendor/model')
    ).resolves.toMatchObject({
      inputModalities: ['text'],
      outputModalities: ['text'],
      toolCalling: true,
      structuredOutput: false,
    });
  });

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

  it('reports when a failed connection cannot clean up its temporary secret', async () => {
    const result = await connectAndAddProvider(
      {
        provider: 'openai',
        label: 'OpenAI',
        baseUrl: 'https://api.openai.com',
        apiKey: 'sk-secret',
      },
      {
        storeSecret: vi.fn(async () => ({ ok: true as const, id: 'handle-1' })),
        deleteSecret: vi.fn(async () => ({ ok: false as const, error: 'keychain locked' })),
        discoverModels: vi.fn(async () => ({ ok: false as const, error: '401 unauthorized' })),
        addProvider: vi.fn(() => 'provider-1'),
      }
    );

    expect(result).toEqual({
      ok: false,
      error: '401 unauthorized Secret cleanup failed: keychain locked',
    });
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

  it('returns a structured failure when initial secret storage rejects', async () => {
    const result = await connectAndAddProvider(
      {
        provider: 'openai',
        label: 'OpenAI',
        baseUrl: 'https://api.openai.com',
        apiKey: 'sk-secret',
      },
      {
        storeSecret: vi.fn(async () => {
          throw new Error('IPC closed');
        }),
        deleteSecret: vi.fn(),
        discoverModels: vi.fn(),
        addProvider: vi.fn(() => 'provider-1'),
      }
    );

    expect(result).toEqual({ ok: false, error: 'IPC closed' });
  });
});

describe('replaceSecretHandle', () => {
  it('commits the new handle before deleting the old secret', async () => {
    const calls: string[] = [];
    const result = await replaceSecretHandle(
      {
        value: 'sk-new',
        label: 'OpenAI key',
        oldHandleId: 'old-handle',
      },
      {
        storeSecret: vi.fn(async () => {
          calls.push('store');
          return { ok: true as const, id: 'new-handle' };
        }),
        commitHandle: vi.fn(() => calls.push('commit')),
        deleteSecret: vi.fn(async () => {
          calls.push('delete');
          return { ok: true as const };
        }),
      }
    );

    expect(result).toEqual({ ok: true, handleId: 'new-handle' });
    expect(calls).toEqual(['store', 'commit', 'delete']);
  });

  it('keeps the new handle active and reports failure to retire the old secret', async () => {
    const result = await replaceSecretHandle(
      { value: 'sk-new', label: 'OpenAI key', oldHandleId: 'old-handle' },
      {
        storeSecret: vi.fn(async () => ({ ok: true as const, id: 'new-handle' })),
        commitHandle: vi.fn(),
        deleteSecret: vi.fn(async () => ({ ok: false as const, error: 'keychain locked' })),
      }
    );

    expect(result).toEqual({
      ok: true,
      handleId: 'new-handle',
      cleanupWarning: 'Could not remove the previous API key: keychain locked',
    });
  });

  it('returns a structured failure when secret storage rejects', async () => {
    const result = await replaceSecretHandle(
      { value: 'sk-new', label: 'OpenAI key' },
      {
        storeSecret: vi.fn(async () => {
          throw new Error('IPC closed');
        }),
        commitHandle: vi.fn(),
        deleteSecret: vi.fn(),
      }
    );

    expect(result).toEqual({ ok: false, error: 'IPC closed' });
  });
});
