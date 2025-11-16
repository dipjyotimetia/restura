'use client';

import { useCallback, useMemo } from 'react';
import { useRequestStore } from '@/store/useRequestStore';
import { useHistoryStore } from '@/store/useHistoryStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { HttpRequest, KeyValue, AuthConfig, Response as ApiResponse, RequestSettings } from '@/types';
import { v4 as uuidv4 } from 'uuid';
import axios, { AxiosRequestConfig } from 'axios';
import ScriptExecutor from '@/lib/scriptExecutor';
import { isElectron, getElectronAPI } from '@/lib/platform';
import { shouldBypassProxy, toAxiosProxyConfig } from '@/lib/proxyHelper';
import { validateURL } from '@/lib/urlValidator';

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
    const startTime = Date.now();

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

      // Execute pre-request script if exists
      let preRequestResult;
      if (httpRequest.preRequestScript) {
        const executor = new ScriptExecutor(envVars, {});
        preRequestResult = await executor.executeScript(
          httpRequest.preRequestScript,
          {
            request: {
              url: httpRequest.url,
              method: httpRequest.method,
              headers: httpRequest.headers
                .filter((h) => h.enabled)
                .reduce(
                  (acc, h) => ({ ...acc, [h.key]: h.value }),
                  {} as Record<string, string>
                ),
              body: httpRequest.body.raw,
            },
          }
        );

        // Update environment variables if script modified them
        if (preRequestResult.success && preRequestResult.variables) {
          Object.entries(preRequestResult.variables).forEach(([key, value]) => {
            envVars[key] = value;
          });
        }

        setScriptResult({ preRequest: preRequestResult });
      }

      // Resolve environment variables
      const resolvedUrl = resolveVariables(httpRequest.url);

      // Security: Validate URL to prevent SSRF attacks
      const urlValidation = validateURL(resolvedUrl, {
        allowPrivateIPs: false,
        allowLocalhost: globalSettings.allowLocalhost ?? true, // Allow localhost by default for development
      });

      if (!urlValidation.valid) {
        throw new Error(`Invalid URL: ${urlValidation.error}`);
      }

      // Log warnings if any
      if (urlValidation.warnings && urlValidation.warnings.length > 0) {
        console.warn('URL validation warnings:', urlValidation.warnings);
      }

      // Build query params
      const params: Record<string, string> = {};
      httpRequest.params
        .filter((p) => p.enabled && p.key)
        .forEach((p) => {
          params[p.key] = resolveVariables(p.value);
        });

      // Build headers
      const headers: Record<string, string> = {};
      httpRequest.headers
        .filter((h) => h.enabled && h.key)
        .forEach((h) => {
          headers[h.key] = resolveVariables(h.value);
        });

      // Get effective settings (request-specific or global)
      const effectiveSettings: RequestSettings = httpRequest.settings || {
        timeout: globalSettings.defaultTimeout,
        followRedirects: globalSettings.followRedirects,
        maxRedirects: globalSettings.maxRedirects,
        verifySsl: globalSettings.verifySsl,
        proxy: globalSettings.proxy,
      };

      // Build Axios config with settings
      const axiosConfig: AxiosRequestConfig = {
        method: httpRequest.method,
        url: resolvedUrl,
        params,
        headers,
        data: httpRequest.body.type !== 'none' ? httpRequest.body.raw : undefined,
        timeout: effectiveSettings.timeout,
        maxRedirects: effectiveSettings.followRedirects ? effectiveSettings.maxRedirects : 0,
        validateStatus: () => true, // Accept all status codes
      };

      // Apply proxy configuration if enabled
      const proxyConfig = effectiveSettings.proxy;
      if (proxyConfig?.enabled && proxyConfig.host) {
        // Check if URL should bypass proxy
        if (!shouldBypassProxy(resolvedUrl, proxyConfig.bypassList)) {
          if (isElectron()) {
            // In Electron, we can use Node.js native proxy support
            // This requires IPC handler in main process (added separately)
            const electronAPI = getElectronAPI();
            if (electronAPI && 'http' in electronAPI) {
              // Use Electron IPC for proxy request (full proxy support)
              try {
                const electronResponse = await (electronAPI as unknown as {
                  http: {
                    request: (config: unknown) => Promise<{
                      status: number;
                      statusText: string;
                      headers: Record<string, string>;
                      data: unknown;
                    }>;
                  };
                }).http.request({
                  ...axiosConfig,
                  proxy: proxyConfig,
                  verifySsl: effectiveSettings.verifySsl,
                });

                const endTime = Date.now();
                const responseData: ApiResponse = {
                  id: uuidv4(),
                  requestId: httpRequest.id,
                  status: electronResponse.status,
                  statusText: electronResponse.statusText,
                  headers: electronResponse.headers,
                  body:
                    typeof electronResponse.data === 'string'
                      ? electronResponse.data
                      : JSON.stringify(electronResponse.data, null, 2),
                  size: new Blob([JSON.stringify(electronResponse.data)]).size,
                  time: endTime - startTime,
                  timestamp: Date.now(),
                };

                // Execute test script if exists
                if (httpRequest.testScript) {
                  const executor = new ScriptExecutor(envVars, {});
                  const testResult = await executor.executeScript(httpRequest.testScript, {
                    request: {
                      url: httpRequest.url,
                      method: httpRequest.method,
                      headers: httpRequest.headers
                        .filter((h) => h.enabled)
                        .reduce(
                          (acc, h) => ({ ...acc, [h.key]: h.value }),
                          {} as Record<string, string>
                        ),
                      body: httpRequest.body.raw,
                    },
                    response: {
                      status: electronResponse.status,
                      statusText: electronResponse.statusText,
                      headers: electronResponse.headers,
                      body: electronResponse.data,
                      time: endTime - startTime,
                      size: responseData.size,
                    },
                  });
                  setScriptResult({ preRequest: preRequestResult, test: testResult });
                }

                setCurrentResponse(responseData);
                addHistoryItem(httpRequest, responseData);
                return;
              } catch {
                // Fall back to regular Axios if Electron IPC fails
                console.warn('Electron proxy IPC not available, falling back to Axios');
              }
            }
          }

          // For web mode or fallback: use Axios proxy config (limited support)
          // Note: Browser Axios doesn't support proxy directly
          // This primarily works in Node.js environment (Electron main process)
          const axiosProxy = toAxiosProxyConfig(proxyConfig);
          if (axiosProxy) {
            // Add proxy warning header for debugging
            headers['X-Proxy-Configured'] = 'true';
            console.info(
              `Proxy configured: ${proxyConfig.type}://${proxyConfig.host}:${proxyConfig.port}`,
              '\nNote: Browser-based requests have limited proxy support due to CORS restrictions.'
            );
          }
        }
      }

      // Make request with Axios
      const response = await axios(axiosConfig);

      const endTime = Date.now();

      const responseData: ApiResponse = {
        id: uuidv4(),
        requestId: httpRequest.id,
        status: response.status,
        statusText: response.statusText,
        headers: response.headers as Record<string, string>,
        body:
          typeof response.data === 'string'
            ? response.data
            : JSON.stringify(response.data, null, 2),
        size: new Blob([JSON.stringify(response.data)]).size,
        time: endTime - startTime,
        timestamp: Date.now(),
      };

      // Execute test script if exists
      let testResult;
      if (httpRequest.testScript) {
        const executor = new ScriptExecutor(envVars, {});
        testResult = await executor.executeScript(httpRequest.testScript, {
          request: {
            url: httpRequest.url,
            method: httpRequest.method,
            headers: httpRequest.headers
              .filter((h) => h.enabled)
              .reduce(
                (acc, h) => ({ ...acc, [h.key]: h.value }),
                {} as Record<string, string>
              ),
            body: httpRequest.body.raw,
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
      addHistoryItem(httpRequest, responseData);
    } catch (error: unknown) {
      const endTime = Date.now();

      // Type guard for axios error
      const isAxiosError = (
        err: unknown
      ): err is {
        response?: {
          status?: number;
          statusText?: string;
          headers?: Record<string, string>;
          data?: unknown;
        };
        message?: string;
      } => {
        return (
          typeof err === 'object' &&
          err !== null &&
          ('response' in err || 'message' in err)
        );
      };

      const axiosError = isAxiosError(error) ? error : null;
      const errorMessage =
        error instanceof Error ? error.message : 'Request failed';

      const errorResponse: ApiResponse = {
        id: uuidv4(),
        requestId: httpRequest.id,
        status: axiosError?.response?.status || 0,
        statusText: axiosError?.response?.statusText || 'Error',
        headers: axiosError?.response?.headers || {},
        body: axiosError?.response?.data
          ? JSON.stringify(axiosError.response.data, null, 2)
          : errorMessage,
        size: 0,
        time: endTime - startTime,
        timestamp: Date.now(),
      };

      setCurrentResponse(errorResponse);
      addHistoryItem(httpRequest, errorResponse);
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
