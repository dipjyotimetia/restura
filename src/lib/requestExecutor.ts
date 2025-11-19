import { HttpRequest, Response as ApiResponse, RequestSettings, AppSettings } from '@/types';
import { v4 as uuidv4 } from 'uuid';
import axios, { AxiosRequestConfig } from 'axios';
import { Cookie } from 'tough-cookie';
import ScriptExecutor, { ScriptResult } from '@/lib/scriptExecutor';
import { isElectron, getElectronAPI } from '@/lib/platform';
import { shouldBypassProxy, toAxiosProxyConfig } from '@/lib/proxyHelper';
import { validateURL } from '@/lib/urlValidator';
import { useCookieStore } from '@/store/useCookieStore';

export interface RequestExecutionResult {
  response: ApiResponse;
  scriptResult?: {
    preRequest?: ScriptResult;
    test?: ScriptResult;
  };
  envVars?: Record<string, string>;
}

export interface RequestExecutorOptions {
  request: HttpRequest;
  envVars: Record<string, string>;
  globalSettings: AppSettings;
  resolveVariables: (text: string, vars?: Record<string, string>) => string;
}

export async function executeRequest(options: RequestExecutorOptions): Promise<RequestExecutionResult> {
  const { request, envVars, globalSettings, resolveVariables } = options;
  const startTime = Date.now();

  // Execute pre-request script if exists
  let preRequestResult: ScriptResult | undefined;
  if (request.preRequestScript) {
    const executor = new ScriptExecutor(envVars, {});
    preRequestResult = await executor.executeScript(
      request.preRequestScript,
      {
        request: {
          url: request.url,
          method: request.method,
          headers: request.headers
            .filter((h) => h.enabled)
            .reduce(
              (acc, h) => ({ ...acc, [h.key]: h.value }),
              {} as Record<string, string>
            ),
          body: request.body.raw,
        },
      }
    );

    // Update environment variables if script modified them
    if (preRequestResult.success && preRequestResult.variables) {
      Object.assign(envVars, preRequestResult.variables);
    }
  }

  // Resolve environment variables
  // Note: We pass envVars to resolveVariables if the function supports it, 
  // otherwise we might need to update how resolveVariables works or rely on the store being updated.
  // For now, assuming resolveVariables uses the store, but we might need to manually resolve using envVars here.
  // Let's assume resolveVariables is bound to the store, but we should really use the local envVars.
  // Since we can't easily change the store hook, we'll do a simple replacement here for local vars.
  const resolveLocal = (text: string) => {
    let result = text;
    Object.entries(envVars).forEach(([key, value]) => {
      result = result.replace(new RegExp(`{{${key}}}`, 'g'), value);
    });
    // Fallback to global resolver for other vars
    return resolveVariables(result);
  };

  const resolvedUrl = resolveLocal(request.url);

  // Security: Validate URL
  const urlValidation = validateURL(resolvedUrl, {
    allowPrivateIPs: false,
    allowLocalhost: globalSettings.allowLocalhost ?? true,
  });

  if (!urlValidation.valid) {
    throw new Error(`Invalid URL: ${urlValidation.error}`);
  }

  // Build query params
  const params: Record<string, string> = {};
  request.params
    .filter((p) => p.enabled && p.key)
    .forEach((p) => {
      params[p.key] = resolveLocal(p.value);
    });

  // Build headers
  const headers: Record<string, string> = {};
  request.headers
    .filter((h) => h.enabled && h.key)
    .forEach((h) => {
      headers[h.key] = resolveLocal(h.value);
    });

  // Add Cookies
  // Note: useCookieStore is a hook/store. We can access getState() outside components.
  const cookies = useCookieStore.getState().getCookiesForUrl(resolvedUrl);
  if (cookies.length > 0) {
    const cookieHeader = cookies.map((c) => `${c.key}=${c.value}`).join('; ');
    headers['Cookie'] = cookieHeader;
  }

  // Get effective settings
  const effectiveSettings: RequestSettings = request.settings || {
    timeout: globalSettings.defaultTimeout,
    followRedirects: globalSettings.followRedirects,
    maxRedirects: globalSettings.maxRedirects,
    verifySsl: globalSettings.verifySsl,
    proxy: globalSettings.proxy,
  };

  // Build Axios config
  const axiosConfig: AxiosRequestConfig = {
    method: request.method,
    url: resolvedUrl,
    params,
    headers,
    data: request.body.type !== 'none' ? request.body.raw : undefined,
    timeout: effectiveSettings.timeout,
    maxRedirects: effectiveSettings.followRedirects ? effectiveSettings.maxRedirects : 0,
    validateStatus: () => true,
  };

  let responseData: ApiResponse;

  // Apply proxy configuration if enabled
  const proxyConfig = effectiveSettings.proxy;
  if (proxyConfig?.enabled && proxyConfig.host && !shouldBypassProxy(resolvedUrl, proxyConfig.bypassList)) {
    if (isElectron()) {
      const electronAPI = getElectronAPI();
      if (electronAPI && 'http' in electronAPI) {
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

          // Process Set-Cookie headers
          const setCookie = electronResponse.headers['set-cookie'] || electronResponse.headers['Set-Cookie'];
          if (setCookie) {
            const cookiesToSet = Array.isArray(setCookie) ? setCookie : [setCookie];
            cookiesToSet.forEach((cookieStr) => {
              const parsedCookie = Cookie.parse(cookieStr);
              if (parsedCookie) {
                useCookieStore.getState().addCookie({
                  id: uuidv4(),
                  key: parsedCookie.key,
                  value: parsedCookie.value,
                  domain: parsedCookie.domain || new URL(resolvedUrl).hostname,
                  path: parsedCookie.path || '/',
                  expires: parsedCookie.expires === 'Infinity' || !parsedCookie.expires ? undefined : parsedCookie.expires.toString(),
                  secure: parsedCookie.secure,
                  httpOnly: parsedCookie.httpOnly,
                  lastAccessed: new Date().toISOString(),
                });
              }
            });
          }

          const endTime = Date.now();
          responseData = {
            id: uuidv4(),
            requestId: request.id,
            status: electronResponse.status,
            statusText: electronResponse.statusText,
            headers: electronResponse.headers,
            body: typeof electronResponse.data === 'string'
                ? electronResponse.data
                : JSON.stringify(electronResponse.data, null, 2),
            size: new Blob([JSON.stringify(electronResponse.data)]).size,
            time: endTime - startTime,
            timestamp: Date.now(),
          };
        } catch (err) {
          console.warn('Electron proxy IPC failed, falling back to Axios', err);
          // Fallback to axios below
        }
      }
    } else {
      // Web mode proxy warning
      const axiosProxy = toAxiosProxyConfig(proxyConfig);
      if (axiosProxy) {
        headers['X-Proxy-Configured'] = 'true';
      }
    }
  }

  // If responseData is not set (Electron failed or not Electron), use Axios
  if (typeof responseData! === 'undefined') {
    try {
      const response = await axios(axiosConfig);
      const endTime = Date.now();
      responseData = {
        id: uuidv4(),
        requestId: request.id,
        status: response.status,
        statusText: response.statusText,
        headers: response.headers as Record<string, string | string[]>,
        body: typeof response.data === 'string'
            ? response.data
            : JSON.stringify(response.data, null, 2),
        size: new Blob([JSON.stringify(response.data)]).size,
        time: endTime - startTime,
        timestamp: Date.now(),
      };
    } catch (error: unknown) {
      const endTime = Date.now();
      const isAxiosError = axios.isAxiosError(error);
      const errorMessage = error instanceof Error ? error.message : 'Request failed';

      responseData = {
        id: uuidv4(),
        requestId: request.id,
        status: isAxiosError && error.response ? error.response.status : 0,
        statusText: isAxiosError && error.response ? error.response.statusText : 'Error',
        headers: isAxiosError && error.response ? (error.response.headers as Record<string, string | string[]>) : {},
        body: isAxiosError && error.response?.data
          ? JSON.stringify(error.response.data, null, 2)
          : errorMessage,
        size: 0,
        time: endTime - startTime,
        timestamp: Date.now(),
      };
    }
  }

  // Execute test script if exists
  let testResult: ScriptResult | undefined;
  if (request.testScript) {
    const executor = new ScriptExecutor(envVars, {});
    testResult = await executor.executeScript(request.testScript, {
      request: {
        url: request.url,
        method: request.method,
        headers: request.headers
          .filter((h) => h.enabled)
          .reduce(
            (acc, h) => ({ ...acc, [h.key]: h.value }),
            {} as Record<string, string>
          ),
        body: request.body.raw,
      },
      response: {
        status: responseData.status,
        statusText: responseData.statusText,
        headers: responseData.headers as Record<string, string>,
        body: responseData.body, // Note: body is string here, might need parsing if JSON
        time: responseData.time,
        size: responseData.size,
      },
    });
  }

  return {
    response: responseData,
    scriptResult: {
      preRequest: preRequestResult,
      test: testResult,
    },
    envVars,
  };
}
