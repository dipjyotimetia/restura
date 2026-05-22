import { useState, useMemo, useEffect, useRef } from 'react';
import { useRequestStore } from '@/store/useRequestStore';
import { useActiveResponse, useActiveStreamingEvents, useActiveTab } from '@/store/selectors';
import { StreamingResponseViewer } from '@/components/shared/StreamingResponseViewer';
import { useSettingsStore } from '@/store/useSettingsStore';
import { formatBytes, formatTime } from '@/lib/shared/utils';
import { detectLanguage } from '@/lib/shared/console-format';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Copy, Check, Zap, Rows, Columns, Search, Download,
} from 'lucide-react';
import { toast } from 'sonner';
import { lazyComponent } from '@/lib/shared/lazyComponent';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/shared/utils';
import { Scale, Stagger, StaggerItem, AnimatePresence, motion } from '@/components/ui/motion';
import { withErrorBoundary } from '@/components/shared/ErrorBoundary';
import {
  Floater,
  StatusPill,
  Stat,
  SubTabBar,
  Segmented,
  Kbd,
  WaterfallBar,
  type SubTab,
} from '@/components/ui/spatial';
import type * as Monaco from 'monaco-editor';

// Bodies above this size skip pretty-print to avoid freezing the main thread
// on multi-MB responses; raw text still renders fine through Monaco.
const PRETTY_PRINT_MAX_BYTES = 1_000_000;

const CodeEditor = lazyComponent(
  () => import('@/components/shared/CodeEditor'),
  <div className="absolute inset-0 p-4 space-y-2">
    <Skeleton className="h-3.5 w-3/4 rounded" />
    <Skeleton className="h-3.5 w-1/2 rounded" />
    <Skeleton className="h-3.5 w-2/3 rounded" />
    <Skeleton className="h-3.5 w-4/5 rounded" />
  </div>
);

const formatJson = (body: string): string => {
  if (body.length > PRETTY_PRINT_MAX_BYTES) return body;
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
};

function alpnLabel(alpn?: 'h1.1' | 'h2' | 'h3'): string {
  if (alpn === 'h2') return 'HTTP/2';
  if (alpn === 'h3') return 'HTTP/3';
  if (alpn === 'h1.1') return 'HTTP/1.1';
  return '—';
}

function ResponseSkeleton() {
  return (
    <Scale className="h-full flex flex-col relative z-20">
      <Floater radius="panel" elevation="float-lg" className="h-full flex flex-col overflow-hidden">
        <div className="flex items-center gap-4 px-4 py-2.5 border-b border-sp-line">
          <Skeleton className="h-7 w-28 rounded-md" />
          <div className="h-5 w-px bg-sp-line" />
          <Skeleton className="h-5 w-20 rounded" />
          <div className="h-5 w-px bg-sp-line" />
          <Skeleton className="h-5 w-16 rounded" />
        </div>
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
      </Floater>
    </Scale>
  );
}

type ResponseTab = 'body' | 'headers' | 'cookies' | 'timeline' | 'tests' | 'preview';
type BodyFormat = 'pretty' | 'raw' | 'preview';

function IconButton({
  icon,
  label,
  onClick,
  active,
}: { icon: React.ReactNode; label: string; onClick?: () => void; active?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          className={cn(
            'inline-flex items-center justify-center size-7 rounded-sp-btn transition-colors',
            'text-sp-muted hover:text-sp-text hover:bg-sp-hover',
            active && 'text-sp-accent bg-sp-active'
          )}
        >
          {icon}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function LayoutToggleButton() {
  const { settings, updateSettings } = useSettingsStore();
  const vertical = settings.layoutOrientation === 'vertical';
  return (
    <IconButton
      icon={vertical ? <Columns className="h-3.5 w-3.5" /> : <Rows className="h-3.5 w-3.5" />}
      label={`Switch to ${vertical ? 'side-by-side' : 'stacked'} layout`}
      onClick={() =>
        updateSettings({ layoutOrientation: vertical ? 'horizontal' : 'vertical' })
      }
    />
  );
}

function ResponseViewer() {
  const currentResponse = useActiveResponse();
  const streamingEvents = useActiveStreamingEvents();
  const activeTabId = useActiveTab()?.id;
  const isLoading = useRequestStore((state) => state.isLoading);
  const [activeTab, setActiveTab] = useState<ResponseTab>('body');
  const [bodyFormat, setBodyFormat] = useState<BodyFormat>('pretty');
  const [copiedHeader, setCopiedHeader] = useState<string | null>(null);
  const [copiedBody, setCopiedBody] = useState(false);
  const [headerFilter, setHeaderFilter] = useState('');
  const copyHeaderTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyBodyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const responseEditorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);

  useEffect(() => {
    return () => {
      if (copyHeaderTimer.current) clearTimeout(copyHeaderTimer.current);
      if (copyBodyTimer.current) clearTimeout(copyBodyTimer.current);
    };
  }, []);

  const language = useMemo(
    () => (currentResponse ? detectLanguage(currentResponse.body, currentResponse.headers) : 'json'),
    [currentResponse]
  );

  // Pretty-printing a large JSON body can stall the main thread, so only
  // compute it when the body/preview tab is actually visible.
  const formattedBody = useMemo(() => {
    if (!currentResponse) return '';
    const showsBody = activeTab === 'body' || activeTab === 'preview';
    if (!showsBody) return '';
    if (bodyFormat === 'raw') return currentResponse.body;
    if (language === 'json') return formatJson(currentResponse.body);
    return currentResponse.body;
  }, [currentResponse, language, bodyFormat, activeTab]);

  const headerEntries = useMemo(
    () => Object.entries(currentResponse?.headers ?? {}),
    [currentResponse?.headers]
  );

  const filteredHeaderEntries = useMemo(() => {
    if (!headerFilter) return headerEntries;
    const needle = headerFilter.toLowerCase();
    return headerEntries.filter(([key]) => key.toLowerCase().includes(needle));
  }, [headerEntries, headerFilter]);

  const cookies = useMemo(() => {
    if (!currentResponse) return [] as Array<{ name: string; value: string; attrs: string }>;
    const raw = currentResponse.headers['set-cookie'] ?? currentResponse.headers['Set-Cookie'];
    if (!raw) return [];
    const list = Array.isArray(raw) ? raw : [raw];
    return list.map((entry) => {
      const [pair, ...rest] = entry.split(';');
      const eq = pair?.indexOf('=') ?? -1;
      const name = eq > 0 ? pair!.slice(0, eq).trim() : (pair ?? '');
      const value = eq > 0 ? pair!.slice(eq + 1).trim() : '';
      return { name, value, attrs: rest.map((s) => s.trim()).join(' · ') };
    });
  }, [currentResponse]);

  const serverTiming = useMemo(() => {
    if (!currentResponse || activeTab !== 'timeline') {
      return [] as Array<{ name: string; dur?: number; desc?: string }>;
    }
    const raw = currentResponse.headers['server-timing'] ?? currentResponse.headers['Server-Timing'];
    if (!raw) return [];
    const list = Array.isArray(raw) ? raw : [raw];
    const out: Array<{ name: string; dur?: number; desc?: string }> = [];
    for (const entry of list) {
      for (const part of entry.split(',')) {
        const segs = part.split(';').map((s) => s.trim());
        const first = segs[0];
        if (!first) continue;
        const parsed: { name: string; dur?: number; desc?: string } = { name: first };
        for (const seg of segs.slice(1)) {
          const eq = seg.indexOf('=');
          if (eq < 0) continue;
          const k = seg.slice(0, eq).trim().toLowerCase();
          const v = seg.slice(eq + 1).trim().replace(/^"|"$/g, '');
          if (k === 'dur') parsed.dur = Number(v);
          else if (k === 'desc') parsed.desc = v;
        }
        out.push(parsed);
      }
    }
    return out;
  }, [currentResponse, activeTab]);

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

  const handleDownloadBody = () => {
    if (!currentResponse) return;
    const blob = new Blob([currentResponse.body], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `response-${activeTabId ?? 'body'}.${language === 'json' ? 'json' : 'txt'}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  if (streamingEvents) {
    return (
      <TooltipProvider delayDuration={300}>
        <Floater
          radius="panel"
          elevation="float-lg"
          className="h-full flex flex-col overflow-hidden relative z-20"
        >
          <div className="h-11 flex items-center px-3 border-b border-sp-line">
            <span className="sp-label">Streaming response</span>
            <div className="flex-1" />
            <LayoutToggleButton />
          </div>
          <div className="flex-1 min-h-0">
            <StreamingResponseViewer events={streamingEvents} />
          </div>
        </Floater>
      </TooltipProvider>
    );
  }

  const tabs: ReadonlyArray<SubTab<ResponseTab>> = [
    ...(language === 'html' ? [{ value: 'preview' as const, label: 'Preview' }] : []),
    { value: 'body' as const, label: 'Body', ...(language !== 'text' && { badge: language.toUpperCase() }) },
    { value: 'headers' as const, label: 'Headers', count: headerEntries.length },
    { value: 'cookies' as const, label: 'Cookies', count: cookies.length },
    { value: 'timeline' as const, label: 'Timeline' },
    { value: 'tests' as const, label: 'Tests' },
  ];

  // Only the total `time` is available on Response — we render a single TTFB
  // segment rather than invent DNS/TCP/TLS splits we don't have data for.
  const waterfallSegments = currentResponse
    ? [{ label: 'Wait', ms: currentResponse.time, color: '#4d9fff', emphasised: true }]
    : [];

  return (
    <TooltipProvider delayDuration={300}>
      <AnimatePresence mode="wait">
        {isLoading ? (
          <motion.div
            key="loading"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.1 }}
            className="h-full"
          >
            <ResponseSkeleton />
          </motion.div>
        ) : !currentResponse ? (
          <motion.div
            key="empty"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="h-full"
          >
            <Floater
              radius="panel"
              elevation="float-lg"
              className="h-full flex flex-col items-center justify-center gap-4 text-sp-dim relative z-20"
            >
              <div className="flex flex-col items-center gap-3 px-8 py-6 rounded-sp-panel sp-inset">
                <Zap className="h-6 w-6 text-sp-accent opacity-60" />
                <div className="text-center space-y-1">
                  <p className="text-sp-12 font-mono text-sp-muted">Send a request to see the response</p>
                  <div className="flex items-center justify-center gap-1">
                    <Kbd size="xs">⌘</Kbd>
                    <Kbd size="xs">↵</Kbd>
                  </div>
                </div>
              </div>
            </Floater>
          </motion.div>
        ) : (
          <motion.div
            key={`response-${currentResponse.timestamp}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="h-full"
          >
            <Floater
              radius="panel"
              elevation="float-lg"
              className="h-full flex flex-col overflow-hidden relative z-20"
            >
              {/* Status row padding 12×16 / hairline bottom per handoff §5 */}
              <div className="flex items-center gap-3 px-4 py-3 border-b border-sp-line">
                <StatusPill status={currentResponse.status} text={currentResponse.statusText} />
                <Stat label="Time" value={formatTime(currentResponse.time)} />
                <Stat label="Size" value={formatBytes(currentResponse.size)} />
                <Stat label="HTTP" value={alpnLabel(currentResponse.negotiatedAlpn)} />

                <div className="flex-1" />

                <div className="flex flex-col items-end gap-1">
                  <span className="sp-label">Waterfall</span>
                  <WaterfallBar segments={waterfallSegments} width={220} height={8} />
                </div>

                <LayoutToggleButton />
              </div>

              <SubTabBar
                tabs={tabs}
                value={activeTab}
                onChange={setActiveTab}
                right={
                  activeTab === 'body' ? (
                    <div className="flex items-center gap-2">
                      <Segmented
                        size="sm"
                        value={bodyFormat}
                        onChange={setBodyFormat}
                        options={[
                          { value: 'pretty', label: 'Pretty' },
                          { value: 'raw', label: 'Raw' },
                          ...(language === 'html' ? [{ value: 'preview' as const, label: 'Preview' }] : []),
                        ]}
                        ariaLabel="Response body format"
                      />
                      <IconButton
                        icon={<Search className="h-3.5 w-3.5" />}
                        label="Find in response (Ctrl+F)"
                        onClick={() => responseEditorRef.current?.getAction('actions.find')?.run()}
                      />
                      <IconButton
                        icon={copiedBody ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                        label={copiedBody ? 'Copied!' : 'Copy response body'}
                        onClick={handleCopyBody}
                      />
                      <IconButton
                        icon={<Download className="h-3.5 w-3.5" />}
                        label="Download response"
                        onClick={handleDownloadBody}
                      />
                    </div>
                  ) : undefined
                }
              />

              <div className="flex-1 min-h-0 overflow-hidden">
                {activeTab === 'body' && (
                  <div className="relative h-full" style={{ background: 'var(--sp-code)' }}>
                    {formattedBody ? (
                      <CodeEditor
                        value={formattedBody}
                        language={language}
                        readOnly
                        height="100%"
                        showCopyButton={false}
                        onEditorMount={(editor) => { responseEditorRef.current = editor; }}
                        path={activeTabId ? `tab-${activeTabId}-response` : undefined}
                      />
                    ) : (
                      <div className="flex flex-col items-center justify-center h-full gap-3 text-sp-dim">
                        <p className="text-sp-12 font-mono">No body content returned</p>
                      </div>
                    )}
                  </div>
                )}

                {activeTab === 'preview' && (
                  <iframe
                    srcDoc={currentResponse.body}
                    sandbox="allow-scripts allow-same-origin"
                    className="w-full h-full bg-white border-0"
                    title="HTML Preview"
                  />
                )}

                {activeTab === 'headers' && (
                  <div className="h-full overflow-auto">
                    {headerEntries.length > 8 && (
                      <div className="sticky top-0 z-10 px-4 pt-3 pb-2 bg-sp-surface border-b border-sp-line">
                        <input
                          value={headerFilter}
                          onChange={(e) => setHeaderFilter(e.target.value)}
                          placeholder={`Filter ${headerEntries.length} headers…`}
                          aria-label="Filter response headers"
                          className="w-full h-7 px-2 rounded-sp-btn bg-sp-surface-lo border border-sp-line text-sp-12 font-mono outline-none focus:border-sp-line-strong"
                        />
                      </div>
                    )}
                    <div className="px-3 py-1">
                      {filteredHeaderEntries.map(([key, value]) => (
                        <div
                          key={key}
                          className="group grid grid-cols-[200px_1fr_auto] gap-3 py-1.5 border-b border-sp-line items-start"
                        >
                          <span className="font-mono text-sp-12 text-sp-muted truncate">{key}</span>
                          <span className="font-mono text-sp-12 text-sp-text break-all">
                            {Array.isArray(value) ? value.join(', ') : value}
                          </span>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                type="button"
                                onClick={() => handleCopyHeader(key, value)}
                                aria-label={copiedHeader === key ? 'Copied!' : 'Copy header'}
                                className="size-5 inline-flex items-center justify-center text-sp-dim hover:text-sp-text opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity rounded-sp-chip hover:bg-sp-hover"
                              >
                                {copiedHeader === key ? (
                                  <Check className="h-3 w-3 text-emerald-400" />
                                ) : (
                                  <Copy className="h-3 w-3" />
                                )}
                              </button>
                            </TooltipTrigger>
                            <TooltipContent>{copiedHeader === key ? 'Copied!' : 'Copy header'}</TooltipContent>
                          </Tooltip>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {activeTab === 'cookies' && (
                  <div className="h-full overflow-auto">
                    {cookies.length === 0 ? (
                      <div className="flex items-center justify-center h-full">
                        <p className="text-sp-12 text-sp-dim font-mono">No cookies set by this response</p>
                      </div>
                    ) : (
                      <div className="px-3 py-2 space-y-1">
                        {cookies.map((c, i) => (
                          <div key={`${c.name}-${i}`} className="grid grid-cols-[160px_1fr] gap-3 py-1.5 border-b border-sp-line">
                            <span className="font-mono text-sp-12 text-sp-text truncate">{c.name}</span>
                            <div className="space-y-0.5">
                              <span className="font-mono text-sp-12 text-sp-muted break-all">{c.value}</span>
                              {c.attrs && (
                                <div className="text-sp-10-5 text-sp-dim font-mono">{c.attrs}</div>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {activeTab === 'timeline' && (
                  <div className="h-full overflow-auto px-4 py-3 space-y-4">
                    <div>
                      <div className="sp-label mb-2">Total</div>
                      <div className="flex items-center gap-3">
                        <WaterfallBar segments={waterfallSegments} width={320} height={10} />
                        <span className="font-mono text-sp-12 text-sp-text tabular-nums">
                          {formatTime(currentResponse.time)}
                        </span>
                      </div>
                    </div>
                    <div>
                      <div className="sp-label mb-2">Server-Timing</div>
                      {serverTiming.length === 0 ? (
                        <Floater radius="btn" elevation="inset" className="p-3">
                          <p className="text-sp-12 text-sp-dim font-mono">
                            No Server-Timing headers reported by upstream
                          </p>
                        </Floater>
                      ) : (
                        <Floater radius="btn" elevation="inset" className="p-3 space-y-2">
                          {serverTiming.map((t, i) => (
                            <div key={`${t.name}-${i}`} className="grid grid-cols-[140px_1fr_auto] gap-3 items-center">
                              <span className="font-mono text-sp-12 text-sp-text">{t.name}</span>
                              <span className="font-mono text-sp-11-5 text-sp-muted truncate">
                                {t.desc ?? ''}
                              </span>
                              <span className="font-mono text-sp-12 text-sp-muted tabular-nums">
                                {typeof t.dur === 'number' ? `${t.dur} ms` : '—'}
                              </span>
                            </div>
                          ))}
                        </Floater>
                      )}
                    </div>
                  </div>
                )}

                {activeTab === 'tests' && (
                  <div className="flex items-center justify-center h-full">
                    <p className="text-sp-12 text-sp-dim font-mono">No tests recorded for this response</p>
                  </div>
                )}
              </div>
            </Floater>
          </motion.div>
        )}
      </AnimatePresence>
    </TooltipProvider>
  );
}

export default withErrorBoundary(ResponseViewer);
