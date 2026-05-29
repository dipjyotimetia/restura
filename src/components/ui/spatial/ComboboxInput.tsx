'use client';

import * as React from 'react';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { cn } from '@/lib/shared/utils';
import { VariableInput } from '@/components/shared/VariableInput';

export interface ComboboxSuggestion {
  value: string;
  description?: string;
}

export interface ComboboxInputProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'onChange' | 'value'
> {
  value: string;
  onChange: (next: string) => void;
  suggestions: ReadonlyArray<ComboboxSuggestion>;
  /**
   * Called when the user explicitly selects a suggestion (mouse or Enter).
   * The component still calls `onChange(suggestion.value)` first; this hook is
   * for side-effects like auto-filling a paired default-value column.
   */
  onSelectSuggestion?: (suggestion: ComboboxSuggestion) => void;
  /** Open the popover only after the user has interacted with the input. Default true. */
  openOnFocus?: boolean;
  /** Maximum visible suggestions before scrolling. */
  maxItems?: number;
  /** Optional className on the underlying <input>. */
  inputClassName?: string;
}

/**
 * Free-form input with a typeahead dropdown of suggestions. The list filters
 * by case-insensitive substring of the current input value. Selecting a
 * suggestion replaces the input value; typing a value that isn't in the list
 * is also accepted (suggestions are non-binding).
 *
 * Anchored via Radix `PopoverAnchor` to the underlying <input> so it tracks
 * layout without needing a wrapping container. Use inside grid cells without
 * disturbing column sizing.
 */
export const ComboboxInput = React.forwardRef<HTMLInputElement, ComboboxInputProps>(
  function ComboboxInput(
    {
      value,
      onChange,
      suggestions,
      onSelectSuggestion,
      openOnFocus = true,
      maxItems = 12,
      inputClassName,
      onKeyDown,
      onFocus,
      onBlur,
      ...inputProps
    },
    ref
  ) {
    const [open, setOpen] = React.useState(false);
    const [activeIdx, setActiveIdx] = React.useState(0);
    const listboxId = React.useId();
    const optionPrefix = React.useId();

    const filtered = React.useMemo(() => {
      const q = value.trim().toLowerCase();
      if (!q) return suggestions.slice(0, maxItems);
      return suggestions.filter((s) => s.value.toLowerCase().includes(q)).slice(0, maxItems);
    }, [value, suggestions, maxItems]);

    React.useEffect(() => {
      // Keep the highlight in bounds when the filtered list shrinks.
      if (activeIdx >= filtered.length) {
        setActiveIdx(filtered.length > 0 ? filtered.length - 1 : 0);
      }
    }, [filtered.length, activeIdx]);

    const select = (s: ComboboxSuggestion) => {
      onChange(s.value);
      onSelectSuggestion?.(s);
      setOpen(false);
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
      onKeyDown?.(e);
      if (e.defaultPrevented) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (!open) setOpen(true);
        setActiveIdx((i) => (filtered.length === 0 ? 0 : Math.min(i + 1, filtered.length - 1)));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        if (open && filtered[activeIdx]) {
          e.preventDefault();
          select(filtered[activeIdx]);
        }
      } else if (e.key === 'Escape') {
        if (open) {
          e.preventDefault();
          setOpen(false);
        }
      } else if (e.key === 'Tab') {
        // Don't trap focus — closing on Tab matches platform combobox UX.
        setOpen(false);
      }
    };

    const isOpen = open && filtered.length > 0;

    return (
      <Popover open={isOpen} onOpenChange={setOpen}>
        <PopoverAnchor asChild>
          <VariableInput
            rawInput
            ref={ref}
            value={value}
            onValueChange={(val) => {
              onChange(val);
              setOpen(true);
              setActiveIdx(0);
            }}
            onFocus={(e) => {
              onFocus?.(e);
              if (openOnFocus) setOpen(true);
            }}
            onBlur={(e) => {
              onBlur?.(e);
              // Defer close so a click inside the popover registers first.
              setTimeout(() => setOpen(false), 150);
            }}
            onKeyDown={handleKeyDown}
            role="combobox"
            aria-expanded={isOpen}
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={
              isOpen && filtered[activeIdx] ? `${optionPrefix}-${activeIdx}` : undefined
            }
            className={inputClassName}
            {...inputProps}
          />
        </PopoverAnchor>
        <PopoverContent
          align="start"
          sideOffset={4}
          className="w-[var(--radix-popover-anchor-width)] min-w-[220px] p-0 max-h-[280px] overflow-auto"
          onOpenAutoFocus={(e) => {
            // Keep focus on the input — the popover is a passive listbox.
            e.preventDefault();
          }}
          onPointerDownOutside={(e) => {
            // The anchor input carries role="combobox"; prevent Radix from
            // dismissing the popover when the pointer-down is on the input
            // itself — the blur timeout already handles the close.
            const t = e.target as Element | null;
            if (t?.closest('[role="combobox"]')) e.preventDefault();
          }}
          onInteractOutside={(e) => {
            const t = e.target as Element | null;
            if (t?.closest('[role="combobox"]')) e.preventDefault();
          }}
        >
          <ul id={listboxId} role="listbox" className="py-1">
            {filtered.map((s, idx) => {
              const active = idx === activeIdx;
              return (
                <li
                  key={s.value}
                  id={`${optionPrefix}-${idx}`}
                  role="option"
                  aria-selected={active}
                  onMouseDown={(e) => {
                    // mousedown so the input's blur-close doesn't race the click.
                    e.preventDefault();
                    select(s);
                  }}
                  onMouseEnter={() => setActiveIdx(idx)}
                  className={cn(
                    'flex flex-col gap-0 px-2.5 py-1.5 cursor-pointer rounded-sp-chip mx-1',
                    'text-sp-12 transition-colors',
                    active ? 'bg-sp-active text-sp-text' : 'text-sp-text/90 hover:bg-sp-hover'
                  )}
                >
                  <span className="font-mono">{s.value}</span>
                  {s.description && (
                    <span className="text-sp-11 text-sp-dim font-normal">{s.description}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </PopoverContent>
      </Popover>
    );
  }
);
