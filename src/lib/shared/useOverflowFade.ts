import { useCallback, useRef } from 'react';

/**
 * Marks a horizontally scrollable element with `data-overflow-left` /
 * `data-overflow-right` attributes so `.sp-scroll-fade` (globals.css) can fade
 * the cropped edge. Pair with the `sp-scroll-fade` class on the same element.
 *
 * Returns a ref callback. Updates happen directly on the DOM node — scrolling
 * and resizing never trigger React re-renders.
 */
export function useOverflowFade<T extends HTMLElement>(): (node: T | null) => void {
  const cleanupRef = useRef<(() => void) | null>(null);

  return useCallback((node: T | null) => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    if (!node) return;

    const update = () => {
      const { scrollLeft, scrollWidth, clientWidth } = node;
      node.toggleAttribute('data-overflow-left', scrollLeft > 1);
      // -1 tolerance: fractional scroll widths report e.g. 719.5 vs 720.
      node.toggleAttribute('data-overflow-right', scrollLeft + clientWidth < scrollWidth - 1);
    };

    update();
    node.addEventListener('scroll', update, { passive: true });
    // try/catch — jsdom test setups stub ResizeObserver with a mock that
    // isn't constructible via `new`.
    let ro: ResizeObserver | null = null;
    try {
      ro = new ResizeObserver(update);
      ro.observe(node);
    } catch {
      ro = null;
    }
    // Tabs opening/closing change scrollWidth without a resize.
    const mo = new MutationObserver(update);
    mo.observe(node, { childList: true });

    cleanupRef.current = () => {
      node.removeEventListener('scroll', update);
      ro?.disconnect();
      mo.disconnect();
    };
  }, []);
}
