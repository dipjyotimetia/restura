'use client';

import {
  Check,
  Clock,
  Code2,
  Cookie as CookieIcon,
  Copy,
  ExternalLink,
  FileText,
  GitCompare,
  Maximize2,
  RotateCw,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { type CodeGeneratorType, codeGenerators } from '@/lib/shared/codeGenerators';
import {
  detectLanguage,
  formatBytes,
  formatClockTime,
  getStatusBadgeColor,
  httpLikeStatus,
} from '@/lib/shared/console-format';
import { parseRequestCookies, parseResponseCookies } from '@/lib/shared/cookie-parser';
import { lazyComponent } from '@/lib/shared/lazyComponent';
import { cn } from '@/lib/shared/utils';
import type { ConsoleEntry } from '@/store/useConsoleStore';

const CodeEditor = lazyComponent(
  () => import('@/components/shared/CodeEditor'),
  <div className="h-[150px] bg-muted/50 rounded-lg animate-pulse" />
);

const formatHeadersForCopy = (headers: Record<string, string | string[]>) =>
  Object.entries(headers)
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
    .join('\n');

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success(`${label} copied to clipboard`);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Failed to copy');
    }
  };

  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-5 w-5 opacity-0 group-hover:opacity-100 transition-opacity"
      onClick={handleCopy}
    >
      {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
    </Button>
  );
}

interface NetworkEntryDetailProps {
  compareCount: number;
  entry: ConsoleEntry | undefined;
  onCompare: () => void;
  onCopyAsCode: (generator: CodeGeneratorType) => void;
  onCopyCurl: () => void;
  onExpand: () => void;
  onOpenInNewTab: () => void;
  onReplay: () => void;
}

export default function NetworkEntryDetail({
  compareCount,
  entry,
  onCompare,
  onCopyAsCode,
  onCopyCurl,
  onExpand,
  onOpenInNewTab,
  onReplay,
}: NetworkEntryDetailProps) {
  const selectedStatus = entry ? httpLikeStatus(entry.protocol, entry.response.status) : 0;
  const requestCookies = useMemo(
    () =>
      entry ? parseRequestCookies(entry.request.headers as Record<string, string | string[]>) : [],
    [entry]
  );
  const responseCookies = useMemo(
    () => (entry ? parseResponseCookies(entry.response.headers) : []),
    [entry]
  );

  if (!entry) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
        <FileText className="h-8 w-8 mb-2 opacity-30" />
        <p className="text-xs">Select a request to view details</p>
      </div>
    );
  }

  return (
    <Tabs defaultValue="response" className="h-full flex flex-col">
      <div className="px-4 pt-2 border-b border-border flex items-center justify-between gap-2">
        <TabsList className="h-8">
          <TabsTrigger value="request" className="text-xs h-7">
            <FileText className="h-3 w-3 mr-1.5" />
            Request
          </TabsTrigger>
          <TabsTrigger value="response" className="text-xs h-7">
            <FileText className="h-3 w-3 mr-1.5" />
            Response
          </TabsTrigger>
        </TabsList>
        <div className="flex items-center gap-1">
          {compareCount === 2 && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={() => onCompare()}
              title="Compare the two selected entries"
            >
              <GitCompare className="h-3 w-3 mr-1" />
              Compare ({compareCount})
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-[11px]"
            onClick={onReplay}
            title="Replay in the active tab (or open a new HTTP tab if not HTTP)"
          >
            <RotateCw className="h-3 w-3 mr-1" />
            Replay
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-[11px]"
            onClick={onOpenInNewTab}
            title="Open in a new tab"
          >
            <ExternalLink className="h-3 w-3 mr-1" />
            New tab
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[11px]"
                title="Copy request as code"
              >
                <Code2 className="h-3 w-3 mr-1" />
                Copy as
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuLabel className="text-[11px]">Copy request as</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-xs" onClick={onCopyCurl}>
                cURL
              </DropdownMenuItem>
              {(
                Object.entries(codeGenerators) as Array<
                  [CodeGeneratorType, (typeof codeGenerators)[CodeGeneratorType]]
                >
              )
                .filter(([key]) => key !== 'curl')
                .map(([key, gen]) => (
                  <DropdownMenuItem key={key} className="text-xs" onClick={() => onCopyAsCode(key)}>
                    {gen.name}
                  </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => onExpand()}
            title="Expand entry to a full-screen view"
            aria-label="Expand entry"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* At-a-glance summary — visible on both Request and Response tabs. */}
      <div className="flex items-center gap-3 px-4 py-1.5 border-b border-border/60 text-[11px] font-mono">
        <Badge
          variant="outline"
          className={cn('text-[10px] px-1.5 py-0', getStatusBadgeColor(selectedStatus))}
        >
          {selectedStatus || 'ERR'} {entry.response.statusText}
        </Badge>
        <span className="flex items-center gap-1 text-muted-foreground tabular-nums">
          <Clock className="h-3 w-3" />
          {entry.response.time}ms
        </span>
        {entry.requestSize != null && (
          <span className="text-muted-foreground tabular-nums" title="Request size">
            ↑ {formatBytes(entry.requestSize)}
          </span>
        )}
        <span className="text-muted-foreground tabular-nums" title="Response size">
          ↓ {formatBytes(entry.response.size)}
        </span>
        {entry.bodyTruncated && (
          <Badge
            variant="outline"
            className="text-[9px] px-1 py-0 bg-amber-500/10 text-amber-500 border-amber-500/30"
            title="Body exceeded the live capture limit and was cut at capture time"
          >
            body truncated
          </Badge>
        )}
      </div>

      <TabsContent value="request" className="flex-1 m-0 overflow-hidden">
        <ScrollArea className="h-full">
          <div className="px-4 pt-2 pb-4 space-y-3">
            {/* General info */}
            <div className="space-y-1.5">
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                General
              </h4>
              <div className="bg-muted/50 rounded-lg p-3 space-y-2 text-xs">
                <div className="flex justify-between items-center group">
                  <span className="text-muted-foreground">URL</span>
                  <div className="flex items-center gap-1 ml-4">
                    <span className="font-mono text-foreground truncate max-w-[280px]">
                      {entry.resolvedUrl ?? entry.request.url}
                    </span>
                    <CopyButton value={entry.resolvedUrl ?? entry.request.url} label="URL" />
                  </div>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Method</span>
                  <span className="font-semibold">{entry.request.method}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Timestamp</span>
                  <span>{formatClockTime(entry.timestamp)}</span>
                </div>
              </div>
            </div>

            {/* Request headers */}
            <div className="space-y-2">
              <div className="flex items-center justify-between group">
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  Request Headers
                  <Badge variant="secondary" className="ml-2 text-[10px]">
                    {Object.keys(entry.request.headers).length}
                  </Badge>
                </h4>
                {Object.keys(entry.request.headers).length > 0 && (
                  <CopyButton value={formatHeadersForCopy(entry.request.headers)} label="Headers" />
                )}
              </div>
              <div className="bg-muted/50 rounded-lg p-3 space-y-1.5 text-xs font-mono">
                {Object.entries(entry.request.headers).length > 0 ? (
                  Object.entries(entry.request.headers).map(([key, value]) => (
                    <div key={key} className="flex">
                      <span className="text-primary/80 font-medium min-w-[120px]">{key}:</span>
                      <span className="text-sp-muted break-all ml-2">{value}</span>
                    </div>
                  ))
                ) : (
                  <span className="text-muted-foreground">No headers</span>
                )}
              </div>
            </div>

            {/* Cookies sent — parsed from the Cookie request header. */}
            {requestCookies.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                  <CookieIcon className="h-3 w-3" />
                  Cookies
                  <Badge variant="secondary" className="ml-1 text-[10px]">
                    {requestCookies.length}
                  </Badge>
                </h4>
                <div className="bg-muted/50 rounded-lg p-3 space-y-1.5 text-xs font-mono">
                  {requestCookies.map((c) => (
                    <div key={c.name} className="flex">
                      <span className="text-primary/80 font-medium min-w-[120px]">{c.name}</span>
                      <span className="text-sp-muted break-all ml-2">{c.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Request body */}
            {entry.request.body && (
              <div className="space-y-2">
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  Request Body
                </h4>
                <div className="rounded-lg overflow-hidden border border-border">
                  <CodeEditor
                    value={entry.request.body}
                    language={detectLanguage(entry.request.body)}
                    readOnly={true}
                    height="150px"
                    showCopyButton={true}
                    minimap={false}
                  />
                </div>
              </div>
            )}
          </div>
        </ScrollArea>
      </TabsContent>

      <TabsContent value="response" className="flex-1 m-0 overflow-hidden">
        <ScrollArea className="h-full">
          <div className="px-4 pt-2 pb-4 space-y-3">
            {/* The Status / Response size / Request size summary box that
                      used to live here was a duplicate of the inline summary
                      row just above (status + ↑↓ bytes). Removed so the detail
                      pane gets straight to Timing → Headers → Body. */}

            {/* Timing breakdown */}
            <div className="space-y-1.5">
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                <Clock className="h-3 w-3" />
                Timing
              </h4>
              <div className="bg-muted/50 rounded-lg p-3 space-y-3">
                <div className="flex justify-between items-center text-xs">
                  <span className="text-muted-foreground">Total Time</span>
                  <span
                    className={cn(
                      'font-medium',
                      entry.response.time < 200
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : entry.response.time < 500
                          ? 'text-amber-600 dark:text-amber-400'
                          : 'text-red-600 dark:text-red-400'
                    )}
                  >
                    {entry.response.time}ms
                  </span>
                </div>
                {/* Visual timing bar */}
                <div className="space-y-1.5">
                  <div className="h-2 rounded-full overflow-hidden bg-muted">
                    <div
                      className={cn(
                        'h-full rounded-full transition-all',
                        entry.response.time < 200
                          ? 'bg-emerald-500'
                          : entry.response.time < 500
                            ? 'bg-amber-500'
                            : 'bg-red-500'
                      )}
                      style={{
                        width: `${Math.min(100, (entry.response.time / 1000) * 100)}%`,
                      }}
                    />
                  </div>
                  <div className="flex justify-between text-[10px] text-muted-foreground">
                    <span>0ms</span>
                    <span>500ms</span>
                    <span>1000ms</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Response headers */}
            <div className="space-y-2">
              <div className="flex items-center justify-between group">
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  Response Headers
                  <Badge variant="secondary" className="ml-2 text-[10px]">
                    {Object.keys(entry.response.headers).length}
                  </Badge>
                </h4>
                {Object.keys(entry.response.headers).length > 0 && (
                  <CopyButton
                    value={formatHeadersForCopy(entry.response.headers)}
                    label="Headers"
                  />
                )}
              </div>
              <div className="bg-muted/50 rounded-lg p-3 space-y-1.5 text-xs font-mono">
                {Object.entries(entry.response.headers).length > 0 ? (
                  Object.entries(entry.response.headers).map(([key, value]) => (
                    <div key={key} className="flex">
                      <span className="text-primary/80 font-medium min-w-[120px]">{key}:</span>
                      <span className="text-sp-muted break-all ml-2">
                        {Array.isArray(value) ? value.join(', ') : value}
                      </span>
                    </div>
                  ))
                ) : (
                  <span className="text-muted-foreground">No headers</span>
                )}
              </div>
            </div>

            {/* Cookies set — parsed from response Set-Cookie. */}
            {responseCookies.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                  <CookieIcon className="h-3 w-3" />
                  Set-Cookie
                  <Badge variant="secondary" className="ml-1 text-[10px]">
                    {responseCookies.length}
                  </Badge>
                </h4>
                <div className="bg-muted/50 rounded-lg p-3 space-y-2 text-xs font-mono">
                  {responseCookies.map((c, i) => (
                    <div key={`${c.name}-${i}`} className="space-y-0.5">
                      <div className="flex">
                        <span className="text-primary/80 font-medium min-w-[120px]">{c.name}</span>
                        <span className="text-sp-muted break-all ml-2">{c.value}</span>
                      </div>
                      {/* Attributes — only render when something was actually parsed,
                                so the panel stays compact for typical cookies. */}
                      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground pl-[120px] ml-2">
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

            {/* Response body preview */}
            {entry.response.body && (
              <div className="space-y-2">
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  Response Body
                </h4>
                <div className="rounded-lg overflow-hidden border border-border">
                  <CodeEditor
                    value={entry.response.body.substring(0, 10000)}
                    language={detectLanguage(entry.response.body, entry.response.headers)}
                    readOnly={true}
                    height="200px"
                    showCopyButton={true}
                    minimap={false}
                  />
                </div>
                {entry.response.body.length > 10000 && (
                  <p className="text-xs text-muted-foreground">
                    Showing first 10KB of {formatBytes(entry.response.body.length)}
                  </p>
                )}
              </div>
            )}
          </div>
        </ScrollArea>
      </TabsContent>
    </Tabs>
  );
}
