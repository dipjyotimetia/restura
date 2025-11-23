'use client';

import { useState, useEffect, useCallback } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useRequestStore } from '@/store/useRequestStore';
import { useHistoryStore } from '@/store/useHistoryStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useConsoleStore, createConsoleEntry } from '@/store/useConsoleStore';
import { HttpMethod, AuthConfig as AuthConfigType, RequestSettings, RequestBody } from '@/types';
import { Settings } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import axios, { AxiosProxyConfig } from 'axios';
import AuthConfiguration from '@/features/auth/components/AuthConfig';
import ScriptExecutor from '@/features/scripts/lib/scriptExecutor';
import CodeGeneratorDialog from '@/components/shared/CodeGeneratorDialog';
import { useSettingsStore } from '@/store/useSettingsStore';
import { toast } from 'sonner';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useKeyValueCollection } from '@/hooks/useKeyValueCollection';
import { withErrorBoundary } from '@/components/shared/ErrorBoundary';

// New modular components
import KeyValueEditor from '@/components/shared/KeyValueEditor';
import RequestBodyEditor from '@/features/http/components/RequestBodyEditor';
import ScriptsEditor from '@/features/scripts/components/ScriptsEditor';
import RequestSettingsEditor from '@/features/http/components/RequestSettingsEditor';
import RequestLine from '@/features/http/components/RequestLine';

function RequestBuilder() {
  const { currentRequest, updateRequest, setLoading, setCurrentResponse, isLoading, setScriptResult } =
    useRequestStore();
  const { addHistoryItem } = useHistoryStore();
  const { resolveVariables, getActiveEnvironment } = useEnvironmentStore();
  const { settings: globalSettings } = useSettingsStore();
  const { addEntry } = useConsoleStore();
  const [activeTab, setActiveTab] = useState('params');
  const [codeGenOpen, setCodeGenOpen] = useState(false);

  // Check if we have a valid HTTP request
  const isHttpRequest = currentRequest?.type === 'http';
  const httpRequest = isHttpRequest ? currentRequest : null;

  // Use shared hooks for key-value collection management
  // These must be called unconditionally to follow Rules of Hooks
  const {
    handleAdd: handleAddParam,
    handleUpdate: handleUpdateParam,
    handleDelete: handleDeleteParam,
  } = useKeyValueCollection(
    httpRequest?.params ?? [],
    (params) => updateRequest({ params })
  );

  const {
    handleAdd: handleAddHeader,
    handleUpdate: handleUpdateHeader,
    handleDelete: handleDeleteHeader,
  } = useKeyValueCollection(
    httpRequest?.headers ?? [],
    (headers) => updateRequest({ headers })
  );

  // Keyboard shortcuts for tab switching
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

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

  // Early return after all hooks
  if (!httpRequest) {
    return null;
  }

  // Settings handlers - memoized for performance
  const getEffectiveSettings = useCallback((): RequestSettings => {
    return (
      httpRequest.settings || {
        timeout: globalSettings.defaultTimeout,
        followRedirects: globalSettings.followRedirects,
        maxRedirects: globalSettings.maxRedirects,
        verifySsl: globalSettings.verifySsl,
        proxy: globalSettings.proxy,
      }
    );
  }, [httpRequest.settings, globalSettings]);

  const handleSettingsChange = (updates: Partial<RequestSettings>) => {
    const currentSettings = httpRequest.settings || getEffectiveSettings();
    updateRequest({
      settings: { ...currentSettings, ...updates },
    });
  };

  const handleToggleOverride = (enabled: boolean) => {
    if (enabled) {
      handleSettingsChange({});
    } else {
      updateRequest({ settings: undefined });
    }
  };

  const handleProxyOverrideChange = (useOverride: boolean) => {
    if (useOverride) {
      handleSettingsChange({
        proxy: { ...globalSettings.proxy },
      });
    } else {
      const currentSettings = httpRequest.settings;
      if (currentSettings) {
        const { proxy: _, ...rest } = currentSettings;
        updateRequest({ settings: { ...rest, proxy: undefined } });
      }
    }
  };

  // Request handlers
  const handleMethodChange = (method: HttpMethod) => {
    updateRequest({ method });
  };

  const handleUrlChange = (url: string) => {
    updateRequest({ url });
  };

  // Body handlers
  const handleBodyTypeChange = (type: RequestBody['type']) => {
    updateRequest({ body: { ...httpRequest.body, type } });
  };

  const handleBodyContentChange = (raw: string) => {
    updateRequest({
      body: { ...httpRequest.body, raw },
    });
  };

  // Auth handler
  const handleAuthChange = (auth: AuthConfigType) => {
    updateRequest({ auth });
  };

  // Scripts handlers
  const handlePreRequestScriptChange = (script: string) => {
    updateRequest({ preRequestScript: script });
  };

  const handleTestScriptChange = (script: string) => {
    updateRequest({ testScript: script });
  };

  // Send request handler
  const handleSendRequest = useCallback(async () => {
    if (!httpRequest?.url || isLoading) return;

    setLoading(true);
    const startTime = Date.now();

    toast.loading('Sending request...', { id: 'request' });

    try {
      const envVars: Record<string, string> = {};
      const activeEnv = getActiveEnvironment();
      if (activeEnv) {
        activeEnv.variables
          .filter((v) => v.enabled)
          .forEach((v) => {
            envVars[v.key] = v.value;
          });
      }

      let preRequestResult;
      if (httpRequest.preRequestScript) {
        const executor = new ScriptExecutor(envVars, {});
        preRequestResult = await executor.executeScript(httpRequest.preRequestScript, {
          request: {
            url: httpRequest.url,
            method: httpRequest.method,
            headers: httpRequest.headers
              .filter((h) => h.enabled)
              .reduce((acc, h) => ({ ...acc, [h.key]: h.value }), {}),
            body: httpRequest.body.raw,
          },
        });

        if (preRequestResult.success && preRequestResult.variables) {
          Object.entries(preRequestResult.variables).forEach(([key, value]) => {
            envVars[key] = value;
          });
        }

        setScriptResult({ preRequest: preRequestResult });
      }

      const resolvedUrl = resolveVariables(httpRequest.url);

      const params: Record<string, string> = {};
      httpRequest.params
        .filter((p) => p.enabled && p.key)
        .forEach((p) => {
          params[p.key] = resolveVariables(p.value);
        });

      const headers: Record<string, string> = {};
      httpRequest.headers
        .filter((h) => h.enabled && h.key)
        .forEach((h) => {
          headers[h.key] = resolveVariables(h.value);
        });

      // Get effective settings (merge request-specific with global settings)
      const effectiveSettings = getEffectiveSettings();

      // Configure proxy if enabled
      let proxyConfig: AxiosProxyConfig | false = false;
      if (effectiveSettings.proxy?.enabled) {
        proxyConfig = {
          host: effectiveSettings.proxy.host,
          port: effectiveSettings.proxy.port,
          protocol: effectiveSettings.proxy.type,
          ...(effectiveSettings.proxy.auth && {
            auth: {
              username: effectiveSettings.proxy.auth.username,
              password: effectiveSettings.proxy.auth.password,
            },
          }),
        };
      }

      const response = await axios({
        method: httpRequest.method,
        url: resolvedUrl,
        params,
        headers,
        data: httpRequest.body.type !== 'none' ? httpRequest.body.raw : undefined,
        timeout: effectiveSettings.timeout,
        maxRedirects: effectiveSettings.followRedirects ? effectiveSettings.maxRedirects : 0,
        proxy: proxyConfig,
        // Always capture response status (don't throw on non-2xx)
        validateStatus: () => true,
      });

      const endTime = Date.now();

      const bodyContent = typeof response.data === 'string'
        ? response.data
        : JSON.stringify(response.data, null, 2);
      const responseData = {
        id: uuidv4(),
        requestId: httpRequest.id,
        status: response.status,
        statusText: response.statusText,
        headers: response.headers as Record<string, string | string[]>,
        body: bodyContent,
        size: new Blob([bodyContent]).size,
        time: endTime - startTime,
        timestamp: Date.now(),
      };

      let testResult;
      if (httpRequest.testScript) {
        const executor = new ScriptExecutor(envVars, {});
        testResult = await executor.executeScript(httpRequest.testScript, {
          request: {
            url: httpRequest.url,
            method: httpRequest.method,
            headers: httpRequest.headers
              .filter((h) => h.enabled)
              .reduce((acc, h) => ({ ...acc, [h.key]: h.value }), {}),
            body: httpRequest.body.raw,
          },
          response: {
            status: response.status,
            statusText: response.statusText,
            headers: Object.fromEntries(
              Object.entries(response.headers).map(([key, value]) => [
                key,
                Array.isArray(value) ? value.join(', ') : value
              ])
            ),
            body: response.data,
            time: endTime - startTime,
            size: responseData.size,
          },
        });

        setScriptResult({ preRequest: preRequestResult, test: testResult });
      }

      setCurrentResponse(responseData);
      addHistoryItem(httpRequest, responseData);

      // Add to console
      const scriptLogs = [
        ...(preRequestResult?.logs || []),
        ...(testResult?.logs || []),
      ];
      const consoleEntry = createConsoleEntry(
        httpRequest,
        responseData,
        headers,
        scriptLogs,
        testResult?.tests
      );
      addEntry(consoleEntry);

      toast.success(`Request completed: ${response.status} ${response.statusText}`, {
        id: 'request',
        duration: 3000,
      });
    } catch (error: unknown) {
      const endTime = Date.now();

      const isAxiosError = (
        err: unknown
      ): err is {
        response?: { status?: number; statusText?: string; headers?: Record<string, string | string[]>; data?: unknown };
        message?: string;
      } => {
        return typeof err === 'object' && err !== null && ('response' in err || 'message' in err);
      };

      const axiosError = isAxiosError(error) ? error : null;
      const errorMessage = error instanceof Error ? error.message : 'Request failed';

      const errorBody = axiosError?.response?.data
        ? JSON.stringify(axiosError.response.data, null, 2)
        : errorMessage;
      const errorResponse = {
        id: uuidv4(),
        requestId: httpRequest.id,
        status: axiosError?.response?.status || 0,
        statusText: axiosError?.response?.statusText || 'Error',
        headers: axiosError?.response?.headers || {},
        body: errorBody,
        size: new Blob([errorBody]).size,
        time: endTime - startTime,
        timestamp: Date.now(),
      };

      setCurrentResponse(errorResponse);
      addHistoryItem(httpRequest, errorResponse);

      // Add to console (error case - headers may not be available)
      const consoleEntry = createConsoleEntry(
        httpRequest,
        errorResponse,
        {},
        [],
        undefined
      );
      addEntry(consoleEntry);

      toast.error(`Request failed: ${errorMessage}`, {
        id: 'request',
        duration: 5000,
      });
    } finally {
      setLoading(false);
    }
  }, [
    httpRequest,
    isLoading,
    setLoading,
    getActiveEnvironment,
    resolveVariables,
    setScriptResult,
    setCurrentResponse,
    addHistoryItem,
    getEffectiveSettings,
    addEntry,
  ]);

  // Keyboard shortcut for sending request
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        handleSendRequest();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleSendRequest]);

  return (
    <div className="flex-1 flex flex-col border-b border-border bg-background relative z-30">
      {/* Request Line */}
      <RequestLine
        method={httpRequest.method}
        url={httpRequest.url}
        isLoading={isLoading}
        onMethodChange={handleMethodChange}
        onUrlChange={handleUrlChange}
        onSend={handleSendRequest}
        onOpenCodeGen={() => setCodeGenOpen(true)}
      />

      {/* Code Generator Dialog */}
      <CodeGeneratorDialog open={codeGenOpen} onOpenChange={setCodeGenOpen} request={httpRequest} />

      {/* Request Details Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col overflow-hidden">
        <div className="px-3 lg:px-4 py-1.5 lg:py-2 border-b border-border/40">
          <TabsList className="w-full justify-start h-8 lg:h-10 bg-muted p-0.5 lg:p-1 border border-border/50">
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <TabsTrigger value="params" className="flex-1 sm:flex-none text-[10px] lg:text-xs px-2 lg:px-3">
                      Params
                      {httpRequest.params.filter((p) => p.enabled && p.key).length > 0 && (
                        <span className="ml-1.5 inline-flex items-center justify-center h-4 min-w-4 px-1 text-[10px] font-bold rounded-full bg-primary/10 text-primary tabular-nums">
                          {httpRequest.params.filter((p) => p.enabled && p.key).length}
                        </span>
                      )}
                    </TabsTrigger>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Query Parameters (⌥1)</p>
                </TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <TabsTrigger value="headers" className="flex-1 sm:flex-none text-[10px] lg:text-xs px-2 lg:px-3 border-r border-border/50 lg:pr-3 lg:mr-1">
                      Headers
                      {httpRequest.headers.filter((h) => h.enabled && h.key).length > 0 && (
                        <span className="ml-1.5 inline-flex items-center justify-center h-4 min-w-4 px-1 text-[10px] font-bold rounded-full bg-primary/10 text-primary tabular-nums">
                          {httpRequest.headers.filter((h) => h.enabled && h.key).length}
                        </span>
                      )}
                    </TabsTrigger>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Request Headers (⌥2)</p>
                </TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <TabsTrigger value="body" className="flex-1 sm:flex-none text-[10px] lg:text-xs px-2 lg:px-3">
                      Body
                      {httpRequest.body.type !== 'none' && httpRequest.body.raw && (
                        <span className="ml-2 h-1.5 w-1.5 rounded-full bg-emerald-500 ring-2 ring-emerald-500/20" />
                      )}
                    </TabsTrigger>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Request Body (⌥3)</p>
                </TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <TabsTrigger value="auth" className="flex-1 sm:flex-none text-[10px] lg:text-xs px-2 lg:px-3 border-r border-border/50 lg:pr-3 lg:mr-1">
                      Auth
                      {httpRequest.auth.type !== 'none' && (
                        <span className="ml-2 h-1.5 w-1.5 rounded-full bg-emerald-500 ring-2 ring-emerald-500/20" />
                      )}
                    </TabsTrigger>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Authentication (⌥4)</p>
                </TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <TabsTrigger value="scripts" className="flex-1 sm:flex-none text-[10px] lg:text-xs px-2 lg:px-3">
                      Scripts
                      {(httpRequest.preRequestScript || httpRequest.testScript) && (
                        <span className="ml-2 h-1.5 w-1.5 rounded-full bg-amber-500 ring-2 ring-amber-500/20" />
                      )}
                    </TabsTrigger>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Pre-request & Test Scripts (⌥5)</p>
                </TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <TabsTrigger value="settings" className="flex-1 sm:flex-none text-[10px] lg:text-xs px-2 lg:px-3">
                      <Settings className="h-3 w-3 lg:h-3.5 lg:w-3.5 mr-1 lg:mr-1.5 opacity-70" />
                      Settings
                      {httpRequest.settings && <span className="ml-2 h-1.5 w-1.5 rounded-full bg-blue-500 ring-2 ring-blue-500/20" />}
                    </TabsTrigger>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Request Settings (⌥6)</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </TabsList>
        </div>

        <TabsContent value="params" className="flex-1 overflow-auto p-4">
          <KeyValueEditor
            items={httpRequest.params}
            onAdd={handleAddParam}
            onUpdate={handleUpdateParam}
            onDelete={handleDeleteParam}
            keyPlaceholder="Parameter name"
            valuePlaceholder="Parameter value"
            addButtonText="Add Param"
            itemType="parameter"
          />
        </TabsContent>

        <TabsContent value="headers" className="flex-1 overflow-auto p-4">
          <KeyValueEditor
            items={httpRequest.headers}
            onAdd={handleAddHeader}
            onUpdate={handleUpdateHeader}
            onDelete={handleDeleteHeader}
            keyPlaceholder="Header name"
            valuePlaceholder="Header value"
            addButtonText="Add Header"
            itemType="header"
          />
        </TabsContent>

        <TabsContent value="body" className="flex-1 overflow-auto p-4">
          <RequestBodyEditor
            body={httpRequest.body}
            onBodyTypeChange={handleBodyTypeChange}
            onBodyContentChange={handleBodyContentChange}
            url={httpRequest.url}
          />
        </TabsContent>

        <TabsContent value="auth" className="flex-1 overflow-auto p-4">
          <AuthConfiguration auth={httpRequest.auth} onChange={handleAuthChange} />
        </TabsContent>

        <TabsContent value="scripts" className="flex-1 overflow-auto p-4">
          <ScriptsEditor
            preRequestScript={httpRequest.preRequestScript || ''}
            testScript={httpRequest.testScript || ''}
            onPreRequestScriptChange={handlePreRequestScriptChange}
            onTestScriptChange={handleTestScriptChange}
          />
        </TabsContent>

        <TabsContent value="settings" className="flex-1 overflow-auto p-4">
          <RequestSettingsEditor
            settings={httpRequest.settings}
            globalSettings={globalSettings}
            onSettingsChange={handleSettingsChange}
            onToggleOverride={handleToggleOverride}
            onProxyOverrideChange={handleProxyOverrideChange}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default withErrorBoundary(RequestBuilder);
