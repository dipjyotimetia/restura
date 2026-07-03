import { Copy, Check, Zap, Rows, Columns, Search, Download, Braces, FileDown } from 'lucide-react';
import type * as Monaco from 'monaco-editor';
import { useState, useMemo, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { withErrorBoundary } from '@/components/shared/ErrorBoundary';
import { ImagePreview } from '@/components/shared/ImagePreview';
import { StreamingResponseViewer } from '@/components/shared/StreamingResponseViewer';
import { VisualizerFrame } from '@/components/shared/VisualizerFrame';
import { Scale, Stagger, StaggerItem, AnimatePresence, motion } from '@/components/ui/motion';
import { Skeleton } from '@/components/ui/skeleton';
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { AiActionsMenu } from '@/features/ai/components/AiActionsMenu';
import { base64ToBytes, extensionForContentType } from '@/lib/shared/binaryBody';
import { detectLanguage } from '@/lib/shared/console-format';
import { PRETTY_PRINT_MAX_BYTES } from '@/lib/shared/constants';
import { isCsvResponse } from '@/lib/shared/csvParser';
import { lazyComponent } from '@/lib/shared/lazyComponent';
import { cn, formatBytes, formatTime } from '@/lib/shared/utils';
import { useActiveResponse, useActiveStreamingEvents, useActiveTab } from '@/store/selectors';
import { useRequestStore } from '@/store/useRequestStore';
import { useSettingsStore } from '@/store/useSettingsStore';

const CodeEditor = lazyComponent(
  () => import('@/components/shared/CodeEditor'),
  <div className="absolute inset-0 p-4 space-y-2">
    <Skeleton className="h-3.5 w-3/4 rounded" />
    <Skeleton className="h-3.5 w-1/2 rounded" />
    <Skeleton className="h-3.5 w-2/3 rounded" />
    <Skeleton className="h-3.5 w-4/5 rounded" />
  </div>
);

// CSV (papaparse) and JSONPath (jsonpath-plus) only load when actually used.
const CsvTableViewer = lazyComponent(
  () => import('@/components/shared/CsvTableViewer'),
  <div className="p-4">
    <Skeleton className="h-4 w-1/2 rounded" />
  </div>
);
const JsonPathQuery = lazyComponent(
  () => import('@/components/shared/JsonPathQuery'),
  <div className="p-4">
    <Skeleton className="h-4 w-1/2 rounded" />
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
            <StaggerItem>
              <Skeleton className="h-3.5 w-12 rounded" />
            </StaggerItem>
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
            <StaggerItem>
              <Skeleton className="h-3.5 w-8 rounded" />
            </StaggerItem>
          </Stagger>
        </div>
      </Floater>
    </Scale>
  );
}

type ResponseTab = 'body' | 'headers' | 'cookies' | 'timeline' | 'tests' | 'preview' | 'visualize';
type BodyFormat = 'pretty' | 'raw' | 'preview' | 'table';

function IconButton({
  icon,
  label,
  onClick,
  active,
}: {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  active?: boolean;
}) {
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
      onClick={() => updateSettings({ layoutOrientation: vertical ? 'horizontal' : 'vertical' })}
    />
  );
}

function ResponseViewer() {
  const currentResponse = useActiveResponse();
  const streamingEvents = useActiveStreamingEvents();
  const activeTab_ = useActiveTab();
  const activeTabId = activeTab_?.id;
  // pm.visualizer.set captures into ScriptResult.visualization. We check
  // either script phase; the test phase wins (last writer) if both fired.
  const visualization =
    activeTab_?.scriptResult?.test?.visualization ??
    activeTab_?.scriptResult?.preRequest?.visualization;
  const isLoading = useRequestStore((state) => state.isLoading);
  const [activeTab, setActiveTab] = useState<ResponseTab>('body');
  const [bodyFormat, setBodyFormat] = useState<BodyFormat>('pretty');
  const [showJsonPath, setShowJsonPath] = useState(false);
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
    () =>
      currentResponse ? detectLanguage(currentResponse.body, currentResponse.headers) : 'json',
    [currentResponse]
  );

  const contentType = useMemo(() => {
    const raw =
      currentResponse?.headers['content-type'] ?? currentResponse?.headers['Content-Type'] ?? '';
    return (Array.isArray(raw) ? raw[0] : raw) ?? '';
  }, [currentResponse?.headers]);

  // Binary bodies arrive base64-encoded (Response.bodyEncoding); image/* gets a
  // visual preview, other binary gets a download affordance. CSV is text, so it
  // only applies when the body wasn't base64-encoded.
  const isBase64 = currentResponse?.bodyEncoding === 'base64';
  const isImage = Boolean(isBase64 && /^image\//i.test(contentType));
  // Memoized: CSV sniffing splits the whole body, so don't redo it on every
  // unrelated re-render (header-filter typing, copy toasts, tab switches).
  const isCsv = useMemo(
    () => Boolean(currentResponse && !isBase64 && isCsvResponse(contentType, currentResponse.body)),
    [currentResponse, isBase64, contentType]
  );

  // Reset the body view to a sensible default whenever the response changes:
  // CSV → table, everything else → pretty. Also drop any open JSONPath overlay.
  // Keyed on the response id (unique) — timestamps can collide within a ms.
  useEffect(() => {
    setBodyFormat(isCsv ? 'table' : 'pretty');
    setShowJsonPath(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentResponse?.id]);

  // Pretty-printing a large JSON body can stall the main thread, so only
  // compute it when the body/preview tab is actually visible.
  const formattedBody = useMemo(() => {
    if (!currentResponse) return '';
    const showsBody = activeTab === 'body' || activeTab === 'preview';
    if (!showsBody) return '';
    // Binary (base64) and table views render their own components, not Monaco.
    if (isBase64 || bodyFormat === 'table') return '';
    if (bodyFormat === 'raw') return currentResponse.body;
    if (language === 'json') return formatJson(currentResponse.body);
    return currentResponse.body;
  }, [currentResponse, language, bodyFormat, activeTab, isBase64]);

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
    const raw =
      currentResponse.headers['server-timing'] ?? currentResponse.headers['Server-Timing'];
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
          const v = seg
            .slice(eq + 1)
            .trim()
            .replace(/^"|"$/g, '');
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
    let blob: Blob;
    let ext: string;
    if (isBase64) {
      // Reconstruct the original bytes from the base64 body for a faithful download.
      const bytes = base64ToBytes(currentResponse.body);
      blob = new Blob([bytes as BlobPart], { type: contentType || 'application/octet-stream' });
      ext = extensionForContentType(contentType);
    } else {
      blob = new Blob([currentResponse.body], { type: 'application/octet-stream' });
      ext = language === 'json' ? 'json' : isCsv ? 'csv' : 'txt';
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `response-${activeTabId ?? 'body'}.${ext}`;
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
    {
      value: 'body' as const,
      label: 'Body',
      ...(language !== 'text' && { badge: language.toUpperCase() }),
    },
    { value: 'headers' as const, label: 'Headers', count: headerEntries.length },
    { value: 'cookies' as const, label: 'Cookies', count: cookies.length },
    { value: 'timeline' as const, label: 'Timeline' },
    { value: 'tests' as const, label: 'Tests' },
    // Visualize tab — only present when the test script called
    // pm.visualizer.set. Postman's behaviour: the tab disappears on the
    // next request that doesn't visualize, which falls out of this
    // conditional naturally.
    ...(visualization
      ? [{ value: 'visualize' as const, label: 'Visualize' } satisfies SubTab<ResponseTab>]
      : []),
  ];

  // Only the total `time` is available on Response — we render a single "Wait"
  // segment rather than invent DNS/TCP/TLS splits we don't have data for.
  const waterfallSegments = currentResponse
    ? [
        {
          label: 'Wait',
          ms: currentResponse.time,
          color: 'var(--color-proto-http)',
          emphasised: true,
        },
      ]
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
              className="h-full flex flex-col items-center justify-center text-sp-dim relative z-20"
            >
              <div className="flex flex-col items-center gap-2.5">
                <Zap className="h-4 w-4 text-sp-dim" />
                <p className="text-sp-12 text-sp-muted">Send a request to see the response</p>
                <div className="flex items-center justify-center gap-1.5 text-sp-11 text-sp-dim">
                  <Kbd size="sm">⌘</Kbd>
                  <Kbd size="sm">↵</Kbd>
                  <span className="font-mono">to send</span>
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
              className="@container h-full flex flex-col overflow-hidden relative z-20"
            >
              {/* Status row padding 12×16 / hairline bottom per handoff §5.
                  Container-query responsive: the waterfall + the HTTP stat drop
                  out as the PANEL (not the viewport) gets narrow, so the row
                  stays clean at any split width or in stacked layout. */}
              <div className="flex items-center gap-3 px-4 py-3 border-b border-sp-line">
                <StatusPill status={currentResponse.status} text={currentResponse.statusText} />
                <Stat label="Time" value={formatTime(currentResponse.time)} />
                <Stat label="Size" value={formatBytes(currentResponse.size)} />
                {currentResponse.negotiatedAlpn && (
                  <Stat label="HTTP" value={alpnLabel(currentResponse.negotiatedAlpn)} />
                )}

                <div className="flex-1" />

                <div className="hidden @md:flex flex-col items-end gap-1">
                  <span className="sp-label">Waterfall</span>
                  <WaterfallBar segments={waterfallSegments} width={220} height={8} />
                </div>

                <AiActionsMenu />
                <LayoutToggleButton />
              </div>

              <SubTabBar
                tabs={tabs}
                value={activeTab}
                onChange={setActiveTab}
                right={
                  activeTab === 'body' ? (
                    <div className="flex items-center gap-2">
                      {!isBase64 && (
                        <Segmented
                          size="sm"
                          value={bodyFormat}
                          onChange={setBodyFormat}
                          options={[
                            { value: 'pretty', label: 'Pretty' },
                            { value: 'raw', label: 'Raw' },
                            ...(language === 'html'
                              ? [{ value: 'preview' as const, label: 'Preview' }]
                              : []),
                            ...(isCsv ? [{ value: 'table' as const, label: 'Table' }] : []),
                          ]}
                          ariaLabel="Response body format"
                        />
                      )}
                      {!isBase64 && language === 'json' && (
                        <IconButton
                          icon={<Braces className="h-3.5 w-3.5" />}
                          label="Query with JSONPath"
                          active={showJsonPath}
                          onClick={() => setShowJsonPath((v) => !v)}
                        />
                      )}
                      {!isBase64 && bodyFormat !== 'table' && !showJsonPath && (
                        <IconButton
                          icon={<Search className="h-3.5 w-3.5" />}
                          label="Find in response (Ctrl+F)"
                          onClick={() =>
                            responseEditorRef.current?.getAction('actions.find')?.run()
                          }
                        />
                      )}
                      {!isBase64 && (
                        <IconButton
                          icon={
                            copiedBody ? (
                              <Check className="h-3.5 w-3.5 text-emerald-400" />
                            ) : (
                              <Copy className="h-3.5 w-3.5" />
                            )
                          }
                          label={copiedBody ? 'Copied!' : 'Copy response body'}
                          onClick={handleCopyBody}
                        />
                      )}
                      <IconButton
                        icon={
                          isBase64 ? (
                            <FileDown className="h-3.5 w-3.5" />
                          ) : (
                            <Download className="h-3.5 w-3.5" />
                          )
                        }
                        label={isBase64 ? 'Download file' : 'Download response'}
                        onClick={handleDownloadBody}
                      />
                    </div>
                  ) : undefined
                }
              />

              <div className="flex-1 min-h-0 overflow-hidden">
                {activeTab === 'body' && (
                  <div className="relative h-full" style={{ background: 'var(--sp-code)' }}>
                    {isImage ? (
                      <ImagePreview
                        base64={currentResponse.body}
                        contentType={contentType}
                        size={currentResponse.size}
                      />
                    ) : isBase64 ? (
                      <div className="flex flex-col items-center justify-center h-full gap-3 text-sp-dim">
                        <FileDown className="h-7 w-7 opacity-60" />
                        <p className="text-sp-12 font-mono text-center">
                          Binary response · {contentType || 'unknown type'}
                          <br />
                          {formatBytes(currentResponse.size)}
                        </p>
                        <button
                          type="button"
                          onClick={handleDownloadBody}
                          className="px-3 py-1.5 rounded-sp-btn bg-sp-surface-lo border border-sp-line text-sp-12 font-mono text-sp-text hover:bg-sp-hover transition-colors"
                        >
                          Download file
                        </button>
                      </div>
                    ) : showJsonPath ? (
                      <JsonPathQuery
                        body={currentResponse.body}
                        onClose={() => setShowJsonPath(false)}
                      />
                    ) : bodyFormat === 'table' ? (
                      <CsvTableViewer body={currentResponse.body} />
                    ) : formattedBody ? (
                      <CodeEditor
                        value={formattedBody}
                        language={language}
                        readOnly
                        height="100%"
                        showCopyButton={false}
                        onEditorMount={(editor) => {
                          responseEditorRef.current = editor;
                        }}
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
                    // The preview renders an UNTRUSTED upstream response body.
                    // `allow-scripts` ONLY — combining it with `allow-same-origin`
                    // defeats the sandbox (scripts would run in the renderer's
                    // origin, reaching its cookies/storage and the same-origin
                    // /api proxy). Same load-bearing boundary as VisualizerFrame.
                    sandbox="allow-scripts"
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
                            <TooltipContent>
                              {copiedHeader === key ? 'Copied!' : 'Copy header'}
                            </TooltipContent>
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
                        <p className="text-sp-12 text-sp-dim font-mono">
                          No cookies set by this response
                        </p>
                      </div>
                    ) : (
                      <div className="px-3 py-2 space-y-1">
                        {cookies.map((c, i) => (
                          <div
                            key={`${c.name}-${i}`}
                            className="grid grid-cols-[160px_1fr] gap-3 py-1.5 border-b border-sp-line"
                          >
                            <span className="font-mono text-sp-12 text-sp-text truncate">
                              {c.name}
                            </span>
                            <div className="space-y-0.5">
                              <span className="font-mono text-sp-12 text-sp-muted break-all">
                                {c.value}
                              </span>
                              {c.attrs && (
                                <div className="text-sp-11 text-sp-dim font-mono">{c.attrs}</div>
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
                            <div
                              key={`${t.name}-${i}`}
                              className="grid grid-cols-[140px_1fr_auto] gap-3 items-center"
                            >
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
                    <p className="text-sp-12 text-sp-dim font-mono">
                      No tests recorded for this response
                    </p>
                  </div>
                )}

                {activeTab === 'visualize' && visualization && (
                  <VisualizerFrame
                    template={visualization.template}
                    data={visualization.data}
                    className="h-full"
                  />
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
