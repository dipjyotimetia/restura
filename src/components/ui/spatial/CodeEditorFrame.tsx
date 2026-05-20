import * as React from 'react';
import { cn } from '@/lib/shared/utils';

export interface CodeEditorFrameProps extends React.HTMLAttributes<HTMLDivElement> {
  gutter?: boolean;
  lineCount?: number;
}

/**
 * Frame that gives any code surface (textarea, monaco wrapper, syntax-highlighted
 * `<pre>`) the Spatial Depth look: dark `code` background, mono 11.5 type, optional
 * 40px line-number gutter. Children render to the right of the gutter.
 */
export const CodeEditorFrame = React.forwardRef<HTMLDivElement, CodeEditorFrameProps>(
  ({ gutter = true, lineCount = 0, className, children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(
          'relative rounded-sp-panel border border-sp-line overflow-hidden font-mono text-sp-12 tabular-nums',
          className
        )}
        style={{ background: 'var(--sp-code)' }}
        {...props}
      >
        <div className="flex h-full min-h-[120px]">
          {gutter && (
            <div
              aria-hidden="true"
              className="shrink-0 w-10 py-2 pr-2 text-right text-sp-dim text-sp-11-5 select-none border-r border-sp-line"
              style={{ background: 'rgba(0,0,0,0.15)' }}
            >
              {Array.from({ length: Math.max(lineCount, 1) }).map((_, i) => (
                <div key={i} style={{ lineHeight: '18px' }}>
                  {i + 1}
                </div>
              ))}
            </div>
          )}
          <div className="flex-1 overflow-auto py-2 px-3">{children}</div>
        </div>
      </div>
    );
  }
);
CodeEditorFrame.displayName = 'CodeEditorFrame';
