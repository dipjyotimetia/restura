import { useEffect, useRef, useState } from 'react';

export const MCP_COMPLETION_DEBOUNCE_MS = 250;

/** Resolves completion candidates for the current argument value. */
export type McpCompleteFn = (value: string) => Promise<string[]>;

/**
 * Debounced `completion/complete` suggestions for one argument. Only queries
 * while `active` (the field is focused) and discards out-of-order responses.
 */
export function useMcpCompletion(
  complete: McpCompleteFn | undefined,
  value: string,
  active: boolean,
  delayMs: number = MCP_COMPLETION_DEBOUNCE_MS
): string[] {
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const completeRef = useRef(complete);
  completeRef.current = complete;
  const enabled = complete !== undefined && active;

  useEffect(() => {
    if (!enabled) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void completeRef.current?.(value).then(
        (values) => {
          if (!cancelled) setSuggestions(values);
        },
        () => {
          if (!cancelled) setSuggestions([]);
        }
      );
    }, delayMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, value, delayMs]);

  return suggestions;
}
