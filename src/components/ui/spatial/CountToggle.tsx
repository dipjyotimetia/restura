export interface CountToggleProps {
  /** Button label, e.g. "Headers" or "Options". */
  label: string;
  /** Count shown in the trailing "(n)" badge. */
  count: number;
  /** Whether the section this button controls is expanded. */
  expanded: boolean;
  onToggle: () => void;
}

/**
 * Compact disclosure toggle used in connection bars to show/hide a config
 * section, with a monospace count badge — "Headers (2)", "Options (0)".
 * Shared by the SSE, WebSocket, and Socket.IO connection bars.
 */
export function CountToggle({ label, count, expanded, onToggle }: CountToggleProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className="h-7 px-2 rounded-sp-btn text-sp-11 text-sp-muted hover:text-sp-text hover:bg-sp-hover transition-colors shrink-0"
    >
      {label} <span className="font-mono tabular-nums">({count})</span>
    </button>
  );
}

export default CountToggle;
