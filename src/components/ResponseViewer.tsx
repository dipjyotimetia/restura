'use client';

import { useState, useMemo, useEffect } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { useRequestStore } from '@/store/useRequestStore';
import { formatBytes, formatTime } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { Copy, Check, Clock, Database, Zap, CheckCircle2, XCircle, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import dynamic from 'next/dynamic';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { Scale, Stagger, StaggerItem } from '@/components/ui/motion';

const CodeEditor = dynamic(() => import('@/components/CodeEditor'), { ssr: false });

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

const getStatusColor = (status: number) => {
  if (status >= 200 && status < 300) return 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800';
  if (status >= 300 && status < 400) return 'bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400 border-blue-200 dark:border-blue-800';
  if (status >= 400 && status < 500) return 'bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-800';
  if (status >= 500) return 'bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-400 border-red-200 dark:border-red-800';
  return 'bg-slate-50 dark:bg-slate-900 text-slate-700 dark:text-slate-400 border-slate-200 dark:border-slate-700';
};

const getStatusIcon = (status: number) => {
  if (status >= 200 && status < 300) return <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />;
  if (status >= 400) return <XCircle className="h-4 w-4 text-red-600 dark:text-red-400" />;
  return <AlertCircle className="h-4 w-4 text-amber-600 dark:text-amber-400" />;
};

function ResponseSkeleton() {
  return (
    <Scale className="flex-1 flex flex-col bg-background relative z-20">
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

export default function ResponseViewer() {
  const { currentResponse, isLoading } = useRequestStore();
  const [activeTab, setActiveTab] = useState('body');
  const [copiedHeader, setCopiedHeader] = useState<string | null>(null);
  const [showAnimation, setShowAnimation] = useState(false);

  console.log('[ResponseViewer] Render:', {
    hasResponse: !!currentResponse,
    isLoading,
    bodyLength: currentResponse?.body?.length,
    bodyPreview: currentResponse?.body?.substring(0, 100),
  });

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
      <div className="flex-1 flex items-center justify-center bg-background relative z-20 border-l border-border">
        <div className="text-center p-8 rounded-xl bg-muted border border-dashed border-border max-w-md shadow-md">
          <div className="mx-auto mb-4 h-14 w-14 rounded-full bg-gradient-to-br from-slate-blue-100 to-indigo-100 dark:from-slate-blue-900/30 dark:to-indigo-900/30 flex items-center justify-center">
            <Zap className="h-7 w-7 text-slate-blue-600 dark:text-slate-blue-400" />
          </div>
          <p className="text-base font-semibold text-slate-900 dark:text-slate-100 mb-1.5 tracking-tight">Ready to Send</p>
          <p className="text-sm text-slate-600 dark:text-slate-400 mb-4">
            Configure your request and hit Send to see the response
          </p>
          <div className="flex items-center justify-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
            <kbd className="px-2 py-1 bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded text-[10px] font-mono shadow-sm">⌘</kbd>
            <span>+</span>
            <kbd className="px-2 py-1 bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded text-[10px] font-mono shadow-sm">Enter</kbd>
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
          "flex-1 flex flex-col bg-background relative z-20 transition-all duration-300 border-l border-border",
          showAnimation && isSuccess && "animate-success-pulse",
          showAnimation && isError && "animate-error-shake"
        )}
      >
        {/* Response Info Bar */}
        <div className="flex items-center gap-3 px-4 py-2.5 border-b border-border bg-transparent">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">Status</span>
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
          <Separator orientation="vertical" className="h-5 bg-slate-200 dark:bg-slate-700" />
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1.5 cursor-help">
                <Clock className="h-3.5 w-3.5 text-slate-blue-600 dark:text-slate-blue-400" />
                <span className="text-xs font-mono font-semibold text-slate-700 dark:text-slate-200 tabular-nums">{formatTime(currentResponse.time)}</span>
              </div>
            </TooltipTrigger>
            <TooltipContent>
              <p>Response time: {currentResponse.time}ms</p>
            </TooltipContent>
          </Tooltip>
          <Separator orientation="vertical" className="h-5 bg-slate-200 dark:bg-slate-700" />
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1.5 cursor-help">
                <Database className="h-3.5 w-3.5 text-indigo-600 dark:text-indigo-400" />
                <span className="text-xs font-mono font-semibold text-slate-700 dark:text-slate-200 tabular-nums">{formatBytes(currentResponse.size)}</span>
              </div>
            </TooltipTrigger>
            <TooltipContent>
              <p>Response size: {currentResponse.size} bytes</p>
            </TooltipContent>
          </Tooltip>
        </div>

        {/* Response Tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col">
          <TabsList className="w-full rounded-none border-b border-border bg-transparent px-3 h-10">
            <TabsTrigger
              value="body"
              className="h-10 text-xs font-medium data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:bg-primary/5 data-[state=active]:text-primary transition-all"
            >
              Body
              {language !== 'text' && (
                <Badge variant="secondary" className="ml-1.5 h-5 px-1.5 text-xs bg-primary/10 text-primary border-0">
                  {language.toUpperCase()}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger
              value="headers"
              className="h-10 text-xs font-medium data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:bg-primary/5 data-[state=active]:text-primary transition-all"
            >
              Headers
              <Badge variant="secondary" className="ml-1.5 h-5 min-w-5 px-1.5 text-xs bg-primary/10 text-primary border-0 tabular-nums">
                {Object.keys(currentResponse.headers).length}
              </Badge>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="body" className="flex-1 relative p-0 m-0">
            <div className="absolute inset-0 p-3">
              <CodeEditor value={formattedBody} language={language} readOnly height="100%" showCopyButton />
            </div>
          </TabsContent>

          <TabsContent value="headers" className="flex-1 overflow-auto p-3 m-0">
            <div className="space-y-1.5">
              {Object.entries(currentResponse.headers).map(([key, value]) => (
                <div
                  key={key}
                  className="group flex gap-3 p-2.5 rounded-lg bg-slate-50/50 dark:bg-slate-800/30 border border-slate-200/60 dark:border-slate-700/40 hover:border-slate-blue-300 dark:hover:border-slate-blue-700 hover:bg-slate-blue-50/50 dark:hover:bg-slate-blue-950/20 text-xs transition-all"
                >
                  <span className="font-semibold min-w-[180px] text-slate-blue-700 dark:text-slate-blue-300 truncate">{key}:</span>
                  <span className="text-slate-600 dark:text-slate-400 break-all flex-1">
                    {Array.isArray(value) ? value.join(', ') : value}
                  </span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-5 w-5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
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
                </div>
              ))}
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </TooltipProvider>
  );
}
