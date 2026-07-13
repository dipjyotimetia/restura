import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAiLabStore } from '../../store/useAiLabStore';
import { ProviderManager } from '../ProviderManager';

vi.mock('../ModelCatalog', () => ({ ModelCatalog: () => <div>Model catalog</div> }));

function seedProvider() {
  useAiLabStore.setState({
    providers: {
      cfg: {
        id: 'cfg',
        provider: 'openai-compatible',
        label: 'Gateway',
        baseUrl: 'https://example.test',
        pricingKnown: false,
        isLocal: true,
        models: ['custom'],
        createdAt: 0,
      },
    },
    prompts: {},
    datasets: {},
    evalConfigs: {},
    favoriteModelKeys: [],
    recentModelKeys: [],
    agentSuites: {},
  });
}

describe('ProviderManager capability overrides', () => {
  beforeEach(seedProvider);

  it('requires assertion confirmation, labels saved overrides, and resets them', () => {
    render(<ProviderManager />);

    fireEvent.click(screen.getByRole('button', { name: 'Configure custom capabilities' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Tool calling' }));
    expect(screen.getByRole('button', { name: 'Save capability override' })).toBeDisabled();

    fireEvent.click(
      screen.getByRole('checkbox', {
        name: 'I am asserting this model supports these features',
      })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save capability override' }));

    expect(screen.getByText('user asserted')).toBeVisible();
    expect(useAiLabStore.getState().providers.cfg?.capabilityOverrides?.custom?.toolCalling).toBe(
      true
    );

    fireEvent.click(screen.getByRole('button', { name: 'Configure custom capabilities' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset to discovered defaults' }));

    expect(screen.queryByText('user asserted')).not.toBeInTheDocument();
    expect(useAiLabStore.getState().providers.cfg?.capabilityOverrides).toBeUndefined();
  });

  it('does not persist draft capability changes when the editor is closed', () => {
    render(<ProviderManager />);

    fireEvent.click(screen.getByRole('button', { name: 'Configure custom capabilities' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Structured output' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close capability editor' }));

    expect(useAiLabStore.getState().providers.cfg?.capabilityOverrides).toBeUndefined();
  });
});
