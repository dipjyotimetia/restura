import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { buildModelOptions } from '../../lib/modelOptions';
import type { AiLabProviderConfig } from '../../types';
import { ModelCatalog } from '../ModelCatalog';

const PROVIDER: AiLabProviderConfig = {
  id: 'p1',
  provider: 'openrouter',
  label: 'OpenRouter',
  pricingKnown: true,
  isLocal: false,
  models: ['anthropic/claude', 'openai/gpt'],
  modelDetails: {
    'anthropic/claude': {
      label: 'Claude Sonnet',
      vendor: 'Anthropic',
      contextLength: 200_000,
      modality: 'text+image->text',
    },
    'openai/gpt': { label: 'GPT Mini', vendor: 'OpenAI' },
  },
  createdAt: 1,
};

describe('ModelCatalog', () => {
  it('searches across friendly label, id, provider, vendor, and modality', () => {
    render(
      <ModelCatalog
        options={buildModelOptions({ p1: PROVIDER })}
        favoriteKeys={new Set()}
        onToggleFavorite={() => {}}
      />
    );

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search model catalog' }), {
      target: { value: 'image' },
    });

    expect(screen.getByText('Claude Sonnet')).toBeInTheDocument();
    expect(screen.queryByText('GPT Mini')).not.toBeInTheDocument();
  });

  it('exposes an accessible favorite action for each model', () => {
    const onToggleFavorite = vi.fn();
    render(
      <ModelCatalog
        options={buildModelOptions({ p1: PROVIDER })}
        favoriteKeys={new Set(['p1:anthropic/claude'])}
        onToggleFavorite={onToggleFavorite}
      />
    );

    expect(
      screen.getByRole('button', { name: 'Remove Claude Sonnet from favorites' })
    ).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Add GPT Mini to favorites' }));
    expect(onToggleFavorite).toHaveBeenCalledWith('p1:openai/gpt');
  });
});
