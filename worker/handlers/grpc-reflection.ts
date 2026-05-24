import type { Context } from 'hono';
import type { Env } from '../env';
import type { NodeHostnameGuard } from '../adapters';
import { validateURL } from '@shared/protocol/url-validation';
import { MAX_RESPONSE_SIZE } from '@shared/protocol/http-proxy';
import {
  GrpcReflectionRequestBodySchema,
  type GrpcReflectionRequestBody,
} from '@shared/protocol/grpc-schema';
import { parseJsonBody } from '../shared/validate-body';
import { allowPrivateIPs, isLocalDevBypass } from '../shared/env';

const REFLECTION_SERVICE_V1 = 'grpc.reflection.v1.ServerReflection';
const REFLECTION_SERVICE_V1_ALPHA = 'grpc.reflection.v1alpha.ServerReflection';

async function sendReflectionRequest(
  baseUrl: string,
  reflectionServiceName: string,
  request: GrpcReflectionRequestBody['request'],
  timeout: number,
  dnsGuardOptions?: {
    guard: NodeHostnameGuard;
    allowLocalhost: boolean;
    allowPrivateIPs: boolean;
  }
): Promise<unknown> {
  const path = `/${reflectionServiceName}/ServerReflectionInfo`;
  const url = `${baseUrl.replace(/\/$/, '')}${path}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    if (dnsGuardOptions) {
      await dnsGuardOptions.guard(new URL(url).hostname, {
        allowLocalhost: dnsGuardOptions.allowLocalhost,
        allowPrivateIPs: dnsGuardOptions.allowPrivateIPs,
      });
    }
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
      throw new Error(
        `Response size exceeds maximum limit of ${MAX_RESPONSE_SIZE / 1024 / 1024}MB`
      );
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

export function createGrpcReflectionHandler(nodeHostnameGuard?: NodeHostnameGuard) {
  return async function grpcReflectionHandler(c: Context<{ Bindings: Env }>) {
    const parsed = await parseJsonBody(c.req.raw, GrpcReflectionRequestBodySchema);
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, parsed.status);
    }
    const { url, request, timeout = 30000 } = parsed.value;

    // Same gate as worker/index.ts auth — see proxy.ts for rationale.
    const isDev = isLocalDevBypass(c.env);
    const permitPrivateIPs = allowPrivateIPs(c.env);
    const urlValidation = validateURL(url, {
      allowPrivateIPs: permitPrivateIPs,
      allowLocalhost: isDev,
    });
    if (!urlValidation.valid) {
      return c.json({ error: `Invalid URL: ${urlValidation.error}` }, 400);
    }

    let response: unknown;
    let reflectionVersion = 'v1';
    let v1Error: unknown;
    const dnsGuardOptions = nodeHostnameGuard
      ? { guard: nodeHostnameGuard, allowLocalhost: isDev, allowPrivateIPs: permitPrivateIPs }
      : undefined;

    try {
      response = await sendReflectionRequest(
        url,
        REFLECTION_SERVICE_V1,
        request,
        timeout,
        dnsGuardOptions
      );
    } catch (err) {
      v1Error = err;
      reflectionVersion = 'v1alpha';
      try {
        response = await sendReflectionRequest(
          url,
          REFLECTION_SERVICE_V1_ALPHA,
          request,
          timeout,
          dnsGuardOptions
        );
      } catch (alphaErr) {
        const v1Msg = v1Error instanceof Error ? v1Error.message : String(v1Error);
        const alphaMsg = alphaErr instanceof Error ? alphaErr.message : String(alphaErr);
        return c.json(
          { error: `Reflection failed on v1 (${v1Msg}) and v1alpha (${alphaMsg})` },
          500
        );
      }
    }

    const responseData =
      typeof response === 'object' && response !== null
        ? { ...(response as Record<string, unknown>), reflectionVersion }
        : { data: response, reflectionVersion };

    return c.json(responseData);
  };
}

export const grpcReflection = createGrpcReflectionHandler();
