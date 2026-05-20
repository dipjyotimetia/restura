import * as React from 'react';
import { cn } from '@/lib/shared/utils';

const VAR_RE = /(\{\{[a-zA-Z_][a-zA-Z0-9_]*\}\})/g;

export interface VariableTextProps extends React.HTMLAttributes<HTMLSpanElement> {
  text: string;
  emptyLabel?: string;
}

/**
 * Highlights {{varName}} occurrences inside a string with the Spatial Depth
 * amber variable token. Pure display — for editable inputs use the value as
 * raw text and overlay this for the read-only render.
 */
export const VariableText = React.forwardRef<HTMLSpanElement, VariableTextProps>(
  ({ text, emptyLabel, className, ...props }, ref) => {
    if (!text) {
      return (
        <span ref={ref} className={cn('text-sp-dim italic', className)} {...props}>
          {emptyLabel ?? ''}
        </span>
      );
    }
    const parts = text.split(VAR_RE);
    return (
      <span ref={ref} className={cn('whitespace-pre-wrap break-all', className)} {...props}>
        {parts.map((p, i) =>
          VAR_RE.test(p) ? (
            <span key={i} className="sp-variable font-mono">
              {p}
            </span>
          ) : (
            <React.Fragment key={i}>{p}</React.Fragment>
          )
        )}
      </span>
    );
  }
);
VariableText.displayName = 'VariableText';
