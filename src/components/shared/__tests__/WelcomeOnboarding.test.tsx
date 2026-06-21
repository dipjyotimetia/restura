import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, afterEach } from 'vitest';
import WelcomeOnboarding from '../WelcomeOnboarding';
import { useSettingsStore } from '@/store/useSettingsStore';

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

    expect(useSettingsStore.getState().settings.telemetry?.errorsEnabled).toBe(false);
  });
});
