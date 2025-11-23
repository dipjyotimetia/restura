'use client';

import { useCallback, useRef, useEffect, useState } from 'react';
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
  const [windowWidth, setWindowWidth] = useState(1920);
  const isDragging = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const isHorizontal = orientation === 'horizontal';

  // Track window width for responsive min/max
  useEffect(() => {
    const handleResize = () => setWindowWidth(window.innerWidth);
    setWindowWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Responsive min/max values based on viewport
  const minSplit = propMinSplit ?? (windowWidth < 1280 ? 25 : 20);
  const maxSplit = propMaxSplit ?? (windowWidth < 1280 ? 75 : 80);

  const handleResizeStart = useCallback(() => {
    isDragging.current = true;
    document.body.style.cursor = isHorizontal ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
  }, [isHorizontal]);

  const handleResizeMove = useCallback((e: MouseEvent) => {
    if (!isDragging.current || !containerRef.current) return;

    const container = containerRef.current;
    const rect = container.getBoundingClientRect();
    const newPosition = isHorizontal
      ? ((e.clientX - rect.left) / rect.width) * 100
      : ((e.clientY - rect.top) / rect.height) * 100;

    setSplitPosition(Math.min(maxSplit, Math.max(minSplit, newPosition)));
  }, [isHorizontal, minSplit, maxSplit]);

  const handleResizeEnd = useCallback(() => {
    isDragging.current = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  useEffect(() => {
    window.addEventListener('mousemove', handleResizeMove);
    window.addEventListener('mouseup', handleResizeEnd);

    return () => {
      window.removeEventListener('mousemove', handleResizeMove);
      window.removeEventListener('mouseup', handleResizeEnd);
    };
  }, [handleResizeMove, handleResizeEnd]);

  return (
    <div
      ref={containerRef}
      className={cn("flex h-full", isHorizontal ? "flex-row" : "flex-col", className)}
    >
      <div
        style={isHorizontal ? { width: `${splitPosition}%` } : { height: `${splitPosition}%` }}
        className="min-h-0 min-w-0 overflow-hidden"
      >
        {children[0]}
      </div>
      <div
        className={cn(
          "bg-border/20 hover:bg-primary/20 flex items-center justify-center transition-all duration-200 group shrink-0 relative z-50",
          isHorizontal
            ? "w-1.5 cursor-col-resize"
            : "h-1.5 cursor-row-resize"
        )}
        onMouseDown={handleResizeStart}
        role="separator"
        aria-orientation={isHorizontal ? "vertical" : "horizontal"}
        aria-label="Resize panels"
        tabIndex={0}
      >
        <div className={cn(
          "rounded-full bg-border group-hover:bg-primary/50 transition-colors",
          isHorizontal ? "w-1 h-8" : "h-1 w-8"
        )} />
      </div>
      <div
        style={isHorizontal ? { width: `${100 - splitPosition}%` } : { height: `${100 - splitPosition}%` }}
        className="min-h-0 min-w-0 overflow-hidden"
      >
        {children[1]}
      </div>
    </div>
  );
}
