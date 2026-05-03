import { useCallback } from 'react';
import { useRequestStore } from '@/store/useRequestStore';
import { useHistoryStore } from '@/store/useHistoryStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useConsoleStore, createConsoleEntry } from '@/store/useConsoleStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { HttpMethod, AuthConfig, RequestSettings, RequestBody } from '@/types';
import { v4 as uuidv4 } from 'uuid';
import axios, { AxiosProxyConfig, isAxiosError } from 'axios';
import ScriptExecutor from '@/features/scripts/lib/scriptExecutor';
import { toast } from 'sonner';
import { useKeyValueCollection } from '@/hooks/useKeyValueCollection';

export function useHttpRequestPage() {
  const { currentRequest, updateRequest, setLoading, setCurrentResponse, isLoading, setScriptResult } =
    useRequestStore();
  const { addHistoryItem } = useHistoryStore();
  const { resolveVariables, getActiveEnvironment } = useEnvironmentStore();
  const { settings: globalSettings } = useSettingsStore();
  const { addEntry } = useConsoleStore();

  const isHttpRequest = currentRequest?.type === 'http';
  const httpRequest = isHttpRequest ? currentRequest : null;

  const { handleAdd: addParam, handleUpdate: updateParam, handleDelete: removeParam } =
    useKeyValueCollection(httpRequest?.params ?? [], (params) => updateRequest({ params }));

  const { handleAdd: addHeader, handleUpdate: updateHeader, handleDelete: removeHeader } =
    useKeyValueCollection(httpRequest?.headers ?? [], (headers) => updateRequest({ headers }));

  const getEffectiveSettings = useCallback((): RequestSettings => {
    return httpRequest?.settings || {
      timeout: globalSettings.defaultTimeout,
      followRedirects: globalSettings.followRedirects,
      maxRedirects: globalSettings.maxRedirects,
      verifySsl: globalSettings.verifySsl,
      proxy: globalSettings.proxy,
    };
  }, [httpRequest?.settings, globalSettings]);

  const sendRequest = useCallback(async () => {
    if (!httpRequest || !httpRequest.url || isLoading) return;

    setLoading(true);
    const startTime = Date.now();
    toast.loading('Sending request...', { id: 'request' });

    try {
      const envVars: Record<string, string> = {};
      const activeEnv = getActiveEnvironment();
      if (activeEnv) {
        activeEnv.variables.filter((v) => v.enabled).forEach((v) => {
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
            headers: httpRequest.headers.filter((h) => h.enabled).reduce((acc, h) => ({ ...acc, [h.key]: h.value }), {}),
            body: httpRequest.body.raw,
          },
        });
        if (preRequestResult.success && preRequestResult.variables) {
          Object.entries(preRequestResult.variables).forEach(([key, value]) => { envVars[key] = value; });
        }
        setScriptResult({ preRequest: preRequestResult });
      }

      const resolvedUrl = resolveVariables(httpRequest.url);
      const params: Record<string, string> = {};
      httpRequest.params.filter((p) => p.enabled && p.key).forEach((p) => {
        params[p.key] = resolveVariables(p.value);
      });
      const headers: Record<string, string> = {};
      httpRequest.headers.filter((h) => h.enabled && h.key).forEach((h) => {
        headers[h.key] = resolveVariables(h.value);
      });

      const effectiveSettings = getEffectiveSettings();
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
        validateStatus: () => true,
      });

      const endTime = Date.now();
      const bodyContent = typeof response.data === 'string' ? response.data : JSON.stringify(response.data, null, 2);
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
            headers: httpRequest.headers.filter((h) => h.enabled).reduce((acc, h) => ({ ...acc, [h.key]: h.value }), {}),
            body: httpRequest.body.raw,
          },
          response: {
            status: response.status,
            statusText: response.statusText,
            headers: Object.fromEntries(
              Object.entries(response.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value])
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
      const scriptLogs = [...(preRequestResult?.logs || []), ...(testResult?.logs || [])];
      addEntry(createConsoleEntry(httpRequest, responseData, headers, scriptLogs, testResult?.tests));
      toast.success(`Request completed: ${response.status} ${response.statusText}`, { id: 'request', duration: 3000 });
    } catch (error: unknown) {
      const endTime = Date.now();
      const axiosError = isAxiosError(error) ? error : null;
      const errorMessage = error instanceof Error ? error.message : 'Request failed';
      const errorBody = axiosError?.response?.data ? JSON.stringify(axiosError.response.data, null, 2) : errorMessage;
      const errorResponse = {
        id: uuidv4(),
        requestId: httpRequest.id,
        status: axiosError?.response?.status || 0,
        statusText: axiosError?.response?.statusText || 'Error',
        headers: (axiosError?.response?.headers ?? {}) as Record<string, string | string[]>,
        body: errorBody,
        size: new Blob([errorBody]).size,
        time: endTime - startTime,
        timestamp: Date.now(),
      };
      setCurrentResponse(errorResponse);
      addHistoryItem(httpRequest, errorResponse);
      addEntry(createConsoleEntry(httpRequest, errorResponse, {}, [], undefined));
      toast.error(`Request failed: ${errorMessage}`, { id: 'request', duration: 5000 });
    } finally {
      setLoading(false);
    }
  }, [
    httpRequest, isLoading, setLoading, getActiveEnvironment, resolveVariables,
    setScriptResult, setCurrentResponse, addHistoryItem, getEffectiveSettings, addEntry,
  ]);

  const changeSettings = useCallback((updates: Partial<RequestSettings>) => {
    const current = httpRequest?.settings || getEffectiveSettings();
    updateRequest({ settings: { ...current, ...updates } });
  }, [httpRequest?.settings, getEffectiveSettings, updateRequest]);

  const toggleSettingsOverride = useCallback((enabled: boolean) => {
    if (enabled) {
      changeSettings({});
    } else {
      updateRequest({ settings: undefined });
    }
  }, [changeSettings, updateRequest]);

  const changeProxyOverride = useCallback((useOverride: boolean) => {
    if (useOverride) {
      changeSettings({ proxy: { ...globalSettings.proxy } });
    } else {
      const current = httpRequest?.settings;
      if (current) {
        const { proxy: _, ...rest } = current;
        updateRequest({ settings: { ...rest, proxy: undefined } });
      }
    }
  }, [changeSettings, globalSettings.proxy, httpRequest?.settings, updateRequest]);

  const counts = {
    activeParams: httpRequest?.params.filter((p) => p.enabled && p.key).length ?? 0,
    activeHeaders: httpRequest?.headers.filter((h) => h.enabled && h.key).length ?? 0,
  };

  const handlers = {
    sendRequest,
    changeMethod: (method: HttpMethod) => updateRequest({ method }),
    changeUrl: (url: string) => updateRequest({ url }),
    changeAuth: (auth: AuthConfig) => updateRequest({ auth }),
    changeBodyType: (type: RequestBody['type']) => {
      if (!httpRequest) return;
      updateRequest({ body: { ...httpRequest.body, type } });
    },
    changeBodyContent: (raw: string) => {
      if (!httpRequest) return;
      updateRequest({ body: { ...httpRequest.body, raw } });
    },
    changePreRequestScript: (script: string) => updateRequest({ preRequestScript: script }),
    changeTestScript: (script: string) => updateRequest({ testScript: script }),
    addParam, updateParam, removeParam,
    addHeader, updateHeader, removeHeader,
    changeSettings,
    toggleSettingsOverride,
    changeProxyOverride,
  };

  return { httpRequest, isLoading, globalSettings, handlers, counts };
}
