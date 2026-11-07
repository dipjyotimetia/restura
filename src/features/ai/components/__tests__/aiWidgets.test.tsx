import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AI_PROVIDER_LABELS, providerReadiness } from '@/features/ai/lib/providerReadiness';
import { useAiChatStore } from '@/features/ai/store';
import { useRequestStore } from '@/store/useRequestStore';

const h = vi.hoisted(() => ({ electron: true }));

vi.mock('@/lib/shared/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/shared/platform')>();
  return { ...actual, isElectron: () => h.electron };
});

import { AiActionButton } from '../AiActionButton';
import { AiActionsMenu } from '../AiActionsMenu';
import { Composer } from '../Composer';
import { ContextPill } from '../ContextPill';
import { Message } from '../Message';
import { ProviderSetupCard } from '../ProviderSetupCard';

const KEY = { kind: 'handle' as const, id: '00000000-0000-4000-8000-000000000001' };
const EMPTY = { openai: null, anthropic: null, openrouter: null, 'openai-compatible': null };

function ready(): void {
  useAiChatStore.setState({
    activeProvider: 'anthropic',
    providerConfigs: {
      ...EMPTY,
      anthropic: { provider: 'anthropic', defaultModel: 'm', apiKeyRef: KEY },
    },
    queuedAction: null,
  });
}

let settingsEvents: string[] = [];
const onSettings = (e: Event) => settingsEvents.push(String((e as CustomEvent).detail));

beforeEach(() => {
  h.electron = true;
  settingsEvents = [];
  window.addEventListener('restura:open-settings', onSettings);
  useAiChatStore.setState({ activeProvider: 'anthropic', providerConfigs: { ...EMPTY } });
  useAiChatStore.setState({ queuedAction: null });
});
afterEach(() => window.removeEventListener('restura:open-settings', onSettings));

describe('providerReadiness', () => {
  it('cloud providers need a key handle; local needs a base URL', () => {
    expect(providerReadiness('openai', null)).toBe('missing-key');
    expect(providerReadiness('openai', {})).toBe('missing-key');
    expect(providerReadiness('openai', { apiKeyRef: { id: 'x' } })).toBe('ready');
    expect(providerReadiness('openai-compatible', undefined)).toBe('missing-base-url');
    expect(providerReadiness('openai-compatible', { apiKeyRef: { id: 'x' } })).toBe(
      'missing-base-url'
    );
    expect(providerReadiness('openai-compatible', { baseUrlOverride: 'http://l' })).toBe('ready');
  });

  it('labels every chat provider', () => {
    expect(AI_PROVIDER_LABELS.openrouter).toBe('OpenRouter');
    expect(AI_PROVIDER_LABELS['openai-compatible']).toBe('OpenAI-compatible (local)');
  });
});

describe('ProviderSetupCard', () => {
  it('renders nothing once the provider is ready', () => {
    ready();
    const { container } = render(<ProviderSetupCard />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('Composer', () => {
  const box = () => screen.getByLabelText('Chat message');

  it('sends trimmed text on click and resets the box', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    fireEvent.change(box(), { target: { value: '  hello  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith('hello', false);
    expect(box()).toHaveValue('');
  });

  it('sends on Cmd/Ctrl+Enter but not on plain Enter', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    fireEvent.change(box(), { target: { value: 'q' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(box(), { key: 'a', ctrlKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(box(), { key: 'Enter', ctrlKey: true });
    expect(onSend).toHaveBeenCalledTimes(1);
    fireEvent.change(box(), { target: { value: 'again' } });
    fireEvent.keyDown(box(), { key: 'Enter', metaKey: true });
    expect(onSend).toHaveBeenLastCalledWith('again', false);
  });

  it('sends raw only for the message it was toggled on for', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    fireEvent.click(screen.getByRole('switch'));
    fireEvent.change(box(), { target: { value: 'one' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenLastCalledWith('one', true);
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    fireEvent.change(box(), { target: { value: 'two' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenLastCalledWith('two', false);
  });

  it('while streaming shows Stop and ignores the send shortcut', () => {
    const onSend = vi.fn();
    const onStop = vi.fn();
    render(<Composer streaming onSend={onSend} onStop={onStop} />);
    fireEvent.change(box(), { target: { value: 'q' } });
    fireEvent.keyDown(box(), { key: 'Enter', ctrlKey: true });
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole('switch')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('when disabled explains why and blocks sending', () => {
    const onSend = vi.fn();
    render(<Composer disabled onSend={onSend} />);
    expect(box()).toHaveAttribute(
      'placeholder',
      'Chat is unavailable until an AI provider is set up.'
    );
    fireEvent.keyDown(box(), { key: 'Enter', ctrlKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('shows the normal prompt when enabled', () => {
    render(<Composer onSend={() => {}} />);
    expect(box()).toHaveAttribute('placeholder', 'Ask about the active request or response…');
  });
});

describe('ContextPill', () => {
  beforeEach(() => useRequestStore.setState({ tabs: [], activeTabId: null }));

  it('says when no tab is active', () => {
    render(<ContextPill />);
    expect(screen.getByText('No active tab')).toBeInTheDocument();
  });

  it('says no tab when the active id is stale', () => {
    useRequestStore.setState({ tabs: [], activeTabId: 'gone' });
    render(<ContextPill />);
    expect(screen.getByText('No active tab')).toBeInTheDocument();
  });

  it('shows protocol, method, URL and last status', () => {
    useRequestStore.setState({
      tabs: [
        {
          id: 't1',
          request: { type: 'http', method: 'POST', url: 'https://api.example/x' },
          response: { status: 201 },
        },
      ] as never,
      activeTabId: 't1',
    });
    render(<ContextPill />);
    expect(screen.getByText('HTTP · POST https://api.example/x · 201')).toBeInTheDocument();
  });

  it('prefers the mode override and marks a missing URL', () => {
    useRequestStore.setState({
      tabs: [{ id: 't1', modeOverride: 'websocket', request: { type: 'http' } }] as never,
      activeTabId: 't1',
    });
    render(<ContextPill />);
    expect(screen.getByText('WEBSOCKET · (no URL)')).toBeInTheDocument();
  });

  it('falls back to HTTP when the request has no type, method or URL', () => {
    useRequestStore.setState({ tabs: [{ id: 't1', request: {} }] as never, activeTabId: 't1' });
    render(<ContextPill />);
    expect(screen.getByText('HTTP · (no URL)')).toBeInTheDocument();
  });
});

describe('AiActionButton', () => {
  it('unconfigured: a click opens Settings → AI instead of queueing', () => {
    render(<AiActionButton action="generate-tests" showLabel />);
    fireEvent.click(screen.getByRole('button', { name: 'Generate tests' }));
    expect(settingsEvents).toEqual(['ai']);
    expect(useAiChatStore.getState().queuedAction).toBeNull();
  });

  it('ready: queues the seeded prompt with tools forced and shows the label', () => {
    ready();
    render(<AiActionButton action="enrich-docs" showLabel />);
    const btn = screen.getByRole('button', { name: 'Enrich docs' });
    expect(btn).not.toHaveAttribute('aria-disabled');
    expect(btn).toHaveAttribute('title', expect.stringContaining('proposes an action you approve'));
    expect(btn).toHaveTextContent('Enrich docs');
    fireEvent.click(btn);
    const queued = useAiChatStore.getState().queuedAction;
    expect(queued?.forceTools).toBe(true);
    expect(queued?.userText).toContain('enrich_docs');
    expect(useAiChatStore.getState().panelOpen).toBe(true);
  });

  it('icon-only by default', () => {
    ready();
    render(<AiActionButton action="fix" />);
    expect(screen.getByRole('button', { name: 'Fix request' })).toHaveTextContent('');
  });
});

describe('AiActionsMenu', () => {
  function open(): void {
    const trigger = screen.getByRole('button', { name: 'AI actions' });
    act(() => {
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    });
  }

  it('ready: lists the actions and queues the chosen one', async () => {
    ready();
    render(<AiActionsMenu />);
    expect(screen.getByRole('button', { name: 'AI actions' })).toHaveAttribute(
      'title',
      'AI actions — propose a fix, tests, or docs you approve'
    );
    open();
    expect(await screen.findByRole('menuitem', { name: 'Generate tests' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Configure an AI provider/ })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Fix request' }));
    expect(useAiChatStore.getState().queuedAction?.userText).toContain('update_http_request');
  });

  it('unconfigured: offers settings and disables the actions', async () => {
    render(<AiActionsMenu />);
    open();
    const configure = await screen.findByRole('menuitem', { name: 'Configure an AI provider…' });
    for (const name of ['Fix request', 'Generate tests', 'Enrich docs']) {
      expect(screen.getByRole('menuitem', { name })).toHaveAttribute('data-disabled');
    }
    fireEvent.click(configure);
    expect(settingsEvents).toEqual(['ai']);
  });
});

describe('Message copy feedback', () => {
  const reply = {
    id: 'm1',
    role: 'assistant' as const,
    text: 'Copy me',
    status: 'done' as const,
    createdAt: 0,
  };

  it('confirms a copy, then reverts the label', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<Message message={reply} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy reply' }));
    expect(await screen.findByText('Copied')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Copy')).toBeInTheDocument(), { timeout: 3000 });
  });

  it('stays on "Copy" when the clipboard write is refused', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<Message message={reply} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy reply' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.getByText('Copy')).toBeInTheDocument();
    expect(screen.queryByText('Copied')).not.toBeInTheDocument();
  });
});
