import { useCallback, useRef, useState } from 'react';
import { cn } from '@/lib/shared/utils';

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

interface ResizableLayoutProps {
  children: [React.ReactNode, React.ReactNode];
  orientation?: 'horizontal' | 'vertical';
  defaultSplit?: number;
  /**
   * Controlled split (0–100). When provided, the value is owned by the parent
   * (e.g. persisted in a store) and changes are emitted via `onSplitChange`.
   * When omitted, the component keeps its own state seeded from `defaultSplit`.
   */
  split?: number;
  onSplitChange?: (split: number) => void;
  minSplit?: number;
  maxSplit?: number;
  className?: string;
}

export default function ResizableLayout({
  children,
  orientation = 'horizontal',
  defaultSplit = 50,
  split: controlledSplit,
  onSplitChange,
  minSplit: propMinSplit,
  maxSplit: propMaxSplit,
  className,
}: ResizableLayoutProps) {
  const [internalSplit, setInternalSplit] = useState(defaultSplit);
  const [isDraggingState, setIsDraggingState] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const isHorizontal = orientation === 'horizontal';

  const minSplit = propMinSplit ?? 30;
  const maxSplit = propMaxSplit ?? 70;

  const isControlled = controlledSplit !== undefined;
  // Re-clamp on read so a stale persisted value (saved under different bounds)
  // can never wedge the layout out of range.
  const splitPosition = clamp(isControlled ? controlledSplit : internalSplit, minSplit, maxSplit);

  const commitSplit = useCallback(
    (next: number) => {
      const clamped = clamp(next, minSplit, maxSplit);
      if (isControlled) onSplitChange?.(clamped);
      else setInternalSplit(clamped);
    },
    [isControlled, onSplitChange, minSplit, maxSplit]
  );

  const handleResizeStart = useCallback(() => {
    setIsDraggingState(true);
    document.body.style.cursor = isHorizontal ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';

    const handleMove = (e: MouseEvent) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const newPosition = isHorizontal
        ? ((e.clientX - rect.left) / rect.width) * 100
        : ((e.clientY - rect.top) / rect.height) * 100;
      commitSplit(newPosition);
    };

    const handleEnd = () => {
      setIsDraggingState(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleEnd);
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleEnd);
  }, [isHorizontal, commitSplit]);

  return (
    <div
      ref={containerRef}
      className={cn('flex h-full', isHorizontal ? 'flex-row' : 'flex-col', className)}
    >
      <div
        style={isHorizontal ? { width: `${splitPosition}%` } : { height: `${splitPosition}%` }}
        className="min-h-0 min-w-0 overflow-hidden flex flex-col"
      >
        {children[0]}
      </div>
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- ARIA separator resize handle: keyboard-operable splitter */}
      <div
        className={cn(
          'bg-sp-line hover:bg-sp-accent/50 transition-colors duration-200 shrink-0 relative z-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          // The visible divider stays a 1px hairline; an invisible ::before
          // overlay enlarges the pointer hit area (without adding a visible gap)
          // so the divider is actually grabbable — mirrors the console handle.
          'before:absolute before:content-[""] before:z-50',
          isDraggingState && 'bg-sp-accent/60',
          isHorizontal
            ? 'w-px cursor-col-resize before:inset-y-0 before:-inset-x-2 before:cursor-col-resize'
            : 'h-px cursor-row-resize before:inset-x-0 before:-inset-y-2 before:cursor-row-resize'
        )}
        onMouseDown={handleResizeStart}
        onKeyDown={(e) => {
          const step = 5;
          if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
            e.preventDefault();
            commitSplit(splitPosition - step);
          } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
            e.preventDefault();
            commitSplit(splitPosition + step);
          }
        }}
        role="separator"
        aria-orientation={isHorizontal ? 'vertical' : 'horizontal'}
        aria-label="Resize panels"
        aria-valuenow={Math.round(splitPosition)}
        aria-valuemin={minSplit}
        aria-valuemax={maxSplit}
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- ARIA separator must be focusable for keyboard resize
        tabIndex={0}
      />
      <div
        style={
          isHorizontal
            ? { width: `${100 - splitPosition}%` }
            : { height: `${100 - splitPosition}%` }
        }
        className="min-h-0 min-w-0 overflow-hidden flex flex-col"
      >
        {children[1]}
      </div>
    </div>
  );
}
