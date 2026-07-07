import { useEffect, useRef } from 'react';

/**
 * Cmd/Ctrl+Enter "run" shortcut, shared by the Playground and eval builder
 * (mirrors the HTTP builder's send shortcut). Fires from anywhere in the tab,
 * including inside textareas.
 *
 * The window listener is registered ONCE; the latest callback is read through
 * a ref so re-renders (frequent while streaming) don't churn add/remove
 * listener pairs, and the handler still sees fresh state.
 */
export function useCmdEnterRun(onRun: () => void): void {
  const ref = useRef(onRun);
  ref.current = onRun;
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        ref.current();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
