'use client';

import React, { useState, useMemo, useEffect } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { useRequestStore } from '@/store/useRequestStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { formatBytes, formatTime } from '@/lib/shared/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { Copy, Check, Clock, Database, Zap, CheckCircle2, XCircle, AlertCircle, Rows, Columns } from 'lucide-react';
import { toast } from 'sonner';
import { lazy } from 'react';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/shared/utils';
import { Scale, Stagger, StaggerItem } from '@/components/ui/motion';
import { withErrorBoundary } from '@/components/shared/ErrorBoundary';

const CodeEditor = lazy(() => import('@/components/shared/CodeEditor'));

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
  const contentTypeHeader = headers['content-type'] || headers['Content-Type'];
  const contentType = (Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : (contentTypeHeader || '')) || '';

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

// Enhanced status styling with glow effects
const getStatusColor = (status: number) => {
  if (status >= 200 && status < 300) return 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30 glow-success';
  if (status >= 300 && status < 400) return 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30 glow-info';
  if (status >= 400 && status < 500) return 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30 glow-warning';
  if (status >= 500) return 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30 glow-destructive';
  return 'bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/30';
};

// Header category grouping for better organization
const HEADER_CATEGORIES: Record<string, string[]> = {
  'Content': ['content-type', 'content-length', 'content-encoding', 'content-language', 'content-disposition'],
  'Cache': ['cache-control', 'etag', 'expires', 'last-modified', 'age', 'vary'],
  'Security': ['strict-transport-security', 'x-frame-options', 'x-content-type-options', 'x-xss-protection', 'content-security-policy'],
  'CORS': ['access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers', 'access-control-allow-credentials'],
  'Connection': ['connection', 'keep-alive', 'transfer-encoding'],
};

const categorizeHeader = (headerName: string): string => {
  const lowerName = headerName.toLowerCase();
  for (const [category, headers] of Object.entries(HEADER_CATEGORIES)) {
    if (headers.includes(lowerName)) return category;
  }
  return 'Other';
};

const groupHeaders = (headers: Record<string, string | string[]>): Record<string, [string, string | string[]][]> => {
  const grouped: Record<string, [string, string | string[]][]> = {};

  for (const [key, value] of Object.entries(headers)) {
    const category = categorizeHeader(key);
    if (!grouped[category]) grouped[category] = [];
    grouped[category].push([key, value]);
  }

  // Sort categories: Content first, Other last
  const sortedCategories = ['Content', 'Cache', 'Security', 'CORS', 'Connection', 'Other'];
  const result: Record<string, [string, string | string[]][]> = {};

  for (const cat of sortedCategories) {
    if (grouped[cat]) result[cat] = grouped[cat];
  }

  return result;
};

const getStatusIcon = (status: number) => {
  if (status >= 200 && status < 300) return <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />;
  if (status >= 400) return <XCircle className="h-4 w-4 text-red-600 dark:text-red-400" />;
  return <AlertCircle className="h-4 w-4 text-amber-600 dark:text-amber-400" />;
};

function ResponseSkeleton() {
  return (
    <Scale className="h-full flex flex-col bg-background relative z-20">
      <div className="flex items-center gap-4 px-4 py-2.5 border-b border-slate-200/60 dark:border-slate-700/40 bg-slate-50/50 dark:bg-slate-800/50">
        <Skeleton className="h-7 w-28 rounded-md" />
        <div className="h-5 w-px bg-slate-200 dark:bg-slate-700" />
        <Skeleton className="h-5 w-20 rounded" />
        <div className="h-5 w-px bg-slate-200 dark:bg-slate-700" />
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
  const currentResponse = useRequestStore((state) => state.currentResponse);
  const isLoading = useRequestStore((state) => state.isLoading);
  const { settings, updateSettings } = useSettingsStore();
  const [activeTab, setActiveTab] = useState('body');
  const [copiedHeader, setCopiedHeader] = useState<string | null>(null);
  const [showAnimation, setShowAnimation] = useState(false);

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

  // Trigger animation when response changes
  useEffect(() => {
    if (currentResponse) {
      setShowAnimation(true);
      const timer = setTimeout(() => setShowAnimation(false), 1000);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [currentResponse]);

  const handleCopyHeader = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(`${key}: ${value}`);
      setCopiedHeader(key);
      toast.success('Header copied');
      setTimeout(() => setCopiedHeader(null), 2000);
    } catch {
      toast.error('Failed to copy header');
    }
  };

  if (isLoading) {
    return <ResponseSkeleton />;
  }

  if (!currentResponse) {
    return (
      <div className="h-full flex items-center justify-center bg-background relative z-20 border-l border-border">
        <div className="empty-state-container max-w-md px-8">
          <div className="empty-state-icon h-14 w-14 rounded-xl">
            <Zap className="icon-lg text-muted-foreground/60" />
          </div>
          <h4 className="text-base font-semibold text-foreground/90 mb-1.5 tracking-tight">Ready to Send</h4>
          <p className="text-sm text-muted-foreground mb-4 max-w-xs">
            Configure your request and hit Send to see the response
          </p>
          <div className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
            <kbd className="px-2 py-1 bg-surface-2 border border-border/50 rounded text-[10px] font-mono shadow-sm">⌘</kbd>
            <span>+</span>
            <kbd className="px-2 py-1 bg-surface-2 border border-border/50 rounded text-[10px] font-mono shadow-sm">Enter</kbd>
            <span className="ml-1.5">to send request</span>
          </div>
        </div>
      </div>
    );
  }

  const isSuccess = currentResponse.status >= 200 && currentResponse.status < 300;
  const isError = currentResponse.status >= 400;

  return (
    <TooltipProvider delayDuration={300}>
      <div
        className={cn(
          "h-full flex flex-col bg-background relative z-20 transition-all duration-300 border-l border-border",
          showAnimation && isSuccess && "animate-success-pulse",
          showAnimation && isError && "animate-error-shake"
        )}
      >
        {/* Response Info Bar */}
        <div className="flex items-center gap-2 lg:gap-3 px-3 lg:px-4 py-2 lg:py-2.5 border-b border-border bg-transparent">
          <div className="flex items-center gap-1.5 lg:gap-2">
            <span className="text-[10px] lg:text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide hidden lg:inline">Status</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge
                  variant="outline"
                  className={cn(
                    "text-xs font-bold px-2.5 py-1 flex items-center gap-1.5 tabular-nums",
                    getStatusColor(currentResponse.status)
                  )}
                >
                  {getStatusIcon(currentResponse.status)}
                  {currentResponse.status} {currentResponse.statusText}
                </Badge>
              </TooltipTrigger>
              <TooltipContent>
                <p>
                  {currentResponse.status >= 200 && currentResponse.status < 300 && 'Success - Request completed successfully'}
                  {currentResponse.status >= 300 && currentResponse.status < 400 && 'Redirect - Resource has moved'}
                  {currentResponse.status >= 400 && currentResponse.status < 500 && 'Client Error - Check your request'}
                  {currentResponse.status >= 500 && 'Server Error - Server failed to process'}
                  {currentResponse.status === 0 && 'Network Error - Connection failed'}
                </p>
              </TooltipContent>
            </Tooltip>
          </div>
          <Separator orientation="vertical" className="h-4 lg:h-5 bg-slate-200 dark:bg-slate-700" />
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1 lg:gap-1.5 cursor-help">
                <Clock className="h-3 w-3 lg:h-3.5 lg:w-3.5 text-slate-blue-600 dark:text-slate-blue-400" />
                <span className="text-[10px] lg:text-xs font-mono font-semibold text-slate-700 dark:text-slate-200 tabular-nums">{formatTime(currentResponse.time)}</span>
              </div>
            </TooltipTrigger>
            <TooltipContent>
              <p>Response time: {currentResponse.time}ms</p>
            </TooltipContent>
          </Tooltip>
          <Separator orientation="vertical" className="h-4 lg:h-5 bg-slate-200 dark:bg-slate-700" />
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1 lg:gap-1.5 cursor-help">
                <Database className="h-3 w-3 lg:h-3.5 lg:w-3.5 text-indigo-600 dark:text-indigo-400" />
                <span className="text-[10px] lg:text-xs font-mono font-semibold text-slate-700 dark:text-slate-200 tabular-nums">{formatBytes(currentResponse.size)}</span>
              </div>
            </TooltipTrigger>
            <TooltipContent>
              <p>Response size: {currentResponse.size} bytes</p>
            </TooltipContent>
          </Tooltip>
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
          <div className="px-4 py-2 border-b border-border/40">
            <TabsList className="w-full grid grid-cols-2">
              <TabsTrigger value="body">
                Body
                {language !== 'text' && (
                  <Badge variant="secondary" className="ml-2 h-4 px-1 text-[10px]">
                    {language.toUpperCase()}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="headers">
                Headers
                <Badge variant="secondary" className="ml-2 h-4 min-w-4 px-1 text-[10px] tabular-nums">
                  {Object.keys(currentResponse.headers).length}
                </Badge>
              </TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="body" className="flex-1 relative p-0 m-0 min-h-0 border-none outline-none data-[state=active]:block h-full">
            <div className="absolute inset-0">
              {formattedBody ? (
                 <CodeEditor value={formattedBody} language={language} readOnly height="100%" showCopyButton />
              ) : (
                <div className="flex flex-col items-center justify-center h-full text-muted-foreground text-sm">
                  <div className="p-4 rounded-full bg-muted/50 mb-3">
                    <Database className="h-6 w-6 opacity-20" />
                  </div>
                  <p>No body content returned</p>
                </div>
              )}
            </div>
          </TabsContent>

          <TabsContent value="headers" className="flex-1 overflow-auto p-0 m-0 min-h-0">
            <div className="p-3">
              {/* Grouped headers table */}
              <table className="w-full font-mono text-xs">
                <thead>
                  <tr className="text-muted-foreground/60 uppercase tracking-wider text-[10px]">
                    <th className="text-left py-2 px-3 w-1/3">Header</th>
                    <th className="text-left py-2 px-3">Value</th>
                    <th className="w-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(groupHeaders(currentResponse.headers)).map(([category, headers]) => (
                    <React.Fragment key={category}>
                      {/* Category header row */}
                      <tr className="border-t border-border/30">
                        <td colSpan={3} className="py-1.5 px-3 text-[10px] uppercase tracking-wider text-muted-foreground/50 bg-muted/30 font-sans font-medium">
                          {category}
                        </td>
                      </tr>
                      {/* Header rows in this category */}
                      {headers.map(([key, value]) => (
                        <tr
                          key={key}
                          className="group border-t border-border/20 hover:bg-muted/20 transition-colors"
                        >
                          <td className="py-2 px-3 text-primary/80 font-semibold align-top">{key}</td>
                          <td className="py-2 px-3 text-foreground/70 break-all">
                            {Array.isArray(value) ? value.join(', ') : value}
                          </td>
                          <td className="py-2 px-1">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
                                  onClick={() => handleCopyHeader(key, String(value))}
                                >
                                  {copiedHeader === key ? (
                                    <Check className="h-3 w-3 text-emerald-600" />
                                  ) : (
                                    <Copy className="h-3 w-3" />
                                  )}
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>
                                <p>{copiedHeader === key ? 'Copied!' : 'Copy header'}</p>
                              </TooltipContent>
                            </Tooltip>
                          </td>
                        </tr>
                      ))}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </TooltipProvider>
  );
}

export default withErrorBoundary(ResponseViewer);
