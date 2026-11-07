import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WindowChrome } from '../TopBar';

// platform module is consulted for the traffic-light slot on macOS Electron.
vi.mock('@/lib/shared/platform', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    isElectron: vi.fn(() => false),
    getPlatform: vi.fn(() => 'darwin'),
  };
});

import { getPlatform, isElectron } from '@/lib/shared/platform';

beforeEach(() => {
  vi.mocked(isElectron).mockReturnValue(false);
  vi.mocked(getPlatform).mockReturnValue('darwin');
});

describe('WindowChrome', () => {
  it('renders the application banner without a brand label', () => {
    render(<WindowChrome />);
    const banner = screen.getByRole('banner', { name: /application chrome/i });
    expect(banner).toBeInTheDocument();
    expect(screen.queryByText('Restura')).not.toBeInTheDocument();
  });

  it('Search pill click invokes onOpenCommandPalette', async () => {
    const user = userEvent.setup();
    const handler = vi.fn();
    render(<WindowChrome onOpenCommandPalette={handler} />);

    await user.click(screen.getByRole('button', { name: /open command palette/i }));
    expect(handler).toHaveBeenCalledOnce();
  });

  it('Settings button click invokes onOpenSettings', async () => {
    const user = userEvent.setup();
    const handler = vi.fn();
    render(<WindowChrome onOpenSettings={handler} />);

    await user.click(screen.getByRole('button', { name: /open settings/i }));
    expect(handler).toHaveBeenCalledOnce();
  });

  it('Report a bug button invokes onOpenBugReport', async () => {
    const user = userEvent.setup();
    const handler = vi.fn();
    render(<WindowChrome onOpenBugReport={handler} />);

    await user.click(screen.getByRole('button', { name: /report a bug/i }));
    expect(handler).toHaveBeenCalledOnce();
  });

  it('Env pill click invokes onOpenEnvSwitcher when provided', async () => {
    const user = userEvent.setup();
    const switcher = vi.fn();
    const fallback = vi.fn();
    render(<WindowChrome onOpenEnvSwitcher={switcher} setEnvManagerOpen={fallback} />);

    await user.click(screen.getByRole('button', { name: /switch environment/i }));
    expect(switcher).toHaveBeenCalledOnce();
    expect(fallback).not.toHaveBeenCalled();
  });

  it('falls back to setEnvManagerOpen when onOpenEnvSwitcher is omitted', async () => {
    const user = userEvent.setup();
    const fallback = vi.fn();
    render(<WindowChrome setEnvManagerOpen={fallback} />);

    await user.click(screen.getByRole('button', { name: /switch environment/i }));
    expect(fallback).toHaveBeenCalledWith(true);
  });

  it('does NOT render an actionable AI assistant button without onToggleAi (regression guard)', () => {
    render(<WindowChrome />);
    // On web the only assistant affordance is the inert "Desktop only" hint.
    for (const button of screen.queryAllByRole('button', { name: /assistant|ai chat/i })) {
      expect(button).toHaveAttribute('aria-disabled', 'true');
    }
  });

  it('reserves no traffic-light slot outside macOS Electron', () => {
    vi.mocked(isElectron).mockReturnValue(false);
    vi.mocked(getPlatform).mockReturnValue('darwin');
    render(<WindowChrome />);
    expect(screen.queryByTestId('traffic-light-spacer')).toBeNull();
  });

  it('reserves space for the OS traffic lights on macOS Electron without drawing its own', () => {
    vi.mocked(isElectron).mockReturnValue(true);
    vi.mocked(getPlatform).mockReturnValue('darwin');
    const { container } = render(<WindowChrome />);
    // The OS paints the real controls — we only reserve space, never our own dots.
    expect(screen.getByTestId('traffic-light-spacer')).toBeInTheDocument();
    const dots = container.querySelectorAll('span.block.size-3.rounded-full');
    expect(dots).toHaveLength(0);
  });

  it('shows the AI assistant on web as a focusable, inert "Desktop only" button', async () => {
    const user = userEvent.setup();
    vi.mocked(isElectron).mockReturnValue(false);
    render(<WindowChrome />);
    const ai = screen.getByRole('button', { name: /ai assistant/i });
    expect(ai).toHaveAttribute('aria-disabled', 'true');
    expect(ai.getAttribute('title')).toMatch(/desktop only/i);
    await user.click(ai); // no-op, must not throw
  });

  it('keeps the live AI toggle on desktop', () => {
    vi.mocked(isElectron).mockReturnValue(true);
    const onToggleAi = vi.fn();
    render(<WindowChrome onToggleAi={onToggleAi} />);
    screen.getByRole('button', { name: 'Toggle AI chat' }).click();
    expect(onToggleAi).toHaveBeenCalledOnce();
  });
});
