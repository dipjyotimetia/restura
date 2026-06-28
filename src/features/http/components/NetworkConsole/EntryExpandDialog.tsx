'use client';

import { Clock, Cookie as CookieIcon } from 'lucide-react';
import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  detectLanguage,
  formatBytes,
  formatLongTimestamp,
  getStatusBadgeColor,
  httpLikeStatus,
} from '@/lib/shared/console-format';
import { parseRequestCookies, parseResponseCookies } from '@/lib/shared/cookie-parser';
import { lazyComponent } from '@/lib/shared/lazyComponent';
import { cn } from '@/lib/shared/utils';
import type { ConsoleEntry } from '@/store/useConsoleStore';

const CodeEditor = lazyComponent(
  () => import('@/components/shared/CodeEditor'),
  <div className="h-[300px] bg-muted/50 rounded-lg animate-pulse" />
);

interface EntryExpandDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entry: ConsoleEntry | null;
}

/**
 * Full-screen view of a single console entry — pops the cramped bottom-drawer
 * detail pane out into a generous modal so you can actually read large
 * headers and bodies. Sections mirror the inline detail pane (Request first,
 * Response below) but at sizes that make Monaco worthwhile.
 */
export default function EntryExpandDialog({ open, onOpenChange, entry }: EntryExpandDialogProps) {
  const reqCookies = useMemo(
    () =>
      entry ? parseRequestCookies(entry.request.headers as Record<string, string | string[]>) : [],
    [entry]
  );
  const resCookies = useMemo(
    () => (entry ? parseResponseCookies(entry.response.headers) : []),
    [entry]
  );

  if (!entry) return null;

  const displayStatus = httpLikeStatus(entry.protocol, entry.response.status);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!max-w-[min(96vw,1400px)] !w-[min(96vw,1400px)] max-h-[92vh] flex flex-col p-0 gap-0">
        {/* pr-14 reserves the top-right corner for DialogContent's absolute close button */}
        <DialogHeader className="py-3 pl-6 pr-14 border-b border-border">
          <DialogTitle className="text-sm flex items-center gap-3">
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-semibold">
              {entry.request.method}
            </Badge>
            <Badge
              variant="outline"
              className={cn('text-[10px] px-1.5 py-0', getStatusBadgeColor(displayStatus))}
            >
              {displayStatus || 'ERR'} {entry.response.statusText}
            </Badge>
            <span className="font-mono text-xs text-muted-foreground truncate flex-1">
              {entry.request.url}
            </span>
            <span className="flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
              <Clock className="h-3 w-3" />
              {entry.response.time}ms
            </span>
            <span className="text-xs text-muted-foreground tabular-nums" title="Response size">
              ↓ {formatBytes(entry.response.size)}
            </span>
            <span className="text-xs text-muted-foreground">
              {formatLongTimestamp(entry.timestamp)}
            </span>
          </DialogTitle>
          <DialogDescription className="sr-only">
            Full-screen view of the captured request and response, including headers, cookies, and
            body.
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="flex-1">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-px bg-border">
            {/* Request column */}
            <div className="bg-background p-5 space-y-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Request
              </h3>
              <HeaderBlock
                title="Headers"
                headers={entry.request.headers as Record<string, string | string[]>}
              />
              {reqCookies.length > 0 && (
                <CookieList
                  title="Cookies"
                  rows={reqCookies.map((c) => ({ name: c.name, value: c.value }))}
                />
              )}
              {entry.request.body && (
                <BodyBlock
                  label="Body"
                  value={entry.request.body}
                  // Pass the captured request headers so language detection
                  // can use Content-Type rather than payload-sniffing.
                  headers={entry.request.headers as Record<string, string | string[]>}
                  height="320px"
                />
              )}
            </div>

            {/* Response column */}
            <div className="bg-background p-5 space-y-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Response
              </h3>
              <HeaderBlock title="Headers" headers={entry.response.headers} />
              {resCookies.length > 0 && (
                <div className="space-y-1.5">
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                    <CookieIcon className="h-3 w-3" />
                    Set-Cookie
                    <Badge variant="secondary" className="ml-1 text-[10px]">
                      {resCookies.length}
                    </Badge>
                  </h4>
                  <div className="bg-muted/40 rounded-lg p-3 space-y-2 text-xs font-mono">
                    {resCookies.map((c, i) => (
                      <div key={`${c.name}-${i}`} className="space-y-0.5">
                        <div className="flex">
                          <span className="text-primary/80 font-medium min-w-[140px]">
                            {c.name}
                          </span>
                          <span className="text-sp-muted break-all ml-2">{c.value}</span>
                        </div>
                        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground pl-[140px] ml-2">
                          {c.domain && (
                            <span>
                              Domain: <span className="text-sp-muted">{c.domain}</span>
                            </span>
                          )}
                          {c.path && (
                            <span>
                              Path: <span className="text-sp-muted">{c.path}</span>
                            </span>
                          )}
                          {c.expires && (
                            <span>
                              Expires: <span className="text-sp-muted">{c.expires}</span>
                            </span>
                          )}
                          {c.maxAge !== undefined && (
                            <span>
                              Max-Age: <span className="text-sp-muted">{c.maxAge}</span>
                            </span>
                          )}
                          {c.sameSite && (
                            <span>
                              SameSite: <span className="text-sp-muted">{c.sameSite}</span>
                            </span>
                          )}
                          {c.httpOnly && (
                            <span className="text-amber-600 dark:text-amber-400">HttpOnly</span>
                          )}
                          {c.secure && (
                            <span className="text-emerald-600 dark:text-emerald-400">Secure</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {entry.response.body && (
                <BodyBlock
                  label="Body"
                  value={entry.response.body}
                  headers={entry.response.headers}
                  height="420px"
                />
              )}
            </div>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

function HeaderBlock({
  title,
  headers,
}: {
  title: string;
  headers: Record<string, string | string[]>;
}) {
  const entries = Object.entries(headers);
  return (
    <div className="space-y-1.5">
      <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        {title}
        <Badge variant="secondary" className="ml-2 text-[10px]">
          {entries.length}
        </Badge>
      </h4>
      <div className="bg-muted/40 rounded-lg p-3 space-y-1 text-xs font-mono">
        {entries.length === 0 ? (
          <span className="text-muted-foreground">No headers</span>
        ) : (
          entries.map(([key, value]) => (
            <div key={key} className="flex">
              <span className="text-primary/80 font-medium min-w-[140px]">{key}:</span>
              <span className="text-sp-muted break-all ml-2">
                {Array.isArray(value) ? value.join(', ') : value}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function CookieList({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ name: string; value: string }>;
}) {
  return (
    <div className="space-y-1.5">
      <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1">
        <CookieIcon className="h-3 w-3" />
        {title}
        <Badge variant="secondary" className="ml-1 text-[10px]">
          {rows.length}
        </Badge>
      </h4>
      <div className="bg-muted/40 rounded-lg p-3 space-y-1 text-xs font-mono">
        {rows.map((c) => (
          <div key={c.name} className="flex">
            <span className="text-primary/80 font-medium min-w-[140px]">{c.name}</span>
            <span className="text-sp-muted break-all ml-2">{c.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function BodyBlock({
  label,
  value,
  headers,
  height,
}: {
  label: string;
  value: string;
  headers: Record<string, string | string[]> | undefined;
  height: string;
}) {
  return (
    <div className="space-y-1.5">
      <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        {label}
      </h4>
      <div className="rounded-lg overflow-hidden border border-border">
        <CodeEditor
          value={value.substring(0, 100_000)}
          language={detectLanguage(value, headers)}
          readOnly
          height={height}
          showCopyButton
          minimap={false}
        />
      </div>
      {value.length > 100_000 && (
        <p className="text-[11px] text-muted-foreground">
          Showing first 100 KB of {formatBytes(value.length)}.
        </p>
      )}
    </div>
  );
}
