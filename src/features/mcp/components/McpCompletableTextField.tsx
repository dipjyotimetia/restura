import { TextField } from '@/components/ui/spatial';
import { useMcpCompletionField } from '@/features/mcp/components/McpCompletionSuggestions';
import type { McpCompleteFn } from '@/features/mcp/hooks/useMcpCompletion';

/** Single-line argument input with debounced `completion/complete` suggestions. */
export function McpCompletableTextField({
  value,
  onChange,
  complete,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  complete?: McpCompleteFn | undefined;
  label: string;
}) {
  const completion = useMcpCompletionField(complete, value, onChange);
  return (
    <>
      <TextField
        mono
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder=""
        className="w-full"
        {...completion.focusProps}
      />
      {completion.suggestions}
    </>
  );
}
