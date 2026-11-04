import type { ProtocolAuthConfig } from '@shared/protocol/types';
import { applyNonSignAtWireAuth } from './auth-applier';
import { materializeExternalProtocolAuth } from './external-secret-materializer';

/**
 * The HTTP handler's sign-at-wire `resolveSecret`: an unresolvable handle fails
 * the request (as on the Worker and in the CLI) instead of signing with `''`.
 */
export { requiredSecretResolver } from './required-secret';

interface HttpAuthConfig {
  auth?: ProtocolAuthConfig;
  headers?: Record<string, string>;
  params?: Record<string, string>;
  signal?: AbortSignal;
}

/** Resolve and apply opaque credentials only in Electron main. */
export async function materializeHttpAuth(config: HttpAuthConfig): Promise<{
  auth: ProtocolAuthConfig | undefined;
  headers: Record<string, string>;
  params: Record<string, string>;
}> {
  const auth = await materializeExternalProtocolAuth(config.auth, config.signal);
  const applied = applyNonSignAtWireAuth(auth);
  return {
    auth,
    headers: { ...(config.headers ?? {}), ...applied.headers },
    params: { ...(config.params ?? {}), ...applied.params },
  };
}
