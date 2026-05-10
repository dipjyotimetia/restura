import type { Context } from 'hono';
import type { Env } from '../index';
import { validateURL } from '@shared/protocol/url-validation';
import { MAX_RESPONSE_SIZE } from '@shared/protocol/http-proxy';

const REFLECTION_SERVICE_V1 = 'grpc.reflection.v1.ServerReflection';
const REFLECTION_SERVICE_V1_ALPHA = 'grpc.reflection.v1alpha.ServerReflection';

interface ReflectionRequest {
  url: string;
  request: {
    listServices?: string;
    fileContainingSymbol?: string;
  };
  timeout?: number;
}

async function sendReflectionRequest(
  baseUrl: string,
  reflectionServiceName: string,
  request: ReflectionRequest['request'],
  timeout: number
): Promise<unknown> {
  const path = `/${reflectionServiceName}/ServerReflectionInfo`;
  const url = `${baseUrl.replace(/\/$/, '')}${path}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Reflection request failed: ${response.statusText}`);
    }

    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_SIZE) {
      throw new Error(`Response size exceeds maximum limit of ${MAX_RESPONSE_SIZE / 1024 / 1024}MB`);
    }

    return await response.json();
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Reflection request timed out');
    }
    throw error;
  }
}

export async function grpcReflection(c: Context<{ Bindings: Env }>) {
  try {
    const body = await c.req.json<ReflectionRequest>();
    const { url, request, timeout = 30000 } = body;

    const isDev = c.env.ENVIRONMENT === 'development';
    const urlValidation = validateURL(url, { allowPrivateIPs: false, allowLocalhost: isDev });
    if (!urlValidation.valid) {
      return c.json({ error: `Invalid URL: ${urlValidation.error}` }, 400);
    }

    let response: unknown;
    let reflectionVersion = 'v1';
    let v1Error: unknown;

    try {
      response = await sendReflectionRequest(url, REFLECTION_SERVICE_V1, request, timeout);
    } catch (err) {
      v1Error = err;
      reflectionVersion = 'v1alpha';
      try {
        response = await sendReflectionRequest(url, REFLECTION_SERVICE_V1_ALPHA, request, timeout);
      } catch (alphaErr) {
        const v1Msg = v1Error instanceof Error ? v1Error.message : String(v1Error);
        const alphaMsg = alphaErr instanceof Error ? alphaErr.message : String(alphaErr);
        return c.json({ error: `Reflection failed on v1 (${v1Msg}) and v1alpha (${alphaMsg})` }, 500);
      }
    }

    const responseData = typeof response === 'object' && response !== null
      ? { ...(response as Record<string, unknown>), reflectionVersion }
      : { data: response, reflectionVersion };

    return c.json(responseData);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Reflection request failed';
    return c.json({ error: errorMessage }, 500);
  }
}
