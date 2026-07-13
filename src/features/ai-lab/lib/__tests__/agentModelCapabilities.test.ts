import type { ModelCapabilities } from '@shared/agent-lab';
import { describe, expect, it } from 'vitest';
import type { AiLabProviderConfig } from '../../types';
import {
  CONSERVATIVE_DESKTOP_CAPABILITIES,
  capabilitiesForDesktopModel,
  knownCostForCompletion,
} from '../agentModelCapabilities';

function config(patch: Partial<AiLabProviderConfig> = {}): AiLabProviderConfig {
  return {
    id: 'cfg',
    provider: 'openai-compatible',
    label: 'Gateway',
    pricingKnown: false,
    isLocal: true,
    models: ['custom'],
    createdAt: 0,
    ...patch,
  };
}

const TOOL_CAPABILITIES: ModelCapabilities = {
  ...CONSERVATIVE_DESKTOP_CAPABILITIES,
  toolCalling: true,
};

describe('desktop model capability negotiation', () => {
  it('defaults unknown models to text-only without agent features', () => {
    expect(capabilitiesForDesktopModel(config(), 'custom')).toEqual({
      capabilities: CONSERVATIVE_DESKTOP_CAPABILITIES,
      assertedByUser: false,
    });
  });

  it('uses only discovered model-specific capability metadata', () => {
    const result = capabilitiesForDesktopModel(
      config({
        provider: 'anthropic',
        isLocal: false,
        modelDetails: {
          custom: {
            agentCapabilities: { toolCalling: true, maxContextTokens: 32_000 },
            agentCapabilityProvenance: {
              source: 'discovered',
              adapterId: 'openrouter.models',
              adapterVersion: 1,
            },
          },
        },
      }),
      'custom'
    );

    expect(result.assertedByUser).toBe(false);
    expect(result.capabilities).toMatchObject({
      inputModalities: ['text'],
      toolCalling: true,
      structuredOutput: false,
      maxContextTokens: 32_000,
    });
  });

  it('normalizes inconsistent partial discovery metadata field by field', () => {
    const result = capabilitiesForDesktopModel(
      config({
        modelDetails: {
          custom: {
            agentCapabilities: {
              inputModalities: [],
              outputModalities: ['video' as never],
              parallelToolCalls: true,
              toolCalling: false,
              serverTools: ['valid', '', ...Array.from({ length: 40 }, (_, i) => `tool-${i}`)],
            },
            agentCapabilityProvenance: {
              source: 'discovered',
              adapterId: 'openrouter.models',
              adapterVersion: 1,
            },
          },
        },
      }),
      'custom'
    );

    expect(result.capabilities).toMatchObject({
      inputModalities: ['text'],
      outputModalities: ['text'],
      toolCalling: false,
      parallelToolCalls: false,
      structuredOutput: false,
      reasoning: false,
      serverTools: [],
    });
  });

  it('drops server tools when tool calling is not enabled', () => {
    const result = capabilitiesForDesktopModel(
      config({
        modelDetails: {
          custom: {
            agentCapabilities: { toolCalling: false, serverTools: ['web-search'] },
            agentCapabilityProvenance: {
              source: 'discovered',
              adapterId: 'openrouter.models',
              adapterVersion: 1,
            },
          },
        },
      }),
      'custom'
    );

    expect(result.capabilities.serverTools).toEqual([]);
  });

  it('marks explicit capability overrides as user asserted', () => {
    const result = capabilitiesForDesktopModel(
      config({ capabilityOverrides: { custom: TOOL_CAPABILITIES } }),
      'custom'
    );

    expect(result.assertedByUser).toBe(true);
    expect(result.capabilities.toolCalling).toBe(true);
  });
});

describe('known completion cost', () => {
  const completion = {
    promptTokens: 2_000_000,
    completionTokens: 500_000,
    estimatedCostUSD: 0,
  };

  it('omits cost for unknown pricing even when the provider reports zero', () => {
    expect(knownCostForCompletion(config({ pricingKnown: false }), 'custom', completion)).toBe(
      undefined
    );
  });

  it('calculates cost from exact discovered model pricing', () => {
    expect(
      knownCostForCompletion(
        config({
          pricingKnown: true,
          modelDetails: {
            custom: { pricing: { promptPerMTokUSD: 2, completionPerMTokUSD: 8 } },
          },
        }),
        'custom',
        completion
      )
    ).toBe(8);
  });

  it.each(['http://localhost:11434', 'https://ollama.example.test'])(
    'keeps Ollama cost unknown by default at %s',
    (baseUrl) => {
      expect(
        knownCostForCompletion(
          config({ provider: 'ollama', isLocal: true, pricingKnown: false, baseUrl }),
          'custom',
          completion
        )
      ).toBeUndefined();
    }
  );

  it('classifies cost as zero only after an explicit local-zero assertion', () => {
    expect(
      knownCostForCompletion(
        config({
          provider: 'ollama',
          isLocal: true,
          pricingKnown: false,
          costPolicy: 'local-zero',
        }),
        'custom',
        completion
      )
    ).toBe(0);
  });
});
