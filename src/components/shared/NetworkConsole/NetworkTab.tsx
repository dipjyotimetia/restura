import { useState, useMemo, lazy } from 'react';
import { useConsoleStore } from '@/store/useConsoleStore';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Network, FileText, Clock, Database, Copy, Check, Search, X } from 'lucide-react';
import { toast } from 'sonner';
import RequestEntryItem from './RequestEntryItem';
import { cn } from '@/lib/shared/utils';

// Lazy import for CodeEditor to reduce initial bundle
const CodeEditor = lazy(() => import('@/components/shared/CodeEditor'));

const formatTime = (timestamp: number) => {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  });
};

const getStatusColor = (status: number) => {
  if (status >= 200 && status < 300) return 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30';
  if (status >= 300 && status < 400) return 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30';
  if (status >= 400 && status < 500) return 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30';
  if (status >= 500) return 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30';
  return 'bg-gray-500/10 text-gray-600 dark:text-gray-400 border-gray-500/30';
};

// Format bytes to human readable
const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};

// Detect language from content
const detectLanguage = (body: string, headers?: Record<string, string | string[]>) => {
  // Check content-type header
  if (headers) {
    const contentType = headers['content-type'] || headers['Content-Type'] || '';
    const ct = Array.isArray(contentType) ? contentType[0] : contentType;
    if (ct?.includes('json')) return 'json';
    if (ct?.includes('xml')) return 'xml';
    if (ct?.includes('html')) return 'html';
    if (ct?.includes('javascript')) return 'javascript';
  }

  // Try to detect from content
  const trimmed = body.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json';
  if (trimmed.startsWith('<')) return 'xml';

  return 'text';
};

// Format headers as string for copying
const formatHeadersForCopy = (headers: Record<string, string | string[]>) => {
  return Object.entries(headers)
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
    .join('\n');
};

// Copy button component
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

export default function NetworkTab() {
  const { entries, selectedEntryId, selectEntry, searchFilter, setSearchFilter } = useConsoleStore();

  // Filter entries based on search
  const filteredEntries = useMemo(() => {
    if (!searchFilter.trim()) return entries;
    const search = searchFilter.toLowerCase();
    return entries.filter((entry) => {
      return (
        entry.request.url.toLowerCase().includes(search) ||
        entry.request.method.toLowerCase().includes(search) ||
        entry.response.status.toString().includes(search) ||
        entry.response.statusText.toLowerCase().includes(search)
      );
    });
  }, [entries, searchFilter]);

  const selectedEntry = entries.find((e) => e.id === selectedEntryId);

  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground py-8">
        <Network className="h-10 w-10 mb-3 opacity-30" />
        <p className="font-medium text-sm">No requests yet</p>
        <p className="text-xs mt-1">Send a request to see it here</p>
      </div>
    );
  }

  return (
    <div className="flex h-full">
      {/* Entry list */}
      <div className="w-[280px] border-r border-border flex-shrink-0 flex flex-col">
        {/* Search input */}
        <div className="p-2 border-b border-border">
          <div className="relative">
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
        </div>
        <ScrollArea className="flex-1">
          {filteredEntries.length === 0 && searchFilter ? (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
              <Search className="h-6 w-6 mb-2 opacity-30" />
              <p className="text-xs">No matching requests</p>
            </div>
          ) : (
            filteredEntries.map((entry) => (
              <RequestEntryItem
                key={entry.id}
                entry={entry}
                isSelected={entry.id === selectedEntryId}
                onClick={() => selectEntry(entry.id)}
              />
            ))
          )}
        </ScrollArea>
      </div>

      {/* Entry details */}
      <div className="flex-1 min-w-0">
        {selectedEntry ? (
          <Tabs defaultValue="request" className="h-full flex flex-col">
            <div className="px-4 pt-2 border-b border-border">
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
                        <span>{formatTime(selectedEntry.timestamp)}</span>
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
                        <Badge variant="outline" className={cn('text-xs', getStatusColor(selectedEntry.response.status))}>
                          {selectedEntry.response.status} {selectedEntry.response.statusText}
                        </Badge>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground flex items-center gap-1">
                          <Database className="h-3 w-3" />
                          Size
                        </span>
                        <span className="font-medium">{formatBytes(selectedEntry.response.size)}</span>
                      </div>
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
    </div>
  );
}
