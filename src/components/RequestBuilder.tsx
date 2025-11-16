'use client';

import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useRequestStore } from '@/store/useRequestStore';
import { useHistoryStore } from '@/store/useHistoryStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { HttpMethod, KeyValue, AuthConfig as AuthConfigType, RequestSettings } from '@/types';
import { Send, Plus, Trash2, Code2, Settings, Loader2 } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import AuthConfiguration from '@/components/AuthConfig';
import ScriptExecutor from '@/lib/scriptExecutor';
import CodeGeneratorDialog from '@/components/CodeGeneratorDialog';
import { useSettingsStore } from '@/store/useSettingsStore';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import dynamic from 'next/dynamic';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';

const CodeEditor = dynamic(() => import('@/components/CodeEditor'), { ssr: false });

// Method color mapping
const methodColors: Record<string, string> = {
  GET: 'bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/30 hover:bg-green-500/20',
  POST: 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 border-yellow-500/30 hover:bg-yellow-500/20',
  PUT: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30 hover:bg-blue-500/20',
  DELETE: 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30 hover:bg-red-500/20',
  PATCH: 'bg-slate-blue-500/10 text-slate-blue-600 dark:text-slate-blue-400 border-slate-blue-500/30 hover:bg-slate-blue-500/20',
  OPTIONS: 'bg-gray-500/10 text-gray-600 dark:text-gray-400 border-gray-500/30 hover:bg-gray-500/20',
  HEAD: 'bg-gray-500/10 text-gray-600 dark:text-gray-400 border-gray-500/30 hover:bg-gray-500/20',
};

export default function RequestBuilder() {
  const { currentRequest, updateRequest, setLoading, setCurrentResponse, isLoading, setScriptResult } = useRequestStore();
  const { addHistoryItem } = useHistoryStore();
  const { resolveVariables, getActiveEnvironment } = useEnvironmentStore();
  const { settings: globalSettings } = useSettingsStore();
  const [activeTab, setActiveTab] = useState('params');
  const [scriptTab, setScriptTab] = useState<'pre-request' | 'test'>('pre-request');
  const [codeGenOpen, setCodeGenOpen] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);

  // Keyboard shortcuts for tab switching
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle if not typing in input/textarea
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      // Tab switching with Alt + number
      if (e.altKey && !e.metaKey && !e.ctrlKey) {
        const tabMap: Record<string, string> = {
          '1': 'params',
          '2': 'headers',
          '3': 'body',
          '4': 'auth',
          '5': 'scripts',
          '6': 'settings',
        };
        const newTab = tabMap[e.key];
        if (newTab) {
          e.preventDefault();
          setActiveTab(newTab);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  if (!currentRequest || currentRequest.type !== 'http') {
    return null;
  }

  // Get effective settings (request-specific or global defaults)
  const getEffectiveSettings = (): RequestSettings => {
    return currentRequest.settings || {
      timeout: globalSettings.defaultTimeout,
      followRedirects: globalSettings.followRedirects,
      maxRedirects: globalSettings.maxRedirects,
      verifySsl: globalSettings.verifySsl,
      proxy: globalSettings.proxy,
    };
  };

  const handleSettingsChange = (updates: Partial<RequestSettings>) => {
    const currentSettings = currentRequest.settings || getEffectiveSettings();
    updateRequest({
      settings: { ...currentSettings, ...updates },
    });
  };

  const handleProxyOverrideChange = (useOverride: boolean) => {
    if (useOverride) {
      // Create request-specific proxy settings based on global
      handleSettingsChange({
        proxy: { ...globalSettings.proxy },
      });
    } else {
      // Remove request-specific proxy (use global)
      const currentSettings = currentRequest.settings;
      if (currentSettings) {
        const { proxy: _, ...rest } = currentSettings;
        updateRequest({ settings: { ...rest, proxy: undefined } });
      }
    }
  };

  const handleMethodChange = (method: HttpMethod) => {
    updateRequest({ method });
  };

  const handleUrlChange = (url: string) => {
    updateRequest({ url });

    // Validate URL
    if (!url) {
      setUrlError(null);
      return;
    }

    // Allow environment variables like {{baseUrl}}/path
    if (url.includes('{{') && url.includes('}}')) {
      setUrlError(null);
      return;
    }

    try {
      // Check if URL is valid
      const urlToValidate = url.startsWith('http') ? url : `https://${url}`;
      new URL(urlToValidate);
      setUrlError(null);
    } catch {
      setUrlError('Invalid URL format');
    }
  };

  const handleAddParam = () => {
    const newParam: KeyValue = {
      id: uuidv4(),
      key: '',
      value: '',
      enabled: true,
    };
    updateRequest({ params: [...currentRequest.params, newParam] });
  };

  const handleUpdateParam = (id: string, updates: Partial<KeyValue>) => {
    updateRequest({
      params: currentRequest.params.map((p) =>
        p.id === id ? { ...p, ...updates } : p
      ),
    });
  };

  const handleDeleteParam = (id: string) => {
    updateRequest({
      params: currentRequest.params.filter((p) => p.id !== id),
    });
  };

  const handleAddHeader = () => {
    const newHeader: KeyValue = {
      id: uuidv4(),
      key: '',
      value: '',
      enabled: true,
    };
    updateRequest({ headers: [...currentRequest.headers, newHeader] });
  };

  const handleUpdateHeader = (id: string, updates: Partial<KeyValue>) => {
    updateRequest({
      headers: currentRequest.headers.map((h) =>
        h.id === id ? { ...h, ...updates } : h
      ),
    });
  };

  const handleDeleteHeader = (id: string) => {
    updateRequest({
      headers: currentRequest.headers.filter((h) => h.id !== id),
    });
  };

  const handleBodyChange = (raw: string) => {
    updateRequest({
      body: { ...currentRequest.body, raw },
    });
  };

  const handleAuthChange = (auth: AuthConfigType) => {
    updateRequest({ auth });
  };

  const handleSendRequest = useCallback(async () => {
    if (!currentRequest?.url || isLoading) return;

    setLoading(true);
    const startTime = Date.now();

    toast.loading('Sending request...', { id: 'request' });

    try {
      // Get current environment variables
      const envVars: Record<string, string> = {};
      const activeEnv = getActiveEnvironment();
      if (activeEnv) {
        activeEnv.variables.filter(v => v.enabled).forEach(v => {
          envVars[v.key] = v.value;
        });
      }

      // Execute pre-request script if exists
      let preRequestResult;
      if (currentRequest.preRequestScript) {
        const executor = new ScriptExecutor(envVars, {});
        preRequestResult = await executor.executeScript(currentRequest.preRequestScript, {
          request: {
            url: currentRequest.url,
            method: currentRequest.method,
            headers: currentRequest.headers.filter(h => h.enabled).reduce((acc, h) => ({...acc, [h.key]: h.value}), {}),
            body: currentRequest.body.raw
          }
        });

        // Update environment variables if script modified them
        if (preRequestResult.success && preRequestResult.variables) {
          Object.entries(preRequestResult.variables).forEach(([key, value]) => {
            envVars[key] = value;
          });
        }

        setScriptResult({ preRequest: preRequestResult });
      }

      // Resolve environment variables
      const resolvedUrl = resolveVariables(currentRequest.url);

      // Build query params
      const params: Record<string, string> = {};
      currentRequest.params
        .filter((p) => p.enabled && p.key)
        .forEach((p) => {
          params[p.key] = resolveVariables(p.value);
        });

      // Build headers
      const headers: Record<string, string> = {};
      currentRequest.headers
        .filter((h) => h.enabled && h.key)
        .forEach((h) => {
          headers[h.key] = resolveVariables(h.value);
        });

      // Make request
      const response = await axios({
        method: currentRequest.method,
        url: resolvedUrl,
        params,
        headers,
        data: currentRequest.body.type !== 'none' ? currentRequest.body.raw : undefined,
      });

      const endTime = Date.now();

      const responseData = {
        id: uuidv4(),
        requestId: currentRequest.id,
        status: response.status,
        statusText: response.statusText,
        headers: response.headers as Record<string, string>,
        body: typeof response.data === 'string' ? response.data : JSON.stringify(response.data, null, 2),
        size: new Blob([JSON.stringify(response.data)]).size,
        time: endTime - startTime,
        timestamp: Date.now(),
      };

      // Execute test script if exists
      let testResult;
      if (currentRequest.testScript) {
        const executor = new ScriptExecutor(envVars, {});
        testResult = await executor.executeScript(currentRequest.testScript, {
          request: {
            url: currentRequest.url,
            method: currentRequest.method,
            headers: currentRequest.headers.filter(h => h.enabled).reduce((acc, h) => ({...acc, [h.key]: h.value}), {}),
            body: currentRequest.body.raw
          },
          response: {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers as Record<string, string>,
            body: response.data,
            time: endTime - startTime,
            size: responseData.size
          }
        });

        setScriptResult({ preRequest: preRequestResult, test: testResult });
      }

      setCurrentResponse(responseData);
      addHistoryItem(currentRequest, responseData);

      toast.success(`Request completed: ${response.status} ${response.statusText}`, {
        id: 'request',
        duration: 3000
      });
    } catch (error: unknown) {
      const endTime = Date.now();

      // Type guard for axios error
      const isAxiosError = (err: unknown): err is { response?: { status?: number; statusText?: string; headers?: Record<string, string>; data?: unknown }; message?: string } => {
        return typeof err === 'object' && err !== null && ('response' in err || 'message' in err);
      };

      const axiosError = isAxiosError(error) ? error : null;
      const errorMessage = error instanceof Error ? error.message : 'Request failed';

      const errorResponse = {
        id: uuidv4(),
        requestId: currentRequest.id,
        status: axiosError?.response?.status || 0,
        statusText: axiosError?.response?.statusText || 'Error',
        headers: axiosError?.response?.headers || {},
        body: axiosError?.response?.data ? JSON.stringify(axiosError.response.data, null, 2) : errorMessage,
        size: 0,
        time: endTime - startTime,
        timestamp: Date.now(),
      };

      setCurrentResponse(errorResponse);
      addHistoryItem(currentRequest, errorResponse);

      toast.error(`Request failed: ${errorMessage}`, {
        id: 'request',
        duration: 5000
      });
    } finally {
      setLoading(false);
    }
  }, [currentRequest, isLoading, setLoading, getActiveEnvironment, resolveVariables, setScriptResult, setCurrentResponse, addHistoryItem]);

  // Keyboard shortcut for sending request
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd/Ctrl + Enter to send request
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        handleSendRequest();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleSendRequest]);

  return (
    <div className="flex-1 flex flex-col border-b border-slate-blue-500/10 glass relative z-30">
      {/* Request Line */}
      <div className="p-4 border-b border-slate-blue-500/10 bg-gradient-to-r from-slate-blue-500/5 to-indigo-500/5">
        <div className="flex gap-2">
          <Select value={currentRequest.method} onValueChange={(value) => handleMethodChange(value as HttpMethod)}>
            <SelectTrigger className={cn(
              "w-32 font-mono font-semibold border-2 transition-colors glass-subtle",
              methodColors[currentRequest.method]
            )}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="glass border-slate-blue-500/20">
              <SelectItem value="GET" className="font-mono font-semibold">
                <span className="text-green-600 dark:text-green-400">GET</span>
              </SelectItem>
              <SelectItem value="POST" className="font-mono font-semibold">
                <span className="text-yellow-600 dark:text-yellow-400">POST</span>
              </SelectItem>
              <SelectItem value="PUT" className="font-mono font-semibold">
                <span className="text-blue-600 dark:text-blue-400">PUT</span>
              </SelectItem>
              <SelectItem value="DELETE" className="font-mono font-semibold">
                <span className="text-red-600 dark:text-red-400">DELETE</span>
              </SelectItem>
              <SelectItem value="PATCH" className="font-mono font-semibold">
                <span className="text-slate-blue-600 dark:text-slate-blue-400">PATCH</span>
              </SelectItem>
              <SelectItem value="OPTIONS" className="font-mono font-semibold">
                <span className="text-gray-600 dark:text-gray-400">OPTIONS</span>
              </SelectItem>
              <SelectItem value="HEAD" className="font-mono font-semibold">
                <span className="text-gray-600 dark:text-gray-400">HEAD</span>
              </SelectItem>
            </SelectContent>
          </Select>

          <div className="flex-1 relative">
            <Input
              value={currentRequest.url}
              onChange={(e) => handleUrlChange(e.target.value)}
              placeholder="Enter request URL (e.g., https://api.example.com/users)"
              className={cn(
                "w-full font-mono text-sm glass-subtle focus:border-slate-blue-500/40",
                urlError
                  ? "border-red-500/50 focus:border-red-500/70 bg-red-50/50 dark:bg-red-950/20"
                  : "border-slate-blue-500/20"
              )}
              aria-invalid={!!urlError}
              aria-describedby={urlError ? "url-error" : undefined}
            />
            {urlError && (
              <p id="url-error" className="absolute -bottom-5 left-0 text-xs text-red-600 dark:text-red-400">
                {urlError}
              </p>
            )}
          </div>

          <Button
            variant="outline"
            onClick={() => setCodeGenOpen(true)}
            disabled={!currentRequest.url}
            className="glass-subtle border-slate-blue-500/20 shadow-sm hover:shadow-glass hover:border-slate-blue-500/40 transition-all"
            aria-label="Generate code"
          >
            <Code2 className="mr-2 h-4 w-4" />
            Code
          </Button>

          <Button
            onClick={handleSendRequest}
            disabled={isLoading || !currentRequest.url || !!urlError}
            className="min-w-[120px] bg-gradient-to-r from-slate-blue-600 to-indigo-600 hover:from-slate-blue-700 hover:to-indigo-700 shadow-lg shadow-slate-blue-500/25 hover:shadow-slate-blue-500/40 transition-all"
            aria-label={isLoading ? "Sending request" : "Send request"}
          >
            {isLoading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Send className="mr-2 h-4 w-4" />
            )}
            {isLoading ? 'Sending...' : 'Send'}
            {!isLoading && (
              <kbd className="ml-2 pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border bg-white/20 px-1.5 font-mono text-[10px] font-medium opacity-70">
                ⌘↵
              </kbd>
            )}
          </Button>
        </div>
      </div>

      {/* Code Generator Dialog */}
      <CodeGeneratorDialog
        open={codeGenOpen}
        onOpenChange={setCodeGenOpen}
        request={currentRequest}
      />

      {/* Request Details Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col">
        <TabsList className="w-full rounded-none border-b border-slate-200 dark:border-slate-700 bg-transparent px-4 h-12">
          <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <TabsTrigger value="params" className="relative data-[state=active]:border-b-2 data-[state=active]:border-slate-blue-500 data-[state=active]:text-slate-blue-600 dark:data-[state=active]:text-slate-blue-400 transition-all duration-200">
                Params
                {currentRequest.params.filter(p => p.enabled && p.key).length > 0 && (
                  <span className="ml-1.5 inline-flex items-center justify-center h-4 min-w-4 px-1 text-[11px] font-medium rounded bg-slate-blue-100 dark:bg-slate-blue-900/40 text-slate-blue-700 dark:text-slate-blue-300 tabular-nums">
                    {currentRequest.params.filter(p => p.enabled && p.key).length}
                  </span>
                )}
              </TabsTrigger>
            </TooltipTrigger>
            <TooltipContent>
              <p>Query Parameters (⌥1)</p>
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <TabsTrigger value="headers" className="relative data-[state=active]:border-b-2 data-[state=active]:border-slate-blue-500 data-[state=active]:text-slate-blue-600 dark:data-[state=active]:text-slate-blue-400 transition-all duration-200">
                Headers
                {currentRequest.headers.filter(h => h.enabled && h.key).length > 0 && (
                  <span className="ml-1.5 inline-flex items-center justify-center h-4 min-w-4 px-1 text-[11px] font-medium rounded bg-slate-blue-100 dark:bg-slate-blue-900/40 text-slate-blue-700 dark:text-slate-blue-300 tabular-nums">
                    {currentRequest.headers.filter(h => h.enabled && h.key).length}
                  </span>
                )}
              </TabsTrigger>
            </TooltipTrigger>
            <TooltipContent>
              <p>Request Headers (⌥2)</p>
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <TabsTrigger value="body" className="relative data-[state=active]:border-b-2 data-[state=active]:border-slate-blue-500 data-[state=active]:text-slate-blue-600 dark:data-[state=active]:text-slate-blue-400 transition-all duration-200">
                Body
                {currentRequest.body.type !== 'none' && currentRequest.body.raw && (
                  <span className="ml-1.5 h-2 w-2 rounded-full bg-emerald-500" />
                )}
              </TabsTrigger>
            </TooltipTrigger>
            <TooltipContent>
              <p>Request Body (⌥3)</p>
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <TabsTrigger value="auth" className="relative data-[state=active]:border-b-2 data-[state=active]:border-slate-blue-500 data-[state=active]:text-slate-blue-600 dark:data-[state=active]:text-slate-blue-400 transition-all duration-200">
                Auth
                {currentRequest.auth.type !== 'none' && (
                  <span className="ml-1.5 h-2 w-2 rounded-full bg-emerald-500" />
                )}
              </TabsTrigger>
            </TooltipTrigger>
            <TooltipContent>
              <p>Authentication (⌥4)</p>
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <TabsTrigger value="scripts" className="relative data-[state=active]:border-b-2 data-[state=active]:border-slate-blue-500 data-[state=active]:text-slate-blue-600 dark:data-[state=active]:text-slate-blue-400 transition-all duration-200">
                Scripts
                {(currentRequest.preRequestScript || currentRequest.testScript) && (
                  <span className="ml-1.5 h-2 w-2 rounded-full bg-amber-500" />
                )}
              </TabsTrigger>
            </TooltipTrigger>
            <TooltipContent>
              <p>Pre-request & Test Scripts (⌥5)</p>
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <TabsTrigger value="settings" className="flex items-center gap-1 data-[state=active]:border-b-2 data-[state=active]:border-slate-blue-500 data-[state=active]:text-slate-blue-600 dark:data-[state=active]:text-slate-blue-400 transition-all duration-200">
                <Settings className="h-3.5 w-3.5" />
                Settings
                {currentRequest.settings && (
                  <span className="ml-1.5 h-2 w-2 rounded-full bg-blue-500" />
                )}
              </TabsTrigger>
            </TooltipTrigger>
            <TooltipContent>
              <p>Request Settings (⌥6)</p>
            </TooltipContent>
          </Tooltip>
          </TooltipProvider>
        </TabsList>

        <TabsContent value="params" className="flex-1 overflow-auto p-4">
          <TooltipProvider delayDuration={300}>
            <div className="space-y-3">
              {currentRequest.params.map((param) => (
                <div key={param.id} className="flex items-center gap-3 group p-2 rounded-lg hover:bg-slate-blue-500/5 transition-colors">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div>
                        <Switch
                          checked={param.enabled}
                          onCheckedChange={(checked) => handleUpdateParam(param.id, { enabled: checked })}
                          className="data-[state=checked]:bg-slate-blue-600"
                        />
                      </div>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{param.enabled ? 'Disable parameter' : 'Enable parameter'}</p>
                    </TooltipContent>
                  </Tooltip>
                  <Input
                    value={param.key}
                    onChange={(e) => handleUpdateParam(param.id, { key: e.target.value })}
                    placeholder="Key"
                    className="flex-1 glass-subtle border-slate-blue-500/20 focus:border-slate-blue-500/40 transition-colors"
                  />
                  <Input
                    value={param.value}
                    onChange={(e) => handleUpdateParam(param.id, { value: e.target.value })}
                    placeholder="Value"
                    className="flex-1 glass-subtle border-slate-blue-500/20 focus:border-slate-blue-500/40 transition-colors"
                  />
                  <AlertDialog>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="opacity-0 group-hover:opacity-100 transition-opacity text-destructive hover:text-destructive hover:bg-destructive/10"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </AlertDialogTrigger>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>Delete parameter</p>
                      </TooltipContent>
                    </Tooltip>
                    <AlertDialogContent className="glass">
                      <AlertDialogHeader>
                        <AlertDialogTitle>Delete Parameter</AlertDialogTitle>
                        <AlertDialogDescription>
                          Are you sure you want to delete this parameter? This action cannot be undone.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => handleDeleteParam(param.id)}
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        >
                          Delete
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              ))}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button onClick={handleAddParam} variant="outline" size="sm" className="glass-subtle border-slate-blue-500/20 hover:border-slate-blue-500/40 transition-all">
                    <Plus className="mr-2 h-4 w-4" />
                    Add Param
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Add new query parameter</p>
                </TooltipContent>
              </Tooltip>
            </div>
          </TooltipProvider>
        </TabsContent>

        <TabsContent value="headers" className="flex-1 overflow-auto p-4">
          <TooltipProvider delayDuration={300}>
            <div className="space-y-3">
              {currentRequest.headers.map((header) => (
                <div key={header.id} className="flex items-center gap-3 group p-2 rounded-lg hover:bg-slate-blue-500/5 transition-colors">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div>
                        <Switch
                          checked={header.enabled}
                          onCheckedChange={(checked) => handleUpdateHeader(header.id, { enabled: checked })}
                          className="data-[state=checked]:bg-slate-blue-600"
                        />
                      </div>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{header.enabled ? 'Disable header' : 'Enable header'}</p>
                    </TooltipContent>
                  </Tooltip>
                  <Input
                    value={header.key}
                    onChange={(e) => handleUpdateHeader(header.id, { key: e.target.value })}
                    placeholder="Key"
                    className="flex-1 glass-subtle border-slate-blue-500/20 focus:border-slate-blue-500/40 transition-colors"
                  />
                  <Input
                    value={header.value}
                    onChange={(e) => handleUpdateHeader(header.id, { value: e.target.value })}
                    placeholder="Value"
                    className="flex-1 glass-subtle border-slate-blue-500/20 focus:border-slate-blue-500/40 transition-colors"
                  />
                  <AlertDialog>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="opacity-0 group-hover:opacity-100 transition-opacity text-destructive hover:text-destructive hover:bg-destructive/10"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </AlertDialogTrigger>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>Delete header</p>
                      </TooltipContent>
                    </Tooltip>
                    <AlertDialogContent className="glass">
                      <AlertDialogHeader>
                        <AlertDialogTitle>Delete Header</AlertDialogTitle>
                        <AlertDialogDescription>
                          Are you sure you want to delete this header? This action cannot be undone.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => handleDeleteHeader(header.id)}
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        >
                          Delete
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              ))}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button onClick={handleAddHeader} variant="outline" size="sm" className="glass-subtle border-slate-blue-500/20 hover:border-slate-blue-500/40 transition-all">
                    <Plus className="mr-2 h-4 w-4" />
                    Add Header
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Add new request header</p>
                </TooltipContent>
              </Tooltip>
            </div>
          </TooltipProvider>
        </TabsContent>

        <TabsContent value="body" className="flex-1 overflow-auto p-4">
          <div className="space-y-4">
            <Select
              value={currentRequest.body.type}
              onValueChange={(value) =>
                updateRequest({ body: { ...currentRequest.body, type: value as typeof currentRequest.body.type } })
              }
            >
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                <SelectItem value="json">JSON</SelectItem>
                <SelectItem value="xml">XML</SelectItem>
                <SelectItem value="text">Text</SelectItem>
                <SelectItem value="form-data">Form Data</SelectItem>
                <SelectItem value="x-www-form-urlencoded">x-www-form-urlencoded</SelectItem>
              </SelectContent>
            </Select>

            {currentRequest.body.type !== 'none' && (
              <CodeEditor
                value={currentRequest.body.raw || ''}
                onChange={handleBodyChange}
                language={currentRequest.body.type}
                height="300px"
              />
            )}
          </div>
        </TabsContent>

        <TabsContent value="auth" className="flex-1 overflow-auto p-4">
          <AuthConfiguration auth={currentRequest.auth} onChange={handleAuthChange} />
        </TabsContent>

        <TabsContent value="scripts" className="flex-1 overflow-auto p-4">
          <div className="space-y-4">
            <Tabs value={scriptTab} onValueChange={(v) => setScriptTab(v as 'pre-request' | 'test')}>
              <TabsList>
                <TabsTrigger value="pre-request">Pre-request Script</TabsTrigger>
                <TabsTrigger value="test">Test Script</TabsTrigger>
              </TabsList>

              <TabsContent value="pre-request" className="space-y-2 mt-4">
                <div className="text-sm text-muted-foreground mb-2">
                  Execute JavaScript code before sending the request. Use <code className="bg-muted px-1 rounded">pm.variables.set()</code> to set variables.
                </div>
                <CodeEditor
                  value={currentRequest.preRequestScript || ''}
                  onChange={(value) => updateRequest({ preRequestScript: value })}
                  language="javascript"
                  height="400px"
                />
              </TabsContent>

              <TabsContent value="test" className="space-y-2 mt-4">
                <div className="text-sm text-muted-foreground mb-2">
                  Execute JavaScript code after receiving the response. Use <code className="bg-muted px-1 rounded">pm.test()</code> and <code className="bg-muted px-1 rounded">pm.expect()</code> for assertions.
                </div>
                <CodeEditor
                  value={currentRequest.testScript || ''}
                  onChange={(value) => updateRequest({ testScript: value })}
                  language="javascript"
                  height="400px"
                />
              </TabsContent>
            </Tabs>
          </div>
        </TabsContent>

        <TabsContent value="settings" className="flex-1 overflow-auto p-4">
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-base font-medium">Override Global Settings</Label>
                <p className="text-sm text-muted-foreground">
                  Customize settings for this specific request
                </p>
              </div>
              <Switch
                checked={!!currentRequest.settings}
                onCheckedChange={(checked) => {
                  if (checked) {
                    handleSettingsChange({});
                  } else {
                    updateRequest({ settings: undefined });
                  }
                }}
              />
            </div>

            {currentRequest.settings && (
              <>
                {/* Timeout */}
                <div className="space-y-2">
                  <Label>Request Timeout (ms)</Label>
                  <Input
                    type="number"
                    value={getEffectiveSettings().timeout}
                    onChange={(e) =>
                      handleSettingsChange({ timeout: parseInt(e.target.value) || 30000 })
                    }
                    min={1000}
                    max={600000}
                    step={1000}
                    className="w-48"
                  />
                  <p className="text-xs text-muted-foreground">
                    Current: {(getEffectiveSettings().timeout / 1000).toFixed(0)}s
                  </p>
                </div>

                {/* Follow Redirects */}
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Follow Redirects</Label>
                    <p className="text-sm text-muted-foreground">
                      Automatically follow HTTP redirects
                    </p>
                  </div>
                  <Switch
                    checked={getEffectiveSettings().followRedirects}
                    onCheckedChange={(followRedirects) => handleSettingsChange({ followRedirects })}
                  />
                </div>

                {getEffectiveSettings().followRedirects && (
                  <div className="space-y-2">
                    <Label>Max Redirects</Label>
                    <Input
                      type="number"
                      value={getEffectiveSettings().maxRedirects}
                      onChange={(e) =>
                        handleSettingsChange({ maxRedirects: parseInt(e.target.value) || 10 })
                      }
                      min={1}
                      max={50}
                      className="w-32"
                    />
                  </div>
                )}

                {/* SSL Verification */}
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Verify SSL Certificates</Label>
                    <p className="text-sm text-muted-foreground">
                      Validate SSL/TLS certificates
                    </p>
                  </div>
                  <Switch
                    checked={getEffectiveSettings().verifySsl}
                    onCheckedChange={(verifySsl) => handleSettingsChange({ verifySsl })}
                  />
                </div>

                {/* Proxy Override */}
                <div className="space-y-4 rounded-lg border p-4">
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label className="text-base font-medium">Custom Proxy for this Request</Label>
                      <p className="text-sm text-muted-foreground">
                        Override global proxy settings
                      </p>
                    </div>
                    <Switch
                      checked={!!currentRequest.settings?.proxy}
                      onCheckedChange={handleProxyOverrideChange}
                    />
                  </div>

                  {currentRequest.settings?.proxy && (
                    <div className="space-y-4 mt-4">
                      <div className="flex items-center justify-between">
                        <Label>Enable Proxy</Label>
                        <Switch
                          checked={currentRequest.settings.proxy.enabled}
                          onCheckedChange={(enabled) =>
                            handleSettingsChange({
                              proxy: { ...currentRequest.settings!.proxy!, enabled },
                            })
                          }
                        />
                      </div>

                      {currentRequest.settings.proxy.enabled && (
                        <>
                          <div className="grid grid-cols-3 gap-4">
                            <div className="col-span-2 space-y-2">
                              <Label>Proxy Host</Label>
                              <Input
                                value={currentRequest.settings.proxy.host}
                                onChange={(e) =>
                                  handleSettingsChange({
                                    proxy: { ...currentRequest.settings!.proxy!, host: e.target.value },
                                  })
                                }
                                placeholder="proxy.example.com"
                              />
                            </div>
                            <div className="space-y-2">
                              <Label>Port</Label>
                              <Input
                                type="number"
                                value={currentRequest.settings.proxy.port}
                                onChange={(e) =>
                                  handleSettingsChange({
                                    proxy: {
                                      ...currentRequest.settings!.proxy!,
                                      port: parseInt(e.target.value) || 8080,
                                    },
                                  })
                                }
                                placeholder="8080"
                                min={1}
                                max={65535}
                              />
                            </div>
                          </div>

                          <div className="rounded-lg bg-muted/50 p-3">
                            <p className="text-xs text-muted-foreground">
                              <strong>Proxy URL:</strong>{' '}
                              <code>
                                {currentRequest.settings.proxy.type}://
                                {currentRequest.settings.proxy.host}:
                                {currentRequest.settings.proxy.port}
                              </code>
                            </p>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </>
            )}

            {!currentRequest.settings && (
              <div className="rounded-lg bg-muted/50 p-4">
                <p className="text-sm text-muted-foreground">
                  Using global settings. Enable override above to customize for this request.
                </p>
                <div className="mt-2 space-y-1 text-xs">
                  <p>
                    <strong>Timeout:</strong> {(globalSettings.defaultTimeout / 1000).toFixed(0)}s
                  </p>
                  <p>
                    <strong>Follow Redirects:</strong> {globalSettings.followRedirects ? 'Yes' : 'No'}
                  </p>
                  <p>
                    <strong>Verify SSL:</strong> {globalSettings.verifySsl ? 'Yes' : 'No'}
                  </p>
                  <p>
                    <strong>Proxy:</strong>{' '}
                    {globalSettings.proxy.enabled
                      ? `${globalSettings.proxy.type}://${globalSettings.proxy.host}:${globalSettings.proxy.port}`
                      : 'Disabled'}
                  </p>
                </div>
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
