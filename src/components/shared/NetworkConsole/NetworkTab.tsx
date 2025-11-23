'use client';

import { useConsoleStore } from '@/store/useConsoleStore';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Network, FileText, Clock, Database } from 'lucide-react';
import RequestEntryItem from './RequestEntryItem';
import { cn } from '@/lib/shared/utils';

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

export default function NetworkTab() {
  const { entries, selectedEntryId, selectEntry } = useConsoleStore();

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
      <div className="w-[280px] border-r border-border flex-shrink-0">
        <ScrollArea className="h-full">
          {entries.map((entry) => (
            <RequestEntryItem
              key={entry.id}
              entry={entry}
              isSelected={entry.id === selectedEntryId}
              onClick={() => selectEntry(entry.id)}
            />
          ))}
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
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">URL</span>
                        <span className="font-mono text-foreground truncate ml-4 max-w-[300px]">{selectedEntry.request.url}</span>
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
                    <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      Request Headers
                      <Badge variant="secondary" className="ml-2 text-[10px]">
                        {Object.keys(selectedEntry.request.headers).length}
                      </Badge>
                    </h4>
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
                      <pre className="bg-muted/50 rounded-lg p-3 text-xs font-mono overflow-x-auto whitespace-pre-wrap break-all">
                        {selectedEntry.request.body}
                      </pre>
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
                          <Clock className="h-3 w-3" />
                          Time
                        </span>
                        <span className="font-medium">{selectedEntry.response.time}ms</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground flex items-center gap-1">
                          <Database className="h-3 w-3" />
                          Size
                        </span>
                        <span className="font-medium">{(selectedEntry.response.size / 1024).toFixed(2)} KB</span>
                      </div>
                    </div>
                  </div>

                  {/* Response headers */}
                  <div className="space-y-2">
                    <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      Response Headers
                      <Badge variant="secondary" className="ml-2 text-[10px]">
                        {Object.keys(selectedEntry.response.headers).length}
                      </Badge>
                    </h4>
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
                      <pre className="bg-muted/50 rounded-lg p-3 text-xs font-mono overflow-x-auto whitespace-pre-wrap break-all max-h-[200px] overflow-y-auto">
                        {selectedEntry.response.body.substring(0, 5000)}
                        {selectedEntry.response.body.length > 5000 && '...'}
                      </pre>
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
