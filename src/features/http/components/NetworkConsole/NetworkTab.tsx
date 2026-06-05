'use client';

import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
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
  DropdownMenuItem,
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
  Copy,
  Check,
  Search,
  X,
  RotateCw,
  ExternalLink,
  GitCompare,
  SlidersHorizontal,
  ListChecks,
  Maximize2,
  Code2,
  Cookie as CookieIcon,
  HelpCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import RequestEntryItem from './RequestEntryItem';
import EntryCompareDialog from './EntryCompareDialog';
import EntryExpandDialog from './EntryExpandDialog';
import { cn } from '@/lib/shared/utils';
import {
  detectLanguage,
  formatBytes,
  formatClockTime,
  getStatusBadgeColor,
} from '@/lib/shared/console-format';
import { filterEntries, sortEntries, statusClassCounts } from '@/lib/shared/console-filter';
import { parseRequestCookies, parseResponseCookies } from '@/lib/shared/cookie-parser';
import { codeGenerators, type CodeGeneratorType } from '@/lib/shared/codeGenerators';

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
    runFilter,
    setRunFilter,
    removeEntry,
    togglePin,
  } = useConsoleStore();
  const openTab = useRequestStore((s) => s.openTab);
  const updateRequest = useRequestStore((s) => s.updateRequest);
  const activeTab = useActiveTab();

  // Compare-set is local-only — transient UI state, no need to persist.
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [compareDialogOpen, setCompareDialogOpen] = useState(false);
  const [expandOpen, setExpandOpen] = useState(false);
  // Sort is transient view state — order doesn't affect what's in the list.
  const [sortBy, setSortBy] = useState<'recent' | 'time' | 'size' | 'status'>('recent');
  const listRef = useRef<HTMLDivElement>(null);

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

  // Filter using the shared DSL-aware predicate (plain text + key:value +
  // negation + regex). Sort is applied as a separate, view-only step.
  // Pinned entries always group first (stable within pinned/unpinned) so pins
  // don't scatter through the list as new traffic arrives.
  const filteredEntries = useMemo(
    () =>
      sortEntries(
        filterEntries(entries, {
          query: searchFilter,
          statusFilter,
          protocolFilter,
          runFilter,
        }),
        sortBy
      ),
    [entries, searchFilter, statusFilter, protocolFilter, runFilter, sortBy]
  );

  // Per-class counts on the unfiltered list — these badge the status chips so
  // the chip row doubles as a histogram of what's in the log.
  const classCounts = useMemo(() => statusClassCounts(entries), [entries]);

  // Slowest response in the current view — scales every row's waterfall bar.
  const maxTime = useMemo(
    () => filteredEntries.reduce((m, e) => Math.max(m, e.response.time), 0),
    [filteredEntries]
  );

  const selectedEntry = entries.find((e) => e.id === selectedEntryId);

  // Cookies parsed from the captured headers — same source the headers section
  // renders. Memoised because the detail pane re-renders on every selection.
  const requestCookies = useMemo(
    () =>
      selectedEntry
        ? parseRequestCookies(selectedEntry.request.headers as Record<string, string | string[]>)
        : [],
    [selectedEntry]
  );
  const responseCookies = useMemo(
    () => (selectedEntry ? parseResponseCookies(selectedEntry.response.headers) : []),
    [selectedEntry]
  );

  // Keyboard navigation over the entry list. Focus moves with ↑/↓ to the
  // adjacent visible row; Enter selects (already true on click); Delete
  // removes; `p` toggles pin. We rely on the parent's `tabIndex={0}` so the
  // list is focusable; the actual focus-ring is handled by the row.
  const moveSelection = useCallback(
    (dir: 1 | -1) => {
      if (filteredEntries.length === 0) return;
      const idx = filteredEntries.findIndex((e) => e.id === selectedEntryId);
      const next =
        idx < 0
          ? dir === 1
            ? 0
            : filteredEntries.length - 1
          : Math.min(filteredEntries.length - 1, Math.max(0, idx + dir));
      const target = filteredEntries[next];
      if (target) selectEntry(target.id);
    },
    [filteredEntries, selectedEntryId, selectEntry]
  );

  const handleListKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        moveSelection(1);
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        moveSelection(-1);
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!selectedEntryId) return;
        e.preventDefault();
        // Move selection to the next neighbour before removal — the row at the
        // current index vanishes, so we pick the one that will slide up into it.
        const idx = filteredEntries.findIndex((x) => x.id === selectedEntryId);
        const replacement = filteredEntries[idx + 1] ?? filteredEntries[idx - 1];
        removeEntry(selectedEntryId);
        if (replacement) selectEntry(replacement.id);
      } else if (e.key.toLowerCase() === 'p' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (!selectedEntryId) return;
        e.preventDefault();
        togglePin(selectedEntryId);
      }
    },
    [moveSelection, selectedEntryId, filteredEntries, removeEntry, togglePin, selectEntry]
  );

  // Keep the selected row visible after keyboard moves.
  useEffect(() => {
    if (!selectedEntryId || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-entry-id="${selectedEntryId}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedEntryId]);

  const handleCopyAsCode = async (generatorKey: CodeGeneratorType) => {
    if (!selectedEntry) return;
    try {
      const req = entryToHttpRequest(selectedEntry);
      // Captured entries already hold the resolved values (env-vars baked in).
      // We reconstruct the GenerateOptions shape the generators expect.
      const resolvedParams: Record<string, string> = {};
      try {
        for (const [k, v] of new URL(req.url).searchParams) resolvedParams[k] = v;
      } catch {
        /* malformed URL — generators handle a blank params map fine */
      }
      const code = codeGenerators[generatorKey].generate({
        request: req,
        resolvedUrl: req.url,
        resolvedHeaders: selectedEntry.request.headers,
        resolvedParams,
      });
      await navigator.clipboard.writeText(code);
      toast.success(`Copied as ${codeGenerators[generatorKey].name}`);
    } catch (e) {
      toast.error(`Failed to copy: ${e instanceof Error ? e.message : 'unknown error'}`);
    }
  };

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
                placeholder="Filter… try status:5xx -url:health"
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
                className="h-7 pl-7 pr-12 text-xs"
                title={
                  // The full DSL reference, shown on native tooltip hover so we
                  // don't need a popover library for what is essentially a hint.
                  'Filter DSL\n' +
                  '  plain text         → match anywhere\n' +
                  '  "quoted phrase"    → preserves spaces\n' +
                  '  status:5xx | 200   → status class or number\n' +
                  '  method:POST        → HTTP method\n' +
                  '  url:/users         url:~regex\n' +
                  '  host:api.foo.com   protocol:graphql\n' +
                  '  has:body | cookie | test | script\n' +
                  '  -<token>           → negate\n' +
                  'Multiple tokens AND together.'
                }
              />
              {searchFilter ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute right-0.5 top-1/2 -translate-y-1/2 h-6 w-6"
                  onClick={() => setSearchFilter('')}
                >
                  <X className="h-3 w-3" />
                </Button>
              ) : (
                <HelpCircle
                  className="absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground/50 pointer-events-none"
                  aria-hidden="true"
                />
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
          {/* Status filters — each chip carries a live count so the row doubles
              as a histogram of what's in the log. 'all' is implicit total. */}
          <div className="flex flex-wrap gap-1">
            {STATUS_FILTERS.map((f) => {
              const count = classCounts[f.value] ?? 0;
              return (
                <button
                  key={f.value}
                  type="button"
                  onClick={() => setStatusFilter(f.value)}
                  className={cn(
                    'inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded border transition-colors',
                    statusFilter === f.value
                      ? 'bg-primary/15 border-primary/40 text-primary'
                      : 'bg-muted/30 border-transparent text-muted-foreground hover:bg-muted/60',
                    f.value !== 'all' && count === 0 && 'opacity-50'
                  )}
                  aria-pressed={statusFilter === f.value}
                >
                  <span>{f.label}</span>
                  {count > 0 && (
                    <span
                      className={cn(
                        'text-[9px] tabular-nums px-1 rounded-sm',
                        statusFilter === f.value ? 'bg-primary/20' : 'bg-muted-foreground/15'
                      )}
                    >
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
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
          <div
            ref={listRef}
            tabIndex={0}
            role="listbox"
            aria-label="Request log"
            aria-activedescendant={selectedEntryId ? `entry-${selectedEntryId}` : undefined}
            onKeyDown={handleListKeyDown}
            className="outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
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
                <div
                  key={entry.id}
                  id={`entry-${entry.id}`}
                  data-entry-id={entry.id}
                  role="option"
                  aria-selected={entry.id === selectedEntryId}
                >
                  <RequestEntryItem
                    entry={entry}
                    isSelected={entry.id === selectedEntryId}
                    onClick={() => selectEntry(entry.id)}
                    isCompareChecked={compareIds.includes(entry.id)}
                    onToggleCompare={() => toggleCompare(entry.id)}
                    onPinForCompare={() => toggleCompare(entry.id)}
                    maxTime={maxTime}
                  />
                </div>
              ))
            )}
          </div>
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
                    <DropdownMenuItem className="text-xs" onClick={handleCopyCurl}>
                      cURL
                    </DropdownMenuItem>
                    {(
                      Object.entries(codeGenerators) as Array<
                        [CodeGeneratorType, (typeof codeGenerators)[CodeGeneratorType]]
                      >
                    )
                      .filter(([key]) => key !== 'curl')
                      .map(([key, gen]) => (
                        <DropdownMenuItem
                          key={key}
                          className="text-xs"
                          onClick={() => handleCopyAsCode(key)}
                        >
                          {gen.name}
                        </DropdownMenuItem>
                      ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => setExpandOpen(true)}
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
                className={cn(
                  'text-[10px] px-1.5 py-0',
                  getStatusBadgeColor(selectedEntry.response.status)
                )}
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
              {selectedEntry.bodyTruncated && (
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
                            {selectedEntry.request.url}
                          </span>
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
                            <span className="text-primary/80 font-medium min-w-[120px]">
                              {key}:
                            </span>
                            <span className="text-foreground/80 break-all ml-2">{value}</span>
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
                            <span className="text-primary/80 font-medium min-w-[120px]">
                              {c.name}
                            </span>
                            <span className="text-foreground/80 break-all ml-2">{c.value}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Request body */}
                  {selectedEntry.request.body && (
                    <div className="space-y-2">
                      <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                        Request Body
                      </h4>
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
                            selectedEntry.response.time < 200
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : selectedEntry.response.time < 500
                                ? 'text-amber-600 dark:text-amber-400'
                                : 'text-red-600 dark:text-red-400'
                          )}
                        >
                          {selectedEntry.response.time}ms
                        </span>
                      </div>
                      {/* Visual timing bar */}
                      <div className="space-y-1.5">
                        <div className="h-2 rounded-full overflow-hidden bg-muted">
                          <div
                            className={cn(
                              'h-full rounded-full transition-all',
                              selectedEntry.response.time < 200
                                ? 'bg-emerald-500'
                                : selectedEntry.response.time < 500
                                  ? 'bg-amber-500'
                                  : 'bg-red-500'
                            )}
                            style={{
                              width: `${Math.min(100, (selectedEntry.response.time / 1000) * 100)}%`,
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
                            <span className="text-primary/80 font-medium min-w-[120px]">
                              {key}:
                            </span>
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
                              <span className="text-primary/80 font-medium min-w-[120px]">
                                {c.name}
                              </span>
                              <span className="text-foreground/80 break-all ml-2">{c.value}</span>
                            </div>
                            {/* Attributes — only render when something was actually parsed,
                                so the panel stays compact for typical cookies. */}
                            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground pl-[120px] ml-2">
                              {c.domain && (
                                <span>
                                  Domain: <span className="text-foreground/70">{c.domain}</span>
                                </span>
                              )}
                              {c.path && (
                                <span>
                                  Path: <span className="text-foreground/70">{c.path}</span>
                                </span>
                              )}
                              {c.expires && (
                                <span>
                                  Expires: <span className="text-foreground/70">{c.expires}</span>
                                </span>
                              )}
                              {c.maxAge !== undefined && (
                                <span>
                                  Max-Age: <span className="text-foreground/70">{c.maxAge}</span>
                                </span>
                              )}
                              {c.sameSite && (
                                <span>
                                  SameSite: <span className="text-foreground/70">{c.sameSite}</span>
                                </span>
                              )}
                              {c.httpOnly && (
                                <span className="text-amber-600 dark:text-amber-400">HttpOnly</span>
                              )}
                              {c.secure && (
                                <span className="text-emerald-600 dark:text-emerald-400">
                                  Secure
                                </span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Response body preview */}
                  {selectedEntry.response.body && (
                    <div className="space-y-2">
                      <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                        Response Body
                      </h4>
                      <div className="rounded-lg overflow-hidden border border-border">
                        <CodeEditor
                          value={selectedEntry.response.body.substring(0, 10000)}
                          language={detectLanguage(
                            selectedEntry.response.body,
                            selectedEntry.response.headers
                          )}
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
      <EntryExpandDialog
        open={expandOpen}
        onOpenChange={setExpandOpen}
        entry={selectedEntry ?? null}
      />
    </div>
  );
}
