import { useMemo, useRef, useState, useEffect } from 'react';
import { WindowedList } from './lib/windowedList';
import { parseCsv } from '@/lib/shared/csvParser';
import { cn } from '@/lib/shared/utils';

const ROW_HEIGHT = 28;

interface CsvTableViewerProps {
  body: string;
}

/**
 * Renders a CSV/TSV response as a scrollable table. Body rows are virtualised
 * (WindowedList) so a multi-thousand-row export doesn't blow up the DOM. The
 * header row is sticky and shares the same grid template as the body rows.
 */
export function CsvTableViewer({ body }: CsvTableViewerProps) {
  const { headers, rows, truncated, totalRows } = useMemo(() => parseCsv(body), [body]);
  const containerRef = useRef<HTMLDivElement>(null);
  const [viewportHeight, setViewportHeight] = useState(400);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height;
      if (h && h > 0) setViewportHeight(h);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const columnCount = Math.max(headers.length, rows[0]?.length ?? 0);
  const gridTemplate = `2.5rem repeat(${Math.max(columnCount, 1)}, minmax(7rem, 1fr))`;

  if (headers.length === 0 && rows.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sp-12 text-sp-dim font-mono">Could not parse CSV content</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div ref={containerRef} className="flex-1 min-h-0 overflow-x-auto">
        <div style={{ minWidth: 'max-content' }}>
          {/* Sticky header */}
          <div
            className="sticky top-0 z-10 grid bg-sp-surface border-b border-sp-line-strong"
            style={{ gridTemplateColumns: gridTemplate }}
          >
            <div className="px-2 py-1.5 text-sp-10-5 text-sp-dim font-mono border-r border-sp-line">
              #
            </div>
            {headers.map((h, i) => (
              <div
                key={i}
                className="px-2 py-1.5 text-sp-11-5 text-sp-text font-mono font-medium truncate border-r border-sp-line"
                title={h}
              >
                {h}
              </div>
            ))}
          </div>

          <WindowedList<string[]>
            items={rows}
            itemHeight={ROW_HEIGHT}
            height={Math.max(viewportHeight - ROW_HEIGHT, ROW_HEIGHT)}
            renderItem={(row, index) => (
              <div
                className={cn(
                  'grid h-full items-center border-b border-sp-line',
                  index % 2 === 1 && 'bg-sp-surface-lo'
                )}
                style={{ gridTemplateColumns: gridTemplate }}
              >
                <div className="px-2 text-sp-10-5 text-sp-dim font-mono tabular-nums border-r border-sp-line">
                  {index + 1}
                </div>
                {Array.from({ length: columnCount }).map((_, c) => (
                  <div
                    key={c}
                    className="px-2 text-sp-11-5 text-sp-muted font-mono truncate border-r border-sp-line"
                    title={row[c] ?? ''}
                  >
                    {row[c] ?? ''}
                  </div>
                ))}
              </div>
            )}
          />
        </div>
      </div>

      <div className="shrink-0 px-3 py-1.5 border-t border-sp-line text-sp-10-5 text-sp-dim font-mono">
        {totalRows.toLocaleString()} rows · {columnCount} columns
        {truncated && ` · showing first ${rows.length.toLocaleString()}`}
      </div>
    </div>
  );
}

export default CsvTableViewer;
