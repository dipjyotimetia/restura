'use client';

import { useState, useEffect, useCallback } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useRequestStore } from '@/store/useRequestStore';
import { useHistoryStore } from '@/store/useHistoryStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { HttpMethod, KeyValue, AuthConfig as AuthConfigType, RequestSettings, RequestBody } from '@/types';
import { Settings } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import axios, { AxiosProxyConfig } from 'axios';
import https from 'https';
import AuthConfiguration from '@/components/AuthConfig';
import ScriptExecutor from '@/lib/scriptExecutor';
import CodeGeneratorDialog from '@/components/CodeGeneratorDialog';
import { useSettingsStore } from '@/store/useSettingsStore';
import { toast } from 'sonner';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

// New modular components
import KeyValueEditor, { createKeyValueItem } from '@/components/KeyValueEditor';
import RequestBodyEditor from '@/components/RequestBodyEditor';
import ScriptsEditor from '@/components/ScriptsEditor';
import RequestSettingsEditor from '@/components/RequestSettingsEditor';
import RequestLine from '@/components/RequestLine';

export default function RequestBuilder() {
  const { currentRequest, updateRequest, setLoading, setCurrentResponse, isLoading, setScriptResult } =
    useRequestStore();
  const { addHistoryItem } = useHistoryStore();
  const { resolveVariables, getActiveEnvironment } = useEnvironmentStore();
  const { settings: globalSettings } = useSettingsStore();
  const [activeTab, setActiveTab] = useState('params');
  const [codeGenOpen, setCodeGenOpen] = useState(false);

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

  if (!currentRequest || currentRequest.type !== 'http') {
    return null;
  }

  // Settings handlers
  const getEffectiveSettings = (): RequestSettings => {
    return (
      currentRequest.settings || {
        timeout: globalSettings.defaultTimeout,
        followRedirects: globalSettings.followRedirects,
        maxRedirects: globalSettings.maxRedirects,
        verifySsl: globalSettings.verifySsl,
        proxy: globalSettings.proxy,
      }
    );
  };

  const handleSettingsChange = (updates: Partial<RequestSettings>) => {
    const currentSettings = currentRequest.settings || getEffectiveSettings();
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
      const currentSettings = currentRequest.settings;
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

  // Params handlers
  const handleAddParam = () => {
    updateRequest({ params: [...currentRequest.params, createKeyValueItem()] });
  };

  const handleUpdateParam = (id: string, updates: Partial<KeyValue>) => {
    updateRequest({
      params: currentRequest.params.map((p) => (p.id === id ? { ...p, ...updates } : p)),
    });
  };

  const handleDeleteParam = (id: string) => {
    updateRequest({
      params: currentRequest.params.filter((p) => p.id !== id),
    });
  };

  // Headers handlers
  const handleAddHeader = () => {
    updateRequest({ headers: [...currentRequest.headers, createKeyValueItem()] });
  };

  const handleUpdateHeader = (id: string, updates: Partial<KeyValue>) => {
    updateRequest({
      headers: currentRequest.headers.map((h) => (h.id === id ? { ...h, ...updates } : h)),
    });
  };

  const handleDeleteHeader = (id: string) => {
    updateRequest({
      headers: currentRequest.headers.filter((h) => h.id !== id),
    });
  };

  // Body handlers
  const handleBodyTypeChange = (type: RequestBody['type']) => {
    updateRequest({ body: { ...currentRequest.body, type } });
  };

  const handleBodyContentChange = (raw: string) => {
    updateRequest({
      body: { ...currentRequest.body, raw },
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
    if (!currentRequest?.url || isLoading) return;

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
      if (currentRequest.preRequestScript) {
        const executor = new ScriptExecutor(envVars, {});
        preRequestResult = await executor.executeScript(currentRequest.preRequestScript, {
          request: {
            url: currentRequest.url,
            method: currentRequest.method,
            headers: currentRequest.headers
              .filter((h) => h.enabled)
              .reduce((acc, h) => ({ ...acc, [h.key]: h.value }), {}),
            body: currentRequest.body.raw,
          },
        });

        if (preRequestResult.success && preRequestResult.variables) {
          Object.entries(preRequestResult.variables).forEach(([key, value]) => {
            envVars[key] = value;
          });
        }

        setScriptResult({ preRequest: preRequestResult });
      }

      const resolvedUrl = resolveVariables(currentRequest.url);

      const params: Record<string, string> = {};
      currentRequest.params
        .filter((p) => p.enabled && p.key)
        .forEach((p) => {
          params[p.key] = resolveVariables(p.value);
        });

      const headers: Record<string, string> = {};
      currentRequest.headers
        .filter((h) => h.enabled && h.key)
        .forEach((h) => {
          headers[h.key] = resolveVariables(h.value);
        });

      // Get effective settings (merge request-specific with global settings)
      const effectiveSettings = getEffectiveSettings();

      // Configure HTTPS agent for SSL verification
      const httpsAgent = new https.Agent({
        rejectUnauthorized: effectiveSettings.verifySsl,
      });

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
        method: currentRequest.method,
        url: resolvedUrl,
        params,
        headers,
        data: currentRequest.body.type !== 'none' ? currentRequest.body.raw : undefined,
        timeout: effectiveSettings.timeout,
        maxRedirects: effectiveSettings.followRedirects ? effectiveSettings.maxRedirects : 0,
        httpsAgent,
        proxy: proxyConfig,
        // Always capture response status (don't throw on non-2xx)
        validateStatus: () => true,
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

      let testResult;
      if (currentRequest.testScript) {
        const executor = new ScriptExecutor(envVars, {});
        testResult = await executor.executeScript(currentRequest.testScript, {
          request: {
            url: currentRequest.url,
            method: currentRequest.method,
            headers: currentRequest.headers
              .filter((h) => h.enabled)
              .reduce((acc, h) => ({ ...acc, [h.key]: h.value }), {}),
            body: currentRequest.body.raw,
          },
          response: {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers as Record<string, string>,
            body: response.data,
            time: endTime - startTime,
            size: responseData.size,
          },
        });

        setScriptResult({ preRequest: preRequestResult, test: testResult });
      }

      setCurrentResponse(responseData);
      addHistoryItem(currentRequest, responseData);

      toast.success(`Request completed: ${response.status} ${response.statusText}`, {
        id: 'request',
        duration: 3000,
      });
    } catch (error: unknown) {
      const endTime = Date.now();

      const isAxiosError = (
        err: unknown
      ): err is {
        response?: { status?: number; statusText?: string; headers?: Record<string, string>; data?: unknown };
        message?: string;
      } => {
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
        duration: 5000,
      });
    } finally {
      setLoading(false);
    }
  }, [
    currentRequest,
    isLoading,
    setLoading,
    getActiveEnvironment,
    resolveVariables,
    setScriptResult,
    setCurrentResponse,
    addHistoryItem,
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
    <div className="flex-1 flex flex-col border-b border-slate-blue-500/10 glass relative z-30">
      {/* Request Line */}
      <RequestLine
        method={currentRequest.method}
        url={currentRequest.url}
        isLoading={isLoading}
        onMethodChange={handleMethodChange}
        onUrlChange={handleUrlChange}
        onSend={handleSendRequest}
        onOpenCodeGen={() => setCodeGenOpen(true)}
      />

      {/* Code Generator Dialog */}
      <CodeGeneratorDialog open={codeGenOpen} onOpenChange={setCodeGenOpen} request={currentRequest} />

      {/* Request Details Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col">
        <div className="px-4 py-2 border-b bg-muted/20">
          <TabsList className="h-9 w-full justify-start bg-muted/50 p-1 text-muted-foreground">
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <TabsTrigger
                    value="params"
                    className="data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                  >
                    Params
                    {currentRequest.params.filter((p) => p.enabled && p.key).length > 0 && (
                      <span className="ml-1.5 inline-flex items-center justify-center h-4 min-w-4 px-1 text-[11px] font-medium rounded-full bg-primary/10 text-primary tabular-nums">
                        {currentRequest.params.filter((p) => p.enabled && p.key).length}
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
                  <TabsTrigger
                    value="headers"
                    className="data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                  >
                    Headers
                    {currentRequest.headers.filter((h) => h.enabled && h.key).length > 0 && (
                      <span className="ml-1.5 inline-flex items-center justify-center h-4 min-w-4 px-1 text-[11px] font-medium rounded-full bg-primary/10 text-primary tabular-nums">
                        {currentRequest.headers.filter((h) => h.enabled && h.key).length}
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
                  <TabsTrigger
                    value="body"
                    className="data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                  >
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
                  <TabsTrigger
                    value="auth"
                    className="data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                  >
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
                  <TabsTrigger
                    value="scripts"
                    className="data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                  >
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
                  <TabsTrigger
                    value="settings"
                    className="data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                  >
                    <Settings className="h-3.5 w-3.5 mr-1" />
                    Settings
                    {currentRequest.settings && <span className="ml-1.5 h-2 w-2 rounded-full bg-blue-500" />}
                  </TabsTrigger>
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
            items={currentRequest.params}
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
            items={currentRequest.headers}
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
            body={currentRequest.body}
            onBodyTypeChange={handleBodyTypeChange}
            onBodyContentChange={handleBodyContentChange}
          />
        </TabsContent>

        <TabsContent value="auth" className="flex-1 overflow-auto p-4">
          <AuthConfiguration auth={currentRequest.auth} onChange={handleAuthChange} />
        </TabsContent>

        <TabsContent value="scripts" className="flex-1 overflow-auto p-4">
          <ScriptsEditor
            preRequestScript={currentRequest.preRequestScript || ''}
            testScript={currentRequest.testScript || ''}
            onPreRequestScriptChange={handlePreRequestScriptChange}
            onTestScriptChange={handleTestScriptChange}
          />
        </TabsContent>

        <TabsContent value="settings" className="flex-1 overflow-auto p-4">
          <RequestSettingsEditor
            settings={currentRequest.settings}
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
