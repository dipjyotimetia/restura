import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAiLabStore } from '../../store/useAiLabStore';
import { ProviderManager } from '../ProviderManager';

vi.mock('../ModelCatalog', () => ({ ModelCatalog: () => <div>Model catalog</div> }));

const mocks = vi.hoisted(() => ({
  listModels: vi.fn(),
  testConnection: vi.fn(),
  connectAndAddProvider: vi.fn(),
  replaceSecretHandle: vi.fn(),
  deleteSecretHandle: vi.fn(),
  splitDiscoveredModels: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
  electronApi: {
    secrets: { store: vi.fn(), delete: vi.fn() },
  },
}));

vi.mock('../../lib/llmClient', () => ({
  listModels: mocks.listModels,
  testConnection: mocks.testConnection,
}));
vi.mock('../../lib/providerConnection', () => ({
  connectAndAddProvider: mocks.connectAndAddProvider,
  replaceSecretHandle: mocks.replaceSecretHandle,
  deleteSecretHandle: mocks.deleteSecretHandle,
  splitDiscoveredModels: mocks.splitDiscoveredModels,
}));
vi.mock('@/lib/shared/platform', () => ({ getElectronAPI: () => mocks.electronApi }));
vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
    warning: mocks.toastWarning,
  },
}));

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
  beforeEach(() => {
    seedProvider();
    vi.clearAllMocks();
    mocks.splitDiscoveredModels.mockImplementation((models: Array<{ id: string }>) => ({
      models: models.map((model) => model.id),
      modelDetails: {},
    }));
  });

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

  it('requires confirmation for local-zero cost and resets it to unknown', () => {
    render(<ProviderManager />);

    fireEvent.click(screen.getByRole('button', { name: 'Configure cost classification' }));
    expect(screen.getByRole('button', { name: 'Assert local zero cost' })).toBeDisabled();
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'I assert this provider runs locally at zero cost' })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Assert local zero cost' }));

    expect(screen.getByText('local zero asserted')).toBeVisible();
    expect(useAiLabStore.getState().providers.cfg?.costPolicy).toBe('local-zero');

    fireEvent.click(screen.getByRole('button', { name: 'Configure cost classification' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset cost to unknown' }));

    expect(screen.queryByText('local zero asserted')).not.toBeInTheDocument();
    expect(useAiLabStore.getState().providers.cfg?.costPolicy).toBe('unknown');
  });

  it('does not persist draft capability changes when the editor is closed', () => {
    render(<ProviderManager />);

    fireEvent.click(screen.getByRole('button', { name: 'Configure custom capabilities' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Tool calling' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close capability editor' }));

    expect(useAiLabStore.getState().providers.cfg?.capabilityOverrides).toBeUndefined();
  });

  it('explains the desktop transport ceiling and does not offer unsupported assertions', () => {
    render(<ProviderManager />);

    fireEvent.click(screen.getByRole('button', { name: 'Configure custom capabilities' }));

    expect(
      screen.getByText(/desktop transport currently supports text and tool calling only/i)
    ).toBeVisible();
    for (const unsupported of [
      'Structured output',
      'Reasoning controls',
      'Continuation',
      'Image',
      'Audio',
      'Document',
    ]) {
      expect(screen.queryByRole('checkbox', { name: unsupported })).not.toBeInTheDocument();
    }
    expect(screen.getByRole('checkbox', { name: 'Tool calling' })).toBeVisible();
    expect(screen.getByRole('checkbox', { name: 'Parallel tool calls' })).toBeVisible();
  });

  it('validates and completes the provider connection workflow', async () => {
    useAiLabStore.setState({ providers: {} });
    mocks.connectAndAddProvider.mockResolvedValue({ ok: true, modelCount: 2 });
    render(<ProviderManager />);

    fireEvent.click(screen.getByRole('button', { name: 'Connect & save' }));
    expect(mocks.toastError).toHaveBeenCalledWith('Give this provider a recognizable name.');

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Local models' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect & save' }));

    await waitFor(() => expect(mocks.connectAndAddProvider).toHaveBeenCalledOnce());
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Connected Local models with 2 models');
    expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument();
  });

  it('records successful and failed connection tests and catalog refreshes', async () => {
    mocks.testConnection
      .mockResolvedValueOnce({ ok: true, modelCount: 3 })
      .mockResolvedValueOnce({ ok: false, error: 'offline' });
    mocks.listModels
      .mockResolvedValueOnce({ ok: true, models: [{ id: 'new-model' }] })
      .mockResolvedValueOnce({ ok: false, error: 'catalog offline' });
    render(<ProviderManager />);

    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    await waitFor(() => expect(mocks.testConnection).toHaveBeenCalledTimes(1));
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Connected — 3 models available');

    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    await waitFor(() => expect(mocks.testConnection).toHaveBeenCalledTimes(2));
    expect(mocks.toastError).toHaveBeenCalledWith('Connection failed: offline');

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(mocks.listModels).toHaveBeenCalledTimes(1));
    expect(useAiLabStore.getState().providers.cfg?.models).toEqual(['new-model']);

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(mocks.listModels).toHaveBeenCalledTimes(2));
    expect(mocks.toastError).toHaveBeenCalledWith('Catalog refresh failed: catalog offline');
  });

  it('edits provider fields and exercises dependent capability toggles', async () => {
    render(<ProviderManager />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Provider name'), { target: { value: ' Updated ' } });
    fireEvent.change(screen.getByLabelText('Provider base URL'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.queryByLabelText('Provider name')).not.toBeInTheDocument());
    expect(useAiLabStore.getState().providers.cfg?.label).toBe('Updated');
    expect(useAiLabStore.getState().providers.cfg?.baseUrl).toBeUndefined();

    fireEvent.click(screen.getByRole('button', { name: 'Configure custom capabilities' }));
    const parallel = screen.getByRole('checkbox', { name: 'Parallel tool calls' });
    expect(parallel).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Tool calling' }));
    fireEvent.click(parallel);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Tool calling' }));
    expect(parallel).not.toBeChecked();
  });

  it('surfaces thrown provider operations and closes advanced cost editing', async () => {
    mocks.testConnection.mockRejectedValue(new Error('test exploded'));
    mocks.listModels.mockRejectedValue('refresh exploded');
    render(<ProviderManager />);

    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith('Connection failed: test exploded')
    );
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith('Catalog refresh failed: refresh exploded')
    );

    fireEvent.click(screen.getByRole('button', { name: 'Configure cost classification' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(
      screen.queryByRole('checkbox', { name: 'I assert this provider runs locally at zero cost' })
    ).not.toBeInTheDocument();
  });
});
