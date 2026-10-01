import { type MutableRefObject, useEffect, useRef } from 'react';

/**
 * Cmd/Ctrl+Enter runs the active protocol's primary action (send, invoke,
 * connect). The command palette's "Send request" dispatches the same
 * keystroke, so registering here makes both work.
 *
 * Returns a ref: call the hook before any early return, then assign
 * `ref.current` once the handlers exist (null = nothing to do right now,
 * e.g. while a request is already in flight).
 */
export function useSendShortcut(): MutableRefObject<(() => void) | null> {
  const actionRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== 'Enter' || e.defaultPrevented) return;
      const run = actionRef.current;
      if (!run) return;
      e.preventDefault();
      run();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return actionRef;
}
