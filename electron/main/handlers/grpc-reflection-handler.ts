import { ipcMain, session } from 'electron';
import { IPC } from '../../shared/channels';
import {
  createValidatedHandler,
  type ReflectionIpcConfig,
  ReflectionIpcConfigSchema,
} from '../ipc/ipc-validators';
import { resolveManagedProxyForUrl } from '../security/enterprise-network';
import { getManagedEnterprisePolicy } from '../security/managed-enterprise-policy';
import {
  executeConnectReflection,
  resolveGrpcDialAddress,
  unresolvedGrpcProxyDialAddress,
} from './grpc-connect';
import { resolveGrpcReflectionExecutionPolicy } from './grpc-credentials';

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
  let policyConfig: ReflectionIpcConfig & {
    timeout: number;
    verifySsl: boolean;
    minTlsVersion?: 'TLSv1' | 'TLSv1.1' | 'TLSv1.2' | 'TLSv1.3';
  };
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
  const managed = getManagedEnterprisePolicy();
  const proxyTarget = new URL(urlWithScheme);
  if (proxyTarget.protocol === 'grpc:') proxyTarget.protocol = 'http:';
  if (proxyTarget.protocol === 'grpcs:') proxyTarget.protocol = 'https:';
  const proxy =
    managed.status.state === 'unmanaged'
      ? undefined
      : await resolveManagedProxyForUrl(proxyTarget.toString(), session.defaultSession, managed);
  const dial =
    proxy?.type === 'http' || proxy?.type === 'https' || proxy?.resolution
      ? unresolvedGrpcProxyDialAddress(urlWithScheme)
      : await resolveGrpcDialAddress(urlWithScheme);

  return executeConnectReflection({
    url: urlWithScheme,
    dial,
    tls: {
      verifySsl: policyConfig.verifySsl,
      minTlsVersion: policyConfig.minTlsVersion,
      clientCert: policyConfig.clientCert,
      caCert: policyConfig.caCert,
      proxy,
    },
    version,
    request: request as Record<string, unknown>,
    timeoutMs: timeout,
  });
}

export function registerGrpcReflectionIPC(): void {
  ipcMain.handle(
    IPC.grpc.reflect,
    createValidatedHandler(IPC.grpc.reflect, ReflectionIpcConfigSchema, sendReflectionRequest)
  );
}
