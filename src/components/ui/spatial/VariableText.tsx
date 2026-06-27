import * as React from 'react';
import { cn } from '@/lib/shared/utils';

// Token grammar covers both env-style `{{ name }}` and dynamic `{{ $helper }}`
// references, with optional surrounding whitespace and dot/dash/underscore in
// names — matching what the variable resolvers accept.
const VAR_RE = /\{\{\s*\$?[\w.-]+\s*\}\}/g;

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

/** Strip the `{{` / `}}` braces and surrounding whitespace from a token. */
function innerName(token: string): string {
  return token.slice(2, -2).trim();
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
  // Build segments via matchAll rather than `split` + stateful `VAR_RE.test()`:
  // calling `.test()` on a /g regex advances its `lastIndex`, so the old code
  // could misclassify tokens depending on prior iterations.
  const segments: Array<{ text: string; isVar: boolean }> = [];
  let cursor = 0;
  for (const match of text.matchAll(VAR_RE)) {
    const start = match.index ?? 0;
    if (start > cursor) segments.push({ text: text.slice(cursor, start), isVar: false });
    segments.push({ text: match[0], isVar: true });
    cursor = start + match[0].length;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), isVar: false });

  return (
    <span ref={ref} className={cn('whitespace-pre-wrap break-all', className)} {...props}>
      {segments.map((seg, i) => {
        if (!seg.isVar) return <React.Fragment key={i}>{seg.text}</React.Fragment>;
        const name = innerName(seg.text);
        const unresolved = getStatus?.(name) === 'unresolved';
        return (
          <span
            key={i}
            className={cn('font-mono', unresolved ? 'sp-variable-unresolved' : 'sp-variable')}
            title={unresolved ? `Unresolved variable: ${name}` : undefined}
          >
            {seg.text}
          </span>
        );
      })}
    </span>
  );
}
VariableText.displayName = 'VariableText';
