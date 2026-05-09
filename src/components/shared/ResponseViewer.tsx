import { useState, useMemo, useEffect, useRef } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { useRequestStore } from '@/store/useRequestStore';
import { useActiveResponse, useActiveStreamingEvents, useActiveTab } from '@/store/selectors';
import { StreamingResponseViewer } from '@/components/shared/StreamingResponseViewer';
import { useSettingsStore } from '@/store/useSettingsStore';
import { formatBytes, formatTime } from '@/lib/shared/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { Copy, Check, Zap, Rows, Columns, Search } from 'lucide-react';
import { toast } from 'sonner';
import { lazyComponent } from '@/lib/shared/lazyComponent';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/shared/utils';
import { Scale, Stagger, StaggerItem, AnimatePresence, motion } from '@/components/ui/motion';
import { withErrorBoundary } from '@/components/shared/ErrorBoundary';
import type * as Monaco from 'monaco-editor';

const CodeEditor = lazyComponent(
  () => import('@/components/shared/CodeEditor'),
  <div className="absolute inset-0 p-4 space-y-2">
    <Skeleton className="h-3.5 w-3/4 rounded" />
    <Skeleton className="h-3.5 w-1/2 rounded" />
    <Skeleton className="h-3.5 w-2/3 rounded" />
    <Skeleton className="h-3.5 w-4/5 rounded" />
  </div>
);

// Helper functions moved outside component to avoid recreation
const formatJson = (body: string): string => {
  try {
    const parsed = JSON.parse(body);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return body;
  }
};

const detectLanguage = (body: string, headers: Record<string, string | string[]>): string => {
  const rawCt = headers['content-type'] ?? headers['Content-Type'] ?? '';
  const contentType = (Array.isArray(rawCt) ? rawCt[0] ?? '' : rawCt);

  if (contentType.includes('application/json')) return 'json';
  if (contentType.includes('application/xml') || contentType.includes('text/xml')) return 'xml';
  if (contentType.includes('text/html')) return 'html';
  if (contentType.includes('text/css')) return 'css';
  if (contentType.includes('text/javascript') || contentType.includes('application/javascript')) return 'javascript';

  // Try to parse as JSON
  try {
    JSON.parse(body);
    return 'json';
  } catch {
    // Not JSON
  }

  // Check if it looks like XML
  if (body.trim().startsWith('<')) return 'xml';

  return 'text';
};

const getStatusTextColor = (status: number) => {
  if (status >= 200 && status < 300) return 'text-emerald-400';
  if (status >= 300 && status < 400) return 'text-blue-400';
  if (status >= 400 && status < 500) return 'text-amber-400';
  if (status >= 500) return 'text-red-400';
  return 'text-muted-foreground';
};

const getStatusDotColor = (status: number) => {
  if (status >= 200 && status < 300) return 'bg-emerald-400 shadow-[0_0_6px_theme(colors.emerald.400)]';
  if (status >= 300 && status < 400) return 'bg-blue-400 shadow-[0_0_6px_theme(colors.blue.400)]';
  if (status >= 400 && status < 500) return 'bg-amber-400 shadow-[0_0_6px_theme(colors.amber.400)]';
  if (status >= 500) return 'bg-red-400 shadow-[0_0_6px_theme(colors.red.400)]';
  return 'bg-muted-foreground';
};

function ResponseSkeleton() {
  return (
    <Scale className="h-full flex flex-col bg-background relative z-20">
      <div className="flex items-center gap-4 px-4 py-2.5 border-b border-border bg-surface-2/50">
        <Skeleton className="h-7 w-28 rounded-md" />
        <div className="h-5 w-px bg-border" />
        <Skeleton className="h-5 w-20 rounded" />
        <div className="h-5 w-px bg-border" />
        <Skeleton className="h-5 w-16 rounded" />
      </div>
      {/* Code-shaped skeleton */}
      <div className="flex-1 p-4">
        <Stagger className="space-y-2 font-mono text-sm">
          <StaggerItem><Skeleton className="h-3.5 w-12 rounded" /></StaggerItem>
          <StaggerItem className="pl-4 space-y-2">
            <Skeleton className="h-3.5 w-3/4 rounded" />
            <Skeleton className="h-3.5 w-1/2 rounded" />
            <div className="pl-4 space-y-2">
              <Skeleton className="h-3.5 w-2/3 rounded" />
              <Skeleton className="h-3.5 w-4/5 rounded" />
              <Skeleton className="h-3.5 w-1/3 rounded" />
            </div>
            <Skeleton className="h-3.5 w-2/5 rounded" />
          </StaggerItem>
          <StaggerItem><Skeleton className="h-3.5 w-8 rounded" /></StaggerItem>
        </Stagger>
      </div>
    </Scale>
  );
}

function ResponseViewer() {
  // Use selectors to only subscribe to needed state, reducing re-renders
  const currentResponse = useActiveResponse();
  const streamingEvents = useActiveStreamingEvents();
  const activeTabId = useActiveTab()?.id;
  const isLoading = useRequestStore((state) => state.isLoading);
  const { settings, updateSettings } = useSettingsStore();
  const [activeTab, setActiveTab] = useState('body');
  const [copiedHeader, setCopiedHeader] = useState<string | null>(null);
  const [copiedBody, setCopiedBody] = useState(false);
  const copyHeaderTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyBodyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const responseEditorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);

  useEffect(() => {
    return () => {
      if (copyHeaderTimer.current) clearTimeout(copyHeaderTimer.current);
      if (copyBodyTimer.current) clearTimeout(copyBodyTimer.current);
    };
  }, []);

  const toggleLayout = () => {
    updateSettings({
      layoutOrientation: settings.layoutOrientation === 'vertical' ? 'horizontal' : 'vertical'
    });
  };

  // useMemo hooks MUST be before any early returns to follow Rules of Hooks
  const language = useMemo(
    () => (currentResponse ? detectLanguage(currentResponse.body, currentResponse.headers) : 'json'),
    [currentResponse]
  );

  const formattedBody = useMemo(() => {
    if (!currentResponse) return '';
    if (language === 'json') {
      return formatJson(currentResponse.body);
    }
    return currentResponse.body;
  }, [currentResponse, language]);

  const handleCopyHeader = async (key: string, value: string | string[]) => {
    const displayValue = Array.isArray(value) ? value.join(', ') : value;
    try {
      await navigator.clipboard.writeText(`${key}: ${displayValue}`);
      setCopiedHeader(key);
      toast.success('Header copied');
      if (copyHeaderTimer.current) clearTimeout(copyHeaderTimer.current);
      copyHeaderTimer.current = setTimeout(() => setCopiedHeader(null), 2000);
    } catch {
      toast.error('Failed to copy header');
    }
  };

  const handleCopyBody = async () => {
    try {
      await navigator.clipboard.writeText(formattedBody);
      setCopiedBody(true);
      toast.success('Response body copied');
      if (copyBodyTimer.current) clearTimeout(copyBodyTimer.current);
      copyBodyTimer.current = setTimeout(() => setCopiedBody(false), 2000);
    } catch {
      toast.error('Failed to copy response body');
    }
  };

  // Streaming dispatch: when an SSE/NDJSON stream is in flight or recently
  // ended, render the dedicated streaming viewer. The buffered response is
  // explicitly cleared by `setStreamingEvents`, so we don't need to worry
  // about the two paths colliding.
  if (streamingEvents) {
    return (
      <TooltipProvider delayDuration={300}>
        <div className="h-full flex flex-col bg-background relative z-20 border-l border-border">
          <div className="h-11 flex items-center px-3 border-b border-border bg-surface-2/50">
            <span className="text-xs font-mono text-muted-foreground uppercase tracking-widest">
              Streaming response
            </span>
            <div className="flex-1" />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={toggleLayout}
                  className="h-7 w-7"
                >
                  {settings.layoutOrientation === 'vertical' ? (
                    <Columns className="h-3.5 w-3.5" />
                  ) : (
                    <Rows className="h-3.5 w-3.5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>Switch to {settings.layoutOrientation === 'vertical' ? 'side-by-side' : 'stacked'} layout</p>
              </TooltipContent>
            </Tooltip>
          </div>
          <div className="flex-1 min-h-0">
            <StreamingResponseViewer events={streamingEvents} />
          </div>
        </div>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider delayDuration={300}>
      <AnimatePresence mode="wait">
        {isLoading ? (
          <motion.div key="loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.1 }} className="h-full">
            <ResponseSkeleton />
          </motion.div>
        ) : !currentResponse ? (
          <motion.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }} className="h-full flex flex-col items-center justify-center gap-3 text-muted-foreground/50 bg-background relative z-20 border-l border-border">
            <Zap className="h-6 w-6" />
            <div className="text-center">
              <p className="text-xs font-mono">Send a request to see the response</p>
              <p className="text-[10px] font-mono mt-1 text-muted-foreground/30">⌘ Enter</p>
            </div>
          </motion.div>
        ) : (
        <motion.div
          key={`response-${currentResponse.timestamp}`}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="h-full flex flex-col bg-background relative z-20 border-l border-border"
        >
        {/* Status zone */}
        <div className="h-11 flex items-center px-3 border-b border-border bg-surface-2/50">
          {/* Left side: status code + dot + text + metadata */}
          <div className="flex flex-col justify-center">
            <div className="flex items-center gap-2">
              <motion.span
                key={currentResponse.status}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.15, ease: 'easeOut' }}
                className={cn('text-2xl font-mono font-bold tabular-nums', getStatusTextColor(currentResponse.status))}
              >
                {currentResponse.status}
              </motion.span>
              <span aria-hidden="true" className={cn('h-2 w-2 rounded-full flex-shrink-0', getStatusDotColor(currentResponse.status))} />
              <span className="text-xs font-mono text-muted-foreground">{currentResponse.statusText}</span>
            </div>
          </div>
          <span className="text-[10px] font-mono text-muted-foreground/60 ml-3">
            {formatTime(currentResponse.time)} · {formatBytes(currentResponse.size)}
          </span>
          {currentResponse.negotiatedAlpn && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className="ml-2 inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground"
                >
                  {currentResponse.negotiatedAlpn === 'h2'
                    ? 'HTTP/2'
                    : currentResponse.negotiatedAlpn === 'h3'
                      ? 'HTTP/3'
                      : 'HTTP/1.1'}
                </span>
              </TooltipTrigger>
              <TooltipContent>
                <p>
                  Connection negotiated{' '}
                  {currentResponse.negotiatedAlpn === 'h2'
                    ? 'HTTP/2'
                    : currentResponse.negotiatedAlpn === 'h3'
                      ? 'HTTP/3'
                      : 'HTTP/1.1'}{' '}
                  via ALPN
                </p>
              </TooltipContent>
            </Tooltip>
          )}

          {/* Right side: layout toggle */}
          <div className="flex-1" />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={toggleLayout}
                className="h-7 w-7"
              >
                {settings.layoutOrientation === 'vertical' ? (
                  <Columns className="h-3.5 w-3.5" />
                ) : (
                  <Rows className="h-3.5 w-3.5" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Switch to {settings.layoutOrientation === 'vertical' ? 'side-by-side' : 'stacked'} layout</p>
            </TooltipContent>
          </Tooltip>
        </div>

        {/* Response Tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col overflow-hidden">
          <TabsList className="px-3">
            <TabsTrigger value="body">
              Body
              {language !== 'text' && (
                <Badge variant="secondary" className="ml-2 h-4 px-1 text-[10px]">
                  {language.toUpperCase()}
                </Badge>
              )}
            </TabsTrigger>
            {language === 'html' && (
              <TabsTrigger value="preview">Preview</TabsTrigger>
            )}
            <TabsTrigger value="headers">
              Headers
              <Badge variant="secondary" className="ml-2 h-4 min-w-4 px-1 text-[10px] tabular-nums">
                {Object.keys(currentResponse.headers).length}
              </Badge>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="body" className="flex-1 relative p-0 m-0 min-h-0 border-none outline-none data-[state=active]:flex data-[state=active]:flex-col h-full">
            {/* Section header bar */}
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/40">
              <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground/60">RESPONSE BODY</span>
              <div className="flex items-center gap-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => responseEditorRef.current?.getAction('actions.find')?.run()}
                      className="h-6 w-6"
                    >
                      <Search className="h-3 w-3" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>Find in response (Ctrl+F)</p>
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={handleCopyBody}
                      className="h-6 w-6"
                    >
                      {copiedBody ? (
                        <Check className="h-3 w-3 text-emerald-400" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{copiedBody ? 'Copied!' : 'Copy response body'}</p>
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>
            <div className="flex-1 relative min-h-0">
              <div className="absolute inset-0">
                {formattedBody ? (
                  <CodeEditor
                    value={formattedBody}
                    language={language}
                    readOnly
                    height="100%"
                    showCopyButton
                    onEditorMount={(editor) => { responseEditorRef.current = editor; }}
                    path={activeTabId ? `tab-${activeTabId}-response` : undefined}
                  />
                ) : (
                  <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground/50">
                    <p className="text-xs font-mono">No body content returned</p>
                  </div>
                )}
              </div>
            </div>
          </TabsContent>

          <TabsContent value="preview" className="flex-1 relative p-0 m-0 min-h-0 border-none outline-none data-[state=active]:flex data-[state=active]:flex-col h-full">
            <div className="flex-1 relative min-h-0">
              <iframe
                srcDoc={currentResponse.body}
                sandbox="allow-scripts allow-same-origin"
                className="absolute inset-0 w-full h-full bg-white border-0"
                title="HTML Preview"
              />
            </div>
          </TabsContent>

          <TabsContent value="headers" className="flex-1 overflow-auto p-0 m-0 min-h-0">
            <div className="p-4 space-y-1">
              {Object.entries(currentResponse.headers).map(([key, value]) => (
                <div
                  key={key}
                  className="group flex gap-3 p-2 rounded hover:bg-surface-2 transition-colors text-xs"
                >
                  <span className="font-mono font-medium text-primary/80 min-w-[140px] truncate">{key}:</span>
                  <span className="font-mono text-muted-foreground break-all flex-1 text-[11px]">
                    {Array.isArray(value) ? value.join(', ') : value}
                  </span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-5 w-5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity flex-shrink-0"
                        onClick={() => handleCopyHeader(key, value)}
                      >
                        {copiedHeader === key ? (
                          <Check className="h-3 w-3 text-emerald-400" />
                        ) : (
                          <Copy className="h-3 w-3" />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{copiedHeader === key ? 'Copied!' : 'Copy header'}</p>
                    </TooltipContent>
                  </Tooltip>
                </div>
              ))}
            </div>
          </TabsContent>
        </Tabs>
      </motion.div>
      )}
      </AnimatePresence>
    </TooltipProvider>
  );
}

export default withErrorBoundary(ResponseViewer);
