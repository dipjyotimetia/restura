import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/shared/platform', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, isElectron: vi.fn(() => false) };
});

import { hasCompletedOnboarding, ONBOARDING_KEY } from '@/components/shared/WelcomeOnboarding';
import { isElectron } from '@/lib/shared/platform';
import { secureStorage } from '@/lib/shared/secure-storage';
import { useRequestStore } from '@/store/useRequestStore';
import { useFirstRunWelcome } from '../useFirstRunWelcome';

beforeEach(() => {
  secureStorage.remove(ONBOARDING_KEY);
  vi.mocked(isElectron).mockReturnValue(false);
});

describe('useFirstRunWelcome', () => {
  it.each([false, true])('shows the welcome screen on first run (electron=%s)', (electron) => {
    vi.mocked(isElectron).mockReturnValue(electron);
    const { result } = renderHook(() => useFirstRunWelcome());
    expect(result.current.showWelcome).toBe(true);
  });

  it('does not show it once onboarding is complete', () => {
    secureStorage.set(ONBOARDING_KEY, 'true');
    const { result } = renderHook(() => useFirstRunWelcome());
    expect(result.current.showWelcome).toBe(false);
  });

  it('hides on an incidental tab change without persisting completion (A14)', () => {
    const { result } = renderHook(() => useFirstRunWelcome());
    act(() => {
      useRequestStore.getState().createNewRequest('http');
    });
    expect(result.current.showWelcome).toBe(false);
    expect(hasCompletedOnboarding()).toBe(false);
  });

  it('persists completion on an explicit choice', () => {
    const { result } = renderHook(() => useFirstRunWelcome());
    act(() => result.current.finishWelcome());
    expect(result.current.showWelcome).toBe(false);
    expect(hasCompletedOnboarding()).toBe(true);
  });
});
