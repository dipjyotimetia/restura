import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAiChatStore } from '@/features/ai/store';

const h = vi.hoisted(() => ({
  electron: true,
  api: null as null | Record<string, unknown>,
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('@/lib/shared/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/shared/platform')>();
  return {
    ...actual,
    isElectron: () => h.electron,
    getElectronAPI: () => h.api,
  };
});

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: h.toastError, success: h.toastSuccess, info: vi.fn() }),
}));

import { AiActionButton } from '../AiActionButton';
import { AiActionsMenu } from '../AiActionsMenu';
import { Composer } from '../Composer';
import { ProviderSettings } from '../ProviderSettings';
import { ProviderSetupCard } from '../ProviderSetupCard';

const EMPTY_CONFIGS = {
  openai: null,
  anthropic: null,
  openrouter: null,
  'openai-compatible': null,
};

beforeEach(() => {
  h.electron = true;
  h.api = null;
  h.toastError.mockReset();
  h.toastSuccess.mockReset();
  useAiChatStore.setState({ providerConfigs: { ...EMPTY_CONFIGS }, activeProvider: 'anthropic' });
});

describe('ProviderSetupCard (M4)', () => {
  it('names the active cloud provider and asks for an API key', () => {
    render(<ProviderSetupCard />);
    expect(screen.getByTestId('ai-provider-setup')).toHaveTextContent('Anthropic needs an API key');
  });

  it('asks a local provider for a base URL, not an API key', () => {
    useAiChatStore.setState({ activeProvider: 'openai-compatible' });
    render(<ProviderSetupCard />);
    const card = screen.getByTestId('ai-provider-setup');
    expect(card).toHaveTextContent('needs a base URL');
    expect(card).not.toHaveTextContent('API key');
  });

  it('opens Settings → AI', () => {
    const listener = vi.fn();
    window.addEventListener('restura:open-settings', listener);
    render(<ProviderSetupCard />);
    fireEvent.click(screen.getByRole('button', { name: 'Open AI settings' }));
    expect((listener.mock.calls[0]?.[0] as CustomEvent).detail).toBe('ai');
    window.removeEventListener('restura:open-settings', listener);
  });
});

describe('Composer (M4/M12)', () => {
  it('does not claim an API key is needed when disabled', () => {
    render(<Composer disabled onSend={() => {}} />);
    expect(screen.getByLabelText('Chat message')).not.toHaveAttribute(
      'placeholder',
      expect.stringContaining('API key')
    );
  });

  it('shows a persistent send shortcut hint', () => {
    render(<Composer onSend={() => {}} />);
    expect(screen.getByTestId('composer-shortcut-hint')).toHaveTextContent(/Enter to send/);
  });
});

describe('inline AI actions without a provider (M5)', () => {
  it('desktop: renders a disabled button with a configure hint', () => {
    render(<AiActionButton action="fix" />);
    const btn = screen.getByRole('button', { name: /Fix request/ });
    expect(btn).toHaveAttribute('aria-disabled', 'true');
    expect(btn).toHaveAttribute('title', expect.stringContaining('Configure an AI provider'));
  });

  it('desktop: the actions menu trigger is shown with a configure hint', () => {
    render(<AiActionsMenu />);
    const trigger = screen.getByRole('button', { name: /AI actions/ });
    expect(trigger).toHaveAttribute('title', expect.stringContaining('Configure an AI provider'));
  });

  it('web: stays hidden', () => {
    h.electron = false;
    const { container } = render(
      <>
        <AiActionButton action="fix" />
        <AiActionsMenu />
      </>
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('ProviderSettings key save (M2/M4)', () => {
  it('surfaces a failed keychain save instead of failing silently', async () => {
    h.api = {
      secrets: { store: vi.fn().mockResolvedValue({ ok: false, error: 'Keychain locked' }) },
    };
    render(<ProviderSettings />);
    fireEvent.change(screen.getByLabelText('API key', { selector: '#ai-key-openai' }), {
      target: { value: 'sk-test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save OpenAI key' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Keychain locked'));
    expect(useAiChatStore.getState().providerConfigs.openai).toBeNull();
  });

  it('explains when secure storage is unavailable', async () => {
    h.api = {};
    render(<ProviderSettings />);
    fireEvent.change(screen.getByLabelText('API key', { selector: '#ai-key-openai' }), {
      target: { value: 'sk-test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save OpenAI key' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/secure storage is not available/i)
    );
  });

  it('switches the active provider when the first key is saved', async () => {
    h.api = {
      secrets: {
        store: vi.fn().mockResolvedValue({ ok: true, id: '00000000-0000-4000-8000-000000000001' }),
      },
    };
    render(<ProviderSettings />);
    fireEvent.change(screen.getByLabelText('API key', { selector: '#ai-key-openai' }), {
      target: { value: 'sk-test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save OpenAI key' }));
    await waitFor(() => expect(useAiChatStore.getState().providerConfigs.openai).not.toBeNull());
    expect(useAiChatStore.getState().activeProvider).toBe('openai');
  });

  it('tests a saved key against the provider and reports the result', async () => {
    const testConnection = vi.fn().mockResolvedValue({ ok: false, error: '401 Unauthorized' });
    h.api = { aiLab: { testConnection } };
    useAiChatStore.setState({
      providerConfigs: {
        ...EMPTY_CONFIGS,
        openai: {
          provider: 'openai',
          defaultModel: 'gpt-4o',
          apiKeyRef: { kind: 'handle', id: '00000000-0000-4000-8000-000000000002' },
        },
      },
    });
    render(<ProviderSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'Test OpenAI connection' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('401 Unauthorized'));
    expect(testConnection).toHaveBeenCalledWith({
      provider: 'openai',
      baseUrl: expect.stringContaining('openai.com'),
      apiKeyHandleId: '00000000-0000-4000-8000-000000000002',
    });
  });
});
