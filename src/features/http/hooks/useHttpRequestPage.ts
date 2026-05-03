import { useCallback } from 'react';
import { useRequestStore } from '@/store/useRequestStore';
import { useHistoryStore } from '@/store/useHistoryStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useConsoleStore, createConsoleEntry } from '@/store/useConsoleStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import type { HttpMethod, AuthConfig, RequestSettings, RequestBody } from '@/types';
import { toast } from 'sonner';
import { useKeyValueCollection } from '@/hooks/useKeyValueCollection';
import { executeRequest } from '@/features/http/lib/requestExecutor';

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
    toast.loading('Sending request...', { id: 'request' });

    try {
      const envVars: Record<string, string> = {};
      const activeEnv = getActiveEnvironment();
      if (activeEnv) {
        activeEnv.variables.filter((v) => v.enabled).forEach((v) => {
          envVars[v.key] = v.value;
        });
      }

      const result = await executeRequest({
        request: httpRequest,
        envVars,
        globalSettings,
        resolveVariables,
      });

      setScriptResult(result.scriptResult || {});
      setCurrentResponse(result.response);
      addHistoryItem(httpRequest, result.response);
      const scriptLogs = [
        ...(result.scriptResult?.preRequest?.logs || []),
        ...(result.scriptResult?.test?.logs || []),
      ];
      addEntry(
        createConsoleEntry(
          httpRequest,
          result.response,
          result.sentHeaders,
          scriptLogs,
          result.scriptResult?.test?.tests
        )
      );
      toast.success(`Request completed: ${result.response.status} ${result.response.statusText}`, { id: 'request', duration: 3000 });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Request failed';
      toast.error(`Request failed: ${errorMessage}`, { id: 'request', duration: 5000 });
    } finally {
      setLoading(false);
    }
  }, [
    httpRequest, isLoading, setLoading, getActiveEnvironment, resolveVariables,
    setScriptResult, setCurrentResponse, addHistoryItem, globalSettings, addEntry,
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
