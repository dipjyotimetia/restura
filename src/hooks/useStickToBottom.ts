import { useCallback, useLayoutEffect, useRef, useState } from 'react';

/** How close to the bottom (px) still counts as "following the stream". */
const DEFAULT_THRESHOLD = 48;

/**
 * Stick-to-bottom autoscroll for live message logs.
 *
 * While the user is at (or near) the bottom, each new row scrolls the list to
 * the end. Once they scroll up to read something, following stops and
 * `showJump` turns on so the log can render a "Jump to latest" pill — the
 * same behaviour as the HTTP StreamingResponseViewer.
 *
 * Attach `ref` and `onScroll` to the scrolling element; `count` is the number
 * of rendered rows (the trigger for a new-row check).
 */
export function useStickToBottom<T extends HTMLElement = HTMLDivElement>(
  count: number,
  threshold: number = DEFAULT_THRESHOLD
) {
  const ref = useRef<T | null>(null);
  const atBottomRef = useRef(true);
  const prevCountRef = useRef(count);
  const [showJump, setShowJump] = useState(false);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
    atBottomRef.current = atBottom;
    if (atBottom) setShowJump(false);
  }, [threshold]);

  useLayoutEffect(() => {
    const grew = count > prevCountRef.current;
    prevCountRef.current = count;
    const el = ref.current;
    if (!el) return;
    if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      setShowJump(false);
    } else if (grew) {
      setShowJump(true);
    } else if (count === 0) {
      // Log cleared: nothing to jump to, and the next rows should follow.
      atBottomRef.current = true;
      setShowJump(false);
    }
  }, [count]);

  const jumpToLatest = useCallback(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    setShowJump(false);
  }, []);

  return { ref, onScroll, showJump, jumpToLatest };
}
