import { describe, expect, it } from 'vitest';
import {
  type ModelCapabilities,
  type ProviderAdapter,
  ProviderRegistry,
  validateGenerationRequest,
} from '../provider';

const textOnly: ModelCapabilities = {
  inputModalities: ['text'],
  outputModalities: ['text'],
  structuredOutput: false,
  toolCalling: false,
  parallelToolCalls: false,
  reasoning: false,
  continuation: false,
  serverTools: [],
};

function adapter(id: string): ProviderAdapter {
  return {
    id,
    async discoverModels() {
      return [{ id: 'model', capabilities: textOnly }];
    },
    async getCapabilities() {
      return textOnly;
    },
    async generate() {
      return { id: 'response', output: [{ type: 'text', text: 'ok' }], toolCalls: [] };
    },
  };
}

describe('ProviderRegistry', () => {
  it('registers open-ended adapter identifiers without a central enum', () => {
    const registry = new ProviderRegistry([adapter('vendor.experimental')]);

    expect(registry.require('vendor.experimental').id).toBe('vendor.experimental');
  });

  it('rejects duplicate adapter identifiers', () => {
    expect(() => new ProviderRegistry([adapter('same'), adapter('same')])).toThrow(
      'duplicate provider adapter: same'
    );
  });

  it('throws for unknown provider identifiers', () => {
    const registry = new ProviderRegistry([adapter('vendor.experimental')]);

    expect(() => registry.require('vendor.unknown')).toThrow(
      'unknown provider adapter: vendor.unknown'
    );
  });

  it('lists adapters in insertion order', () => {
    const registry = new ProviderRegistry([adapter('vendor.alpha'), adapter('vendor.beta')]);

    expect(registry.list().map((adapter) => adapter.id)).toEqual(['vendor.alpha', 'vendor.beta']);
  });
});

describe('validateGenerationRequest', () => {
  it('rejects multimodal input when the selected model is text-only', () => {
    const errors = validateGenerationRequest(
      {
        model: { providerId: 'vendor', model: 'text-only' },
        messages: [
          {
            role: 'user',
            content: [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }],
          },
        ],
      },
      textOnly
    );

    expect(errors).toEqual(['model does not support image input']);
  });

  it('rejects tool definitions when tool calling is unsupported', () => {
    const errors = validateGenerationRequest(
      {
        model: { providerId: 'vendor', model: 'text-only' },
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        tools: [{ name: 'lookup', description: 'Lookup', inputSchema: { type: 'object' } }],
      },
      textOnly
    );

    expect(errors).toEqual(['model does not support tool calling']);
  });
});
