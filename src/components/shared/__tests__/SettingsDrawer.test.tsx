import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FeatureSettingsDrawer from '@/features/settings/SettingsDrawer';
import { useSettingsStore } from '@/store/useSettingsStore';
import SettingsDrawer from '../SettingsDrawer';

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
  useSettingsStore.getState().updateSettings({ accent: '#2e91ff' });
}

describe('SettingsDrawer', () => {
  beforeEach(() => {
    resetSettings();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the shared import as a compatibility wrapper for the feature-owned drawer', () => {
    expect(SettingsDrawer).toBe(FeatureSettingsDrawer);
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

  it('renders all twelve nav sections', () => {
    render(<SettingsDrawer open onOpenChange={vi.fn()} />);
    const nav = screen.getByRole('navigation', { name: /settings sections/i });
    const buttons = nav.querySelectorAll('button');
    // 12 sections per SECTIONS array (general, appearance, requests, proxy,
    // certificates, security, secrets, ai, data, updates, shortcuts, about).
    expect(buttons).toHaveLength(12);
    expect(screen.getByRole('button', { name: /^AI$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Data$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Security$/i })).toBeInTheDocument();
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

  it('shows published release notes inside the Updates section', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify([
            {
              id: 7,
              tag_name: 'v1.4.0',
              name: 'Restura 1.4.0',
              body: `## Highlights

- **MCP:** In-app release notes

## Upgrade notes

- No action required.

## Fixed

- **HTTP:** Fixed redirect handling.
- ![tracker](https://tracker.example/pixel.png)`,
              html_url: 'https://github.com/dipjyotimetia/restura/releases/tag/v1.4.0',
              published_at: '2026-07-12T00:00:00Z',
              draft: false,
              prerelease: false,
            },
          ])
        )
      )
    );

    render(<SettingsDrawer open onOpenChange={vi.fn()} initialSection="updates" />);

    expect(await screen.findByRole('heading', { name: /release notes/i })).toBeInTheDocument();
    expect(screen.getAllByText('Restura 1.4.0')).toHaveLength(2);
    expect(screen.getByText(/in-app release notes/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^highlights$/i })).toBeInTheDocument();
    expect(screen.getByText(/no action required/i)).toBeInTheDocument();
    const fixedSection = screen.getByRole('button', { name: /fixed\s*2\s*changes/i });
    expect(fixedSection).toHaveAttribute('aria-expanded', 'false');
    await user.click(fixedSection);
    expect(fixedSection).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/fixed redirect handling/i)).toBeInTheDocument();
    expect(screen.queryByAltText('tracker')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open v1\.4\.0 on github/i })).toHaveAttribute(
      'href',
      'https://github.com/dipjyotimetia/restura/releases/tag/v1.4.0'
    );
  });

  it('does not show a personal author profile in About', () => {
    render(<SettingsDrawer open onOpenChange={vi.fn()} initialSection="about" />);

    expect(screen.queryByText('Dipjyoti Metia')).not.toBeInTheDocument();
    expect(screen.queryByText(/creator & maintainer/i)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /github repository/i })).toBeInTheDocument();
  });
});
