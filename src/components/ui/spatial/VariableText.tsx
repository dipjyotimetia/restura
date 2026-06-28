import * as React from 'react';
import { cn } from '@/lib/shared/utils';
import { findVariableTokens } from '@/lib/shared/variableTokens';

// Re-exported so existing consumers can keep importing the predicate from the
// spatial barrel; the grammar itself lives in lib/shared/variableTokens.
export { hasVariableToken } from '@/lib/shared/variableTokens';

export type VariableStatus = 'resolved' | 'unresolved';

export interface VariableTextProps extends React.HTMLAttributes<HTMLSpanElement> {
  text: string;
  emptyLabel?: string;
  /**
   * Optional classifier for `{{var}}` tokens. Receives the inner variable name
   * (braces stripped, trimmed) and decides how it renders: 'resolved' keeps the
   * default amber token, 'unresolved' gets a distinct warning style. When
   * omitted, every token renders amber (status is not evaluated).
   */
  getStatus?: (varName: string) => VariableStatus;
  ref?: React.Ref<HTMLSpanElement>;
}

/**
 * Highlights {{varName}} occurrences inside a string with the Spatial Depth
 * amber variable token. Pure display — for editable inputs use the value as
 * raw text and overlay this for the read-only render. Pass `getStatus` to flag
 * unresolved references with the warning style.
 */
export function VariableText({
  text,
  emptyLabel,
  getStatus,
  className,
  ref,
  ...props
}: VariableTextProps) {
  if (!text) {
    return (
      <span ref={ref} className={cn('text-sp-dim italic', className)} {...props}>
        {emptyLabel ?? ''}
      </span>
    );
  }
  // Split into literal/token segments using the shared scanner so the rendered
  // tokens match exactly what the gate (`hasVariableToken`) and the Monaco
  // decorator recognise.
  const segments: Array<{ text: string; name?: string }> = [];
  let cursor = 0;
  for (const token of findVariableTokens(text)) {
    if (token.start > cursor) segments.push({ text: text.slice(cursor, token.start) });
    segments.push({ text: text.slice(token.start, token.end), name: token.name });
    cursor = token.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) });

  return (
    <span ref={ref} className={cn('whitespace-pre-wrap break-all', className)} {...props}>
      {segments.map((seg, i) => {
        if (seg.name === undefined) return <React.Fragment key={i}>{seg.text}</React.Fragment>;
        const unresolved = getStatus?.(seg.name) === 'unresolved';
        return (
          <span
            key={i}
            className={cn('font-mono', unresolved ? 'sp-variable-unresolved' : 'sp-variable')}
            title={unresolved ? `Unresolved variable: ${seg.name}` : undefined}
          >
            {seg.text}
          </span>
        );
      })}
    </span>
  );
}
VariableText.displayName = 'VariableText';
