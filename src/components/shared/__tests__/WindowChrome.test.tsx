import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

import { isElectron, getPlatform } from '@/lib/shared/platform';

beforeEach(() => {
  vi.mocked(isElectron).mockReturnValue(false);
  vi.mocked(getPlatform).mockReturnValue('darwin');
});

describe('WindowChrome', () => {
  it('renders the application banner with brand label', () => {
    render(<WindowChrome />);
    const banner = screen.getByRole('banner', { name: /application chrome/i });
    expect(banner).toBeInTheDocument();
    expect(screen.getByText('Restura')).toBeInTheDocument();
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

  it('does NOT render an "Open AI assistant" / Sparkles button (regression guard)', () => {
    render(<WindowChrome />);
    expect(
      screen.queryByRole('button', { name: /assistant/i })
    ).not.toBeInTheDocument();
  });

  it('hides traffic-light placeholders outside macOS Electron', () => {
    vi.mocked(isElectron).mockReturnValue(false);
    vi.mocked(getPlatform).mockReturnValue('darwin');
    const { container } = render(<WindowChrome />);
    // Traffic lights live in a `div` with `aria-hidden="true"` immediately after the banner start.
    // Their absence is sufficient — the brand label still renders.
    const dots = container.querySelectorAll('span.block.size-3.rounded-full');
    expect(dots).toHaveLength(0);
  });

  it('renders traffic-light placeholders on macOS Electron', () => {
    vi.mocked(isElectron).mockReturnValue(true);
    vi.mocked(getPlatform).mockReturnValue('darwin');
    const { container } = render(<WindowChrome />);
    const dots = container.querySelectorAll('span.block.size-3.rounded-full');
    expect(dots).toHaveLength(3);
  });
});
