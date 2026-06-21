import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export interface WindowedListHandle {
  scrollToBottom(): void;
  isAtBottom(): boolean;
}

export interface WindowedListProps<T> {
  items: T[];
  itemHeight: number;
  height: number;
  overscan?: number;
  renderItem: (item: T, index: number) => ReactNode;
  onScroll?: (scrollTop: number) => void;
}

const AT_BOTTOM_THRESHOLD = 24; // px

function WindowedListInner<T>(props: WindowedListProps<T>, ref: React.Ref<WindowedListHandle>) {
  const { items, itemHeight, height, overscan = 5, renderItem, onScroll } = props;
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);

  const totalHeight = items.length * itemHeight;
  const visibleCount = Math.ceil(height / itemHeight);
  const startIdx = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan);
  const endIdx = Math.min(items.length, startIdx + visibleCount + overscan * 2);

  useImperativeHandle(
    ref,
    (): WindowedListHandle => ({
      scrollToBottom: () => {
        const el = viewportRef.current;
        if (el) el.scrollTop = totalHeight;
      },
      isAtBottom: () => {
        const el = viewportRef.current;
        if (!el) return true;
        return el.scrollTop + el.clientHeight >= el.scrollHeight - AT_BOTTOM_THRESHOLD;
      },
    }),
    [totalHeight]
  );

  const handleScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      const top = e.currentTarget.scrollTop;
      setScrollTop(top);
      onScroll?.(top);
    },
    [onScroll]
  );

  const visibleItems: ReactNode[] = [];
  for (let i = startIdx; i < endIdx; i++) {
    const item = items[i];
    if (item === undefined) continue;
    visibleItems.push(
      <div
        key={i}
        style={{
          position: 'absolute',
          top: i * itemHeight,
          left: 0,
          right: 0,
          height: itemHeight,
        }}
      >
        {renderItem(item, i)}
      </div>
    );
  }

  return (
    <div
      ref={viewportRef}
      data-windowedlist-viewport
      onScroll={handleScroll}
      style={{ height, overflowY: 'auto', position: 'relative' }}
    >
      <div style={{ height: totalHeight, position: 'relative' }}>{visibleItems}</div>
    </div>
  );
}

// Generic component with forwardRef requires a small cast to preserve generics
export const WindowedList = forwardRef(WindowedListInner) as <T>(
  props: WindowedListProps<T> & { ref?: React.Ref<WindowedListHandle> }
) => ReturnType<typeof WindowedListInner>;
