'use client';

import { useCallback, useMemo } from 'react';
import { useRequestStore } from '@/store/useRequestStore';
import { useHistoryStore } from '@/store/useHistoryStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { HttpRequest, KeyValue, AuthConfig, Response as ApiResponse } from '@/types';
import { v4 as uuidv4 } from 'uuid';
import { executeRequest } from '@/features/http/lib/requestExecutor';

interface UseHttpRequestReturn {
  request: HttpRequest | null;
  response: ApiResponse | null;
  isLoading: boolean;
  updateRequest: (updates: Partial<HttpRequest>) => void;
  sendRequest: () => Promise<void>;
  addParam: () => void;
  updateParam: (id: string, updates: Partial<KeyValue>) => void;
  deleteParam: (id: string) => void;
  addHeader: () => void;
  updateHeader: (id: string, updates: Partial<KeyValue>) => void;
  deleteHeader: (id: string) => void;
  updateBody: (raw: string) => void;
  updateAuth: (auth: AuthConfig) => void;
}

export function useHttpRequest(): UseHttpRequestReturn {
  const {
    currentRequest,
    currentResponse,
    updateRequest: storeUpdateRequest,
    setLoading,
    setCurrentResponse,
    isLoading,
    setScriptResult,
  } = useRequestStore();

  const { addHistoryItem } = useHistoryStore();
  const { resolveVariables, getActiveEnvironment } = useEnvironmentStore();
  const { settings: globalSettings } = useSettingsStore();

  // Type guard for HTTP request
  const httpRequest = useMemo(() => {
    if (currentRequest?.type === 'http') {
      return currentRequest as HttpRequest;
    }
    return null;
  }, [currentRequest]);

  const updateRequest = useCallback(
    (updates: Partial<HttpRequest>) => {
      storeUpdateRequest(updates);
    },
    [storeUpdateRequest]
  );

  // ... (keep param/header/body helpers)

  const addParam = useCallback(() => {
    if (!httpRequest) return;
    const newParam: KeyValue = {
      id: uuidv4(),
      key: '',
      value: '',
      enabled: true,
    };
    updateRequest({ params: [...httpRequest.params, newParam] });
  }, [httpRequest, updateRequest]);

  const updateParam = useCallback(
    (id: string, updates: Partial<KeyValue>) => {
      if (!httpRequest) return;
      updateRequest({
        params: httpRequest.params.map((p) =>
          p.id === id ? { ...p, ...updates } : p
        ),
      });
    },
    [httpRequest, updateRequest]
  );

  const deleteParam = useCallback(
    (id: string) => {
      if (!httpRequest) return;
      updateRequest({
        params: httpRequest.params.filter((p) => p.id !== id),
      });
    },
    [httpRequest, updateRequest]
  );

  const addHeader = useCallback(() => {
    if (!httpRequest) return;
    const newHeader: KeyValue = {
      id: uuidv4(),
      key: '',
      value: '',
      enabled: true,
    };
    updateRequest({ headers: [...httpRequest.headers, newHeader] });
  }, [httpRequest, updateRequest]);

  const updateHeader = useCallback(
    (id: string, updates: Partial<KeyValue>) => {
      if (!httpRequest) return;
      updateRequest({
        headers: httpRequest.headers.map((h) =>
          h.id === id ? { ...h, ...updates } : h
        ),
      });
    },
    [httpRequest, updateRequest]
  );

  const deleteHeader = useCallback(
    (id: string) => {
      if (!httpRequest) return;
      updateRequest({
        headers: httpRequest.headers.filter((h) => h.id !== id),
      });
    },
    [httpRequest, updateRequest]
  );

  const updateBody = useCallback(
    (raw: string) => {
      if (!httpRequest) return;
      updateRequest({
        body: { ...httpRequest.body, raw },
      });
    },
    [httpRequest, updateRequest]
  );

  const updateAuth = useCallback(
    (auth: AuthConfig) => {
      updateRequest({ auth });
    },
    [updateRequest]
  );

  const sendRequest = useCallback(async () => {
    if (!httpRequest) return;

    setLoading(true);

    try {
      // Get current environment variables
      const envVars: Record<string, string> = {};
      const activeEnv = getActiveEnvironment();
      if (activeEnv) {
        activeEnv.variables
          .filter((v) => v.enabled)
          .forEach((v) => {
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
    } catch (error: unknown) {
      // Error handling is mostly done in executeRequest but if it throws, we catch here
      const errorMessage = error instanceof Error ? error.message : 'Request failed';
      console.error('Request execution error:', errorMessage);
      // We could set an error response here if executeRequest throws without returning a response
    } finally {
      setLoading(false);
    }
  }, [
    httpRequest,
    setLoading,
    getActiveEnvironment,
    setScriptResult,
    resolveVariables,
    setCurrentResponse,
    addHistoryItem,
    globalSettings,
  ]);

  return {
    request: httpRequest,
    response: currentResponse,
    isLoading,
    updateRequest,
    sendRequest,
    addParam,
    updateParam,
    deleteParam,
    addHeader,
    updateHeader,
    deleteHeader,
    updateBody,
    updateAuth,
  };
}
