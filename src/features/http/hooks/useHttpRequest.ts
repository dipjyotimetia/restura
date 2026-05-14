'use client';

import { useCallback } from 'react';
import { useRequestStore } from '@/store/useRequestStore';
import { useActiveRequest, useActiveResponse } from '@/store/selectors';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import type { HttpRequest, KeyValue, AuthConfig, Response as ApiResponse } from '@/types';
import { v4 as uuidv4 } from 'uuid';
import { executeStreamingRequest, isStreamingAccept } from '@/features/http/lib/requestExecutor';
import { isElectron } from '@/lib/shared/platform';
import { useRequestAnnouncements } from '@/components/shared/AriaLiveAnnouncer';
import { useRequestRunner } from '@/features/registry/useRequestRunner';

interface UseHttpRequestReturn {
  request: HttpRequest | null;
  response: ApiResponse | null;
  isLoading: boolean;
  updateRequest: (updates: Partial<HttpRequest>) => void;
  sendRequest: () => Promise<void>;
  addParam: () => void;
  updateParam: (id: string, updates: Partial<KeyValue>) => void;
  removeParam: (id: string) => void;
  addHeader: () => void;
  updateHeader: (id: string, updates: Partial<KeyValue>) => void;
  removeHeader: (id: string) => void;
  updateBody: (raw: string) => void;
  updateAuth: (auth: AuthConfig) => void;
}

export function useHttpRequest(): UseHttpRequestReturn {
  const httpRequest = useActiveRequest('http');
  const currentResponse = useActiveResponse();
  const { announceRequestSent, announceRequestComplete, announceRequestFailed } = useRequestAnnouncements();
  const storeUpdateRequest = useRequestStore((s) => s.updateRequest);
  const setLoading = useRequestStore((s) => s.setLoading);
  const setCurrentResponse = useRequestStore((s) => s.setCurrentResponse);
  const isLoading = useRequestStore((s) => s.isLoading);
  const setScriptResult = useRequestStore((s) => s.setScriptResult);

  const { resolveVariables, getActiveEnvironment } = useEnvironmentStore();
  const { settings: globalSettings } = useSettingsStore();
  const { run: runViaRegistry } = useRequestRunner();

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

  const removeParam = useCallback(
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

  const removeHeader = useCallback(
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
    announceRequestSent();
    // Always wipe any prior streaming state so a previous SSE/NDJSON run
    // doesn't bleed into this request — even if this one is buffered.
    useRequestStore.getState().clearStreamingEvents();

    try {
      // Detect streaming Accept and dispatch through the streaming pipeline.
      // Electron's IPC path doesn't yet support streaming response bodies, so
      // fall through to the registry-backed buffered runner on desktop. The
      // registry doesn't model AsyncIterable streams yet (Task 4.x), so the
      // streaming branch keeps its bespoke executor for now.
      const headersRecord: Record<string, string> = {};
      httpRequest.headers
        .filter((h) => h.enabled && h.key)
        .forEach((h) => {
          headersRecord[h.key] = h.value;
        });

      if (isStreamingAccept(headersRecord) && !isElectron()) {
        // Streaming path needs raw envVars + the global resolver. Build them
        // here rather than inside the runner because the registry contract
        // surfaces only a flat variables map; the streaming executor still
        // wants the full {{var}} resolver to stay consistent with the rest
        // of the app.
        const envVars: Record<string, string> = {};
        const activeEnv = getActiveEnvironment();
        if (activeEnv) {
          activeEnv.variables
            .filter((v) => v.enabled)
            .forEach((v) => {
              envVars[v.key] = v.value;
            });
        }
        const { events } = await executeStreamingRequest({
          request: httpRequest,
          envVars,
          globalSettings,
          resolveVariables,
        });
        // Clear any buffered response from a prior run and attach the stream.
        setCurrentResponse(null);
        setScriptResult(null);
        useRequestStore.getState().setStreamingEvents(events);
        // The stream renders incrementally; flip loading off so the viewer
        // becomes interactive immediately. The status pill inside
        // StreamingResponseViewer reflects ongoing/closed/error state.
        return;
      }

      // Non-streaming path: delegate to the registry-backed runner. It
      // handles env extraction, executor invocation, history persistence,
      // and (via ctx.onScriptResult) pushes pre-request + test script
      // results into the active tab so the Console panel updates.
      const { response } = await runViaRegistry(httpRequest, 'http');

      setCurrentResponse(response);
      announceRequestComplete(response.status, response.time);
    } catch (error: unknown) {
      // Error handling is mostly done in executeRequest but if it throws, we catch here
      const errorMessage = error instanceof Error ? error.message : 'Request failed';
      console.error('Request execution error:', errorMessage);
      announceRequestFailed(errorMessage);
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
    globalSettings,
    runViaRegistry,
    announceRequestSent,
    announceRequestComplete,
    announceRequestFailed,
  ]);

  return {
    request: httpRequest,
    response: currentResponse,
    isLoading,
    updateRequest,
    sendRequest,
    addParam,
    updateParam,
    removeParam,
    addHeader,
    updateHeader,
    removeHeader,
    updateBody,
    updateAuth,
  };
}
