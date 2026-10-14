import { sanitizeRequestHeaders } from '@shared/protocol/header-policy';
import { ipcMain } from 'electron';
import { IPC } from '../../shared/channels';
import {
  createValidatedHandler,
  type ReflectionIpcConfig,
  ReflectionIpcConfigSchema,
} from '../ipc/ipc-validators';
import { materializeExternalProtocolAuth } from '../security/external-secret-materializer';
import { executeConnectReflection, resolveGrpcDialAddress } from './grpc-connect';
import { resolveGrpcReflectionExecutionPolicy } from './grpc-credentials';
import { mergeMainSideAuth } from './grpc-handler';

/** The subset of ServerReflectionResponse the renderer consumes. */
interface RawReflectionResponse {
  listServicesResponse?: { service: Array<{ name: string }> };
  fileDescriptorResponse?: { fileDescriptorProto: string[] };
  errorResponse?: { errorCode: number; errorMessage: string };
}

/** Parse a gRPC reflection target into `host:port` + TLS flag. */
export function parseTargetAddress(url: string): { address: string; useTls: boolean } {
  const withScheme = url.includes('://') ? url : `grpc://${url}`;
  const parsed = new URL(withScheme);
  // `grpcs:` is the standard gRPC TLS scheme — treat it as TLS (and default to 443).
  const useTls = parsed.protocol === 'https:' || parsed.protocol === 'grpcs:';
  const port = parsed.port || (useTls ? '443' : '80');
  return { address: `${parsed.hostname}:${port}`, useTls };
}

async function sendReflectionRequest(config: ReflectionIpcConfig): Promise<RawReflectionResponse> {
  let policyConfig: ReflectionIpcConfig & { timeout: number; verifySsl: boolean };
  try {
    policyConfig = resolveGrpcReflectionExecutionPolicy(config);
  } catch (err) {
    return {
      errorResponse: {
        errorCode: 2,
        errorMessage: `gRPC reflection setup failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
  const { url, reflectionService, request, timeout } = policyConfig;

  const version: 'v1' | 'v1alpha' = reflectionService.includes('v1alpha') ? 'v1alpha' : 'v1';

  // Same SSRF resolve+pin (closes the DNS-rebind window) and TLS trust material
  // as the call path, then run reflection over a runtime registry via
  // connect-node — no @grpc/reflection / proto-loader.
  const urlWithScheme = url.includes('://') ? url : `grpc://${url}`;
  const dial = await resolveGrpcDialAddress(urlWithScheme);

  // Reflection carries the request's metadata + auth like any gRPC call (#887).
  // Handle-backed credentials resolve here (after the SSRF pre-flight, as on
  // the call path) via the OS keychain — the plaintext never reaches the
  // renderer — and hop-by-hop / proxy headers are dropped first.
  let metadata: Record<string, string>;
  try {
    const auth = await materializeExternalProtocolAuth(policyConfig.auth);
    metadata = mergeMainSideAuth(sanitizeRequestHeaders(policyConfig.metadata), auth);
  } catch (err) {
    return {
      errorResponse: {
        errorCode: 2,
        errorMessage: `gRPC reflection auth setup failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  return executeConnectReflection({
    url: urlWithScheme,
    dial,
    tls: {
      verifySsl: policyConfig.verifySsl,
      clientCert: policyConfig.clientCert,
      caCert: policyConfig.caCert,
    },
    version,
    request: request as Record<string, unknown>,
    metadata,
    timeoutMs: timeout,
  });
}

export function registerGrpcReflectionIPC(): void {
  ipcMain.handle(
    IPC.grpc.reflect,
    createValidatedHandler(IPC.grpc.reflect, ReflectionIpcConfigSchema, sendReflectionRequest)
  );
}
