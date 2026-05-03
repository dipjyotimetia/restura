import { useCallback, useRef, useState } from 'react';
import { cn } from '@/lib/shared/utils';

interface ResizableLayoutProps {
  children: [React.ReactNode, React.ReactNode];
  orientation?: 'horizontal' | 'vertical';
  defaultSplit?: number;
  minSplit?: number;
  maxSplit?: number;
  className?: string;
}

export default function ResizableLayout({
  children,
  orientation = 'horizontal',
  defaultSplit = 50,
  minSplit: propMinSplit,
  maxSplit: propMaxSplit,
  className,
}: ResizableLayoutProps) {
  const [splitPosition, setSplitPosition] = useState(defaultSplit);
  const [isDraggingState, setIsDraggingState] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const isHorizontal = orientation === 'horizontal';

  const minSplit = propMinSplit ?? 30;
  const maxSplit = propMaxSplit ?? 70;

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
      setSplitPosition(Math.min(maxSplit, Math.max(minSplit, newPosition)));
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
  }, [isHorizontal, minSplit, maxSplit]);

  return (
    <div
      ref={containerRef}
      className={cn('flex h-full', isHorizontal ? 'flex-row' : 'flex-col', className)}
    >
      <div
        style={isHorizontal ? { width: `${splitPosition}%` } : { height: `${splitPosition}%` }}
        className="min-h-0 min-w-0 overflow-hidden"
      >
        {children[0]}
      </div>
      <div
        className={cn(
          'bg-border hover:bg-primary/50 transition-colors duration-200 shrink-0 relative z-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          isDraggingState && 'bg-primary/50 shadow-[0_0_8px_hsl(var(--primary)/0.4)]',
          isHorizontal ? 'w-px cursor-col-resize' : 'h-px cursor-row-resize'
        )}
        onMouseDown={handleResizeStart}
        onKeyDown={(e) => {
          const step = 5;
          if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
            e.preventDefault();
            setSplitPosition((prev) => Math.max(minSplit, prev - step));
          } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
            e.preventDefault();
            setSplitPosition((prev) => Math.min(maxSplit, prev + step));
          }
        }}
        role="separator"
        aria-orientation={isHorizontal ? 'vertical' : 'horizontal'}
        aria-label="Resize panels"
        aria-valuenow={Math.round(splitPosition)}
        aria-valuemin={minSplit}
        aria-valuemax={maxSplit}
        tabIndex={0}
      />
      <div
        style={isHorizontal ? { width: `${100 - splitPosition}%` } : { height: `${100 - splitPosition}%` }}
        className="min-h-0 min-w-0 overflow-hidden"
      >
        {children[1]}
      </div>
    </div>
  );
}
