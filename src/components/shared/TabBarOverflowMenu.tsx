import { ChevronDown } from 'lucide-react';
import { type RefCallback, useCallback, useState } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ProtoChip } from '@/components/ui/spatial';
import { cn } from '@/lib/shared/utils';
import type { RequestTab } from '@/types';

/**
 * Ref callback that reports whether a horizontally scrolling element is
 * overflowing (cropped tabs), composed with another ref callback (the strip's
 * overflow-fade marker).
 */
export function useOverflowing<T extends HTMLElement>(
  inner: RefCallback<T>
): [boolean, RefCallback<T>] {
  const [isOverflowing, setIsOverflowing] = useState(false);
  const ref = useCallback(
    (node: T | null) => {
      const innerCleanup = inner(node);
      if (!node) return;
      const update = () => setIsOverflowing(node.scrollWidth > node.clientWidth + 1);
      update();
      let ro: ResizeObserver | null = null;
      try {
        ro = new ResizeObserver(update);
        ro.observe(node);
      } catch {
        // jsdom setups stub ResizeObserver with a non-constructible mock.
        ro = null;
      }
      // Tabs opening/closing change scrollWidth without a resize.
      const mo = new MutationObserver(update);
      mo.observe(node, { childList: true });
      return () => {
        if (typeof innerCleanup === 'function') innerCleanup();
        ro?.disconnect();
        mo.disconnect();
      };
    },
    [inner]
  );
  return [isOverflowing, ref];
}

interface TabBarOverflowMenuProps {
  tabs: RequestTab[];
  activeTabId: string | null;
  onSelect: (tabId: string) => void;
  nameOf: (tab: RequestTab) => string;
}

/** "All tabs" dropdown shown beside the strip when tabs are cropped. */
export function TabBarOverflowMenu({
  tabs,
  activeTabId,
  onSelect,
  nameOf,
}: TabBarOverflowMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Show all tabs"
          title="All tabs"
          className={cn(
            'inline-flex items-center justify-center size-7 shrink-0',
            'rounded-sp-btn text-sp-muted',
            'hover:bg-sp-hover hover:text-sp-text transition-colors',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent'
          )}
        >
          <ChevronDown className="size-3.5" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={10} className="max-h-[60vh] overflow-y-auto">
        {tabs.map((t) => (
          <DropdownMenuItem
            key={t.id}
            className={cn('gap-2', t.id === activeTabId && 'bg-sp-active')}
            onClick={() => onSelect(t.id)}
          >
            <ProtoChip
              protocol={t.modeOverride ?? t.request.type}
              className="w-12 justify-center"
            />
            <span className="truncate max-w-[240px]">{nameOf(t)}</span>
            {t.isDirty && <span className="sr-only">, unsaved changes</span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
