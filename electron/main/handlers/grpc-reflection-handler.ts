import { ipcMain } from 'electron';
import { IPC } from '../../shared/channels';
import {
  createValidatedHandler,
  ReflectionIpcConfigSchema,
  type ReflectionIpcConfig,
} from '../ipc/ipc-validators';
import { executeConnectReflection, resolveGrpcDialAddress } from './grpc-connect';
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
  const { url, reflectionService, request, timeout = 30000 } = config;
  const version: 'v1' | 'v1alpha' = reflectionService.includes('v1alpha') ? 'v1alpha' : 'v1';

  // Same SSRF resolve+pin (closes the DNS-rebind window) and TLS trust material
  // as the call path, then run reflection over a runtime registry via
  // connect-node — no @grpc/reflection / proto-loader.
  const urlWithScheme = url.includes('://') ? url : `grpc://${url}`;
  const dial = await resolveGrpcDialAddress(urlWithScheme);

  // A server that requires auth to expose its schema is otherwise
  // undiscoverable — merge any handle-backed auth resolved main-side (the
  // renderer already applies inline auth into `metadata` itself) the same
  // way the call path does.
  const metadata = mergeMainSideAuth(config.metadata ?? {}, config.auth);

  return executeConnectReflection({
    url: urlWithScheme,
    dial,
    tls: { verifySsl: config.verifySsl, clientCert: config.clientCert, caCert: config.caCert },
    version,
    request: request as Record<string, unknown>,
    timeoutMs: timeout,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  });
}

export function registerGrpcReflectionIPC(): void {
  ipcMain.handle(
    IPC.grpc.reflect,
    createValidatedHandler(IPC.grpc.reflect, ReflectionIpcConfigSchema, sendReflectionRequest)
  );
}
