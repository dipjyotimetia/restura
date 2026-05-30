import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SettingsDrawer from '../SettingsDrawer';
import { useSettingsStore } from '@/store/useSettingsStore';

// next-themes hook — return a stable theme without trying to read CSS or storage.
vi.mock('next-themes', () => ({
  useTheme: () => ({ theme: 'dark', resolvedTheme: 'dark', setTheme: vi.fn() }),
}));

// platform — default to web; some sections check isElectron().
vi.mock('@/lib/shared/platform', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    isElectron: vi.fn(() => false),
    getElectronAPI: vi.fn(() => null),
  };
});

function resetSettings() {
  // Reset accent to the cobalt default between tests so the accent picker
  // assertions are deterministic.
  useSettingsStore.getState().updateSettings({ accent: '#4d9fff' });
}

describe('SettingsDrawer', () => {
  beforeEach(() => {
    resetSettings();
  });

  it('lands on the General section by default', () => {
    render(<SettingsDrawer open onOpenChange={vi.fn()} />);
    // H1 text "General" is in the rendered section.
    expect(screen.getAllByText('General').length).toBeGreaterThan(0);
  });

  it('initialSection prop opens the drawer on the requested section', () => {
    render(<SettingsDrawer open onOpenChange={vi.fn()} initialSection="shortcuts" />);
    // The Shortcuts section has a "Shortcuts" H1.
    const headings = screen.getAllByText('Shortcuts');
    // At least the H1 in the section content + the nav rail label.
    expect(headings.length).toBeGreaterThanOrEqual(2);
  });

  it('Accent picker: clicking a preset updates the settings store', async () => {
    const user = userEvent.setup();
    render(<SettingsDrawer open onOpenChange={vi.fn()} initialSection="appearance" />);

    // The non-default amber preset.
    const amber = screen.getByRole('button', { name: /accent #f59e0b/i });
    await user.click(amber);

    expect(useSettingsStore.getState().settings.accent).toBe('#f59e0b');
  });

  it('Accent picker: active preset reports aria-pressed=true', () => {
    useSettingsStore.getState().updateSettings({ accent: '#22c55e' });
    render(<SettingsDrawer open onOpenChange={vi.fn()} initialSection="appearance" />);

    const green = screen.getByRole('button', { name: /accent #22c55e/i });
    expect(green).toHaveAttribute('aria-pressed', 'true');
  });

  it('renders all ten nav sections', () => {
    render(<SettingsDrawer open onOpenChange={vi.fn()} />);
    const nav = screen.getByRole('navigation', { name: /settings sections/i });
    const buttons = nav.querySelectorAll('button');
    // 10 sections per SECTIONS array (general, appearance, requests, proxy,
    // certificates, secrets, ai, updates, shortcuts, about).
    expect(buttons).toHaveLength(10);
    expect(screen.getByRole('button', { name: /^AI$/i })).toBeInTheDocument();
  });

  it('Certificates section is no longer a stub — renders the client cert UI', () => {
    render(<SettingsDrawer open onOpenChange={vi.fn()} initialSection="certificates" />);
    // The restored UI surfaces a "PFX / P12" format pill from CertificateOverride.
    expect(screen.getByText(/PFX \/ P12/i)).toBeInTheDocument();
    // …and the CA paste textarea is wired.
    expect(screen.getByLabelText(/paste a PEM bundle/i)).toBeInTheDocument();
  });

  it('Secrets section on web shows DesktopOnlyBadge instead of the stub copy', () => {
    render(<SettingsDrawer open onOpenChange={vi.fn()} initialSection="secrets" />);
    // DesktopOnlyBadge renders the literal "Desktop only" text.
    expect(screen.getByText('Desktop only')).toBeInTheDocument();
    // The old "coming soon" stub must be gone.
    expect(screen.queryByText(/vault overview is coming/i)).not.toBeInTheDocument();
  });
});
