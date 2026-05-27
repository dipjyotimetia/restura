'use client';

import { useState, useMemo } from 'react';
import { lazyComponent } from '@/lib/shared/lazyComponent';
import {
  entryToCurl,
  entryToHttpRequest,
  useConsoleStore,
  type ConsoleProtocol,
  type ConsoleStatusFilter,
} from '@/store/useConsoleStore';
import { useRequestStore } from '@/store/useRequestStore';
import { useActiveTab } from '@/store/selectors';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Network,
  FileText,
  Clock,
  Database,
  Copy,
  Check,
  Search,
  X,
  RotateCw,
  ExternalLink,
  GitCompare,
  SlidersHorizontal,
  ListChecks,
} from 'lucide-react';
import { toast } from 'sonner';
import RequestEntryItem from './RequestEntryItem';
import EntryCompareDialog from './EntryCompareDialog';
import { cn } from '@/lib/shared/utils';
import {
  detectLanguage,
  formatBytes,
  formatClockTime,
  getStatusBadgeColor,
} from '@/lib/shared/console-format';

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

const STATUS_FILTERS: Array<{ value: ConsoleStatusFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: '2xx', label: '2xx' },
  { value: '3xx', label: '3xx' },
  { value: '4xx', label: '4xx' },
  { value: '5xx', label: '5xx' },
  { value: 'errored', label: 'Errored' },
];

// Only protocols that *can* appear in the network entry list today. Frame-only
// protocols (websocket/kafka/socketio) land in the Frames tab (Phase B-1).
const PROTOCOL_FILTERS: Array<{ value: ConsoleProtocol | 'all'; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'http', label: 'HTTP' },
  { value: 'grpc', label: 'gRPC' },
  { value: 'graphql', label: 'GraphQL' },
  { value: 'mcp', label: 'MCP' },
  { value: 'sse', label: 'SSE' },
];

const SORT_OPTIONS: Array<{ value: 'recent' | 'time' | 'size' | 'status'; label: string }> = [
  { value: 'recent', label: 'Recent' },
  { value: 'time', label: 'Time' },
  { value: 'size', label: 'Size' },
  { value: 'status', label: 'Status' },
];

function statusMatches(status: number, filter: ConsoleStatusFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'errored') return status === 0 || status >= 500;
  if (filter === '2xx') return status >= 200 && status < 300;
  if (filter === '3xx') return status >= 300 && status < 400;
  if (filter === '4xx') return status >= 400 && status < 500;
  if (filter === '5xx') return status >= 500 && status < 600;
  return true;
}

export default function NetworkTab() {
  const {
    entries,
    selectedEntryId,
    selectEntry,
    searchFilter,
    setSearchFilter,
    statusFilter,
    setStatusFilter,
    protocolFilter,
    setProtocolFilter,
  } = useConsoleStore();
  const openTab = useRequestStore((s) => s.openTab);
  const updateRequest = useRequestStore((s) => s.updateRequest);
  const activeTab = useActiveTab();

  // Compare-set is local-only — transient UI state, no need to persist.
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [compareDialogOpen, setCompareDialogOpen] = useState(false);
  // Sort + run filter are transient view state.
  const [sortBy, setSortBy] = useState<'recent' | 'time' | 'size' | 'status'>('recent');
  const [runFilter, setRunFilter] = useState<string>('all');

  const toggleCompare = (id: string) => {
    setCompareIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      // Cap at 2 — selecting a third bumps the oldest.
      if (prev.length >= 2) return [prev[1]!, id];
      return [...prev, id];
    });
  };

  const compareEntries = useMemo(
    () =>
      compareIds
        .map((id) => entries.find((e) => e.id === id))
        .filter((e): e is NonNullable<typeof e> => Boolean(e)),
    [compareIds, entries]
  );

  // Distinct runs present in the entry list — drives the run-filter chips.
  const runs = useMemo(() => {
    const seen = new Map<string, string>();
    for (const e of entries) {
      if (e.runId && !seen.has(e.runId)) seen.set(e.runId, e.runLabel ?? 'Run');
    }
    return [...seen.entries()].map(([id, label]) => ({ id, label }));
  }, [entries]);

  // Distinct protocols present — the protocol filter only earns its space when
  // the log actually mixes protocols.
  const protocolsPresent = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) set.add(e.protocol ?? 'http');
    return set;
  }, [entries]);

  const filteredEntries = useMemo(() => {
    const search = searchFilter.trim().toLowerCase();
    const matchesSearch = (entry: (typeof entries)[number]) => {
      if (!search) return true;
      // Content search spans method/url/status AND headers + bodies.
      if (
        entry.request.url.toLowerCase().includes(search) ||
        entry.request.method.toLowerCase().includes(search) ||
        entry.response.status.toString().includes(search) ||
        entry.response.statusText.toLowerCase().includes(search) ||
        (entry.request.body?.toLowerCase().includes(search) ?? false) ||
        entry.response.body.toLowerCase().includes(search)
      ) {
        return true;
      }
      const headerHit = (h: Record<string, string | string[]>) =>
        Object.entries(h).some(
          ([k, v]) =>
            k.toLowerCase().includes(search) ||
            (Array.isArray(v) ? v.join(',') : v).toLowerCase().includes(search)
        );
      return headerHit(entry.request.headers) || headerHit(entry.response.headers);
    };

    const list = entries.filter((entry) => {
      if (!statusMatches(entry.response.status, statusFilter)) return false;
      if (protocolFilter !== 'all' && (entry.protocol ?? 'http') !== protocolFilter) return false;
      if (runFilter !== 'all' && entry.runId !== runFilter) return false;
      return matchesSearch(entry);
    });

    if (sortBy === 'recent') return list;
    const sorted = [...list];
    sorted.sort((a, b) => {
      if (sortBy === 'time') return b.response.time - a.response.time;
      if (sortBy === 'size') return b.response.size - a.response.size;
      return b.response.status - a.response.status; // 'status'
    });
    return sorted;
  }, [entries, searchFilter, statusFilter, protocolFilter, runFilter, sortBy]);

  // Slowest response in the current view — scales every row's waterfall bar.
  const maxTime = useMemo(
    () => filteredEntries.reduce((m, e) => Math.max(m, e.response.time), 0),
    [filteredEntries]
  );

  const selectedEntry = entries.find((e) => e.id === selectedEntryId);

  const handleReplay = () => {
    if (!selectedEntry) return;
    if (activeTab?.request.type !== 'http') {
      const req = entryToHttpRequest(selectedEntry);
      openTab(req, { switchTo: true });
      toast.success('Opened in a new tab');
      return;
    }
    const req = entryToHttpRequest(selectedEntry);
    updateRequest({
      method: req.method,
      url: req.url,
      headers: req.headers,
      params: req.params,
      body: req.body,
      auth: req.auth,
    });
    toast.success('Replayed in active tab');
  };

  const handleOpenInNewTab = () => {
    if (!selectedEntry) return;
    const req = entryToHttpRequest(selectedEntry);
    openTab(req, { switchTo: true });
    toast.success('Opened in a new tab');
  };

  const handleCopyCurl = async () => {
    if (!selectedEntry) return;
    try {
      await navigator.clipboard.writeText(entryToCurl(selectedEntry));
      toast.success('Copied as cURL');
    } catch {
      toast.error('Failed to copy');
    }
  };

  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground py-8">
        <Network className="h-10 w-10 mb-3 opacity-30" />
        <p className="font-medium text-sm">No requests yet</p>
        <p className="text-xs mt-1">Send a request to see it here</p>
      </div>
    );
  }

  const filtersActive =
    statusFilter !== 'all' ||
    protocolFilter !== 'all' ||
    runFilter !== 'all' ||
    searchFilter.trim().length > 0;

  return (
    <div className="flex h-full">
      {/* Entry list */}
      <div className="w-[280px] border-r border-border flex-shrink-0 flex flex-col">
        {/* Search input */}
        <div className="p-2 border-b border-border space-y-2">
          {/* Search + sort/protocol menu */}
          <div className="flex items-center gap-1">
            <div className="relative flex-1">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
              <Input
                placeholder="Filter requests..."
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
                className="h-7 pl-7 pr-7 text-xs"
              />
              {searchFilter && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute right-0.5 top-1/2 -translate-y-1/2 h-6 w-6"
                  onClick={() => setSearchFilter('')}
                >
                  <X className="h-3 w-3" />
                </Button>
              )}
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0"
                  aria-label="Sort and protocol filters"
                  title="Sort & filter"
                >
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuLabel className="text-[11px]">Sort by</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={sortBy}
                  onValueChange={(v) => setSortBy(v as typeof sortBy)}
                >
                  {SORT_OPTIONS.map((s) => (
                    <DropdownMenuRadioItem key={s.value} value={s.value} className="text-xs">
                      {s.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
                {protocolsPresent.size > 1 && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel className="text-[11px]">Protocol</DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                      value={protocolFilter}
                      onValueChange={(v) => setProtocolFilter(v as ConsoleProtocol | 'all')}
                    >
                      {PROTOCOL_FILTERS.map((f) => (
                        <DropdownMenuRadioItem key={f.value} value={f.value} className="text-xs">
                          {f.label}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {/* Status filters */}
          <div className="flex flex-wrap gap-1">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                onClick={() => setStatusFilter(f.value)}
                className={cn(
                  'text-[10px] font-mono px-1.5 py-0.5 rounded border transition-colors',
                  statusFilter === f.value
                    ? 'bg-primary/15 border-primary/40 text-primary'
                    : 'bg-muted/30 border-transparent text-muted-foreground hover:bg-muted/60'
                )}
                aria-pressed={statusFilter === f.value}
              >
                {f.label}
              </button>
            ))}
          </div>
          {/* Run filter — only when runner-tagged entries exist */}
          {runs.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <ListChecks className="h-3 w-3 text-muted-foreground" />
              <button
                type="button"
                onClick={() => setRunFilter('all')}
                className={cn(
                  'text-[10px] font-mono px-1.5 py-0.5 rounded border transition-colors',
                  runFilter === 'all'
                    ? 'bg-primary/15 border-primary/40 text-primary'
                    : 'bg-muted/30 border-transparent text-muted-foreground hover:bg-muted/60'
                )}
              >
                All
              </button>
              {runs.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setRunFilter(r.id)}
                  title={r.label}
                  className={cn(
                    'text-[10px] font-mono px-1.5 py-0.5 rounded border transition-colors max-w-[90px] truncate',
                    runFilter === r.id
                      ? 'bg-primary/15 border-primary/40 text-primary'
                      : 'bg-muted/30 border-transparent text-muted-foreground hover:bg-muted/60'
                  )}
                >
                  {r.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <ScrollArea className="flex-1">
          {filteredEntries.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground px-4 text-center">
              <Search className="h-6 w-6 mb-2 opacity-30" />
              <p className="text-xs">
                {filtersActive ? 'No matching requests' : 'No requests yet'}
              </p>
              {filtersActive && (
                <button
                  type="button"
                  className="text-[10px] underline mt-2 text-primary"
                  onClick={() => {
                    setSearchFilter('');
                    setStatusFilter('all');
                    setProtocolFilter('all');
                    setRunFilter('all');
                  }}
                >
                  Clear filters
                </button>
              )}
            </div>
          ) : (
            filteredEntries.map((entry) => (
              <RequestEntryItem
                key={entry.id}
                entry={entry}
                isSelected={entry.id === selectedEntryId}
                onClick={() => selectEntry(entry.id)}
                isCompareChecked={compareIds.includes(entry.id)}
                onToggleCompare={() => toggleCompare(entry.id)}
                onPinForCompare={() => toggleCompare(entry.id)}
                maxTime={maxTime}
              />
            ))
          )}
        </ScrollArea>
      </div>

      {/* Entry details */}
      <div className="flex-1 min-w-0">
        {selectedEntry ? (
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
                {compareEntries.length === 2 && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-[11px]"
                    onClick={() => setCompareDialogOpen(true)}
                    title="Compare the two selected entries"
                  >
                    <GitCompare className="h-3 w-3 mr-1" />
                    Compare ({compareEntries.length})
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  onClick={handleReplay}
                  title="Replay in the active tab (or open a new HTTP tab if not HTTP)"
                >
                  <RotateCw className="h-3 w-3 mr-1" />
                  Replay
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  onClick={handleOpenInNewTab}
                  title="Open in a new tab"
                >
                  <ExternalLink className="h-3 w-3 mr-1" />
                  New tab
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  onClick={handleCopyCurl}
                  title="Copy as cURL"
                >
                  <Copy className="h-3 w-3 mr-1" />
                  cURL
                </Button>
              </div>
            </div>

            {/* At-a-glance summary — visible on both Request and Response tabs. */}
            <div className="flex items-center gap-3 px-4 py-1.5 border-b border-border/60 text-[11px] font-mono">
              <Badge
                variant="outline"
                className={cn('text-[10px] px-1.5 py-0', getStatusBadgeColor(selectedEntry.response.status))}
              >
                {selectedEntry.response.status || 'ERR'} {selectedEntry.response.statusText}
              </Badge>
              <span className="flex items-center gap-1 text-muted-foreground tabular-nums">
                <Clock className="h-3 w-3" />
                {selectedEntry.response.time}ms
              </span>
              {selectedEntry.requestSize != null && (
                <span className="text-muted-foreground tabular-nums" title="Request size">
                  ↑ {formatBytes(selectedEntry.requestSize)}
                </span>
              )}
              <span className="text-muted-foreground tabular-nums" title="Response size">
                ↓ {formatBytes(selectedEntry.response.size)}
              </span>
            </div>

            <TabsContent value="request" className="flex-1 m-0 overflow-hidden">
              <ScrollArea className="h-full">
                <div className="p-4 space-y-4">
                  {/* General info */}
                  <div className="space-y-2">
                    <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">General</h4>
                    <div className="bg-muted/50 rounded-lg p-3 space-y-2 text-xs">
                      <div className="flex justify-between items-center group">
                        <span className="text-muted-foreground">URL</span>
                        <div className="flex items-center gap-1 ml-4">
                          <span className="font-mono text-foreground truncate max-w-[280px]">{selectedEntry.request.url}</span>
                          <CopyButton value={selectedEntry.request.url} label="URL" />
                        </div>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Method</span>
                        <span className="font-semibold">{selectedEntry.request.method}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Timestamp</span>
                        <span>{formatClockTime(selectedEntry.timestamp)}</span>
                      </div>
                    </div>
                  </div>

                  {/* Request headers */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between group">
                      <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                        Request Headers
                        <Badge variant="secondary" className="ml-2 text-[10px]">
                          {Object.keys(selectedEntry.request.headers).length}
                        </Badge>
                      </h4>
                      {Object.keys(selectedEntry.request.headers).length > 0 && (
                        <CopyButton
                          value={formatHeadersForCopy(selectedEntry.request.headers)}
                          label="Headers"
                        />
                      )}
                    </div>
                    <div className="bg-muted/50 rounded-lg p-3 space-y-1.5 text-xs font-mono">
                      {Object.entries(selectedEntry.request.headers).length > 0 ? (
                        Object.entries(selectedEntry.request.headers).map(([key, value]) => (
                          <div key={key} className="flex">
                            <span className="text-primary/80 font-medium min-w-[120px]">{key}:</span>
                            <span className="text-foreground/80 break-all ml-2">{value}</span>
                          </div>
                        ))
                      ) : (
                        <span className="text-muted-foreground">No headers</span>
                      )}
                    </div>
                  </div>

                  {/* Request body */}
                  {selectedEntry.request.body && (
                    <div className="space-y-2">
                      <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Request Body</h4>
                      <div className="rounded-lg overflow-hidden border border-border">
                        <CodeEditor
                          value={selectedEntry.request.body}
                          language={detectLanguage(selectedEntry.request.body)}
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
                <div className="p-4 space-y-4">
                  {/* Response summary */}
                  <div className="space-y-2">
                    <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Summary</h4>
                    <div className="bg-muted/50 rounded-lg p-3 space-y-2 text-xs">
                      <div className="flex justify-between items-center">
                        <span className="text-muted-foreground">Status</span>
                        <Badge variant="outline" className={cn('text-xs', getStatusBadgeColor(selectedEntry.response.status))}>
                          {selectedEntry.response.status} {selectedEntry.response.statusText}
                        </Badge>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground flex items-center gap-1">
                          <Database className="h-3 w-3" />
                          Response size
                        </span>
                        <span className="font-medium">{formatBytes(selectedEntry.response.size)}</span>
                      </div>
                      {selectedEntry.requestSize != null && (
                        <div className="flex justify-between">
                          <span className="text-muted-foreground flex items-center gap-1">
                            <Database className="h-3 w-3" />
                            Request size
                          </span>
                          <span className="font-medium">{formatBytes(selectedEntry.requestSize)}</span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Timing breakdown */}
                  <div className="space-y-2">
                    <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      Timing
                    </h4>
                    <div className="bg-muted/50 rounded-lg p-3 space-y-3">
                      <div className="flex justify-between items-center text-xs">
                        <span className="text-muted-foreground">Total Time</span>
                        <span className={cn(
                          'font-medium',
                          selectedEntry.response.time < 200 ? 'text-emerald-600 dark:text-emerald-400' :
                          selectedEntry.response.time < 500 ? 'text-amber-600 dark:text-amber-400' :
                          'text-red-600 dark:text-red-400'
                        )}>
                          {selectedEntry.response.time}ms
                        </span>
                      </div>
                      {/* Visual timing bar */}
                      <div className="space-y-1.5">
                        <div className="h-2 rounded-full overflow-hidden bg-muted">
                          <div
                            className={cn(
                              'h-full rounded-full transition-all',
                              selectedEntry.response.time < 200 ? 'bg-emerald-500' :
                              selectedEntry.response.time < 500 ? 'bg-amber-500' :
                              'bg-red-500'
                            )}
                            style={{ width: `${Math.min(100, (selectedEntry.response.time / 1000) * 100)}%` }}
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
                          {Object.keys(selectedEntry.response.headers).length}
                        </Badge>
                      </h4>
                      {Object.keys(selectedEntry.response.headers).length > 0 && (
                        <CopyButton
                          value={formatHeadersForCopy(selectedEntry.response.headers)}
                          label="Headers"
                        />
                      )}
                    </div>
                    <div className="bg-muted/50 rounded-lg p-3 space-y-1.5 text-xs font-mono">
                      {Object.entries(selectedEntry.response.headers).length > 0 ? (
                        Object.entries(selectedEntry.response.headers).map(([key, value]) => (
                          <div key={key} className="flex">
                            <span className="text-primary/80 font-medium min-w-[120px]">{key}:</span>
                            <span className="text-foreground/80 break-all ml-2">
                              {Array.isArray(value) ? value.join(', ') : value}
                            </span>
                          </div>
                        ))
                      ) : (
                        <span className="text-muted-foreground">No headers</span>
                      )}
                    </div>
                  </div>

                  {/* Response body preview */}
                  {selectedEntry.response.body && (
                    <div className="space-y-2">
                      <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Response Body</h4>
                      <div className="rounded-lg overflow-hidden border border-border">
                        <CodeEditor
                          value={selectedEntry.response.body.substring(0, 10000)}
                          language={detectLanguage(selectedEntry.response.body, selectedEntry.response.headers)}
                          readOnly={true}
                          height="200px"
                          showCopyButton={true}
                          minimap={false}
                        />
                      </div>
                      {selectedEntry.response.body.length > 10000 && (
                        <p className="text-xs text-muted-foreground">
                          Showing first 10KB of {formatBytes(selectedEntry.response.body.length)}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </ScrollArea>
            </TabsContent>
          </Tabs>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <FileText className="h-8 w-8 mb-2 opacity-30" />
            <p className="text-xs">Select a request to view details</p>
          </div>
        )}
      </div>

      <EntryCompareDialog
        open={compareDialogOpen}
        onOpenChange={setCompareDialogOpen}
        left={compareEntries[0] ?? null}
        right={compareEntries[1] ?? null}
      />
    </div>
  );
}
