import { Braces, Check, Copy, Download, FileDown, Search, Zap } from 'lucide-react';
import type * as Monaco from 'monaco-editor';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { CompareWithPrevious } from '@/components/shared/CompareWithPrevious';
import { withErrorBoundary } from '@/components/shared/ErrorBoundary';
import { ImagePreview } from '@/components/shared/ImagePreview';
import { InFlightBar } from '@/components/shared/InFlightBar';
import { ResponseEmptyState } from '@/components/shared/ResponseEmptyState';
import { ResponseHeadersPanel } from '@/components/shared/ResponseHeadersPanel';
import { ResponseStatus } from '@/components/shared/ResponseStatus';
import { ResponseTestsPanel } from '@/components/shared/ResponseTestsPanel';
import { IconButton, LayoutToggleButton } from '@/components/shared/ResponseToolbarButtons';
import { StreamingResponseViewer } from '@/components/shared/StreamingResponseViewer';
import { VisualizerFrame } from '@/components/shared/VisualizerFrame';
import { AnimatePresence, motion, Scale, Stagger, StaggerItem } from '@/components/ui/motion';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Floater,
  Kbd,
  Segmented,
  Stat,
  type SubTab,
  SubTabBar,
  SubTabPanel,
  WaterfallBar,
} from '@/components/ui/spatial';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AiActionsMenu } from '@/features/ai/components/AiActionsMenu';
import { classifyRequestError } from '@/features/http/lib/classifyRequestError';
import { base64ToBytes } from '@/lib/shared/binaryBody';
import { detectLanguage } from '@/lib/shared/console-format';
import { isCsvResponse } from '@/lib/shared/csvParser';
import { lazyComponent } from '@/lib/shared/lazyComponent';
import { isElectron, isMac } from '@/lib/shared/platform';
import { downloadExtension, downloadFileName, downloadMime } from '@/lib/shared/responseFiles';
import { formatBytes, formatTime } from '@/lib/shared/utils';
import { useActiveResponse, useActiveStreamingEvents, useActiveTab } from '@/store/selectors';
import { useRequestStore } from '@/store/useRequestStore';
import { buildResponsePreviewDocument } from './lib/responsePreview';
import { LargeBodyNotice, RequestErrorCard } from './ResponseNotices';

// Bodies above this size skip pretty-print to avoid freezing the main thread; raw text still renders fine through Monaco.
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

// CSV (papaparse) and JSONPath (jsonpath-plus) only load when actually used.
const JsonTree = lazyComponent(
  () => import('@/components/shared/JsonTree'),
  <div className="p-4">
    <Skeleton className="h-4 w-1/2 rounded" />
  </div>
);
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

const formatJson = (body: string, force = false): string => {
  if (!force && body.length > PRETTY_PRINT_MAX_BYTES) return body;
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
type BodyFormat = 'pretty' | 'raw' | 'table' | 'tree';

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
  const testResults = activeTab_?.scriptResult?.test?.tests ?? [];
  const isLoading = useRequestStore((state) => state.isLoading);
  const [activeTab, setActiveTab] = useState<ResponseTab>('body');
  const [bodyFormat, setBodyFormat] = useState<BodyFormat>('pretty');
  const [showJsonPath, setShowJsonPath] = useState(false);
  // Opt-in to pretty-printing a body above PRETTY_PRINT_MAX_BYTES (per response).
  const [forceFormat, setForceFormat] = useState(false);
  const [copiedBody, setCopiedBody] = useState(false);
  const copyBodyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const responseEditorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);

  useEffect(() => {
    return () => {
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

  // Transport-level failures (status 0 / proxy-generated) get a summary + next
  // step instead of the raw message dumped into the body editor.
  const errorInfo = useMemo(
    () => (currentResponse ? classifyRequestError(currentResponse, isElectron()) : null),
    [currentResponse]
  );

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
    setForceFormat(false);
  }, [currentResponse?.id]);

  // Pretty-printing a large JSON body can stall the main thread, so only
  // compute it when the body/preview tab is actually visible.
  const formattedBody = useMemo(() => {
    if (!currentResponse) return '';
    const showsBody = activeTab === 'body' || activeTab === 'preview';
    if (!showsBody) return '';
    // Binary (base64) and table views render their own components, not Monaco.
    if (isBase64 || bodyFormat === 'table' || bodyFormat === 'tree') return '';
    if (bodyFormat === 'raw') return currentResponse.body;
    if (language === 'json') return formatJson(currentResponse.body, forceFormat);
    return currentResponse.body;
  }, [currentResponse, language, bodyFormat, activeTab, isBase64, forceFormat]);

  // The tree view parses the body, so it's offered under the same size cap as
  // pretty-printing, and parsed only while it's selected.
  const canShowTree =
    language === 'json' &&
    !isBase64 &&
    (currentResponse?.body.length ?? 0) <= PRETTY_PRINT_MAX_BYTES;
  const treeValue = useMemo(() => {
    if (bodyFormat !== 'tree' || !currentResponse) return undefined;
    try {
      return { value: JSON.parse(currentResponse.body) as unknown };
    } catch {
      return null;
    }
  }, [bodyFormat, currentResponse]);

  // Pretty view of an oversized JSON body is shown unformatted — say so.
  const formattingSkipped =
    language === 'json' &&
    bodyFormat === 'pretty' &&
    !isBase64 &&
    !forceFormat &&
    (currentResponse?.body.length ?? 0) > PRETTY_PRINT_MAX_BYTES;

  const headerEntries = useMemo(
    () => Object.entries(currentResponse?.headers ?? {}),
    [currentResponse?.headers]
  );

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
    // Base64 bodies are rebuilt from the original bytes for a faithful file.
    const content = isBase64
      ? (base64ToBytes(currentResponse.body) as BlobPart)
      : currentResponse.body;
    const blob = new Blob([content], { type: downloadMime(contentType, isBase64) });
    const ext = downloadExtension(contentType, { isBase64, language, isCsv });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = downloadFileName(activeTab_?.request.name, ext);
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
    {
      value: 'tests' as const,
      label: 'Tests',
      ...(testResults.length > 0 && {
        badge: `${testResults.filter((t) => t.passed).length}/${testResults.length}`,
      }),
    },
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
            className="h-full flex flex-col"
          >
            <InFlightBar />
            <div className="flex-1 min-h-0">
              <ResponseSkeleton />
            </div>
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
            <ResponseEmptyState
              icon={<Zap className="h-4 w-4 text-sp-muted" />}
              message="Send a request to see the response"
              hint={
                <div className="flex items-center justify-center gap-1.5 text-sp-11 text-sp-dim">
                  <Kbd size="sm">{isMac() ? '⌘' : 'Ctrl'}</Kbd>
                  <Kbd size="sm">↵</Kbd>
                  <span className="font-mono">to send</span>
                </div>
              }
            />
          </motion.div>
        ) : (
          <motion.div
            key={`response-${currentResponse.id}`}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.2, 0.7, 0.1, 1] }}
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
                {/* One-shot arrival cue — replays because the keyed motion.div
                    above remounts the pill for each new response id. */}
                <ResponseStatus
                  status={currentResponse.status}
                  statusText={currentResponse.statusText}
                />
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
                            ...(canShowTree ? [{ value: 'tree' as const, label: 'Tree' }] : []),
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
                      {!isBase64 &&
                        bodyFormat !== 'table' &&
                        bodyFormat !== 'tree' &&
                        !showJsonPath && (
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
                      {activeTab_ && (
                        <CompareWithPrevious
                          request={activeTab_.request}
                          response={currentResponse}
                        />
                      )}
                    </div>
                  ) : undefined
                }
              />

              <div className="flex-1 min-h-0 overflow-hidden">
                <SubTabPanel tabKey={activeTab} className="h-full">
                  {activeTab === 'body' && (
                    <div className="relative h-full" style={{ background: 'var(--sp-code)' }}>
                      {errorInfo ? (
                        <RequestErrorCard info={errorInfo} url={activeTab_?.request.url ?? ''} />
                      ) : isImage ? (
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
                      ) : bodyFormat === 'tree' ? (
                        treeValue ? (
                          <JsonTree value={treeValue.value} />
                        ) : (
                          <p className="p-4 text-sp-12 text-sp-dim">
                            This body isn’t valid JSON, so it can’t be shown as a tree.
                          </p>
                        )
                      ) : bodyFormat === 'table' ? (
                        <CsvTableViewer body={currentResponse.body} />
                      ) : formattedBody ? (
                        <div className="flex h-full flex-col">
                          {formattingSkipped && (
                            <LargeBodyNotice
                              size={currentResponse.size}
                              onFormat={() => setForceFormat(true)}
                            />
                          )}
                          <div className="relative min-h-0 flex-1">
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
                          </div>
                        </div>
                      ) : (
                        <div className="flex flex-col items-center justify-center h-full gap-3 text-sp-dim">
                          <p className="text-sp-12 font-mono">No body content returned</p>
                        </div>
                      )}
                    </div>
                  )}

                  {activeTab === 'preview' && (
                    <iframe
                      srcDoc={buildResponsePreviewDocument(currentResponse.body)}
                      // The preview renders an UNTRUSTED upstream response body.
                      // An empty sandbox allowlist disables active content and
                      // navigation; the srcDoc CSP separately denies all network
                      // access while retaining inline styles and data: images for
                      // local-only presentation.
                      sandbox=""
                      className="w-full h-full bg-white border-0"
                      title="HTML Preview"
                    />
                  )}

                  {activeTab === 'headers' && <ResponseHeadersPanel entries={headerEntries} />}

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
                    <ResponseTestsPanel result={activeTab_?.scriptResult?.test} />
                  )}

                  {activeTab === 'visualize' && visualization && (
                    <VisualizerFrame
                      template={visualization.template}
                      data={visualization.data}
                      className="h-full"
                    />
                  )}
                </SubTabPanel>
              </div>
            </Floater>
          </motion.div>
        )}
      </AnimatePresence>
    </TooltipProvider>
  );
}

export default withErrorBoundary(ResponseViewer);
