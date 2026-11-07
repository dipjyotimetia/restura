import { useCallback, useState } from 'react';
import {
  hasCompletedOnboarding,
  markOnboardingComplete,
} from '@/components/shared/WelcomeOnboarding';
import { useWelcomeAutoDismiss } from './useWelcomeAutoDismiss';

/**
 * First-run welcome screen state, on every target (web and desktop): the
 * screen replaces the blank starter tab until the user makes a choice. The
 * modal tour is opt-in from there (or Help / the command palette) and never
 * auto-opens.
 *
 * Two ways out, deliberately different:
 *  - `finishWelcome` — an explicit choice (demo, new request, import, tour,
 *    skip): hides the screen and persists completion.
 *  - an incidental tab change from elsewhere (sidebar, palette, shortcut):
 *    only hides it for this session, so the next launch still welcomes.
 */
export function useFirstRunWelcome(): { showWelcome: boolean; finishWelcome: () => void } {
  const [showWelcome, setShowWelcome] = useState(() => !hasCompletedOnboarding());

  const finishWelcome = useCallback(() => {
    markOnboardingComplete();
    setShowWelcome(false);
  }, []);
  const hideWelcome = useCallback(() => setShowWelcome(false), []);
  useWelcomeAutoDismiss(showWelcome, hideWelcome);

  return { showWelcome, finishWelcome };
}
