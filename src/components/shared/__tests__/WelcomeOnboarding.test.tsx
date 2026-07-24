import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { useSettingsStore } from '@/store/useSettingsStore';
import WelcomeOnboarding from '../WelcomeOnboarding';

// jsdom localStorage is empty, so secureStorage.get(ONBOARDING_KEY) is null and
// the dialog opens on its own (after a 500ms timer).

async function advanceToPrivacyStep(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByText('Send Your First Request', undefined, { timeout: 2000 });
  // Click "Next" until the privacy step appears (its button becomes "Get
  // Started", so the loop stops once there's no "Next" button left).
  for (let i = 0; i < 10 && !screen.queryByText('Help Improve Restura'); i++) {
    await user.click(screen.getByRole('button', { name: /next/i }));
  }
}

describe('WelcomeOnboarding privacy step', () => {
  afterEach(() => {
    // Restore the default so the mutation doesn't leak into other tests.
    useSettingsStore.getState().updateSettings({ telemetry: { errorsEnabled: true } });
    localStorage.clear();
  });

  it('shows a telemetry toggle reflecting the on-by-default state', async () => {
    const user = userEvent.setup();
    render(<WelcomeOnboarding />);

    await advanceToPrivacyStep(user);

    const toggle = screen.getByRole('switch', { name: 'Send crash and error reports' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  it('disables telemetry in the settings store when toggled off', async () => {
    const user = userEvent.setup();
    render(<WelcomeOnboarding />);

    await advanceToPrivacyStep(user);
    await user.click(screen.getByRole('switch', { name: 'Send crash and error reports' }));

    await waitFor(() => {
      expect(useSettingsStore.getState().settings.telemetry?.errorsEnabled).toBe(false);
    });
  });

  it('shows the multi-protocol step but hides the desktop-only AI step on web', async () => {
    // jsdom has no window.electron, so isElectron() is false → AI step filtered.
    const user = userEvent.setup();
    render(<WelcomeOnboarding />);
    await screen.findByText('Send Your First Request', undefined, { timeout: 2000 });

    const seenTitles: string[] = [];
    for (let i = 0; i < 12; i++) {
      seenTitles.push(screen.getByRole('heading', { level: 3 }).textContent ?? '');
      const next = screen.queryByRole('button', { name: /next/i });
      if (!next) break;
      await user.click(next);
    }

    expect(seenTitles).toContain('One Client, Every Protocol');
    expect(seenTitles).not.toContain('Ask the AI Assistant');
  });
});
