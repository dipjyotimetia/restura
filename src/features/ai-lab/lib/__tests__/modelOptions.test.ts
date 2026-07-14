import { describe, expect, it } from 'vitest';
import type { AiLabProviderConfig } from '../../types';
import { buildModelOptions } from '../modelOptions';

const provider = (id: string, label: string, models: string[]): AiLabProviderConfig => ({
  id,
  provider: 'openrouter',
  label,
  pricingKnown: true,
  isLocal: false,
  models,
  createdAt: 1,
});

describe('buildModelOptions', () => {
  it('sorts favorites first, then recent models, then the remaining catalog', () => {
    const providers = {
      p1: provider('p1', 'Cloud', ['alpha', 'beta', 'gamma']),
      p2: provider('p2', 'Local', ['delta']),
    };

    const options = buildModelOptions(providers, {
      favoriteModelKeys: ['p1:gamma'],
      recentModelKeys: ['p2:delta', 'p1:beta'],
    });

    expect(options.map((option) => option.key)).toEqual([
      'p1:gamma',
      'p2:delta',
      'p1:beta',
      'p1:alpha',
    ]);
    expect(options[0]).toMatchObject({ isFavorite: true, recentRank: null });
    expect(options[1]).toMatchObject({ isFavorite: false, recentRank: 0 });
  });

  it('uses stable provider and model labels for the uncurated catalog', () => {
    const providers = {
      p2: provider('p2', 'Zulu', ['Beta']),
      p1: provider('p1', 'Alpha', ['Zulu', 'alpha']),
    };

    expect(buildModelOptions(providers).map((option) => option.label)).toEqual([
      'Alpha · alpha',
      'Alpha · Zulu',
      'Zulu · Beta',
    ]);
  });
});
