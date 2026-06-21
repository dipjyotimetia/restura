/**
 * Best-effort extraction of a JSON object from free text — the span from the
 * first `{` to the last `}` (so a single nested object is captured whole).
 * Used to recover a structured payload when a model emits JSON in prose
 * instead of a tool call (judge verdicts, dataset generation, etc.).
 */
export function extractFirstJsonObject(text: string): string | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  return text.slice(start, end + 1);
}
