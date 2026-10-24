import { useState } from 'react';
import { type McpCompleteFn, useMcpCompletion } from '@/features/mcp/hooks/useMcpCompletion';

/**
 * Focus tracking + suggestion list for a text field backed by
 * `completion/complete`. Spread `focusProps` onto the input and render
 * `suggestions` beneath it.
 */
export function useMcpCompletionField(
  complete: McpCompleteFn | undefined,
  value: string,
  onPick: (value: string) => void
) {
  const [focused, setFocused] = useState(false);
  const suggestions = useMcpCompletion(complete, value, focused);
  const visible = suggestions.filter((s) => s !== value);
  return {
    focusProps: {
      onFocus: () => setFocused(true),
      onBlur: () => setFocused(false),
    },
    suggestions:
      focused && visible.length > 0 ? (
        <McpCompletionSuggestions values={visible} onPick={onPick} />
      ) : null,
  };
}

export function McpCompletionSuggestions({
  values,
  onPick,
}: {
  values: string[];
  onPick: (value: string) => void;
}) {
  return (
    <ul
      role="listbox"
      aria-label="Suggestions"
      className="max-h-32 overflow-auto rounded-sp-btn border border-sp-line bg-sp-surface-lo py-1"
    >
      {values.map((value) => (
        <li key={value} role="option" aria-selected={false}>
          <button
            type="button"
            // mousedown (not click) so the input keeps focus and the list isn't unmounted first
            onMouseDown={(event) => {
              event.preventDefault();
              onPick(value);
            }}
            className="w-full text-left px-2 py-0.5 font-mono text-sp-11-5 text-sp-text hover:bg-sp-hover"
          >
            {value}
          </button>
        </li>
      ))}
    </ul>
  );
}
