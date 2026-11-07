import { getProviderModule } from '@shared/protocol/ai/providers';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ProviderConfig, useAiChatStore } from '@/features/ai/store';

const h = vi.hoisted(() => ({ api: null as null | Record<string, unknown> }));

vi.mock('@/lib/shared/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/shared/platform')>();
  return { ...actual, isElectron: () => true, getElectronAPI: () => h.api };
});

// Radix Select does not open under jsdom; render options as plain buttons.
vi.mock('@/components/ui/select', async () => {
  const React = await import('react');
  const Ctx = React.createContext<(value: string) => void>(() => {});
  return {
    Select: ({
      children,
      onValueChange,
    }: {
      children: React.ReactNode;
      onValueChange: (value: string) => void;
    }) => React.createElement(Ctx.Provider, { value: onValueChange }, children),
    SelectContent: ({ children }: { children: React.ReactNode }) =>
      React.createElement('div', null, children),
    SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => {
      const onValueChange = React.useContext(Ctx);
      return React.createElement(
        'button',
        { type: 'button', role: 'option', onClick: () => onValueChange(value) },
        children
      );
    },
    SelectTrigger: ({ children, ...props }: React.ComponentProps<'button'>) =>
      React.createElement('button', { type: 'button', role: 'combobox', ...props }, children),
    SelectValue: () => null,
  };
});

import { ProviderSettings } from '../ProviderSettings';

const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '00000000-0000-4000-8000-000000000002';

const EMPTY = { openai: null, anthropic: null, openrouter: null, 'openai-compatible': null };

const cloud = (provider: 'openai' | 'anthropic', id = ID2): ProviderConfig => ({
  provider,
  defaultModel: getProviderModule(provider).models[0]?.id ?? 'm',
  apiKeyRef: { kind: 'handle', id },
});

function seed(configs: Partial<Record<keyof typeof EMPTY, ProviderConfig>>, active = 'anthropic') {
  useAiChatStore.setState({
    providerConfigs: { ...EMPTY, ...configs } as never,
    activeProvider: active as never,
    conversations: {},
    activeConversationId: null,
  });
}

function typeKey(provider: string, value: string): void {
  fireEvent.change(screen.getByLabelText('API key', { selector: `#ai-key-${provider}` }), {
    target: { value },
  });
}

beforeEach(() => {
  h.api = null;
  seed({});
});

describe('ProviderSettings provider + key management', () => {
  it('switches the active provider from the picker', () => {
    render(<ProviderSettings />);
    fireEvent.click(screen.getByRole('option', { name: 'OpenRouter' }));
    expect(useAiChatStore.getState().activeProvider).toBe('openrouter');
  });

  it('shows provider-specific key placeholders', () => {
    render(<ProviderSettings />);
    expect(document.querySelector('#ai-key-anthropic')).toHaveAttribute('placeholder', 'sk-ant-…');
    expect(document.querySelector('#ai-key-openai')).toHaveAttribute('placeholder', 'sk-…');
    expect(document.querySelector('#ai-key-openrouter')).toHaveAttribute('placeholder', 'sk-or-…');
  });

  it('ignores a blank key', async () => {
    const store = vi.fn();
    h.api = { secrets: { store } };
    render(<ProviderSettings />);
    typeKey('openai', '   ');
    fireEvent.click(screen.getByRole('button', { name: 'Save OpenAI key' }));
    await Promise.resolve();
    expect(store).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('reports a thrown keychain error', async () => {
    h.api = { secrets: { store: vi.fn().mockRejectedValue(new Error('kaput')) } };
    render(<ProviderSettings />);
    typeKey('openai', 'sk-1');
    fireEvent.click(screen.getByRole('button', { name: 'Save OpenAI key' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Could not save the key: kaput')
    );
  });

  it('reports a thrown non-Error value', async () => {
    h.api = { secrets: { store: vi.fn().mockRejectedValue('denied') } };
    render(<ProviderSettings />);
    typeKey('openai', 'sk-1');
    fireEvent.click(screen.getByRole('button', { name: 'Save OpenAI key' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Could not save the key: denied')
    );
  });

  it('reports a refusal without an error message as unknown', async () => {
    h.api = { secrets: { store: vi.fn().mockResolvedValue({ ok: false }) } };
    render(<ProviderSettings />);
    typeKey('openai', 'sk-1');
    fireEvent.click(screen.getByRole('button', { name: 'Save OpenAI key' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Could not save the key: unknown error')
    );
  });

  it('saves a key with the first model, trimmed, and keeps a ready active provider', async () => {
    seed({ anthropic: cloud('anthropic', ID1) }, 'anthropic');
    const store = vi.fn().mockResolvedValue({ ok: true, id: ID2 });
    h.api = { secrets: { store } };
    render(<ProviderSettings />);
    typeKey('openai', '  sk-live  ');
    fireEvent.click(screen.getByRole('button', { name: 'Save OpenAI key' }));
    await waitFor(() => expect(useAiChatStore.getState().providerConfigs.openai).not.toBeNull());
    expect(store).toHaveBeenCalledWith({
      scope: 'ai:openai',
      value: 'sk-live',
      label: 'openai key',
    });
    expect(useAiChatStore.getState().providerConfigs.openai).toEqual({
      provider: 'openai',
      defaultModel: getProviderModule('openai').models[0]?.id,
      apiKeyRef: { kind: 'handle', id: ID2, label: 'openai key' },
    });
    expect(useAiChatStore.getState().activeProvider).toBe('anthropic');
    // The configured card replaces the key input.
    expect(screen.getByText(`API key configured (handle ${ID2.slice(0, 8)}…)`)).toBeInTheDocument();
  });

  it('saving the key of the active provider keeps it active', async () => {
    h.api = { secrets: { store: vi.fn().mockResolvedValue({ ok: true, id: ID1 }) } };
    render(<ProviderSettings />);
    typeKey('anthropic', 'sk-ant-1');
    fireEvent.click(screen.getByRole('button', { name: 'Save Anthropic key' }));
    await waitFor(() => expect(useAiChatStore.getState().providerConfigs.anthropic).not.toBeNull());
    expect(useAiChatStore.getState().activeProvider).toBe('anthropic');
  });

  it('changes the default model of a configured provider', () => {
    seed({ openai: cloud('openai') });
    const second = getProviderModule('openai').models[1];
    if (!second) throw new Error('expected at least two OpenAI models');
    render(<ProviderSettings />);
    fireEvent.click(screen.getByRole('option', { name: new RegExp(`^${second.label} —`) }));
    expect(useAiChatStore.getState().providerConfigs.openai?.defaultModel).toBe(second.id);
  });
});

describe('ProviderSettings connection test', () => {
  beforeEach(() => seed({ openai: cloud('openai') }));
  const testBtn = () => screen.getByRole('button', { name: 'Test OpenAI connection' });

  it('explains when the test IPC is missing', async () => {
    h.api = {};
    render(<ProviderSettings />);
    fireEvent.click(testBtn());
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Connection test is not available in this build.'
      )
    );
  });

  it('shows pending, then a singular model count on success', async () => {
    let resolve: (v: unknown) => void = () => {};
    const testConnection = vi.fn(
      () =>
        new Promise((r) => {
          resolve = r;
        })
    );
    h.api = { aiLab: { testConnection } };
    render(<ProviderSettings />);
    fireEvent.click(testBtn());
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Testing connection…')
    );
    expect(testBtn()).toBeDisabled();
    resolve({ ok: true, modelCount: 1 });
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Connected — 1 model available.')
    );
    expect(testBtn()).toBeEnabled();
  });

  it('pluralises the model count', async () => {
    h.api = { aiLab: { testConnection: vi.fn().mockResolvedValue({ ok: true, modelCount: 12 }) } };
    render(<ProviderSettings />);
    fireEvent.click(testBtn());
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Connected — 12 models available.')
    );
  });

  it('reports a thrown test error', async () => {
    h.api = { aiLab: { testConnection: vi.fn().mockRejectedValue(new Error('ETIMEDOUT')) } };
    render(<ProviderSettings />);
    fireEvent.click(testBtn());
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Connection failed: ETIMEDOUT')
    );
  });

  it('reports a thrown non-Error test failure', async () => {
    h.api = { aiLab: { testConnection: vi.fn().mockRejectedValue('nope') } };
    render(<ProviderSettings />);
    fireEvent.click(testBtn());
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Connection failed: nope')
    );
  });

  it('does nothing for a config without a key handle', async () => {
    const testConnection = vi.fn();
    h.api = { aiLab: { testConnection } };
    seed({ openai: { provider: 'openai', defaultModel: 'gpt' } });
    render(<ProviderSettings />);
    fireEvent.click(testBtn());
    await Promise.resolve();
    expect(testConnection).not.toHaveBeenCalled();
  });
});

describe('ProviderSettings remove key', () => {
  beforeEach(() => seed({ openai: cloud('openai') }));

  it('deletes the keychain entry after confirmation', async () => {
    const del = vi.fn().mockResolvedValue({ ok: true });
    h.api = { secrets: { delete: del } };
    render(<ProviderSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove key' }));
    expect(
      await screen.findByText(/Remove the OpenAI API key\? It will be deleted from the OS keychain/)
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(useAiChatStore.getState().providerConfigs.openai).toBeNull());
    expect(del).toHaveBeenCalledWith(ID2);
  });

  it('keeps the key when cancelled', async () => {
    const del = vi.fn();
    h.api = { secrets: { delete: del } };
    render(<ProviderSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove key' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(del).not.toHaveBeenCalled();
    expect(useAiChatStore.getState().providerConfigs.openai).not.toBeNull();
  });

  it('still clears the config when secure storage is unavailable', async () => {
    render(<ProviderSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove key' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(useAiChatStore.getState().providerConfigs.openai).toBeNull());
  });
});

describe('ProviderSettings local provider', () => {
  it('requires both base URL and model, trims them, and adopts the provider', () => {
    render(<ProviderSettings />);
    const save = screen.getByRole('button', { name: 'Save local provider' });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Base URL'), {
      target: { value: ' http://localhost:11434/v1 ' },
    });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: ' llama3.1 ' } });
    fireEvent.click(save);
    expect(useAiChatStore.getState().providerConfigs['openai-compatible']).toEqual({
      provider: 'openai-compatible',
      defaultModel: 'llama3.1',
      baseUrlOverride: 'http://localhost:11434/v1',
    });
    expect(useAiChatStore.getState().activeProvider).toBe('openai-compatible');
    expect(
      screen.getByText('Configured: http://localhost:11434/v1 · llama3.1')
    ).toBeInTheDocument();
  });

  it('prefills the saved local config', () => {
    seed({
      'openai-compatible': {
        provider: 'openai-compatible',
        defaultModel: 'qwen',
        baseUrlOverride: 'http://127.0.0.1:1234',
      },
    });
    render(<ProviderSettings />);
    expect(screen.getByLabelText('Base URL')).toHaveValue('http://127.0.0.1:1234');
    expect(screen.getByLabelText('Model')).toHaveValue('qwen');
  });
});

describe('ProviderSettings conversation history', () => {
  const SECRET = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH';
  let created: Blob[] = [];
  const origCreate = URL.createObjectURL;
  const origRevoke = URL.revokeObjectURL;

  beforeEach(() => {
    created = [];
    URL.createObjectURL = vi.fn((b: Blob) => {
      created.push(b);
      return 'blob:x';
    }) as never;
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    useAiChatStore.setState({
      conversations: {
        c1: {
          id: 'c1',
          title: 't',
          createdAt: 1,
          updatedAt: 2,
          messages: [
            { id: 'u', role: 'user', text: `my key is ${SECRET}`, status: 'done', createdAt: 1 },
            {
              id: 'a',
              role: 'assistant',
              text: 'ok',
              status: 'error',
              errorMessage: `echo ${SECRET}`,
              createdAt: 2,
            },
            { id: 'b', role: 'assistant', text: 'fine', status: 'done', createdAt: 3 },
          ],
        },
      },
    });
  });
  afterEach(() => {
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
    vi.restoreAllMocks();
  });

  it('exports conversations with secrets redacted', async () => {
    render(<ProviderSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'Export all (JSON)' }));
    expect(created).toHaveLength(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:x');
    const parsed = JSON.parse(await (created[0] as Blob).text()) as {
      conversations: Record<string, { messages: Array<{ text: string; errorMessage?: string }> }>;
      exportedAt: number;
    };
    const msgs = parsed.conversations.c1?.messages ?? [];
    expect(JSON.stringify(parsed)).not.toContain(SECRET);
    expect(msgs[0]?.text).toContain('[REDACTED]');
    expect(msgs[1]?.errorMessage).toContain('[REDACTED]');
    expect(msgs[2]).not.toHaveProperty('errorMessage');
    expect(typeof parsed.exportedAt).toBe('number');
  });

  it('deletes every conversation after confirmation', async () => {
    render(<ProviderSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete all' }));
    await waitFor(() => expect(useAiChatStore.getState().conversations).toEqual({}));
  });
});
