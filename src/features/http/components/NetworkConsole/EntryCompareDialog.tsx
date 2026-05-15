'use client';

import { useMemo } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { lazyComponent } from '@/lib/shared/lazyComponent';
import { cn } from '@/lib/shared/utils';
import { detectLanguage, formatLongTimestamp, getStatusTextColor } from '@/lib/shared/console-format';
import type { ConsoleEntry } from '@/store/useConsoleStore';

interface EntryCompareDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  left: ConsoleEntry | null;
  right: ConsoleEntry | null;
}

const CodeEditor = lazyComponent(
  () => import('@/components/shared/CodeEditor'),
  <div className="h-[200px] bg-muted/50 rounded-lg animate-pulse" />
);

interface HeaderDiffRow {
  key: string;
  leftValue: string | undefined;
  rightValue: string | undefined;
  changed: boolean;
}

function diffHeaders(
  a: Record<string, string | string[]>,
  b: Record<string, string | string[]>
): HeaderDiffRow[] {
  const flat = (h: Record<string, string | string[]>) => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(h)) {
      out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
    }
    return out;
  };
  const fa = flat(a);
  const fb = flat(b);
  const keys = new Set([...Object.keys(fa), ...Object.keys(fb)]);
  return Array.from(keys)
    .sort()
    .map((key) => ({
      key,
      leftValue: fa[key],
      rightValue: fb[key],
      changed: fa[key] !== fb[key],
    }));
}


export default function EntryCompareDialog({
  open,
  onOpenChange,
  left,
  right,
}: EntryCompareDialogProps) {
  const requestHeaderDiff = useMemo(() => {
    if (!left || !right) return [];
    return diffHeaders(
      left.request.headers as unknown as Record<string, string | string[]>,
      right.request.headers as unknown as Record<string, string | string[]>
    );
  }, [left, right]);

  const responseHeaderDiff = useMemo(() => {
    if (!left || !right) return [];
    return diffHeaders(left.response.headers, right.response.headers);
  }, [left, right]);

  if (!left || !right) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!max-w-[min(96vw,1400px)] !w-[min(96vw,1400px)] max-h-[90vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-6 py-3 border-b border-border">
          <DialogTitle className="text-sm">Compare entries</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-px bg-border overflow-hidden flex-1">
          {[left, right].map((entry, idx) => (
            <div key={idx} className="bg-background overflow-auto p-4 space-y-4 text-xs">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-semibold">
                    {entry.request.method}
                  </Badge>
                  <span className={cn('font-medium tabular-nums', getStatusTextColor(entry.response.status))}>
                    {entry.response.status || 'ERR'} {entry.response.statusText}
                  </span>
                  <span className="text-muted-foreground ml-auto">{formatLongTimestamp(entry.timestamp)}</span>
                </div>
                <div className="font-mono break-all bg-muted/40 rounded p-2">{entry.request.url}</div>
                <div className="text-muted-foreground">{entry.response.time}ms · {entry.response.size} B</div>
              </div>

              <div>
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">
                  Request headers
                </h4>
                <div className="bg-muted/30 rounded p-2 font-mono text-[11px] space-y-0.5">
                  {requestHeaderDiff.length === 0 ? (
                    <span className="text-muted-foreground">No headers</span>
                  ) : (
                    requestHeaderDiff.map((row) => {
                      const value = idx === 0 ? row.leftValue : row.rightValue;
                      return (
                        <div
                          key={row.key}
                          className={cn(
                            'flex gap-2',
                            row.changed && 'bg-amber-500/10 -mx-2 px-2 rounded'
                          )}
                        >
                          <span className="text-primary/80 min-w-[120px]">{row.key}:</span>
                          <span className={cn('break-all', value === undefined && 'text-muted-foreground italic')}>
                            {value ?? '(absent)'}
                          </span>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              {entry.request.body && (
                <div>
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">
                    Request body
                  </h4>
                  <div className="rounded-lg overflow-hidden border border-border">
                    <CodeEditor
                      value={entry.request.body}
                      language={detectLanguage(entry.request.body)}
                      readOnly
                      height="160px"
                      showCopyButton
                      minimap={false}
                    />
                  </div>
                </div>
              )}

              <div>
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">
                  Response headers
                </h4>
                <div className="bg-muted/30 rounded p-2 font-mono text-[11px] space-y-0.5">
                  {responseHeaderDiff.length === 0 ? (
                    <span className="text-muted-foreground">No headers</span>
                  ) : (
                    responseHeaderDiff.map((row) => {
                      const value = idx === 0 ? row.leftValue : row.rightValue;
                      return (
                        <div
                          key={row.key}
                          className={cn(
                            'flex gap-2',
                            row.changed && 'bg-amber-500/10 -mx-2 px-2 rounded'
                          )}
                        >
                          <span className="text-primary/80 min-w-[120px]">{row.key}:</span>
                          <span className={cn('break-all', value === undefined && 'text-muted-foreground italic')}>
                            {value ?? '(absent)'}
                          </span>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              {entry.response.body && (
                <div>
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">
                    Response body
                  </h4>
                  <div className="rounded-lg overflow-hidden border border-border">
                    <CodeEditor
                      value={entry.response.body.substring(0, 10000)}
                      language={detectLanguage(entry.response.body, entry.response.headers)}
                      readOnly
                      height="220px"
                      showCopyButton
                      minimap={false}
                    />
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="px-6 py-2 border-t border-border text-[11px] text-muted-foreground bg-muted/30">
          Highlighted rows differ between the two entries. Body diff is visual (no inline highlight) — use Cmd+F to scan large payloads.
        </div>
      </DialogContent>
    </Dialog>
  );
}
